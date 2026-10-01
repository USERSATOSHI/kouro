import { describe, expect, test } from "bun:test";
import type { JsonValue, ProjectionFrame, RunView } from "@kouro/core/contracts";
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

  test("clears a prior run before the next run snapshot arrives", () => {
    const store = new RunSyncStore();
    store.replace(view());

    store.beginRun("run-next");

    expect(store.getSnapshot()).toBeNull();
    expect(store.status).toBe("connecting");
  });

  test("does not multiply retained activity on unrelated frames and preserves terminal cursors", () => {
    const store = new RunSyncStore();
    const initial = view();
    const event = { type: "text", at: "2026-10-01T00:00:00Z", data: "one" };
    const initialWithActivity = {
      ...initial,
      state: {
        ...initial.state,
        attempts: {
          a: {
            id: "a",
            invocationId: "i",
            ordinal: 0,
            status: "running",
            startedAt: null,
            finishedAt: null,
            output: [],
            evidence: [],
            artifacts: [],
            workspace: null,
            harnessEvents: [event],
          },
        },
      },
    } satisfies RunView;
    store.replace(initialWithActivity);
    for (let revision = 1; revision <= 10; revision++) {
      const state = { ...initialWithActivity.state, revision, eventCursor: revision };
      store.apply({
        projectionVersion: 1,
        runId: initial.runId,
        baseRevision: revision - 1,
        revision,
        eventCursor: revision,
        state,
      });
    }
    expect(store.getSnapshot()?.liveActivity).toHaveLength(1);
    const next = { ...initialWithActivity.state, revision: 11, eventCursor: 11 };
    store.apply({
      projectionVersion: 1,
      runId: initial.runId,
      baseRevision: 10,
      revision: 11,
      eventCursor: 11,
      state: next,
      activity: { attemptId: "a", event: { type: "text", data: "two" } },
    });
    const terminal = {
      ...next,
      revision: 12,
      eventCursor: 12,
      status: "succeeded" as const,
      attempts: {
        a: {
          ...next.attempts.a,
          status: "succeeded" as const,
          harnessEvents: [event, { type: "text", data: "two" }],
        },
      },
    };
    store.apply({
      projectionVersion: 1,
      runId: initial.runId,
      baseRevision: 11,
      revision: 12,
      eventCursor: 12,
      state: terminal,
    });
    expect(store.getSnapshot()?.liveActivity).toHaveLength(2);
    expect(store.getSnapshot()?.liveActivity?.[1].cursor).toBe(11);
  });

  test("restores recent durable activity and updates host controls with live frames", () => {
    const store = new RunSyncStore();
    store.replace({
      ...view(),
      m2: {
        activity: [
          { attemptId: "a", cursor: 1, event: { type: "text", data: "before reconnect" } },
        ],
        capabilities: { pause: true, resume: false },
      },
    } as RunView);
    expect(store.getSnapshot()?.liveActivity?.[0].cursor).toBe(1);
    const state = { ...view(1).state, status: "paused" as const };
    store.apply({
      projectionVersion: 1,
      runId: "run-test",
      baseRevision: 0,
      revision: 1,
      eventCursor: 1,
      state,
      m2: { capabilities: { pause: false, resume: true }, steerableInvocationIds: [] },
    } as ProjectionFrame);
    expect(store.getSnapshot()?.capabilities.resume).toBe(true);
    expect(store.getSnapshot()?.capabilities.pause).toBeUndefined();
  });
  test("projects live tool input and output before completion and restores it after reconnect", () => {
    const store = new RunSyncStore();
    const initial = view();
    store.replace(initial);
    const activity: JsonValue[] = [
      {
        type: "tool",
        data: { id: "read", name: "Read", input: { path: "app.ts" }, status: "started" },
      },
      { type: "tool", data: { id: "read", output: "source code", status: "completed" } },
    ];
    activity.forEach((event, index) =>
      store.apply({
        projectionVersion: 1,
        runId: initial.runId,
        baseRevision: index,
        revision: index + 1,
        eventCursor: index + 1,
        state: view(index + 1).state,
        activity: { attemptId: "a", event },
      }),
    );
    expect(store.getSnapshot()?.tools).toHaveLength(1);
    expect(store.getSnapshot()?.tools[0]).toMatchObject({
      name: "Read",
      input: { path: "app.ts" },
      output: "source code",
      status: "completed",
    });
    store.replace({
      ...view(2),
      m2: {
        activity: activity.map((event, index) => ({ attemptId: "a", cursor: index + 1, event })),
      },
    } as RunView);
    expect(store.getSnapshot()?.tools).toHaveLength(1);
    expect(store.getSnapshot()?.tools[0].output).toBe("source code");
  });
});
