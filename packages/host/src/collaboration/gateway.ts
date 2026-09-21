import type {
  CollaborationChannel,
  CollaborationGrant,
  CollaborationLimits,
  CollaborationManifest,
  CollaborationMessage,
  CollaborationSend,
  JsonValue,
} from "@kouro/core";
import { assertMessageTarget, collaborationBodyBytes } from "@kouro/core";
import { id, json, now, parseJson } from "../id.ts";
import type { Journal } from "../storage/journal.ts";
import type { CollaborationTools } from "../types.ts";
import type { ScoutResult } from "../types.ts";
import type { ScoutGateway } from "../scouting/gateway.ts";

export type WaitRequest = {
  readonly grantId: string;
  readonly waitId?: string;
  readonly participantId: string;
  readonly attemptId: string;
  readonly maxMessages: number;
  readonly idleDeadline: string;
  readonly revision?: number;
};

/** Durable, bounded collaboration protocol. All mutations use the Journal's SQLite transaction. */
export class CollaborationGateway {
  constructor(private readonly journal: Journal) {}

  /** Create the deliberately small tool surface handed to one host turn. */
  tools(
    grant: CollaborationGrant,
    subagents?: ScoutGateway,
    subagent?: (input: {
      requestId: string;
      subagentId: string;
      input: Record<string, unknown>;
      signal?: AbortSignal;
    }) => Promise<ScoutResult>,
  ): CollaborationTools {
    return {
      participantId: grant.participantId,
      send_message: (input) =>
        this.send(grant.grantId, {
          recipientParticipantId: input.to,
          body: input.body,
          idempotencyKey: input.idempotencyKey,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        }),
      publish_blackboard: (input) => {
        const channel = `blackboard:${input.type}`;
        this.ensureBlackboardChannel(grant.runId, channel);
        return this.send(grant.grantId, {
          channel,
          body: input.body,
          idempotencyKey: input.idempotencyKey,
          ...(input.supersedes ? { replyTo: input.supersedes } : {}),
        });
      },
      wait: (input) =>
        this.wait({
          grantId: grant.grantId,
          waitId: input.waitId,
          participantId: grant.participantId,
          attemptId: grant.attemptId,
          maxMessages: Math.max(1, Math.min(64, input.maxMessages ?? 8)),
          idleDeadline: input.idleDeadline ?? new Date().toISOString(),
        }),
      ...(subagents && subagent
        ? {
            subagent: (input) => subagent(input),
          }
        : {}),
    };
  }

  private attemptInvocation(runId: string, attemptId: string): string {
    const view = this.journal.getView(runId);
    const attempt = view?.state.attempts[attemptId];
    if (!attempt) throw new Error("attempt is not registered");
    return attempt.invocationId;
  }

  private ensureBlackboardChannel(runId: string, channel: string): void {
    const exists = this.journal.db
      .query("SELECT 1 FROM collaboration_channels WHERE run_id=?1 AND name=?2")
      .get(runId, channel);
    if (exists) return;
    const participants = this.journal.db
      .query(
        "SELECT participant_id FROM collaboration_participants WHERE run_id=?1 ORDER BY participant_id",
      )
      .all(runId) as Array<{ participant_id: string }>;
    this.configureChannel(runId, {
      name: channel,
      participants: participants.map((item) => item.participant_id),
    });
  }

  configureParticipant(
    runId: string,
    participantId: string,
    status: "active" | "completed" = "active",
  ): void {
    this.journal.transaction(() => {
      const prior = this.journal.db
        .query(
          "SELECT status FROM collaboration_participants WHERE run_id=?1 AND participant_id=?2",
        )
        .get(runId, participantId) as { status: string } | null;
      if (prior?.status === "completed" && status !== "completed")
        throw new Error("completed participant cannot be resurrected");
      this.journal.db
        .query(
          "INSERT INTO collaboration_participants(run_id, participant_id, status) VALUES (?1, ?2, ?3) ON CONFLICT(run_id, participant_id) DO UPDATE SET status=excluded.status",
        )
        .run(runId, participantId, status);
      this.ensureUsage(runId);
    });
  }

