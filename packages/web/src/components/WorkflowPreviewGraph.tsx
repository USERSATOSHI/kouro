import { Badge, Box, Group, Paper, Stack, Text, useComputedColorScheme } from "@mantine/core";
import { Background, Controls, Handle, Position, ReactFlow, type NodeProps } from "@xyflow/react";
import { useMemo } from "react";
import { layoutWorkbenchGraph } from "../data/workbenchLayout";
import type { WorkflowGraph, WorkflowNode } from "../types";

function PreviewNode({ data }: NodeProps) {
  const node = data.node as WorkflowNode;
  return (
    <Paper w={176} p="sm" bg="var(--mantine-color-body)">
      <Handle type="target" position={Position.Left} />
      <Stack gap={5}>
        <Badge size="xs" variant="light">
          {node.kind}
        </Badge>
        <Text fw={600} size="sm">
          {node.id === "subagent" && node.definitionId !== data.rootDefinitionId
            ? node.definitionId
            : node.id}
        </Text>
        {node.role && (
          <Text size="xs" c="dimmed">
            {node.role}
          </Text>
        )}
      </Stack>
      <Handle type="source" position={Position.Right} />
    </Paper>
  );
}
const nodeTypes = { preview: PreviewNode };
export function WorkflowPreviewGraph({
  graph,
  rootDefinitionId,
}: {
  graph?: WorkflowGraph;
  rootDefinitionId?: string;
}) {
  const colorMode = useComputedColorScheme("dark");
  const projection = useMemo(() => {
    const key = (node: WorkflowNode) => `${node.definitionId ?? "root"}:${node.id}`;
    const sourceNodes = graph?.nodes ?? [];
    const nodes = sourceNodes.map((node) => ({
      id: key(node),
      type: "work",
      position: { x: 0, y: 0 },
      data: { node },
    }));
    const edges = (graph?.edges ?? []).flatMap((edge) => {
      const source = sourceNodes.find(
        (node) =>
          node.id === edge.source &&
          (!edge.definitionId || node.definitionId === edge.definitionId),
      );
      const target = sourceNodes.find(
        (node) =>
          node.id === edge.target &&
          (!(edge.targetDefinitionId ?? edge.definitionId) ||
            node.definitionId === (edge.targetDefinitionId ?? edge.definitionId)),
      );
      return source && target
        ? [
            {
              ...edge,
              id: `${edge.definitionId ?? "root"}:${edge.id}`,
              source: key(source),
              target: key(target),
            },
          ]
        : [];
    });
    return layoutWorkbenchGraph(
      { nodes, edges, scopes: [], breadcrumbs: [], instances: [] },
      rootDefinitionId ?? sourceNodes[0]?.definitionId ?? "root",
      false,
    );
  }, [graph, rootDefinitionId]);
  return (
    <Box h={{ base: 320, lg: 430 }} miw={0}>
      {projection.nodes.length ? (
        <ReactFlow
          colorMode={colorMode}
          style={{ backgroundColor: "var(--mantine-color-body)" }}
          nodes={projection.nodes.map((node) => ({ ...node, type: "preview" }))}
          edges={projection.edges.map((edge) => ({ ...edge, type: "smoothstep" }))}
          nodeTypes={nodeTypes}
          fitView
          nodesConnectable={false}
          nodesDraggable={false}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      ) : (
        <Group h="100%" justify="center">
          <Text c="dimmed" size="sm">
            Select a workflow to see its compiled graph.
          </Text>
        </Group>
      )}
    </Box>
  );
}
