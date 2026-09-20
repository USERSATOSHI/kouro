import { describe, expect, test } from "bun:test";
import { projectHierarchicalGraph } from "./hierarchicalProjection";
import type { UiRunView, WorkflowGraph } from "../types";

const fixture = (): { graph: WorkflowGraph; view: UiRunView } => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: "plan", label: "plan", kind: "call", position: { x: 20, y: 20 }, scopeId: "root" },
      { id: "read", label: "read", kind: "agent", position: { x: 20, y: 20 }, scopeId: "child-a" },
      {
        id: "write",
        label: "write",
        kind: "agent",
        position: { x: 240, y: 20 },
        scopeId: "child-b",
      },
    ],
    edges: [
      { id: "parallel-a", source: "plan", target: "read", label: "branch a" },
      { id: "parallel-b", source: "plan", target: "write", label: "branch b" },
    ],
    groups: [
      { id: "root", label: "root" },
      { id: "child-a", label: "planner A", parentId: "root", definitionId: "planner" },
      { id: "child-b", label: "planner B", parentId: "root", definitionId: "planner" },
    ],
  };
  const view = {
    runId: "run",
    revision: 2,
    eventCursor: 2,
    projectionVersion: 1,
    workflowId: "root",
    serverClock: "2026-01-01T00:00:00Z",
    state: "running",
    scopes: {
      root: {
        id: "root",
        parentScopeId: null,
        definitionId: "root",
        status: "running",
        activationOrdinal: 0,
      },
      "child-a": {
        id: "child-a",
        parentScopeId: "root",
        definitionId: "planner",
        status: "running",
        activationOrdinal: 1,
      },
      "child-b": {
        id: "child-b",
        parentScopeId: "root",
        definitionId: "planner",
        status: "running",
        activationOrdinal: 2,
      },
    },
    invocations: {
      i1: {
        invocationId: "i1",
        sourceNodeId: "read",
        scopeId: "child-a",
        ordinal: 1,
        state: "running",
        outputArtifactIds: [],
        evidenceArtifactIds: [],
        artifactIds: [],
      },
      i2: {
        invocationId: "i2",
        sourceNodeId: "read",
        scopeId: "child-b",
        ordinal: 2,
        state: "succeeded",
        outputArtifactIds: [],
        evidenceArtifactIds: [],
        artifactIds: [],
      },
    },
    attempts: {},
    spans: {},
    artifacts: {},
    context: [],
    tools: [],
    logs: [],
    usage: [],
    diagnostics: [],
    capabilities: {},
  } as unknown as UiRunView;
  return { graph, view };
};

describe("hierarchical graph projection", () => {
  test("keeps repeated child instances distinct and preserves descendant selection", () => {
    const { graph, view } = fixture();
    const projected = projectHierarchicalGraph(graph, view, new Set(), "i2");
    expect(
      projected.instances
        .filter((item) => item.sourceNodeId === "read")
        .map((item) => item.invocationId),
    ).toEqual(["i1", "i2"]);
    expect(
      projected.nodes
        .filter((node) => node.type === "work")
        .filter((node) => (node.data.node as { id: string }).id === "read")
        .map((node) => node.id),
    ).toEqual(["read::i1", "read::i2"]);
    expect(new Set(projected.nodes.map((node) => node.id)).size).toBe(projected.nodes.length);
    expect(projected.breadcrumbs).toEqual(["root", "planner · child-b"]);
  });

  test("collapse hides descendants without changing source order", () => {
    const { graph, view } = fixture();
    const projected = projectHierarchicalGraph(graph, view, new Set(["child-a"]), "i1");
    expect(projected.nodes.some((node) => node.id === "read")).toBe(false);
    expect(projected.nodes.some((node) => node.id === "write")).toBe(true);
    expect(projected.breadcrumbs).toEqual(["root", "planner · child-a"]);
  });
});
