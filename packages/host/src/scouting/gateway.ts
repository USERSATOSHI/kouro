import { canonicalize, collaborationBodyBytes, validateJsonSchema } from "@kouro/core";
import type { JsonValue } from "@kouro/core";
import { createHash } from "node:crypto";
import { json, now, parseJson } from "../id.ts";
import type { Journal } from "../storage/journal.ts";
import type { ScoutDelivery, ScoutRequest, ScoutRequestState, ScoutResult } from "../types.ts";

const MAX_TOTAL_REQUESTS = 4;
const MAX_RESULT_BYTES = 64 * 1024;

interface ScoutRow {
  run_id: string;
  request_id: string;
  parent_invocation_id: string;
  parent_attempt_id: string;
  scout_id: string;
  question: string;
  input_json: string;
  request_digest: string;
  input_digest: string;
  child_definition_id: string;
  child_agent_id: string;
  effective_harness: string | null;
  model_id: string | null;
  workspace_id: string | null;
  deadline_at: string | null;
  dispatch_id: string | null;
  usage_json: string;
  ordinal: number;
  optional: number;
  state: ScoutRequestState;
  result_json: string | null;
  result_artifact_id: string | null;
  result_digest: string | null;
  error: string | null;
}

type ScoutRunner = (request: ScoutRequest, signal?: AbortSignal) => Promise<JsonValue>;

export class ScoutGateway {
  private readonly inFlight = new Map<string, Promise<ScoutResult>>();

  constructor(private readonly journal: Journal) {}

