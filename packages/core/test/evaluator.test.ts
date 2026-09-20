import { describe, expect, test } from "bun:test";
import { evaluateBehavior, evaluateEfficiency, type RunView } from "../src/index.ts";
import type { ExecutionState } from "../src/contracts.ts";

function view(): RunView {
  const state: ExecutionState = {
    runId: "run_eval",
    revision: 8,
    eventCursor: 8,
    status: "succeeded",
    rootScopeId: "root",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:03.000Z",
    scopes: {},
    invocations: {
      plan: {
        id: "plan",
        scopeId: "root",
        nodeId: "plan",
        activationOrdinal: 0,
        status: "succeeded",
        inputBindings: {},
        output: [],
        evidence: [],
        artifacts: [],
        workspace: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        outcome: "success",
      },
      repair: {
        id: "repair",
        scopeId: "root",
        nodeId: "impl",
        activationOrdinal: 1,
        repairPass: 1,
        status: "succeeded",
        inputBindings: {},
        output: [],
        evidence: [],
        artifacts: [],
        workspace: null,
        createdAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        outcome: "success",
      },
    },
    attempts: {
      a1: {
        id: "a1",
        invocationId: "plan",
        ordinal: 0,
        status: "succeeded",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        output: [],
        evidence: [],
        artifacts: [],
        workspace: null,
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      a2: {
        id: "a2",
        invocationId: "repair",
        ordinal: 1,
        status: "succeeded",
        startedAt: "2026-01-01T00:00:01.000Z",
        finishedAt: "2026-01-01T00:00:02.000Z",
        output: [],
        evidence: [],
        artifacts: [],
        workspace: null,
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    },
    recovery: null,
    counters: {},
    approvals: {},
    control: "none",
  };
  return {
    projectionVersion: 1,
    runId: state.runId,
    revision: state.revision,
    eventCursor: state.eventCursor,
    bundle: {} as RunView["bundle"],
    state,
    serverClock: state.finishedAt!,
  };
}

const evaluator = {
  id: "builtin.metrics",
  version: "1",
  sourceDigest: "source-digest",
  config: {},
};

describe("evaluation evidence", () => {
  test("reports behavior and keeps fallback attempts distinct from repair passes", async () => {
    const evidence = await evaluateBehavior(view(), evaluator);
    expect(evidence.status).toBe("passed");
    expect(evidence.value).toMatchObject({
      invocations: 2,
      attempts: 2,
      repairPasses: 1,
      fallbackAttempts: 1,
    });
    expect(evidence.target).toEqual({ runId: "run_eval", revision: 8 });
    expect(evidence.evaluatorSourceDigest).toBe("source-digest");
  });

  test("marks missing usage unavailable rather than zero", async () => {
    const evidence = await evaluateEfficiency(view(), evaluator);
    expect(evidence.status).toBe("unavailable");
    expect(evidence.value?.inputTokens).toBe(13);
    expect(evidence.value?.cost).toBeNull();
    expect(evidence.completeness.complete).toBe(false);
    expect(evidence.completeness.missing).toContain("cost");
  });
});
