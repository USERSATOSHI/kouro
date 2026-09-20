import type { RunView } from "@kouro/core/contracts";

/** Wire-level fixture used by the browser test; production components render it unchanged. */
export function m8PerformanceFixture(): {
  workflow: { id: string; name: string; graph: { nodes: unknown[]; edges: unknown[] } };
  run: RunView;
} {
  const nodes = Array.from({ length: 500 }, (_, index) => ({
    id: `node-${index}`,
    label: `Node ${index}`,
    kind: index % 5 === 0 ? "agent" : "command",
    position: { x: (index % 10) * 220, y: Math.floor(index / 10) * 120 },
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: `edge-${index}`,
    source: `node-${index}`,
    target: node.id,
  }));
  const startedAt = new Date(Date.now() - 30_000).toISOString();
  const invocations = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, index) => {
      const id = `invocation-${index}`;
      return [
        id,
        {
          id,
          scopeId: "root",
          nodeId: index < 500 ? `node-${index}` : `history-node-${index}`,
          activationOrdinal: index,
          status: index === 9_999 ? "running" : "succeeded",
          inputBindings: {},
          output: [],
          evidence: [],
          artifacts: [],
          workspace: null,
          createdAt: startedAt,
          startedAt,
          completedAt: index === 9_999 ? null : new Date(Date.now() - 29_000 + index).toISOString(),
          outcome: index === 9_999 ? null : "succeeded",
        },
      ];
    }),
  );
  const run = {
    projectionVersion: 1,
    runId: "m8-browser-fixture",
    revision: 10_000,
    eventCursor: 10_000,
    bundle: {} as RunView["bundle"],
    serverClock: new Date().toISOString(),
    state: {
      runId: "m8-browser-fixture",
      revision: 10_000,
      eventCursor: 10_000,
      status: "running",
      rootScopeId: "root",
      startedAt,
      finishedAt: null,
      scopes: {
        root: {
          id: "root",
          parentScopeId: null,
          definitionId: "root",
          status: "running",
          activationOrdinal: 0,
        },
      },
      invocations,
      attempts: {},
      recovery: null,
      counters: { root: 10_000 },
      approvals: {},
    },
  } as RunView;
  return {
    workflow: { id: "m8-fixture", name: "M8 browser fixture", graph: { nodes, edges } },
    run,
  };
}
