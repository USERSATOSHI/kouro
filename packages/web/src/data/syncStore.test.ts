import { describe, expect, test } from "bun:test";
import type { ProjectionFrame, RunView } from "@kouro/core/contracts";
import { RunSyncStore } from "./syncStore";

const view = (revision = 0): RunView => ({
  projectionVersion: 1,
  runId: "run-test",
  revision,
  eventCursor: revision,
  bundle: {
    formatVersion: 1,
    semanticVersions: { compiler: "1", expressions: "1", schemas: "1" },
    rootDefinitionId: "tiny",
    definitions: {},
    schemas: {},
    limits: {
      maxScopes: 1,
      maxInvocations: 4,
      maxAttempts: 4,
      maxTurns: 4,
      maxMessages: 4,
      maxConcurrentEffects: 1,
      maxRunDurationMs: 1000,
    },
    sourceMap: {},
    boundSummary: { scopes: 1, invocations: 1, attempts: 1, saturated: false },
    digest: "digest",
    canonicalJson: "{}",
  },
  state: {
    runId: "run-test",
    revision,
    eventCursor: revision,
    status: revision ? "running" : "pending",
    rootScopeId: "scope",
    startedAt: null,
    finishedAt: null,
    scopes: {},
    invocations: {},
    attempts: {},
    counters: {},
    approvals: {},
    recovery: null,
  },
  serverClock: "2026-09-18T00:00:00.000Z",
});

describe("run projection sync", () => {
  test("applies a contiguous frame and ignores duplicates", () => {
    const store = new RunSyncStore();
    store.replace(view());
    const frame = {
      projectionVersion: 1,
      runId: "run-test",
      baseRevision: 0,
      revision: 1,
      eventCursor: 1,
      state: view(1).state,
    } satisfies ProjectionFrame;
    expect(store.apply(frame)).toBe("applied");
    expect(store.getSnapshot()?.revision).toBe(1);
    expect(store.apply(frame)).toBe("duplicate");
  });

  test("marks a cursor gap stale so the caller can refetch a snapshot", () => {
    const store = new RunSyncStore();
    store.replace(view());
    let reset = "";
    store.onReset((reason) => {
      reset = reason;
    });
    const frame = {
      projectionVersion: 1,
      runId: "run-test",
      baseRevision: 3,
      revision: 4,
      eventCursor: 4,
      state: view(4).state,
    } satisfies ProjectionFrame;
    expect(store.apply(frame)).toBe("reset");
    expect(store.status).toBe("stale");
    expect(reset).toContain("gap");
  });
  test("retains the host clock anchor across live frames until a fresh snapshot", () => {
    const store = new RunSyncStore();
    store.replace({ ...view(), servedAt: "2026-09-19T12:00:00.000Z" } as RunView);
    expect(store.getSnapshot()?.servedAt).toBe("2026-09-19T12:00:00.000Z");
    expect(
      store.apply({
        projectionVersion: 1,
        runId: "run-test",
        baseRevision: 0,
        revision: 1,
        eventCursor: 1,
        state: view(1).state,
      }),
    ).toBe("applied");
    expect(store.getSnapshot()?.servedAt).toBe("2026-09-19T12:00:00.000Z");
  });
});