  setParticipantStatus(runId: string, participantId: string, status: "active" | "completed"): void {
    this.journal.transaction(() => {
      const prior = this.journal.db
        .query(
          "SELECT status FROM collaboration_participants WHERE run_id=?1 AND participant_id=?2",
        )
        .get(runId, participantId) as { status: string } | null;
      if (prior?.status === "completed" && status !== "completed")
        throw new Error("completed participant cannot be resurrected");
      this.journal.db
        .query(
          "UPDATE collaboration_participants SET status=?1 WHERE run_id=?2 AND participant_id=?3",
        )
        .run(status, runId, participantId);
    });
  }

  configureChannel(runId: string, channel: CollaborationChannel): void {
    if (!channel.name || channel.participants.length === 0)
      throw new Error("channel ACL is required");
    this.journal.transaction(() =>
      this.journal.db
        .query(
          "INSERT INTO collaboration_channels(run_id,name,participants_json,max_body_bytes) VALUES (?1,?2,?3,?4) ON CONFLICT(run_id,name) DO UPDATE SET participants_json=excluded.participants_json,max_body_bytes=excluded.max_body_bytes",
        )
        .run(runId, channel.name, json(channel.participants), channel.maxBodyBytes ?? null),
    );
  }

  issueGrant(input: {
    runId: string;
    attemptId: string;
    participantId: string;
    expiresAt: string;
  }): CollaborationGrant {
    const view = this.journal.getView(input.runId);
    const attempt = view?.state.attempts[input.attemptId];
    if (
      !attempt ||
      attempt.status === "succeeded" ||
      attempt.status === "failed" ||
      attempt.status === "recovery-required"
    )
      throw new Error("attempt is not active");
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new Error("grant is expired");
    const participant = this.journal.db
      .query("SELECT status FROM collaboration_participants WHERE run_id=?1 AND participant_id=?2")
      .get(input.runId, input.participantId) as { status: string } | null;
    if (!participant || participant.status !== "active")
      throw new Error("participant is not active");
    const grantId = id("grant");
    this.journal.transaction(() => {
      this.journal.db
        .query(
          "INSERT INTO collaboration_grants(id,run_id,attempt_id,participant_id,expires_at) VALUES (?1,?2,?3,?4,?5)",
        )
        .run(grantId, input.runId, input.attemptId, input.participantId, input.expiresAt);
      this.ensureUsage(input.runId);
    });
    return { grantId, ...input };
  }

  revokeGrant(grantId: string): void {
    this.journal.db.query("UPDATE collaboration_grants SET revoked=1 WHERE id=?1").run(grantId);
  }

