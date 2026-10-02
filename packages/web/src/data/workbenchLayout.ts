import type { Node } from "@xyflow/react";
import type { GraphProjection } from "./hierarchicalProjection";
import type { WorkflowNode } from "../types";

/** Arrange the PDF's horizontal workflow and attributed child lanes without changing identities. */
export function layoutWorkbenchGraph(
  projection: GraphProjection,
  rootDefinitionId: string,
  detailed: boolean,
): GraphProjection {
  const work = projection.nodes.filter(
    (node) =>
      node.type === "work" && (detailed || (node.data.node as WorkflowNode).kind !== "complete"),
  );
  const roots = work.filter(
    (node) =>
      !(node.data.node as WorkflowNode).definitionId ||
      (node.data.node as WorkflowNode).definitionId === rootDefinitionId,
  );
  const rootIds = new Set(roots.map((node) => node.id));
  const links = projection.edges.filter(
    (edge) =>
      rootIds.has(edge.source) &&
      rootIds.has(edge.target) &&
      !edge.hidden &&
      !/repair|exhausted/.test(edge.label ?? ""),
  );
  const indegree = new Map(roots.map((node) => [node.id, 0]));
  const ranks = new Map(roots.map((node) => [node.id, 0]));
  for (const edge of links) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  const queue = roots.filter((node) => !indegree.get(node.id)).map((node) => node.id);
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of links.filter((edge) => edge.source === id)) {
      ranks.set(edge.target, Math.max(ranks.get(edge.target) ?? 0, (ranks.get(id) ?? 0) + 1));
      indegree.set(edge.target, (indegree.get(edge.target) ?? 1) - 1);
      if (indegree.get(edge.target) === 0) queue.push(edge.target);
    }
  }
  // Cyclic frontiers remain separate and inspectable even when no DAG rank can be assigned.
  let nextRank = Math.max(0, ...ranks.values());
  for (const node of roots) if (!visited.has(node.id)) ranks.set(node.id, ++nextRank);
  const atRank = new Map<number, number>();
  const positioned: Node[] = roots.map((node) => {
    const rank = ranks.get(node.id) ?? 0;
    const lane = atRank.get(rank) ?? 0;
    atRank.set(rank, lane + 1);
    return { ...node, position: { x: rank === 0 ? 0 : rank * 290 + 140, y: 180 + lane * 120 } };
  });
  const childDefinitions = [
    ...new Set(
      work
        .filter((node) => !rootIds.has(node.id))
        .map((node) => (node.data.node as WorkflowNode).definitionId ?? ""),
    ),
  ];
  for (const [lane, definition] of childDefinitions.entries()) {
    const children = work.filter(
      (node) =>
        !rootIds.has(node.id) && (node.data.node as WorkflowNode).definitionId === definition,
    );
    for (const [index, node] of children.entries())
      positioned.push({
        ...node,
        position: {
          x: 230 + index * 220,
          y: lane % 2 === 0 ? 20 - Math.floor(lane / 2) * 150 : 340 + Math.floor(lane / 2) * 150,
        },
      });
  }
  const visibleIds = new Set(positioned.map((node) => node.id));
  const scopes = detailed
    ? projection.nodes
        .filter((node) => node.type === "scope")
        .flatMap((node) => {
          const members = positioned.filter(
            (child) => child.data.scopeId === (node.data.scope as { id: string }).id,
          );
          if (!members.length)
            return (node.data.scope as { collapsed?: boolean }).collapsed ? [node] : [];
          const left = Math.min(...members.map((child) => child.position.x)) - 20;
          const top = Math.min(...members.map((child) => child.position.y)) - 40;
          const width = Math.max(...members.map((child) => child.position.x + 176)) - left + 20;
          const height = Math.max(...members.map((child) => child.position.y + 85)) - top + 20;
          return [
            {
              ...node,
              position: { x: left, y: top },
              data: { ...node.data, width, height },
              style: { ...node.style, width, height },
            },
          ];
        })
    : [];
  for (const scope of scopes) visibleIds.add(scope.id);
  return {
    ...projection,
    nodes: [...scopes, ...positioned],
    edges: projection.edges.map((edge) => ({
      ...edge,
      hidden: edge.hidden || !visibleIds.has(edge.source) || !visibleIds.has(edge.target),
    })),
  };
}
