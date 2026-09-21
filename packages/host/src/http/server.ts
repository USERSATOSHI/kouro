import { randomBytes, randomUUID } from "node:crypto";
import { join, normalize, relative } from "node:path";
import { Elysia } from "elysia";
import type { ApplicationService } from "../application/service.ts";
import {
  validateDataset,
  validateExperiment,
  validateSchemaFixture,
  renderPromptFixture,
  compileDevelopmentPreview,
  type DatasetDefinition,
  type ExperimentDefinition,
} from "@kouro/core";

export interface HostServerOptions {
  token?: string;
  port?: number;
  staticRoot?: string;
}
interface Session {
  csrf: string;
  createdAt: number;
}
export interface HostServer {
  app: Elysia;
  token: string;
  port: number;
  start(): ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
}
type MutableStatus = { status?: number | string };

export function createHostServer(
  service: ApplicationService,
  options: HostServerOptions = {},
): HostServer {
  const token = options.token ?? process.env.KOURO_TOKEN ?? randomBytes(24).toString("base64url");
  const port = options.port ?? Number(process.env.KOURO_PORT ?? 43127);
  const sessions = new Map<string, Session>();
  const app = new Elysia();
  const bodyObject = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const unauthorized = (set: MutableStatus, message = "Authentication required") => {
    set.status = 401;
    return { error: "unauthorized", message };
  };
  const denied = (set: MutableStatus) =>
    set.status === 403
      ? { error: "forbidden", message: "Origin or CSRF check failed" }
      : unauthorized(set);
  const checked = (request: Request, set: MutableStatus, command = false): Session | null => {
    if (!validOriginHost(request)) {
      set.status = 403;
      return null;
    }
    const sessionId = parseCookies(request.headers.get("cookie") ?? "").kouro_session;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      unauthorized(set);
      return null;
    }
    if (command && request.headers.get("x-csrf-token") !== session.csrf) {
      set.status = 403;
      return null;
    }
    return session;
  };

  app.get("/api/session", ({ request, set }) => {
    if (!validOriginHost(request)) {
      set.status = 403;
      return { error: "invalid-origin" };
    }
    const sessionId = parseCookies(request.headers.get("cookie") ?? "").kouro_session;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    return session ? { csrfToken: session.csrf } : unauthorized(set);
  });
  app.post("/api/session", ({ request, set, body }) => {
    if (!validOriginHost(request)) {
      set.status = 403;
      return { error: "invalid-origin" };
    }
    if (String(bodyObject(body).token ?? "") !== token) {
      set.status = 401;
      return { error: "invalid-token" };
    }
    const sessionId = randomUUID();
    const csrf = randomBytes(24).toString("base64url");
    sessions.set(sessionId, { csrf, createdAt: Date.now() });
    set.headers["set-cookie"] = `kouro_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`;
    return { csrfToken: csrf };
  });

  app.get("/api/workflows", ({ request, set }) =>
    checked(request, set) ? service.workflows() : denied(set),
  );
  app.get("/api/execution-profiles", ({ request, set }) =>
    checked(request, set) ? service.executionProfiles() : denied(set),
  );
  // M8 development tools are deliberately stateless previews. Prompt execution
  // below delegates to the ordinary run command, so it cannot become a second
  // execution engine or hide provider/artifact evidence.
  app.post("/api/development/schema", async ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    const input = bodyObject(body);
    if (!("schema" in input)) {
      set.status = 400;
      return { error: "invalid-schema-request" };
    }
    return validateSchemaFixture(input.schema as never, input.value);
  });
  app.post("/api/development/prompt", async ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      return await renderPromptFixture(bodyObject(body) as never);
    } catch (cause) {
      set.status = 400;
      return {
        error: "invalid-prompt-fixture",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/development/prompt/run", async ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const input = bodyObject(body);
      if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim())
        throw new Error("idempotencyKey is required");
      if (
        input.executionProfile !== undefined &&
        !["scripted", "codex-readonly", "pi-readonly"].includes(String(input.executionProfile))
      )
        throw new Error("unsupported execution profile");
      return toWebRun(
        await service.runPromptFixture({
          fixture: input.fixture as never,
          idempotencyKey: input.idempotencyKey,
          executionProfile: input.executionProfile as
            | "scripted"
            | "codex-readonly"
            | "pi-readonly"
            | undefined,
        }),
      );
    } catch (cause) {
      set.status = 400;
      return {
        error: "prompt-run-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/development/compile", async ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      return await compileDevelopmentPreview(bodyObject(body) as never);
    } catch (cause) {
      set.status = 400;
      return {
        error: "invalid-workflow-source",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/datasets", ({ request, set }) =>
    checked(request, set) ? service.experiments.listDatasets() : denied(set),
  );
  app.post("/api/datasets", async ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const dataset = bodyObject(body) as unknown as DatasetDefinition;
      validateDataset(dataset);
      return await service.experiments.createDataset(dataset);
    } catch (cause) {
      set.status = 400;
      return {
        error: "invalid-dataset",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/experiments", ({ request, set }) =>
    checked(request, set) ? service.experiments.list() : denied(set),
  );
  app.post("/api/experiments", async ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const definition = bodyObject(body) as unknown as ExperimentDefinition;
      validateExperiment(definition);
      return await service.experiments.create(definition);
    } catch (cause) {
      set.status = 400;
      return {
        error: "invalid-experiment",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/experiments/:id", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    const experiment = service.experiments.get(params.id);
    if (!experiment) {
      set.status = 404;
      return { error: "experiment-not-found" };
    }
    return experiment;
  });
  app.post("/api/experiments/:id/resume", ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const input = bodyObject(body);
      if (!service.experiments.get(params.id)) {
        set.status = 404;
        return { error: "experiment-not-found" };
      }
      // Cell execution is intentionally acknowledged asynchronously. A large
      // experiment is a durable job, not an HTTP request whose lifetime should
      // be coupled to every ordinary run completing.
      void service.experiments
        .resume(params.id, {
          actor: typeof input.actor === "string" ? input.actor : undefined,
          maxConcurrent: Number.isSafeInteger(input.maxConcurrent)
            ? Number(input.maxConcurrent)
            : undefined,
        })
        .catch(() => {
          // The experiment snapshot and individual cell errors remain the source
          // of truth for the operator; do not turn a completed HTTP ack into a
          // second, non-durable error channel.
        });
      return service.experiments.get(params.id);
    } catch (cause) {
      set.status = 400;
      return {
        error: "experiment-resume-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/experiments/:id/cancel", ({ request, set, params }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      service.experiments.cancel(params.id);
      return service.experiments.get(params.id);
    } catch (cause) {
      set.status = 400;
      return {
        error: "experiment-cancel-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/runs", ({ request, set, query }) =>
    checked(request, set)
      ? service
          .listRunsPage(
            Math.min(100, nonnegativeInt(query.limit) || 100),
            nonnegativeInt(query.offset),
          )
          .map(toWebRun)
      : denied(set),
  );
  app.get("/api/runs/:id/checkpoint", async ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    try {
      const eligibility = await service.checkpointEligibility(params.id);
      const checkpoint = service.checkpoint(params.id);
      const comparison = service.checkpointComparison(params.id);
      return {
        runId: params.id,
        eligibility,
        checkpoint: checkpoint
          ? {
              ...checkpoint,
              id: checkpoint.checkpointId,
              treeDigest: checkpoint.workspaceTreeDigest,
              inheritedInvocationIds: checkpoint.inheritedSourceInvocationIds,
              pendingInvocationIds: checkpoint.pendingFrontier.map((item) => item.invocationId),
            }
          : undefined,
        genealogy: service.genealogy(params.id),
        comparison,
        timeline: {
          items: comparison.entries.map((entry) => ({
            id: entry.invocationId,
            label: entry.label,
            phase: entry.status,
            ...(entry.durationKnown ? { durationMs: entry.durationMs } : {}),
            detail: entry.detail,
          })),
        },
      };
    } catch (cause) {
      set.status = 404;
      return {
        error: "checkpoint-not-found",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/runs/:id/checkpoints", async ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const input = bodyObject(body);
      return await service.captureCheckpoint(params.id, {
        checkpointId: typeof input.checkpointId === "string" ? input.checkpointId : undefined,
        expectedRevision: Number.isSafeInteger(input.expectedRevision)
          ? Number(input.expectedRevision)
          : undefined,
        idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined,
      });
    } catch (cause) {
      set.status = 409;
      return {
        error: "checkpoint-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/checkpoints/:id/forks", async ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const input = bodyObject(body);
      const forks = await service.forkCheckpoint({
        checkpointId: params.id,
        requestKey: typeof input.requestKey === "string" ? input.requestKey : `fork:${params.id}`,
        name: typeof input.name === "string" ? input.name : undefined,
        executionProfile:
          typeof input.executionProfile === "string"
            ? (input.executionProfile as "scripted" | "codex-readonly" | "pi-readonly")
            : undefined,
        promptVariants:
          input.promptVariants &&
          typeof input.promptVariants === "object" &&
          !Array.isArray(input.promptVariants)
            ? (input.promptVariants as Record<string, string>)
            : undefined,
        count: input.count === 1 ? 1 : 2,
        input:
          typeof input.input === "object" && input.input !== null
            ? (input.input as Record<string, unknown>)
            : undefined,
      });
      return { checkpointId: params.id, forks };
    } catch (cause) {
      set.status = 409;
      return {
        error: "fork-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/runs/:id/genealogy", ({ request, set, params }) =>
    checked(request, set) ? service.genealogy(params.id) : denied(set),
  );
  app.get("/api/runs/:id/collaboration", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    try {
      return service.collaboration(params.id);
    } catch (cause) {
      set.status = 404;
      return {
        error: "collaboration-not-found",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/runs/:id/scouts", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    if (!service.getView(params.id)) {
      set.status = 404;
      return { error: "run-not-found" };
    }
    return service.scouts(params.id);
  });
  app.post("/api/runs", async ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    const input = bodyObject(body);
    const workflowIds = new Set((await service.workflows()).map((workflow) => workflow.id));
    if (
      !workflowIds.has(String(input.workflowId)) ||
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey
    ) {
      set.status = 400;
      return { error: "invalid-run-request" };
    }
    if (
      input.executionProfile !== undefined &&
      input.executionProfile !== "scripted" &&
      input.executionProfile !== "codex-readonly" &&
      input.executionProfile !== "pi-readonly"
    ) {
      set.status = 400;
      return { error: "invalid-execution-profile" };
    }
    try {
      return toWebRun(
        await service.createRun({
          workflowId: String(input.workflowId),
          idempotencyKey: input.idempotencyKey,
          input:
            typeof input.input === "object" && input.input !== null
              ? (input.input as Record<string, unknown>)
              : undefined,
          executionProfile: input.executionProfile as
            | "scripted"
            | "codex-readonly"
            | "pi-readonly"
            | undefined,
          workspace:
            typeof input.workspace === "object" &&
            input.workspace !== null &&
            typeof (input.workspace as Record<string, unknown>).repositoryPath === "string"
              ? {
                  repositoryPath: String(
                    (input.workspace as Record<string, unknown>).repositoryPath,
                  ),
                  workspaceId:
                    typeof (input.workspace as Record<string, unknown>).workspaceId === "string"
                      ? String((input.workspace as Record<string, unknown>).workspaceId)
                      : undefined,
                }
              : undefined,
        }),
      );
    } catch (cause) {
      set.status = 400;
      return {
        error: "run-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/runs/:id/diff", async ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    if (!service.getView(params.id)) {
      set.status = 404;
      return { error: "run-not-found" };
    }
    try {
      const snapshot = await service.workspaceSnapshot(params.id);
      return snapshot ?? { error: "workspace-not-configured" };
    } catch (cause) {
      set.status = 409;
      return {
        error: "workspace-unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/runs/:id/actions", ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    const input = bodyObject(body);
    if (
      typeof input.action !== "string" ||
      !Number.isSafeInteger(input.expectedRevision) ||
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey.trim()
    ) {
      set.status = 400;
      return { error: "unsupported-or-invalid-action" };
    }
    try {
      if (["pause", "resume", "cancel", "interrupt", "detach"].includes(input.action))
        return service.control({
          runId: params.id,
          action: input.action as "pause" | "resume" | "cancel" | "interrupt" | "detach",
          expectedRevision: Number(input.expectedRevision),
          actor: "local-operator",
          idempotencyKey: input.idempotencyKey,
        });
      if (input.action === "retry" && typeof input.invocationId === "string")
        return service.retry({
          runId: params.id,
          invocationId: input.invocationId,
          expectedRevision: Number(input.expectedRevision),
          actor: "local-operator",
          idempotencyKey: input.idempotencyKey,
        });
      if (
        input.action === "deliver" &&
        (typeof input.expectedTree === "string" || typeof input.deliveryActionId === "string")
      )
        return service.workspaceCommit({
          runId: params.id,
          expectedTree:
            typeof input.expectedTree === "string"
              ? input.expectedTree
              : (service.deliveryAction(String(input.deliveryActionId))?.resultTree ?? ""),
          operationKey: input.idempotencyKey,
          message:
            typeof input.message === "string" && input.message.trim()
              ? input.message
              : `Deliver ${params.id}`,
          ...(typeof input.deliveryActionId === "string"
            ? { deliveryActionId: input.deliveryActionId }
            : {}),
        });
      if (
        (input.action !== "approve" && input.action !== "reject") ||
        typeof input.invocationId !== "string"
      )
        throw new Error("unsupported-or-invalid-action");
      return service.decideApproval({
        runId: params.id,
        invocationId: input.invocationId,
        decision: input.action === "approve" ? "approved" : "rejected",
        expectedRevision: Number(input.expectedRevision),
        actor:
          typeof input.actor === "string" && input.actor.trim() ? input.actor : "local-operator",
        idempotencyKey: input.idempotencyKey,
        ...(typeof input.bindingDigest === "string" ? { bindingDigest: input.bindingDigest } : {}),
        ...(Number.isSafeInteger(input.subjectRevision)
          ? { subjectRevision: Number(input.subjectRevision) }
          : {}),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      set.status =
        message.startsWith("stale-action") || message.startsWith("Approval is stale") ? 409 : 400;
      return {
        error:
          message.startsWith("stale-action") || message.startsWith("Approval is stale")
            ? "stale-action"
            : "action-rejected",
        message,
      };
    }
  });
  app.get("/api/runs/:id/view", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    const view = service.getView(params.id);
    if (!view) {
      set.status = 404;
      return { error: "run-not-found" };
    }
    return {
      ...view,
      servedAt: new Date().toISOString(),
      m2: {
        capabilities: {
          pause: view.state.status === "running",
          resume: view.state.status === "paused",
          detach: view.state.status === "running" || view.state.status === "paused",
        },
      },
    };
  });
  app.get("/api/runs/:id/events", ({ request, set, params, query }) => {
    if (!checked(request, set)) return denied(set);
    if (!service.getView(params.id)) {
      set.status = 404;
      return { error: "run-not-found" };
    }
    const after = nonnegativeInt(query.after);
    return {
      events: service.getEvents(params.id, after),
      nextCursor: service.getView(params.id)?.eventCursor ?? after,
    };
  });
  app.get("/api/runs/:id/evidence", ({ request, set, params, query }) => {
    if (!checked(request, set)) return denied(set);
    if (!service.getView(params.id)) {
      set.status = 404;
      return { error: "run-not-found" };
    }
    const revision = query.revision === undefined ? undefined : Number(query.revision);
    return service.getEvaluationEvidence(params.id, {
      revision: Number.isSafeInteger(revision) ? revision : undefined,
      evaluatorId: typeof query.evaluatorId === "string" ? query.evaluatorId : undefined,
    });
  });
  app.get("/api/runs/:id/delivery/:actionId", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    const action = service.deliveryAction(params.actionId);
    if (!action || action.runId !== params.id) {
      set.status = 404;
      return { error: "delivery-action-not-found" };
    }
    return action;
  });
  app.post("/api/runs/:id/delivery", async ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const input = bodyObject(body);
      if (typeof input.requestKey !== "string" || !input.requestKey.trim())
        throw new Error("delivery requestKey is required");
      return await service.prepareDelivery({
        runId: params.id,
        requestKey: input.requestKey,
        ...(typeof input.invocationId === "string" ? { invocationId: input.invocationId } : {}),
        message:
          typeof input.message === "string" && input.message.trim()
            ? input.message
            : `Deliver ${params.id}`,
        ...(Array.isArray(input.validationEvidence)
          ? {
              validationEvidence: input.validationEvidence.filter(
                (item): item is string => typeof item === "string",
              ),
            }
          : {}),
        ...(Array.isArray(input.reviewEvidence)
          ? {
              reviewEvidence: input.reviewEvidence.filter(
                (item): item is string => typeof item === "string",
              ),
            }
          : {}),
      });
    } catch (cause) {
      set.status = 409;
      return {
        error: "delivery-preparation-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/runs/:id/delivery/:actionId", ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    try {
      const input = bodyObject(body);
      if (input.decision !== "approved" && input.decision !== "rejected")
        throw new Error("delivery decision must be approved or rejected");
      const action = service.deliveryAction(params.actionId);
      if (!action || action.runId !== params.id) throw new Error("delivery action not found");
      return service.decideDelivery({
        actionId: params.actionId,
        decision: input.decision,
        actor: typeof input.actor === "string" ? input.actor : "local-operator",
      });
    } catch (cause) {
      set.status = 409;
      return {
        error: "delivery-decision-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/experiments/:id/cells/:cellKey/evidence", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    const experiment = service.experiments.get(params.id);
    if (!experiment) {
      set.status = 404;
      return { error: "experiment-not-found" };
    }
    const cell = experiment.cells.find((item) => item.key === params.cellKey);
    if (!cell) {
      set.status = 404;
      return { error: "cell-not-found" };
    }
    return service.getEvaluationEvidence(cell.runId ?? "", {
      experimentId: params.id,
      cellKey: params.cellKey,
    });
  });
  app.get("/api/runs/:id/stream", ({ request, set, params, query }) => {
    if (!checked(request, set)) return denied(set);
    if (!service.getView(params.id)) {
      set.status = 404;
      return { error: "run-not-found" };
    }
    const after = Math.max(
      nonnegativeInt(query.after),
      nonnegativeInt(request.headers.get("last-event-id")),
    );
    const abortController = new AbortController();
    request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        // Bun closes idle HTTP responses after its default timeout. A comment
        // frame keeps an otherwise quiet run observable without inventing a
        // lifecycle event, revision, or projection update.
        const heartbeat = setInterval(() => {
          if (abortController.signal.aborted) return;
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            abortController.abort();
          }
        }, 5_000);
        void (async () => {
          try {
            for await (const frame of service.stream(params.id, after, abortController.signal)) {
              if (abortController.signal.aborted) break;
              controller.enqueue(
                encoder.encode(`id: ${frame.revision}\ndata: ${JSON.stringify(frame)}\n\n`),
              );
            }
          } catch {
            /* client disconnected */
          } finally {
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              /* cancelled */
            }
          }
        })();
      },
      cancel() {
        abortController.abort();
      },
    });
    set.headers["content-type"] = "text/event-stream; charset=utf-8";
    set.headers["cache-control"] = "no-cache, no-transform";
    set.headers["connection"] = "keep-alive";
    return new Response(stream);
  });
  app.post("/api/comparisons", ({ request, set, body }) => {
    if (!checked(request, set, true)) return denied(set);
    const input = bodyObject(body);
    if (
      !Array.isArray(input.runs) ||
      !Array.isArray(input.anchors) ||
      !Number.isSafeInteger(input.evidenceRevision)
    ) {
      set.status = 400;
      return { error: "invalid-comparison" };
    }
    try {
      return service.saveComparison({
        id: typeof input.id === "string" ? input.id : undefined,
        runs: input.runs as never,
        anchors: input.anchors as never,
        evidenceRevision: Number(input.evidenceRevision),
      });
    } catch (cause) {
      set.status = 400;
      return {
        error: "comparison-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/comparisons/:id", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    const comparison = service.comparison(params.id);
    if (!comparison) {
      set.status = 404;
      return { error: "comparison-not-found" };
    }
    return comparison;
  });
  app.get("/api/comparisons/:id/timeline", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    try {
      return service.comparisonTimeline(params.id);
    } catch (cause) {
      set.status = 404;
      return {
        error: "comparison-timeline-not-found",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/comparisons/:id/pairwise", ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    const input = bodyObject(body);
    if (
      typeof input.actor !== "string" ||
      !input.actor.trim() ||
      input.rubric === undefined ||
      !Number.isSafeInteger(input.evidenceRevision)
    ) {
      set.status = 400;
      return { error: "invalid-pairwise-request" };
    }
    try {
      return service.createPairwise({
        comparisonId: params.id,
        eligibleActor: input.actor,
        rubric: input.rubric,
        evidenceRevision: Number(input.evidenceRevision),
        evidenceA: Array.isArray(input.evidenceA) ? input.evidenceA : undefined,
        evidenceB: Array.isArray(input.evidenceB) ? input.evidenceB : undefined,
        leakageRisk: Array.isArray(input.leakageRisk)
          ? input.leakageRisk.filter((item): item is string => typeof item === "string")
          : undefined,
      });
    } catch (cause) {
      set.status = 400;
      return {
        error: "pairwise-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/pairwise/:id", ({ request, set, params, query }) => {
    if (!checked(request, set)) return denied(set);
    try {
      return service.pairwise(params.id, typeof query.actor === "string" ? query.actor : "");
    } catch (cause) {
      set.status = 403;
      return {
        error: "pairwise-denied",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.post("/api/pairwise/:id/decisions", ({ request, set, params, body }) => {
    if (!checked(request, set, true)) return denied(set);
    const input = bodyObject(body);
    if (
      typeof input.actor !== "string" ||
      typeof input.choice !== "string" ||
      typeof input.idempotencyKey !== "string"
    ) {
      set.status = 400;
      return { error: "invalid-pairwise-decision" };
    }
    try {
      return service.decidePairwise({
        assignmentId: params.id,
        actor: input.actor,
        choice: input.choice as never,
        reason: typeof input.reason === "string" ? input.reason : undefined,
        idempotencyKey: input.idempotencyKey,
        correctionOf: typeof input.correctionOf === "string" ? input.correctionOf : undefined,
      });
    } catch (cause) {
      set.status = 400;
      return {
        error: "pairwise-decision-rejected",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
  app.get("/api/artifacts/:id/content", ({ request, set, params }) => {
    if (!checked(request, set)) return denied(set);
    try {
      const ref = service.artifact(params.id);
      if (!ref) {
        set.status = 404;
        return { error: "artifact-not-found" };
      }
      set.headers["content-type"] = ref.mediaType ?? "application/octet-stream";
      set.headers["content-disposition"] = `attachment; filename="${params.id}"`;
      set.headers["x-content-type-options"] = "nosniff";
      return service.readArtifact(params.id);
    } catch {
      set.status = 404;
      return { error: "artifact-not-found" };
    }
  });

  app.get("/", () =>
    options.staticRoot ? Bun.file(join(options.staticRoot, "index.html")) : "Kouro local host",
  );
  if (options.staticRoot)
    app.get("/*", async ({ request, set }) => {
      if (!validOriginHost(request)) {
        set.status = 403;
        return { error: "invalid-origin" };
      }
      const root = normalize(options.staticRoot!);
      const path = normalize(
        join(root, decodeURIComponent(new URL(request.url).pathname).replace(/^\//, "")),
      );
      if (relative(root, path).startsWith("..")) {
        set.status = 400;
        return { error: "invalid-path" };
      }
      const file = Bun.file(path);
      if (await file.exists()) return file;
      const fallback = Bun.file(join(root, "index.html"));
      if (await fallback.exists()) return fallback;
      set.status = 404;
      return { error: "not-found" };
    });

  let server: ReturnType<typeof Bun.serve> | undefined;
  return {
    app,
    token,
    port,
    start() {
      server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.handle });
      return server;
    },
    async stop() {
      server?.stop();
      await service.close();
    },
  };
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim().split("="))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}
function nonnegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
function validOriginHost(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const hostHeader = request.headers.get("host") ?? requestUrl.host;
  const host = hostHeader
    .replace(/^\[/, "")
    .replace(/\](:\d+)?$/, "")
    .split(":")[0];
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && url.host === requestUrl.host;
  } catch {
    return false;
  }
}
function toWebRun(run: {
  runId: string;
  workflowId: string;
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  executionProfile?: string;
  task?: string;
  workItem?: unknown;
}) {
  return {
    id: run.runId,
    runId: run.runId,
    workflowId: run.workflowId,
    state: run.status,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    executionProfile: run.executionProfile,
    ...(run.task ? { task: run.task } : {}),
    ...(run.workItem ? { workItem: run.workItem } : {}),
  };
}
