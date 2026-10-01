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
    bundle: {
      formatVersion: 1,
      semanticVersions: { compiler: "1", expressions: "1", schemas: "1" },
      rootDefinitionId: "root",
      definitions: {
        root: {
          id: "root",
          inputPorts: [],
          outputPorts: [],
          dataBindings: [],
          counters: [],
          entry: "node-0",
          exits: ["node-499"],
          nodes: nodes.map((node) => ({
            id: node.id,
            kind: "command" as const,
            executable: "true",
            args: [],
            inputPorts: [],
            outputPorts: [],
            bindings: [],
            acceptedExitCodes: [0],
            timeoutMs: 1000,
          })),
          controlEdges: edges.map((edge) => ({
            id: edge.id,
            sourceNodeId: edge.source,
            targetNodeId: edge.target,
            outcome: "succeeded",
            kind: "sequential" as const,
          })),
        },
      },
      schemas: {},
      sourceMap: {},
      digest: "m8-fixture",
      canonicalJson: "{}",
      limits: {
        maxScopes: 1,
        maxInvocations: 10000,
        maxAttempts: 10000,
        maxTurns: 10000,
        maxMessages: 1,
        maxConcurrentEffects: 1,
        maxRunDurationMs: 600000,
      },
      boundSummary: { scopes: 1, invocations: 10000, attempts: 10000, saturated: false },
    } as RunView["bundle"],
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