  send(grantId: string, request: CollaborationSend): CollaborationMessage {
    assertMessageTarget(request);
    return this.journal.transaction(() => {
      const grant = this.authorizeGrant(grantId);
      const run = this.journal.getView(grant.runId);
      if (
        !run ||
        ["succeeded", "failed", "cancelled", "interrupted", "recovery-required"].includes(
          run.state.status,
        )
      )
        throw new Error("run is terminal");
      const limits = run.bundle.limits as CollaborationLimits;
      const bytes = collaborationBodyBytes(request.body);
      if (bytes > (limits.maxMessageBytes ?? 64 * 1024))
        throw new Error("message payload is oversized");
      if (request.expiresAt && new Date(request.expiresAt).getTime() <= Date.now())
        throw new Error("message is expired");
      if (request.recipientParticipantId) {
        const recipient = this.journal.db
          .query(
            "SELECT status FROM collaboration_participants WHERE run_id=?1 AND participant_id=?2",
          )
          .get(grant.runId, request.recipientParticipantId) as { status: string } | null;
        if (!recipient) throw new Error("recipient is outside this run");
        if (recipient.status !== "active") throw new Error("recipient participant is not active");
      }
      if (request.replyTo) {
        const replied = this.journal.db
          .query(
            "SELECT recipient_participant_id, channel FROM collaboration_messages WHERE id=?1 AND run_id=?2",
          )
          .get(request.replyTo, grant.runId) as {
          recipient_participant_id: string | null;
          channel: string | null;
        } | null;
        if (
          !replied ||
          (replied.recipient_participant_id !== grant.participantId && !replied.channel)
        )
          throw new Error("reply target is not readable");
      }
      if (request.channel) {
        const channel = this.journal.db
          .query(
            "SELECT participants_json as participants,max_body_bytes as maxBodyBytes FROM collaboration_channels WHERE run_id=?1 AND name=?2",
          )
          .get(grant.runId, request.channel) as {
          participants: string;
          maxBodyBytes: number | null;
        } | null;
        if (!channel) throw new Error("channel is not authorized");
        const members = parseJson<string[]>(channel.participants);
        if (!members.includes(grant.participantId))
          throw new Error("sender is not authorized for channel");
        if (channel.maxBodyBytes !== null && bytes > channel.maxBodyBytes)
          throw new Error("message payload is oversized for channel");
      }
      const existing = this.journal.db
        .query(
          "SELECT * FROM collaboration_messages WHERE run_id=?1 AND sender_attempt_id=?2 AND idempotency_key=?3",
        )
        .get(grant.runId, grant.attemptId, request.idempotencyKey) as MessageRow | null;
      if (existing) {
        if (
          existing.body_json !== json(request.body) ||
          existing.recipient_participant_id !== (request.recipientParticipantId ?? null) ||
          existing.channel !== (request.channel ?? null)
        )
          throw new Error("message idempotency conflict");
        return toMessage(existing);
      }
      const usage = this.journal.db
        .query("SELECT messages FROM collaboration_usage WHERE run_id=?1")
        .get(grant.runId) as { messages: number };
      if (usage.messages >= limits.maxMessages) throw new Error("message budget exceeded");
      const started = this.journal.db
        .query("SELECT started_at as startedAt FROM collaboration_usage WHERE run_id=?1")
        .get(grant.runId) as { startedAt: string };
      if (Date.now() - Date.parse(started.startedAt) > limits.maxRunDurationMs)
        throw new Error("run duration budget exceeded");
      const messageId = id("msg");
      const timestamp = now();
      this.journal.db
        .query(
          "INSERT INTO collaboration_messages(id,run_id,sender_participant_id,sender_attempt_id,recipient_participant_id,channel,body_json,reply_to,idempotency_key,body_bytes,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        )
        .run(
          messageId,
          grant.runId,
          grant.participantId,
          grant.attemptId,
          request.recipientParticipantId ?? null,
          request.channel ?? null,
          json(request.body),
          request.replyTo ?? null,
          request.idempotencyKey,
          bytes,
          timestamp,
          request.expiresAt ?? null,
        );
      this.journal.db
        .query("UPDATE collaboration_usage SET messages=messages+1 WHERE run_id=?1")
        .run(grant.runId);
      return {
        id: messageId,
        runId: grant.runId,
        senderParticipantId: grant.participantId,
        senderAttemptId: grant.attemptId,
        recipientParticipantId: request.recipientParticipantId,
        channel: request.channel,
        body: request.body,
        replyTo: request.replyTo,
        createdAt: timestamp,
        expiresAt: request.expiresAt,
      };
    });
  }

  wait(input: WaitRequest): CollaborationManifest | null {
    return this.journal.transaction(() => {
      const grant = this.authorizeGrant(input.grantId);
      if (grant.attemptId !== input.attemptId || grant.participantId !== input.participantId)
        throw new Error("wait grant subject mismatch");
      const view = this.journal.getView(grant.runId);
      const runId = view?.runId;
      if (!runId) throw new Error("attempt is not registered");
      const attempt = view.state.attempts[input.attemptId];
      if (!attempt || ["succeeded", "failed", "recovery-required"].includes(attempt.status))
        throw new Error("attempt is not active");
      if (
        ["succeeded", "failed", "cancelled", "interrupted", "recovery-required"].includes(
          view.state.status,
        )
      )
        throw new Error("run is terminal");
      const participant = this.journal.db
        .query(
          "SELECT status FROM collaboration_participants WHERE run_id=?1 AND participant_id=?2",
        )
        .get(runId, input.participantId) as { status: string } | null;
      if (!participant || participant.status !== "active") return null;
      const waitId = input.waitId ?? id("wait");
      const existing = this.journal.db
        .query("SELECT * FROM collaboration_batches WHERE wait_id=?1")
        .get(waitId) as BatchRow | null;
      if (existing) return parseJson<CollaborationManifest>(existing.manifest_json);
      this.journal.db
        .query(
          "INSERT OR IGNORE INTO collaboration_waits(id,run_id,participant_id,attempt_id,max_messages,idle_deadline,revision) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        )
        .run(
          waitId,
          runId,
          input.participantId,
          input.attemptId,
          input.maxMessages,
          input.idleDeadline,
          input.revision ?? 0,
        );
      const candidates = this.journal.db
        .query(
          "SELECT m.* FROM collaboration_messages m WHERE m.run_id=?1 AND (m.recipient_participant_id=?2 OR m.channel IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM collaboration_message_reservations r WHERE r.message_id=m.id) ORDER BY m.created_at",
        )
        .all(runId, input.participantId) as MessageRow[];
      const rows = candidates
        .filter(
          (row) =>
            (row.recipient_participant_id === input.participantId ||
              (row.channel !== null &&
                this.channelAllows(runId, row.channel, input.participantId))) &&
            (!row.expires_at || Date.parse(row.expires_at) > Date.now()),
        )
        .slice(0, input.maxMessages);
      if (rows.length === 0 && Date.parse(input.idleDeadline) > Date.now()) return null;
      const visible = rows.map(toMessage);
      const all = candidates
        .filter(
          (row) =>
            row.recipient_participant_id === input.participantId ||
            (row.channel !== null && this.channelAllows(runId, row.channel, input.participantId)),
        )
        .map((row) => ({
          id: row.id,
          expired: !!row.expires_at && Date.parse(row.expires_at) <= Date.now(),
        }));
      const omitted = all
        .filter((row) => !rows.some((item) => item.id === row.id))
        .map((row) => ({ messageId: row.id, reason: row.expired ? "expired" : "not-selected" }));
      const manifest = {
        batchId: id("batch"),
        messageIds: visible.map((item) => item.id),
        visible,
        omitted,
      } satisfies CollaborationManifest;
      const run = this.journal.getView(runId)!;
      const limits = run.bundle.limits as CollaborationLimits;
      const usage = this.journal.db
        .query("SELECT turns,invocations,concurrent FROM collaboration_usage WHERE run_id=?1")
        .get(runId) as { turns: number; invocations: number; concurrent: number };
      if (usage.turns >= limits.maxTurns) throw new Error("turn budget exceeded");
      if (usage.invocations >= limits.maxInvocations) throw new Error("invocation budget exceeded");
      if (usage.concurrent >= limits.maxConcurrentEffects)
        throw new Error("concurrency budget exceeded");
      this.journal.db
        .query(
          "UPDATE collaboration_usage SET turns=turns+1,invocations=invocations+1,concurrent=concurrent+1 WHERE run_id=?1",
        )
        .run(runId);
      this.journal.db
        .query("UPDATE collaboration_waits SET state='reserved' WHERE id=?1")
        .run(waitId);
      this.journal.db
        .query(
          "INSERT INTO collaboration_batches(id,wait_id,message_ids_json,manifest_json,state,created_at) VALUES (?1,?2,?3,?4,'reserved',?5)",
        )
        .run(manifest.batchId, waitId, json(manifest.messageIds), json(manifest), now());
      for (const messageId of manifest.messageIds)
        this.journal.db
          .query(
            "INSERT INTO collaboration_message_reservations(message_id,batch_id) VALUES (?1,?2)",
          )
          .run(messageId, manifest.batchId);
      return manifest;
    });
  }

  markProviderDelivery(batchId: string, state: "accepted" | "uncertain" | "failed"): void {
    this.journal.db
      .query("UPDATE collaboration_batches SET provider_state=?1,state=?2 WHERE id=?3")
      .run(state, state === "accepted" ? "delivered" : state, batchId);
  }

  snapshot(runId: string): Record<string, unknown> {
    const view = this.journal.getView(runId);
    if (!view) throw new Error("run not found");
    const usage = this.journal.db
      .query(
        "SELECT messages,turns,invocations,concurrent,started_at as startedAt FROM collaboration_usage WHERE run_id=?1",
      )
      .get(runId) as {
      messages: number;
      turns: number;
      invocations: number;
      concurrent: number;
      startedAt: string;
    } | null;
    const participants = this.journal.db
      .query(
        "SELECT participant_id as id,status FROM collaboration_participants WHERE run_id=?1 ORDER BY participant_id",
      )
      .all(runId) as Array<{ id: string; status: string }>;
    const channels = this.journal.db
      .query(
        "SELECT name as id,name,participants_json as participantIds FROM collaboration_channels WHERE run_id=?1 ORDER BY name",
      )
      .all(runId) as Array<{ id: string; name: string; participantIds: string }>;
    const rows = this.journal.db
      .query("SELECT * FROM collaboration_messages WHERE run_id=?1 ORDER BY created_at")
      .all(runId) as MessageRow[];
    const messages = rows.map((item) => {
      const body = parseJson<JsonValue>(item.body_json);
      const context = this.journal.db
        .query(
          "SELECT b.context_manifest_ids_json as ids, b.provider_state as delivery FROM collaboration_message_reservations r JOIN collaboration_batches b ON b.id=r.batch_id WHERE r.message_id=?1",
        )
        .get(item.id) as { ids: string; delivery: string } | null;
      return {
        id: item.id,
        channelId: item.channel ?? "",
        senderId: item.sender_participant_id,
        recipientIds: item.recipient_participant_id ? [item.recipient_participant_id] : [],
        body: typeof body === "string" ? body : JSON.stringify(body),
        createdAt: item.created_at,
        senderAttemptId: item.sender_attempt_id,
        recipientContextIds: context ? parseJson<string[]>(context.ids) : [],
        delivery: context?.delivery ?? "durable",
      };
    });
    const limits = view.bundle.limits as CollaborationLimits;
    return {
      runId,
      objective: view.bundle.rootDefinitionId,
      startedAt: usage?.startedAt,
      budgets: {
        messages: { used: usage?.messages ?? 0, limit: limits.maxMessages },
        messageTurns: { used: usage?.turns ?? 0, limit: limits.maxTurns },
        invocations: { used: usage?.invocations ?? 0, limit: limits.maxInvocations },
        elapsedMs: {
          used: usage ? Math.max(0, Date.now() - Date.parse(usage.startedAt)) : 0,
          limit: limits.maxRunDurationMs,
        },
        concurrency: { used: usage?.concurrent ?? 0, limit: limits.maxConcurrentEffects },
      },
      participants: participants.map((item) => ({
        id: item.id,
        name: item.id,
        role: "participant",
        state: item.status,
      })),
      channels: channels.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.name.startsWith("blackboard") ? "blackboard" : "channel",
        participantIds: parseJson<string[]>(item.participantIds),
      })),
      messages,
      blackboard: messages.filter((item) => item.channelId.startsWith("blackboard")),
      artifacts: Object.values(view.state.attempts).flatMap((attempt) =>
        attempt.artifacts.map((artifact) => ({
          id: artifact.id,
          name: artifact.id,
          producerId: attempt.id,
        })),
      ),
      timeline: messages.map((item) => ({
        id: `timeline:${item.id}`,
        participantId: item.senderId,
        type: "message",
        label: "Message sent",
        at: item.createdAt,
        messageId: item.id,
        attemptId: item.senderAttemptId,
      })),
    };
  }

  releaseDelivery(batchId: string): void {
    this.journal.transaction(() => {
      const row = this.journal.db
        .query(
          "SELECT w.run_id as runId FROM collaboration_batches b JOIN collaboration_waits w ON w.id=b.wait_id WHERE b.id=?1 AND b.state='reserved'",
        )
        .get(batchId) as { runId: string } | null;
      if (!row) return;
      this.journal.db
        .query("UPDATE collaboration_batches SET state='released' WHERE id=?1")
        .run(batchId);
      this.journal.db
        .query(
          "UPDATE collaboration_usage SET concurrent=CASE WHEN concurrent>0 THEN concurrent-1 ELSE 0 END WHERE run_id=?1",
        )
        .run(row.runId);
    });
  }

  markContextManifest(batchId: string, contextManifestIds: readonly string[]): void {
    this.journal.db
      .query("UPDATE collaboration_batches SET context_manifest_ids_json=?1 WHERE id=?2")
      .run(json(contextManifestIds), batchId);
  }

  private authorizeGrant(grantId: string): CollaborationGrant {
    const row = this.journal.db
      .query("SELECT * FROM collaboration_grants WHERE id=?1")
      .get(grantId) as GrantRow | null;
    if (!row || row.revoked || new Date(row.expires_at).getTime() <= Date.now())
      throw new Error("gateway grant is expired or revoked");
    const view = this.journal.getView(row.run_id);
    const attempt = view?.state.attempts[row.attempt_id];
    if (
      !attempt ||
      attempt.status === "succeeded" ||
      attempt.status === "failed" ||
      attempt.status === "recovery-required"
    )
      throw new Error("attempt is not active");
    return {
      grantId: row.id,
      runId: row.run_id,
      attemptId: row.attempt_id,
      participantId: row.participant_id,
      expiresAt: row.expires_at,
    };
  }
  private ensureUsage(runId: string): void {
    this.journal.db
      .query("INSERT OR IGNORE INTO collaboration_usage(run_id,started_at) VALUES (?1,?2)")
      .run(runId, now());
  }
  private channelAllows(runId: string, channel: string, participantId: string): boolean {
    const row = this.journal.db
      .query(
        "SELECT participants_json as participants FROM collaboration_channels WHERE run_id=?1 AND name=?2",
      )
      .get(runId, channel) as { participants: string } | null;
    return !!row && parseJson<string[]>(row.participants).includes(participantId);
  }
}

type GrantRow = {
  id: string;
  run_id: string;
  attempt_id: string;
  participant_id: string;
  expires_at: string;
  revoked: number;
};
type MessageRow = {
  id: string;
  run_id: string;
  sender_participant_id: string;
  sender_attempt_id: string;
  recipient_participant_id: string | null;
  channel: string | null;
  body_json: string;
  reply_to: string | null;
  created_at: string;
  expires_at: string | null;
};
type BatchRow = { manifest_json: string };
function toMessage(row: MessageRow): CollaborationMessage {
  return {
    id: row.id,
    runId: row.run_id,
    senderParticipantId: row.sender_participant_id,
    senderAttemptId: row.sender_attempt_id,
    recipientParticipantId: row.recipient_participant_id ?? undefined,
    channel: row.channel ?? undefined,
    body: parseJson<JsonValue>(row.body_json),
    replyTo: row.reply_to ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
  };
}
