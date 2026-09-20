import { describe, expect, test } from "bun:test";
import { WorkflowBuilder, compileWorkflow, artifactType } from "@kouro/core";
import { Journal } from "../src/storage/journal";
import { CollaborationGateway } from "../src/collaboration/gateway";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

async function fixture() {
  const output = artifactType<string>("Output", { type: "string" });
  const workflow = new WorkflowBuilder({
    id: "collab",
    version: "1",
    limits: { maxMessages: 1, maxTurns: 8, maxInvocations: 8, maxConcurrentEffects: 1 },
  });
  const agent = workflow.agent("agent", { prompt: "work", produces: output });
  const done = workflow.complete("done");
  agent.on("success").to(done);
  workflow.startAt(agent);
  const bundle = await compileWorkflow(workflow.build());
  const dataDir = mkdtempSync(`${tmpdir()}/kouro-collab-`);
  const journal = new Journal({ dataDir });
  const created = journal.createRun({
    workflowId: "collab",
    bundle,
    idempotencyKey: crypto.randomUUID(),
  });
  const runId = created.run.runId;
  journal.append({
    runId,
    type: "run.started",
    payload: { rootScopeId: "scope", rootDefinitionId: bundle.rootDefinitionId },
  });
  journal.append({
    runId,
    type: "invocation.created",
    payload: { invocationId: "inv", scopeId: "scope", nodeId: "agent" },
  });
  journal.append({
    runId,
    type: "attempt.reserved",
    payload: { attemptId: "attempt", invocationId: "inv", ordinal: 0 },
  });
  journal.append({ runId, type: "attempt.started", payload: { attemptId: "attempt" } });
  const gateway = new CollaborationGateway(journal);
  gateway.configureParticipant(runId, "sender");
  gateway.configureParticipant(runId, "receiver");
  return { journal, gateway, runId, dataDir };
}

describe("bounded collaboration gateway", () => {
  test("binds sender to active attempt and rejects spoof/cross-run/ACL", async () => {
    const a = await fixture();
    a.gateway.configureChannel(a.runId, { name: "qa", participants: ["receiver"] });
    const grant = a.gateway.issueGrant({
      runId: a.runId,
      attemptId: "attempt",
      participantId: "sender",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(() =>
      a.gateway.send(grant.grantId, {
        recipientParticipantId: "nobody",
        body: "x",
        idempotencyKey: "x",
      }),
    ).toThrow();
    expect(() =>
      a.gateway.send(grant.grantId, { channel: "qa", body: "x", idempotencyKey: "x" }),
    ).toThrow(/authorized/);
    expect(() =>
      a.gateway.send(grant.grantId, {
        recipientParticipantId: "receiver",
        body: "x",
        idempotencyKey: "x",
      }),
    ).not.toThrow();
    a.journal.close();
  });

  test("deduplicates sends and reserves one selective batch across restart", async () => {
    const a = await fixture();
    const grant = a.gateway.issueGrant({
      runId: a.runId,
      attemptId: "attempt",
      participantId: "sender",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = a.gateway.send(grant.grantId, {
      recipientParticipantId: "receiver",
      body: { ok: true },
      idempotencyKey: "same",
    });
    expect(
      a.gateway.send(grant.grantId, {
        recipientParticipantId: "receiver",
        body: { ok: true },
        idempotencyKey: "same",
      }).id,
    ).toBe(first.id);
    const receiverGrant = a.gateway.issueGrant({
      runId: a.runId,
      attemptId: "attempt",
      participantId: "receiver",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const batch = a.gateway.wait({
      grantId: receiverGrant.grantId,
      waitId: "wait",
      participantId: "receiver",
      attemptId: "attempt",
      maxMessages: 1,
      idleDeadline: new Date(Date.now() - 1).toISOString(),
    });
    expect(batch?.visible).toHaveLength(1);
    expect(
      a.gateway.wait({
        grantId: receiverGrant.grantId,
        waitId: "wait",
        participantId: "receiver",
        attemptId: "attempt",
        maxMessages: 1,
        idleDeadline: new Date(Date.now() - 1).toISOString(),
      })?.batchId,
    ).toBe(batch?.batchId);
    a.journal.close();
    const reopened = new Journal({ dataDir: a.dataDir });
    const afterRestart = new CollaborationGateway(reopened);
    expect(
      afterRestart.send(grant.grantId, {
        recipientParticipantId: "receiver",
        body: { ok: true },
        idempotencyKey: "same",
      }).id,
    ).toBe(first.id);
    expect(
      afterRestart.wait({
        grantId: receiverGrant.grantId,
        waitId: "wait",
        participantId: "receiver",
        attemptId: "attempt",
        maxMessages: 1,
        idleDeadline: new Date(Date.now() - 1).toISOString(),
      })?.batchId,
    ).toBe(batch?.batchId);
    afterRestart.markContextManifest(batch!.batchId, ["ctx-1"]);
    expect(
      (afterRestart.snapshot(a.runId).messages as Array<{ recipientContextIds: string[] }>)[0]
        ?.recipientContextIds,
    ).toEqual(["ctx-1"]);
    afterRestart.markProviderDelivery(batch!.batchId, "uncertain");
    expect(
      (
        reopened.db
          .query("SELECT provider_state as state FROM collaboration_batches WHERE id=?1")
          .get(batch!.batchId) as { state: string }
      ).state,
    ).toBe("uncertain");
    reopened.close();
  });

  test("rejects expired grants and records expired omissions", async () => {
    const a = await fixture();
    const sender = a.gateway.issueGrant({
      runId: a.runId,
      attemptId: "attempt",
      participantId: "sender",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const receiver = a.gateway.issueGrant({
      runId: a.runId,
      attemptId: "attempt",
      participantId: "receiver",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    a.gateway.send(sender.grantId, {
      recipientParticipantId: "receiver",
      body: "soon",
      idempotencyKey: "expiring",
    });
    a.journal.db
      .query("UPDATE collaboration_messages SET expires_at=?1 WHERE idempotency_key='expiring'")
      .run(new Date(Date.now() - 1).toISOString());
    const manifest = a.gateway.wait({
      grantId: receiver.grantId,
      waitId: "expired-wait",
      participantId: "receiver",
      attemptId: "attempt",
      maxMessages: 1,
      idleDeadline: new Date(Date.now() - 1).toISOString(),
    });
    expect(manifest?.omitted[0]?.reason).toBe("expired");
    a.journal.db
      .query("UPDATE collaboration_grants SET expires_at=?1 WHERE id=?2")
      .run(new Date(Date.now() - 1).toISOString(), receiver.grantId);
    expect(() =>
      a.gateway.wait({
        grantId: receiver.grantId,
        waitId: "expired-grant",
        participantId: "receiver",
        attemptId: "attempt",
        maxMessages: 1,
        idleDeadline: new Date(Date.now() - 1).toISOString(),
      }),
    ).toThrow(/expired/);
    expect(() =>
      a.gateway.send(sender.grantId, {
        recipientParticipantId: "receiver",
        body: "x".repeat(70_000),
        idempotencyKey: "large",
      }),
    ).toThrow(/oversized/);
    a.journal.close();
  });

  test("atomically enforces the message budget under concurrent sends", async () => {
    const a = await fixture();
    const grant = a.gateway.issueGrant({
      runId: a.runId,
      attemptId: "attempt",
      participantId: "sender",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() =>
          a.gateway.send(grant.grantId, {
            recipientParticipantId: "receiver",
            body: i,
            idempotencyKey: `race-${i}`,
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    a.journal.close();
  });
});