  request(input: {
    runId: string;
    parentInvocationId: string;
    parentAttemptId: string;
    requestId: string;
    scoutId: string;
    question: string;
    input: Record<string, unknown>;
    enforceAuthorization?: boolean;
  }): ScoutRequest {
    if (!input.requestId.trim()) throw new Error("scout request ID is required");
    if (new TextEncoder().encode(input.requestId).byteLength > 128)
      throw new Error("scout request ID exceeds 128 bytes");
    if (!input.question.trim()) throw new Error("scout question is required");
    if (collaborationBodyBytes(input.input as JsonValue) > MAX_RESULT_BYTES)
      throw new Error("scout request exceeds input byte limit");
    const requestDigest = canonicalize({
      parentInvocationId: input.parentInvocationId,
      parentAttemptId: input.parentAttemptId,
      scoutId: input.scoutId,
      input: input.input,
    });
    return this.journal.transaction(() => {
      const view = this.journal.getView(input.runId);
      if (!view) throw new Error(`Run not found: ${input.runId}`);
      const parent = view.state.invocations[input.parentInvocationId];
      const attempt = view.state.attempts[input.parentAttemptId];
      if (!parent || !attempt || attempt.invocationId !== parent.id || attempt.status !== "running")
        throw new Error("scout request parent attempt is not active");
      const parentScope = view.state.scopes[parent.scopeId];
      const parentNode = parentScope
        ? view.bundle.definitions[parentScope.definitionId]?.nodes.find(
            (candidate) => candidate.id === parent.nodeId,
          )
        : undefined;
      if (parentNode?.kind !== "agent")
        throw new Error("only an agent invocation may start a subagent");
      const definition =
        view.bundle.definitions[
          parent.scopeId === view.state.rootScopeId
            ? view.bundle.rootDefinitionId
            : (view.state.scopes[parent.scopeId]?.definitionId ?? view.bundle.rootDefinitionId)
        ];
      const scout = definition?.scouts?.find((candidate) => candidate.id === input.scoutId);
      if (!scout) throw new Error(`subagent ${input.scoutId} is not declared`);
      const authorizedSubagents =
        parentNode.uses ?? (definition?.scouts ?? []).map((item) => item.id);
      if (input.enforceAuthorization && !authorizedSubagents.includes(input.scoutId))
        throw new Error(`subagent ${input.scoutId} is not authorized for agent ${parentNode.id}`);
      const prior = this.row(input.runId, input.parentAttemptId, input.requestId);
      if (prior) {
        if (prior.request_digest !== digest(requestDigest))
          throw new Error("scout request ID payload conflict");
        return toRequest(prior);
      }
      const child = view.bundle.definitions[scout.definitionId];
      if (!child) throw new Error(`scout definition ${scout.definitionId} is unavailable`);
      const childAgent = child.nodes.find((candidate) => candidate.kind === "agent");
      if (!childAgent || childAgent.kind !== "agent")
        throw new Error(`scout definition ${scout.definitionId} has no agent identity`);
      validateInputs(view.bundle.schemas, child.inputPorts, input.input);
      const runInput = parseJson<Record<string, unknown>>(
        (this.journal.getRunRow(input.runId)?.input_json ?? "{}") as string,
      );
      const profile = runInput.__kouroExecutionProfile;
      const configuredHarness =
        profile === "codex-readonly" || profile === "codex-workspace-write"
          ? "codex"
          : profile === "claude-readonly" || profile === "claude-workspace-write"
            ? "claude"
            : profile === "pi-readonly"
              ? "pi"
              : "scripted";
      const workspace = runInput.__kouroWorkspace as { workspaceId?: unknown } | undefined;
      const workspaceId =
        workspace && typeof workspace.workspaceId === "string" ? workspace.workspaceId : undefined;
      const timeoutMs = Math.min(parentNode.timeoutMs, childAgent.timeoutMs, 60_000);
      const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
      const spent = this.journal.db
        .query(
          "SELECT COUNT(*) as count FROM scout_requests WHERE run_id=?1 AND parent_attempt_id=?2 AND scout_id=?3",
        )
        .get(input.runId, input.parentAttemptId, input.scoutId) as { count: number };
      if (spent.count >= scout.maxInvocations)
        throw new Error(`scout ${input.scoutId} budget exceeded`);
      const total = this.journal.db
        .query(
          "SELECT COUNT(*) as count FROM scout_requests WHERE run_id=?1 AND parent_attempt_id=?2",
        )
        .get(input.runId, input.parentAttemptId) as { count: number };
      const policy = parentNode.scoutPolicy ?? {
        maxRequests: MAX_TOTAL_REQUESTS,
        maxConcurrent: 2,
      };
      if (total.count >= policy.maxRequests)
        throw new Error("planning-stage scout budget exceeded");
      const concurrent = this.journal.db
        .query(
          "SELECT COUNT(*) as count FROM scout_requests WHERE run_id=?1 AND parent_attempt_id=?2 AND state IN ('accepted','running')",
        )
        .get(input.runId, input.parentAttemptId) as { count: number };
      const scoutConcurrent = this.journal.db
        .query(
          "SELECT COUNT(*) as count FROM scout_requests WHERE run_id=?1 AND parent_attempt_id=?2 AND scout_id=?3 AND state IN ('accepted','running')",
        )
        .get(input.runId, input.parentAttemptId, input.scoutId) as { count: number };
      if (concurrent.count >= policy.maxConcurrent)
        throw new Error("planning-stage scout concurrency limit exceeded");
      if (scoutConcurrent.count >= scout.maxConcurrent)
        throw new Error(`scout ${input.scoutId} concurrency limit exceeded`);
      this.journal.db
        .query("INSERT OR IGNORE INTO collaboration_usage(run_id,started_at) VALUES (?1,?2)")
        .run(input.runId, now());
      const usage = this.journal.db
        .query("SELECT invocations FROM collaboration_usage WHERE run_id=?1")
        .get(input.runId) as { invocations: number };
      if (usage.invocations >= view.bundle.limits.maxInvocations)
        throw new Error("run invocation budget exceeded by scout request");
      const timestamp = now();
      this.journal.db
        .query(
          "INSERT INTO scout_requests(run_id,request_id,parent_invocation_id,parent_attempt_id,scout_id,question,input_json,request_digest,input_digest,child_definition_id,child_agent_id,effective_harness,model_id,workspace_id,deadline_at,usage_json,ordinal,optional,state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'{}',?16,?17,'accepted',?18,?18)",
        )
        .run(
          input.runId,
          input.requestId,
          input.parentInvocationId,
          input.parentAttemptId,
          input.scoutId,
          input.question,
          json(input.input),
          digest(requestDigest),
          digest(canonicalize(input.input)),
          scout.definitionId,
          childAgent.id,
          childAgent.harness ?? parentNode.harness ?? configuredHarness,
          childAgent.modelId ?? parentNode.modelId ?? null,
          workspaceId ?? null,
          deadlineAt,
          total.count,
          scout.optional ? 1 : 0,
          timestamp,
        );
      this.journal.db
        .query("UPDATE collaboration_usage SET invocations=invocations+1 WHERE run_id=?1")
        .run(input.runId);
      return toRequest(this.row(input.runId, input.parentAttemptId, input.requestId)!);
    });
  }

