import type { Node } from "@xyflow/react";
import type { UiInvocation, UiRunView, WorkflowGraph, WorkflowNode } from "../types";
import { asArray } from "../types";

export interface GraphScope {
  id: string;
  parentId?: string;
  definitionId?: string;
  label: string;
  depth: number;
  collapsed: boolean;
}

export interface GraphProjection {
  nodes: Node[];
  edges: Array<{ id: string; source: string; target: string; label?: string; hidden?: boolean }>;
  scopes: GraphScope[];
  breadcrumbs: string[];
  instances: Array<{
    sourceNodeId: string;
    invocationId: string;
    scopeId: string;
    ordinal: number;
  }>;
}

const scopePath = (id: string, scopes: Record<string, GraphScope>): string[] => {
  const result: string[] = [];
  let current: string | undefined = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    result.unshift(current);
    current = scopes[current]?.parentId;
  }
  return result;
};

/**
 * Projects a possibly-new M4 graph into a deterministic React Flow model.
 * Missing child metadata is intentionally treated as a flat root graph.
 */
export function projectHierarchicalGraph(
  graph: WorkflowGraph | undefined,
  view: UiRunView,
  collapsed: ReadonlySet<string> = new Set(),
  selectedId?: string,
): GraphProjection {
  const sourceNodes = graph?.nodes ?? [];
  const invocations = asArray(view.invocations);
  const invocationsByNode = new Map<string, UiInvocation[]>();
  for (const invocation of invocations) {
    const related = invocationsByNode.get(invocation.sourceNodeId) ?? [];
    related.push(invocation);
    invocationsByNode.set(invocation.sourceNodeId, related);
  }
  const firstScopeByNode = new Map<string, string>();
  for (const invocation of invocations)
    firstScopeByNode.set(invocation.sourceNodeId, invocation.scopeId);
  const scopeStates = asArray(view.scopes);
  const scopeById: Record<string, GraphScope> = {};
  for (const scope of scopeStates) {
    const definitionLabel = scope.definitionId || scope.id;
    scopeById[scope.id] = {
      id: scope.id,
      parentId: scope.parentScopeId ?? undefined,
      definitionId: scope.definitionId,
      // Repeated calls share a definition name, so include the concrete scope
      // identity when it differs. Breadcrumbs must disambiguate instances.
      label: definitionLabel === scope.id ? definitionLabel : `${definitionLabel} · ${scope.id}`,
      depth: 0,
      collapsed: collapsed.has(scope.id),
    };
  }
  for (const group of graph?.groups ?? []) {
    scopeById[group.id] ??= {
      id: group.id,
      parentId: group.parentId,
      definitionId: group.definitionId,
      label: group.label || group.id,
      depth: 0,
      collapsed: collapsed.has(group.id),
    };
  }
  for (const scope of Object.values(scopeById))
    scope.depth = scopePath(scope.id, scopeById).length - 1;

  const nodeScope = (node: WorkflowNode) =>
    node.scopeId || node.groupId || firstScopeByNode.get(node.id);
  const invocationDefinition = (item: UiInvocation) => view.scopes[item.scopeId]?.definitionId;
  const hiddenByCollapse = (scopeId: string | undefined) =>
    scopeId ? scopePath(scopeId, scopeById).some((id) => scopeById[id]?.collapsed) : false;
  // A collapsed scope remains visible as its own toggle; only descendants are
  // hidden. This is what makes expand/collapse reversible in a live graph.
  const visibleScopes = Object.values(scopeById).filter(
    (scope) => !hiddenByCollapse(scope.id) || collapsed.has(scope.id),
  );
  const scopes = visibleScopes.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const scopeOrder = new Map(scopes.map((scope, index) => [scope.id, index]));
  const nodes: Node[] = [];
  for (const [index, node] of sourceNodes.entries()) {
    const scopeId = nodeScope(node);
    if (hiddenByCollapse(scopeId)) continue;
    // Graph nodes describe a child definition and may carry the first observed
    // scope only. Runtime invocation scope is authoritative for each instance.
    const matching = (invocationsByNode.get(node.id) ?? []).filter(
      (item) =>
        item.sourceNodeId === node.id &&
        (!node.definitionId || invocationDefinition(item) === node.definitionId),
    );
    const instances = matching.length ? matching : [undefined];
    const base = node.position ?? {
      x: (index % 3) * 230 + 60,
      y: Math.floor(index / 3) * 150 + 65,
    };
    instances.forEach((invocation, instanceIndex) => {
      // A source node is a definition identity; invocationId disambiguates loop,
      // repeated-call, and repair instances in the rendered execution graph.
      const renderedId = invocation
        ? `${node.definitionId ? `${node.definitionId}:` : ""}${node.id}::${invocation.invocationId}`
        : `${node.definitionId ? `${node.definitionId}:` : ""}${node.id}`;
      const instanceScopeId = invocation?.scopeId ?? scopeId;
      if (hiddenByCollapse(instanceScopeId)) return;
      nodes.push({
        id: renderedId,
        type: "work",
        // Reserve a deterministic row for each scope instance. A small offset
        // made nested scope containers overlap and caused parent/neighbor nodes
        // to intercept scope-header clicks.
        position: {
          x: base.x + instanceIndex * 24,
          y: base.y + (scopeOrder.get(instanceScopeId ?? "") ?? 0) * 180 + instanceIndex * 96,
        },
        data: {
          node,
          state: invocation?.state,
          scopeId: instanceScopeId,
          invocationId: invocation?.invocationId,
        },
        selected: invocation?.invocationId === selectedId,
      });
    });
  }
  for (const scope of scopes) {
    const children = nodes.filter((node) => node.data.scopeId === scope.id);
    if (!children.length && !scope.collapsed) continue;
    const minX = children.length ? Math.min(...children.map((node) => node.position.x)) - 24 : 60;
    const minY = children.length
      ? Math.min(...children.map((node) => node.position.y)) - 42
      : 80 + (scopeOrder.get(scope.id) ?? 0) * 180;
    const maxX = children.length
      ? Math.max(...children.map((node) => node.position.x + 190)) + 24
      : minX + 214;
    const maxY = children.length
      ? Math.max(...children.map((node) => node.position.y + 90)) + 24
      : minY + 116;
    nodes.unshift({
      id: `scope:${scope.id}`,
      type: "scope",
      position: { x: minX, y: minY },
      data: { scope, width: maxX - minX, height: maxY - minY },
      selectable: scope.depth > 0,
      hidden: false,
      // The root container is visual context only and must not intercept
      // clicks destined for nested scope headers or work nodes.
      style: { pointerEvents: scope.depth > 0 ? "auto" : "none" },
      zIndex: scope.depth > 0 ? 0 : -1,
    });
  }
  const workNodes = nodes.filter((node) => node.type === "work");
  const edges = (graph?.edges ?? []).flatMap((edge) => {
    const definitionId =
      edge.definitionId ?? graph?.nodes.find((node) => node.id === edge.source)?.definitionId;
    const sources = workNodes.filter(
      (node) =>
        (node.data.node as { id: string }).id === edge.source &&
        (!definitionId || (node.data.node as WorkflowNode).definitionId === definitionId),
    );
    const targets = workNodes.filter(
      (node) =>
        (node.data.node as { id: string }).id === edge.target &&
        (!definitionId || (node.data.node as WorkflowNode).definitionId === definitionId),
    );
    if (!sources.length || !targets.length) return [{ ...edge, hidden: true }];
    // Keep branch links scoped where possible; otherwise retain the explicit
    // graph relationship for every rendered instance.
    const pairs = sources.flatMap((source) => {
      const sameScope = targets.filter((target) => target.data.scopeId === source.data.scopeId);
      return (sameScope.length ? sameScope : targets).map((target) => ({ source, target }));
    });
    return pairs.map(({ source, target }, index) => ({
      ...edge,
      id: pairs.length === 1 ? edge.id : `${edge.id}::${source.id}::${target.id}::${index}`,
      source: source.id,
      target: target.id,
      hidden: false,
    }));
  });
  const selected = invocations.find((item) => item.invocationId === selectedId);
  const breadcrumbs = selected
    ? scopePath(selected.scopeId, scopeById).map((id) => scopeById[id]?.label ?? id)
    : [];
  const instances = invocations
    .filter((item) =>
      sourceNodes.some(
        (node) =>
          node.id === item.sourceNodeId &&
          (!node.definitionId || node.definitionId === invocationDefinition(item)),
      ),
    )
    .sort((a, b) => a.sourceNodeId.localeCompare(b.sourceNodeId) || a.ordinal - b.ordinal)
    .map((item) => ({
      sourceNodeId: item.sourceNodeId,
      invocationId: item.invocationId,
      scopeId: item.scopeId,
      ordinal: item.ordinal,
    }));
  return { nodes, edges, scopes, breadcrumbs, instances };
}

export const descendantsOf = (scopeId: string, scopes: GraphScope[]) => {
  const children = new Map<string, string[]>();
  for (const scope of scopes)
    if (scope.parentId)
      children.set(scope.parentId, [...(children.get(scope.parentId) ?? []), scope.id]);
  const result: string[] = [];
  const queue = [...(children.get(scopeId) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    result.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return result;
};
