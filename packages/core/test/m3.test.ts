import { describe, expect, test } from "bun:test";
import {
  WorkflowBuilder,
  artifactType,
  compileWorkflow,
  compileWorkflowDetailed,
  createInitialState,
  decide,
  reduceEvent,
  type LifecycleEvent,
} from "../src/index";

const text = artifactType<string>("text", { type: "string" });
const ev = (
  runId: string,
  sequence: number,
  type: LifecycleEvent["type"],
  payload: unknown,
  actor?: string,
) =>
  ({
    eventId: `${runId}-${sequence}`,
    runId,
    sequence,
    schemaVersion: 1 as const,
    type,
    recordedAt: `2026-09-19T00:00:${String(sequence).padStart(2, "0")}Z`,
    payload,
    ...(actor ? { actor } : {}),
  }) as LifecycleEvent;

describe("M3 bounded controls", () => {
  test("repair helper lowers to a bounded counter guard and fallback", async () => {
    const w = new WorkflowBuilder({ id: "repair" });
    const check = w.command("check", { executable: "/usr/bin/false" });
    const implement = w.agent("implement", { prompt: "repair", produces: text });
    const failed = w.complete("failed", { result: "failed" });
    check.on("success").to(failed);
    implement.on("success").to(failed);
    check
      .on("failure")
      .repair(implement, { maxRepairs: 3, feedback: check.output, exhausted: failed });
    w.startAt(check);
    const bundle = await compileWorkflow(w.build());
    const definition = bundle.definitions.repair;
    expect(definition.counters).toEqual([{ id: "check:failure:repairs", max: 3 }]);
    expect(definition.controlEdges.filter((edge) => edge.sourceNodeId === "check")).toHaveLength(3);
    expect(definition.controlEdges.find((edge) => edge.counterIncrement)?.guard).toEqual({
      kind: "counter-below-limit",
      counterId: "check:failure:repairs",
    });
  });

  test("unbounded residual cycles are rejected but bounded repair cycles compile", async () => {
    const unbounded = new WorkflowBuilder({ id: "unbounded" });
    const a = unbounded.agent("a", { prompt: "a", produces: text });
    const b = unbounded.agent("b", { prompt: "b", produces: text });
    unbounded.startAt(a);
    a.on("success").to(b);
    b.on("success").to(a);
    const rejected = await compileWorkflowDetailed(unbounded.build());
    expect(rejected.diagnostics.map((d) => d.code)).toContain("UNSUPPORTED_CYCLE");
    const bounded = new WorkflowBuilder({ id: "bounded" });
    const check = bounded.command("check", { executable: "/usr/bin/false" });
    const repair = bounded.agent("repair", { prompt: "repair", produces: text });
    const done = bounded.complete("done");
    const failed = bounded.complete("failed", { result: "failed" });
    bounded.startAt(check);
    check.on("success").to(done);
    check.on("failure").repair(repair, { maxRepairs: 1, exhausted: failed });
    repair.on("success").to(check);
    await expect(compileWorkflow(bounded.build())).resolves.toBeDefined();
  });

  test("approval is a durable wait and stale decisions are rejected", async () => {
    const w = new WorkflowBuilder({ id: "approval" });
    const approval = w.approval("approve", { action: "accept-plan" });
    const done = w.complete("done");
    w.startAt(approval);
    approval.on("approved").to(done);
    approval.on("rejected").to(done);
    const bundle = await compileWorkflow(w.build());
    let state = createInitialState("run");
    state = reduceEvent(state, ev("run", 1, "run.started", {}));
    expect(decide(bundle, state)[0]?.kind).toBe("activate");
    state = reduceEvent(
      state,
      ev("run", 2, "invocation.created", { invocationId: "inv", nodeId: "approve" }),
    );
    expect(decide(bundle, state)[0]).toMatchObject({
      kind: "request-approval",
      invocationId: "inv",
      action: "accept-plan",
    });
    state = reduceEvent(
      state,
      ev("run", 3, "approval.requested", {
        approvalId: "ap",
        invocationId: "inv",
        action: "accept-plan",
        bindingDigest: "d",
        subjectRevision: 2,
      }),
    );
    expect(() =>
      reduceEvent(
        state,
        ev(
          "run",
          4,
          "approval.decided",
          { approvalId: "ap", decision: "approved", bindingDigest: "other", subjectRevision: 2 },
          "alice",
        ),
      ),
    ).toThrow(/stale/);
    state = reduceEvent(
      state,
      ev(
        "run",
        4,
        "approval.decided",
        { approvalId: "ap", decision: "approved", bindingDigest: "d", subjectRevision: 2 },
        "alice",
      ),
    );
    expect(state.invocations.inv.status).toBe("succeeded");
    expect(state.approvals.ap.status).toBe("approved");
  });

  test("repair feedback keeps failed validator output and stops at the exact bound", async () => {
    const w = new WorkflowBuilder({ id: "repair-runtime" });
    const validate = w.agent("validate", { prompt: "validate", produces: text });
    const repair = w.agent("repair", { prompt: "repair", produces: text });
    const exhausted = w.complete("exhausted", { result: "failed" });
    w.startAt(validate);
    validate.on("success").to(exhausted);
    validate.on("failure").repair(repair, {
      maxRepairs: 3,
      feedback: validate.output,
      exhausted,
    });
    repair.on("success").to(validate);
    const bundle = await compileWorkflow(w.build());
    let state = createInitialState("repair-run");
    state = reduceEvent(state, ev("repair-run", 1, "run.started", {}));
    for (let pass = 0; pass < 3; pass += 1) {
      const invocationId = `validate-${pass}`;
      state = reduceEvent(
        state,
        ev("repair-run", state.revision + 1, "invocation.created", {
          invocationId,
          nodeId: "validate",
          activationOrdinal: pass,
        }),
      );
      state = reduceEvent(
        state,
        ev("repair-run", state.revision + 1, "invocation.completed", {
          invocationId,
          status: "failed",
          direct: true,
          output: [{ id: `failed-output-${pass}` }],
        }),
      );
      if (pass > 0) {
        state = reduceEvent(
          state,
          ev("repair-run", state.revision + 1, "counter.incremented", {
            scopeId: state.rootScopeId,
            counterId: "validate:failure:repairs",
            value: pass,
          }),
        );
      }
      const intent = decide(bundle, state).find((item) => item.kind === "activate");
      expect(intent).toMatchObject({
        nodeId: "repair",
        counterId: "validate:failure:repairs",
        repairPass: pass + 1,
        bindings: { feedback: { artifactId: `failed-output-${pass}` } },
      });
      state = reduceEvent(
        state,
        ev("repair-run", state.revision + 1, "invocation.created", {
          invocationId: `repair-${pass}`,
          nodeId: "repair",
          activationOrdinal: pass + 10,
          sourceInvocationId: invocationId,
          sourceEdgeId: "validate:failure:repair",
        }),
      );
    }
    const finalId = "validate-final";
    state = reduceEvent(
      state,
      ev("repair-run", state.revision + 1, "invocation.created", {
        invocationId: finalId,
        nodeId: "validate",
        activationOrdinal: 3,
      }),
    );
    state = reduceEvent(
      state,
      ev("repair-run", state.revision + 1, "invocation.completed", {
        invocationId: finalId,
        status: "failed",
        direct: true,
      }),
    );
    state = reduceEvent(
      state,
      ev("repair-run", state.revision + 1, "counter.incremented", {
        scopeId: state.rootScopeId,
        counterId: "validate:failure:repairs",
        value: 3,
      }),
    );
    expect(decide(bundle, state).find((item) => item.kind === "activate")).toMatchObject({
      nodeId: "exhausted",
    });
  });

  test("operational retries add attempts without consuming repair counters", () => {
    let state = createInitialState("retry-run");
    state = reduceEvent(state, ev("retry-run", 1, "run.started", {}));
    state = reduceEvent(
      state,
      ev("retry-run", 2, "invocation.created", { invocationId: "v", nodeId: "validate" }),
    );
    state = reduceEvent(
      state,
      ev("retry-run", 3, "attempt.reserved", { attemptId: "a1", invocationId: "v" }),
    );
    state = reduceEvent(state, ev("retry-run", 4, "attempt.started", { attemptId: "a1" }));
    state = reduceEvent(
      state,
      ev("retry-run", 5, "attempt.completed", { attemptId: "a1", status: "failed" }),
    );
    state = reduceEvent(
      state,
      ev("retry-run", 6, "invocation.completed", { invocationId: "v", status: "failed" }),
    );
    state = reduceEvent(
      state,
      ev("retry-run", 7, "run.retried", {
        invocationId: "v",
        sourceAttemptId: "a1",
        attemptId: "a2",
      }),
    );
    state = reduceEvent(
      state,
      ev("retry-run", 8, "attempt.reserved", { attemptId: "a2", invocationId: "v" }),
    );
    expect(Object.keys(state.attempts)).toHaveLength(2);
    expect(state.counters).toEqual({});
    expect(state.invocations.v.repairPass).toBeUndefined();
  });
});