  async invoke(input: {
    runId: string;
    parentInvocationId: string;
    parentAttemptId: string;
    requestId: string;
    scoutId: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
    runner: ScoutRunner;
  }): Promise<ScoutResult> {
    const key = `${input.runId}:${input.parentAttemptId}:${input.requestId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = (async (): Promise<ScoutResult> => {
      const question =
        typeof input.input.question === "string"
          ? input.input.question
          : "Scout repository evidence";
      try {
        const accepted = this.request({
          runId: input.runId,
          parentInvocationId: input.parentInvocationId,
          parentAttemptId: input.parentAttemptId,
          requestId: input.requestId,
          scoutId: input.scoutId,
          question,
          input: input.input,
          enforceAuthorization: true,
        });
        if (accepted.state === "succeeded") return succeededResult(accepted);
        if (["failed", "unknown", "cancelled"].includes(accepted.state))
          return failedResult(accepted);
        this.claim(input.runId, input.parentAttemptId, input.requestId);
        const result = await input.runner(accepted, input.signal);
        const completed = this.complete(
          input.runId,
          input.parentAttemptId,
          input.requestId,
          result,
        );
        this.deliver(input.runId, input.parentAttemptId, input.requestId);
        return succeededResult(completed);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const current = this.row(input.runId, input.parentAttemptId, input.requestId);
        if (current && ["accepted", "running"].includes(current.state))
          return failedResult(
            input.signal?.aborted
              ? this.cancel(input.runId, input.parentAttemptId, input.requestId, message)
              : this.fail(input.runId, input.parentAttemptId, input.requestId, message),
          );
        return {
          requestId: input.requestId,
          scoutId: input.scoutId,
          state: "failed",
          error: { code: "SCOUT_REQUEST_REJECTED", message },
        };
      }
    })();
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  acceptanceError(
    runId: string,
    parentAttemptId: string,
    uses: readonly { id: string; optional: boolean }[],
  ): string | undefined {
    for (const scout of uses) {
      const scoutId = scout.id;
      const rows = this.journal.db
        .query(
          "SELECT state, optional, error FROM scout_requests WHERE run_id=?1 AND parent_attempt_id=?2 AND scout_id=?3 ORDER BY ordinal",
        )
        .all(runId, parentAttemptId, scoutId) as Array<{
        state: ScoutRequestState;
        optional: number;
        error: string | null;
      }>;
      if (rows.length === 0) {
        if (scout.optional) continue;
        return `required scout ${scoutId} was not requested`;
      }
      const required = rows.some((row) => row.optional === 0);
      if (!required) continue;
      const unfinished = rows.find((row) => row.state === "accepted" || row.state === "running");
      if (unfinished) return `required scout ${scoutId} is still ${unfinished.state}`;
      const failed = rows.find((row) => row.state !== "succeeded");
      if (failed)
        return `required scout ${scoutId} ended in ${failed.state}: ${failed.error ?? "unknown error"}`;
    }
    return undefined;
  }

  reconcile(runId: string): void {
    this.journal.transaction(() => {
      this.journal.db
        .query(
          "UPDATE scout_requests SET state='cancelled', error='parent attempt interrupted during host recovery', updated_at=?1 WHERE run_id=?2 AND state='accepted'",
        )
        .run(now(), runId);
      this.journal.db
        .query(
          "UPDATE scout_requests SET state='unknown', error='child outcome unknown after host recovery', updated_at=?1 WHERE run_id=?2 AND state='running'",
        )
        .run(now(), runId);
    });
  }

  claim(runId: string, parentAttemptOrRequestId: string, requestId?: string): ScoutRequest {
    const parentAttemptId = requestId
      ? parentAttemptOrRequestId
      : this.findParentAttempt(runId, parentAttemptOrRequestId);
    const actualRequestId = requestId ?? parentAttemptOrRequestId;
    return this.journal.transaction(() => {
      const row = this.require(runId, parentAttemptId, actualRequestId);
      if (row.state === "accepted") {
        this.journal.db
          .query(
            "UPDATE scout_requests SET state='running', dispatch_id=?1, updated_at=?2 WHERE run_id=?3 AND parent_attempt_id=?4 AND request_id=?5 AND state='accepted'",
          )
          .run(
            `${runId}/${parentAttemptId}/${actualRequestId}`,
            now(),
            runId,
            parentAttemptId,
            actualRequestId,
          );
      }
      return toRequest(this.require(runId, parentAttemptId, actualRequestId));
    });
  }

  complete(
    runId: string,
    parentAttemptOrRequestId: string,
    requestIdOrResult: string | JsonValue,
    resultMaybe?: JsonValue,
  ): ScoutRequest {
    const legacy = resultMaybe === undefined;
    const parentAttemptId = legacy
      ? this.findParentAttempt(runId, parentAttemptOrRequestId)
      : parentAttemptOrRequestId;
    const requestId = legacy ? parentAttemptOrRequestId : String(requestIdOrResult);
    const result = (legacy ? requestIdOrResult : resultMaybe) as JsonValue;
    return this.journal.transaction(() => {
      const row = this.require(runId, parentAttemptId, requestId);
      if (row.state !== "accepted" && row.state !== "running")
        throw new Error(`scout request is ${row.state}`);
      const view = this.journal.getView(runId);
      if (!view) throw new Error(`Run not found: ${runId}`);
      const parent = view.state.invocations[row.parent_invocation_id];
      const definition = parent
        ? view.bundle.definitions[
            view.state.scopes[parent.scopeId]?.definitionId ?? view.bundle.rootDefinitionId
          ]
        : undefined;
      const scout = definition?.scouts?.find((candidate) => candidate.id === row.scout_id);
      const child = scout ? view.bundle.definitions[scout.definitionId] : undefined;
      if (!child) throw new Error("scout definition is unavailable");
      validateScoutOutput(view.bundle.schemas, child.outputPorts, result);
      const bytes = collaborationBodyBytes(result);
      if (bytes > MAX_RESULT_BYTES) throw new Error("scout result exceeds output byte limit");
      const artifact = this.journal.blobs.put(
        runId,
        new TextEncoder().encode(JSON.stringify(result)),
        "application/vnd.kouro.scout-result+json",
      );
      this.journal.insertArtifact(artifact);
      this.journal.db
        .query(
          "UPDATE scout_requests SET state='succeeded', result_json=?1, result_artifact_id=?2, result_digest=?3, error=NULL, updated_at=?4 WHERE run_id=?5 AND parent_attempt_id=?6 AND request_id=?7 AND state IN ('accepted','running')",
        )
        .run(
          json(result),
          artifact.id,
          digest(canonicalize(result)),
          now(),
          runId,
          parentAttemptId,
          requestId,
        );
      return toRequest(this.require(runId, parentAttemptId, requestId));
    });
  }

  fail(
    runId: string,
    parentAttemptOrRequestId: string,
    requestIdOrError: string,
    errorOrState?: string,
    state: "failed" | "unknown" | "cancelled" = "failed",
  ): ScoutRequest {
    const legacy =
      errorOrState === undefined || ["failed", "unknown", "cancelled"].includes(errorOrState);
    const parentAttemptId = legacy
      ? this.findParentAttempt(runId, parentAttemptOrRequestId)
      : parentAttemptOrRequestId;
    const requestId = legacy ? parentAttemptOrRequestId : requestIdOrError;
    const error = legacy ? requestIdOrError : errorOrState!;
    const actualState =
      legacy && ["failed", "unknown", "cancelled"].includes(errorOrState ?? "")
        ? (errorOrState as "failed" | "unknown" | "cancelled")
        : state;
    return this.journal.transaction(() => {
      const row = this.require(runId, parentAttemptId, requestId);
      if (["succeeded", "failed", "cancelled", "unknown"].includes(row.state))
        return toRequest(row);
      this.journal.db
        .query(
          "UPDATE scout_requests SET state=?1, error=?2, updated_at=?3 WHERE run_id=?4 AND parent_attempt_id=?5 AND request_id=?6 AND state IN ('accepted','running')",
        )
        .run(actualState, error, now(), runId, parentAttemptId, requestId);
      return toRequest(this.require(runId, parentAttemptId, requestId));
    });
  }

  cancel(
    runId: string,
    parentAttemptOrRequestId: string,
    requestIdOrReason: string,
    reason = "cancelled",
  ): ScoutRequest {
    if (arguments.length === 3)
      return this.fail(runId, parentAttemptOrRequestId, requestIdOrReason, "cancelled");
    return this.fail(runId, parentAttemptOrRequestId, requestIdOrReason, reason, "cancelled");
  }

  deliver(
    runId: string,
    parentAttemptOrRequestId: string,
    requestIdOrPlannerAttempt: string,
  ): ScoutDelivery {
    const direct = this.row(runId, parentAttemptOrRequestId, requestIdOrPlannerAttempt);
    const parentAttemptId = direct
      ? parentAttemptOrRequestId
      : this.findParentAttempt(runId, parentAttemptOrRequestId);
    const requestId = direct ? requestIdOrPlannerAttempt : parentAttemptOrRequestId;
    return this.journal.transaction(() => {
      const row = this.require(runId, parentAttemptId, requestId);
      if (row.state !== "succeeded") {
        if (row.optional) throw new Error(`optional scout result is unavailable: ${row.state}`);
        throw new Error(`required scout result is unavailable: ${row.state}`);
      }
      const existing = this.journal.db
        .query(
          "SELECT manifest_json FROM scout_deliveries WHERE run_id=?1 AND parent_attempt_id=?2 AND request_id=?3 AND planner_attempt_id=?2",
        )
        .get(runId, parentAttemptId, requestId) as { manifest_json: string } | null;
      if (existing) return parseJson<ScoutDelivery>(existing.manifest_json);
      const resultBytes = row.result_json
        ? new TextEncoder().encode(row.result_json).byteLength
        : 0;
      const delivery: ScoutDelivery = {
        requestId,
        plannerAttemptId: parentAttemptId,
        manifest: {
          requestId,
          scoutId: row.scout_id,
          ...(row.result_artifact_id ? { artifactId: row.result_artifact_id } : {}),
          ...(row.result_digest ? { resultDigest: row.result_digest } : {}),
          bytes: resultBytes,
          source: "scout-result",
        },
        ...(row.result_json === null ? {} : { result: parseJson(row.result_json) }),
      };
      this.journal.db
        .query(
          "INSERT INTO scout_deliveries(run_id,parent_attempt_id,request_id,planner_attempt_id,manifest_json,delivered_at) VALUES (?1,?2,?3,?2,?4,?5)",
        )
        .run(runId, parentAttemptId, requestId, json(delivery), now());
      return delivery;
    });
  }

  deliveries(runId: string, plannerAttemptId: string): readonly ScoutDelivery[] {
    return (
      this.journal.db
        .query(
          "SELECT d.manifest_json FROM scout_deliveries d JOIN scout_requests r ON r.run_id=d.run_id AND r.parent_attempt_id=d.parent_attempt_id AND r.request_id=d.request_id WHERE d.run_id=?1 AND d.planner_attempt_id=?2 ORDER BY r.ordinal",
        )
        .all(runId, plannerAttemptId) as Array<{ manifest_json: string }>
    ).map((row) => parseJson<ScoutDelivery>(row.manifest_json));
  }

  requests(runId: string): readonly ScoutRequest[] {
    return (
      this.journal.db
        .query("SELECT * FROM scout_requests WHERE run_id=?1 ORDER BY created_at, request_id")
        .all(runId) as ScoutRow[]
    ).map(toRequest);
  }

  private row(runId: string, parentAttemptId: string, requestId: string): ScoutRow | null {
    return this.journal.db
      .query(
        "SELECT * FROM scout_requests WHERE run_id=?1 AND parent_attempt_id=?2 AND request_id=?3",
      )
      .get(runId, parentAttemptId, requestId) as ScoutRow | null;
  }

  private require(runId: string, parentAttemptId: string, requestId: string): ScoutRow {
    const row = this.row(runId, parentAttemptId, requestId);
    if (!row) throw new Error(`scout request not found: ${requestId}`);
    return row;
  }

  private findParentAttempt(runId: string, requestId: string): string {
    const rows = this.journal.db
      .query("SELECT parent_attempt_id FROM scout_requests WHERE run_id=?1 AND request_id=?2")
      .all(runId, requestId) as Array<{ parent_attempt_id: string }>;
    if (rows.length !== 1) throw new Error(`scout request not uniquely identified: ${requestId}`);
    return rows[0].parent_attempt_id;
  }
}

function toRequest(row: ScoutRow): ScoutRequest {
  return {
    runId: row.run_id,
    requestId: row.request_id,
    parentInvocationId: row.parent_invocation_id,
    parentAttemptId: row.parent_attempt_id,
    scoutId: row.scout_id,
    question: row.question,
    input: parseJson<Record<string, unknown>>(row.input_json),
    ordinal: row.ordinal,
    optional: row.optional === 1,
    state: row.state,
    ...(row.result_json === null ? {} : { result: parseJson(row.result_json) }),
    ...(row.result_artifact_id === null ? {} : { resultArtifactId: row.result_artifact_id }),
    ...(row.result_digest === null ? {} : { resultDigest: row.result_digest }),
    ...(row.child_definition_id ? { childDefinitionId: row.child_definition_id } : {}),
    ...(row.child_agent_id ? { childAgentId: row.child_agent_id } : {}),
    ...(row.effective_harness === null ? {} : { effectiveHarness: row.effective_harness }),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
    ...(row.dispatch_id === null ? {} : { dispatchId: row.dispatch_id }),
    usage: parseJson(row.usage_json),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function succeededResult(request: ScoutRequest): ScoutResult {
  if (!request.resultArtifactId || request.result === undefined)
    return {
      requestId: request.requestId,
      scoutId: request.scoutId,
      state: "failed",
      error: { code: "SCOUT_RESULT_MISSING", message: "Scout success has no durable result" },
    };
  return {
    requestId: request.requestId,
    scoutId: request.scoutId,
    state: "succeeded",
    result: request.result,
    resultArtifactId: request.resultArtifactId,
    resultDigest: request.resultDigest ?? digest(canonicalize(request.result)),
  };
}

function failedResult(request: ScoutRequest): ScoutResult {
  const state = ["failed", "unknown", "cancelled"].includes(request.state)
    ? (request.state as "failed" | "unknown" | "cancelled")
    : "failed";
  return {
    requestId: request.requestId,
    scoutId: request.scoutId,
    state,
    error: { code: `SCOUT_${state.toUpperCase()}`, message: request.error ?? state },
  };
}

function validateInputs(
  schemas: Readonly<Record<string, JsonValue>>,
  ports: readonly {
    name: string;
    schemaDigest: string;
    required: boolean;
    defaultValue?: JsonValue;
  }[],
  input: Record<string, unknown>,
): void {
  for (const key of Object.keys(input))
    if (!ports.some((port) => port.name === key))
      throw new Error(`scout input ${key} is not declared`);
  for (const port of ports) {
    const value = input[port.name];
    if (value === undefined) {
      if (port.required && port.defaultValue === undefined)
        throw new Error(`missing required scout input ${port.name}`);
      continue;
    }
    const schema = schemas[port.schemaDigest];
    if (!schema) throw new Error(`missing scout input schema ${port.schemaDigest}`);
    const check = validateJsonSchema(value, schema);
    if (!check.valid) throw new Error(`invalid scout input ${port.name}: ${check.error}`);
  }
}

function validateScoutOutput(
  schemas: Readonly<Record<string, JsonValue>>,
  ports: readonly { name: string; schemaDigest: string }[],
  result: JsonValue,
): void {
  if (ports.length === 0) return;
  for (const port of ports) {
    const value = ports.length === 1 ? result : isRecord(result) ? result[port.name] : undefined;
    const schema = schemas[port.schemaDigest];
    if (!schema) throw new Error(`missing scout output schema ${port.schemaDigest}`);
    const check = validateJsonSchema(value, schema);
    if (!check.valid) throw new Error(`invalid scout output ${port.name}: ${check.error}`);
  }
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
