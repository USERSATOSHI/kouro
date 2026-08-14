import '@xyflow/react/dist/style.css';

import type {
  ApprovalView,
  ArtifactView,
  InvocationActivityView,
  RepositorySummary,
  RunDetails,
  RunSummary,
  TicketDetails,
  TicketListItem,
  TicketProjectView,
  TicketProviderConfigurationView,
  WorkflowNodeView,
  WorkflowSubagentView,
} from '@kouro/api-contracts';
import {
  type DeliveryMetadata,
  type DeliveryState,
  estimateCostUsd,
  sumUsage,
  type TokenUsage,
} from '@kouro/domain';
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  createRun,
  controlInvocation,
  controlRun,
  decideApproval,
  deleteRun,
  fetchApprovals,
  fetchArtifact,
  fetchArtifacts,
  fetchInvocationActivity,
  fetchRepositories,
  fetchRun,
  fetchRuns,
  fetchTicket,
  fetchTicketProjects,
  fetchTicketProviderConfigurations,
  fetchTickets,
  publishRun,
  reconnectEvents,
  type ReplayedEvent,
} from './api.ts';
import {
  approvalDiffArtifact,
  attemptCostUsd,
  formatByteSize,
  formatTokenCount,
  formatUsd,
  invocationDisplayState,
  invocationFailure,
  runCostUsd,
  runUsage,
} from './execution-presentation.ts';
import {
  invocationControlAvailability,
  preferredInvocationSequence,
} from './execution-controls.ts';
import { newIdempotencyKey } from './idempotency-key.ts';
import {
  runComparisonColumn,
  runComparisonWarnings,
  type RunComparisonColumn,
} from './run-comparison.ts';
import { timelineModel, type TimelineSubagentObservation } from './timeline.ts';
import {
  CodeViewer,
  MarkdownContent,
  structuredValueMarkdown,
} from './code-viewer.tsx';
import {
  diagramModeForStoredValue,
  type DiagramMode,
} from './diagram-preferences.ts';
import {
  groupTranscript,
  parseTranscript,
  type TranscriptEntry,
} from './transcript.ts';

type Tab = 'control' | 'details' | 'events' | 'artifacts' | 'approval';
type DiagramDirection = 'TB' | 'LR';

interface WorkspaceStyle extends CSSProperties {
  readonly '--inspector-height': string;
}

interface DrawerDrag {
  readonly pointerId: number;
  readonly startHeight: number;
  readonly startY: number;
}

interface WorkItemView {
  readonly provider: string;
  readonly reference: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly checksum: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formattedJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

function jsonMarkdown(text: string): string | undefined {
  try {
    return structuredValueMarkdown(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function workItemFor(run: RunDetails): WorkItemView | undefined {
  const value = run.state.configuration.workItem;
  if (
    !isRecord(value) ||
    typeof value.provider !== 'string' ||
    typeof value.reference !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    !Array.isArray(value.acceptanceCriteria) ||
    !value.acceptanceCriteria.every((criterion) => typeof criterion === 'string') ||
    typeof value.checksum !== 'string'
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    reference: value.reference,
    title: value.title,
    description: value.description,
    acceptanceCriteria: value.acceptanceCriteria,
    checksum: value.checksum,
  };
}

function stateClass(state: string): string {
  return `state state-${state.replaceAll('_', '-')}`;
}

function isTerminalRun(run: RunSummary): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(run.status);
}

function repositoryName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

interface WorkflowNodeData extends Record<string, unknown> {
  readonly title: string;
  readonly nodeType: WorkflowNodeView['type'] | 'subagent';
  readonly state: string;
  readonly direction: DiagramDirection;
  readonly usageLabel?: string;
  readonly parentNodeId?: string;
}

type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>;

function WorkflowGraphNode({ data }: NodeProps<WorkflowFlowNode>) {
  const horizontal = data.direction === 'LR';
  return (
    <div className={`flow-node flow-node-${data.nodeType}`}>
      <Handle position={horizontal ? Position.Left : Position.Top} type="target" />
      <small>{data.nodeType}</small>
      <strong>{data.title}</strong>
      <span className={stateClass(data.state)}>{data.state}</span>
      {data.usageLabel ? <small className="flow-node-usage">{data.usageLabel}</small> : null}
      <Handle position={horizontal ? Position.Right : Position.Bottom} type="source" />
    </div>
  );
}

const workflowNodeTypes = { workflow: WorkflowGraphNode };

interface WorkflowEdgeData extends Record<string, unknown> {
  readonly direction: DiagramDirection;
  readonly label: string;
  readonly labelOffset: number;
  readonly selected: boolean;
}

type WorkflowFlowEdge = Edge<WorkflowEdgeData, 'workflow'>;

function WorkflowGraphEdge({
  data,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<WorkflowFlowEdge>) {
  if (!data) return null;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });
  const xOffset = data.direction === 'TB' ? data.labelOffset : 0;
  const yOffset = data.direction === 'LR' ? data.labelOffset : 0;
  return (
    <>
      <BaseEdge markerEnd={markerEnd} path={path} style={style} />
      <EdgeLabelRenderer>
        <span
          className={`flow-edge-label${data.selected ? ' selected' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX + xOffset}px, ${labelY + yOffset}px)`,
          }}
        >
          {data.label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

const workflowEdgeTypes = { workflow: WorkflowGraphEdge };

function graphDepths(run: RunDetails): ReadonlyMap<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const edge of run.edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const depths = new Map<string, number>([[run.entryNodeId, 0]]);
  const queue = [run.entryNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    if (source === undefined) continue;
    const depth = depths.get(source) ?? 0;
    for (const target of outgoing.get(source) ?? []) {
      if (depths.has(target)) continue;
      depths.set(target, depth + 1);
      queue.push(target);
    }
  }
  const fallbackDepth = Math.max(0, ...depths.values()) + 1;
  for (const node of run.nodes) {
    if (!depths.has(node.id)) depths.set(node.id, fallbackDepth);
  }
  return depths;
}

function executionUsageLabel(
  executions: readonly { readonly usage?: TokenUsage; readonly model?: string }[],
): string | undefined {
  const reported = executions.filter(
    (execution): execution is typeof execution & { readonly usage: TokenUsage } =>
      execution.usage !== undefined,
  );
  if (reported.length === 0) return undefined;
  const usage = sumUsage(reported.map((execution) => execution.usage));
  const costs = reported.map((execution) => estimateCostUsd(execution.usage, execution.model));
  const cost = costs.every((candidate): candidate is number => candidate !== undefined)
    ? costs.reduce((total, candidate) => total + candidate, 0)
    : undefined;
  return `${formatTokenCount(usage.inputTokens + usage.outputTokens)} tok · ${cost === undefined ? 'unpriced' : `${formatUsd(cost)} est.`}`;
}

function workflowNodeUsageLabel(run: RunDetails, nodeId: string): string | undefined {
  return executionUsageLabel(
    run.state.invocations
      .filter((invocation) => invocation.nodeId === nodeId)
      .flatMap(({ attempts }) => attempts),
  );
}

interface DiagramSubagent {
  readonly id: string;
  readonly parentNodeId: string;
  readonly definition: WorkflowSubagentView;
}

function diagramSubagents(run: RunDetails): readonly DiagramSubagent[] {
  return (run.subagents ?? []).flatMap((definition) =>
    definition.parentNodeIds.map((parentNodeId) => ({
      id: `subagent:${parentNodeId}:${definition.id}`,
      parentNodeId,
      definition,
    })),
  );
}

function subagentExecutions(run: RunDetails, child: DiagramSubagent) {
  return run.state.invocations
    .filter(({ nodeId }) => nodeId === child.parentNodeId)
    .flatMap(({ attempts }) => attempts)
    .flatMap(({ subagents }) => subagents ?? [])
    .filter(({ subagentId }) => subagentId === child.definition.id);
}

function subagentState(run: RunDetails, child: DiagramSubagent): string {
  return subagentExecutions(run, child).at(-1)?.state ?? 'declared';
}

function flowchartNodes(
  run: RunDetails,
  direction: DiagramDirection,
): WorkflowFlowNode[] {
  const depths = graphDepths(run);
  const layers = new Map<number, WorkflowNodeView[]>();
  for (const node of run.nodes) {
    const depth = depths.get(node.id) ?? 0;
    const layer = layers.get(depth) ?? [];
    layer.push(node);
    layers.set(depth, layer);
  }
  const widestLayer = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const crossAxisGap = 270;
  const depthGap = 180;
  const workflowNodes: WorkflowFlowNode[] = [...layers.entries()].flatMap(([depth, layer]) => {
    const sorted = layer.toSorted((left, right) => left.ordinal - right.ordinal);
    const offset = ((widestLayer - sorted.length) * crossAxisGap) / 2;
    return sorted.map((node, index) => ({
      id: node.id,
      type: 'workflow' as const,
      position:
        direction === 'TB'
          ? { x: offset + index * crossAxisGap, y: depth * depthGap }
          : { x: depth * crossAxisGap, y: offset + index * depthGap },
      data: {
        title: node.title,
        nodeType: node.type,
        state: nodeState(run, node),
        usageLabel: workflowNodeUsageLabel(run, node.id),
        direction,
      },
    }));
  });
  const byId = new Map(workflowNodes.map((node) => [node.id, node]));
  const children = diagramSubagents(run);
  const childCounts = new Map<string, number>();
  for (const child of children) {
    childCounts.set(child.parentNodeId, (childCounts.get(child.parentNodeId) ?? 0) + 1);
  }
  const childIndexes = new Map<string, number>();
  const subagentNodes = children.flatMap((child) => {
    const parent = byId.get(child.parentNodeId);
    if (!parent) return [];
    const index = childIndexes.get(child.parentNodeId) ?? 0;
    childIndexes.set(child.parentNodeId, index + 1);
    const count = childCounts.get(child.parentNodeId) ?? 1;
    const crossOffset = (index - (count - 1) / 2) * 190;
    const executions = subagentExecutions(run, child);
    return [{
      id: child.id,
      type: 'workflow' as const,
      position:
        direction === 'TB'
          ? { x: parent.position.x + crossOffset, y: parent.position.y + 98 }
          : { x: parent.position.x + 150, y: parent.position.y + crossOffset },
      selectable: false,
      data: {
        title: child.definition.role,
        nodeType: 'subagent' as const,
        state: subagentState(run, child),
        direction,
        usageLabel: executionUsageLabel(executions),
        parentNodeId: child.parentNodeId,
      },
    }];
  });
  return [...workflowNodes, ...subagentNodes];
}

function nodeState(run: RunDetails, node: WorkflowNodeView): string {
  const latest = run.state.invocations.filter(({ nodeId }) => nodeId === node.id).at(-1);
  if (!latest) return 'pending';
  return displayedInvocationState(run, node, latest);
}

function displayedInvocationState(
  run: RunDetails,
  node: WorkflowNodeView,
  invocation: RunDetails['state']['invocations'][number],
): string {
  if (node.type === 'complete' && invocation.state === 'pending' && isTerminalRun(run)) {
    return run.status;
  }
  return invocationDisplayState(invocation);
}

function flowEdges(run: RunDetails, direction: DiagramDirection): WorkflowFlowEdge[] {
  const selectedTransitions = new Set(
    run.state.invocations.flatMap(({ selectedTransitionId }) =>
      selectedTransitionId ? [selectedTransitionId] : [],
    ),
  );
  const activeNodes = new Set(
    run.nodes
      .filter(({ latestState }) => ['active', 'waiting_for_approval'].includes(latestState ?? ''))
      .map(({ id }) => id),
  );
  const outgoingCounts = new Map<string, number>();
  for (const edge of run.edges) {
    outgoingCounts.set(edge.source, (outgoingCounts.get(edge.source) ?? 0) + 1);
  }
  const sourceCounts = new Map<string, number>();
  const workflowEdges: WorkflowFlowEdge[] = run.edges.map((edge) => {
    const siblingIndex = sourceCounts.get(edge.source) ?? 0;
    sourceCounts.set(edge.source, siblingIndex + 1);
    const siblingCount = outgoingCounts.get(edge.source) ?? 1;
    const labelOffset = (siblingIndex - (siblingCount - 1) / 2) * 30;
    const selected = selectedTransitions.has(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'workflow' as const,
      animated: activeNodes.has(edge.source),
      data: {
        direction,
        label: edge.outcome,
        labelOffset,
        selected,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: selected ? '#2f81f7' : '#6e7681',
      },
      style: {
        stroke: selected ? '#2f81f7' : '#6e7681',
        strokeWidth: selected ? 2.5 : 1.5,
      },
    };
  });
  const subagentEdges: WorkflowFlowEdge[] = diagramSubagents(run).map((child) => ({
    id: `delegates:${child.parentNodeId}:${child.definition.id}`,
    source: child.parentNodeId,
    target: child.id,
    type: 'workflow',
    animated: activeNodes.has(child.parentNodeId),
    data: {
      direction,
      label: 'delegates',
      labelOffset: 0,
      selected: false,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#8957e5' },
    style: { stroke: '#8957e5', strokeDasharray: '5 4', strokeWidth: 1.5 },
  }));
  return [...workflowEdges, ...subagentEdges];
}

interface TimelineStyle extends CSSProperties {
  readonly '--timeline-track-min': string;
}

function timelineUsageLabel(block: ReturnType<typeof timelineModel>['lanes'][number]['blocks'][number]): string | undefined {
  if (!block.usage) return undefined;
  const tokens = formatTokenCount(block.usage.inputTokens + block.usage.outputTokens);
  return `${tokens} tok · ${block.costUsd === undefined ? 'unpriced' : `${formatUsd(block.costUsd)} est.`}`;
}

function timelineSubagentObservations(
  activities: Readonly<Record<number, InvocationActivityView>>,
): readonly TimelineSubagentObservation[] {
  return Object.values(activities).flatMap((activity) =>
    parseTranscript(activity.transcript).flatMap((entry) => {
      if (entry.kind !== 'subagent' || !entry.callId || !entry.subagentId) return [];
      const state =
        entry.status === 'failed'
          ? ('failed' as const)
          : entry.status === 'completed'
            ? ('succeeded' as const)
            : ('active' as const);
      return [{
        invocationSequence: activity.invocationSequence,
        attemptNumber: activity.attemptNumber,
        nodeId: activity.nodeId,
        callId: entry.callId,
        subagentId: entry.subagentId,
        state,
        ...(entry.harnessId ? { harnessId: entry.harnessId } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.usage ? { usage: entry.usage } : {}),
      }];
    }),
  );
}

function RunTimeline({
  activities,
  run,
  selectedNodeId,
  onSelectNode,
}: {
  readonly activities: Readonly<Record<number, InvocationActivityView>>;
  readonly run: RunDetails;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
}) {
  const observations = useMemo(() => timelineSubagentObservations(activities), [activities]);
  const model = useMemo(() => timelineModel(run, observations), [observations, run]);
  if (model.tickCount === 0) {
    return (
      <div className="timeline">
        <p className="timeline-empty">No invocation has been activated yet.</p>
      </div>
    );
  }
  const tickPercent = 100 / model.tickCount;
  const ticks = Array.from({ length: model.tickCount }, (_, index) => index + 1);
  const timelineStyle: TimelineStyle = {
    '--timeline-track-min': `${Math.max(480, model.tickCount * 156)}px`,
  };
  return (
    <div className="timeline" style={timelineStyle}>
      <div className="timeline-scroll">
        <header className="timeline-header">
          <span className="timeline-lane-heading">Node · lane</span>
          <div className="timeline-axis">
            {ticks.map((tick) => (
              <span
                className="timeline-tick"
                key={tick}
                style={{ left: `${((tick - 1) * tickPercent).toFixed(3)}%` }}
              >
                {tick}
              </span>
            ))}
            <span className="timeline-tick timeline-tick-end" style={{ left: '100%' }}>
              end
            </span>
          </div>
        </header>
        {model.lanes.map((lane) => (
          <section className={`timeline-lane timeline-lane-${lane.kind}`} key={lane.laneId}>
            <button
              aria-pressed={selectedNodeId === lane.nodeId}
              className={selectedNodeId === lane.nodeId ? 'timeline-lane-label selected' : 'timeline-lane-label'}
              onClick={() => onSelectNode(lane.nodeId)}
              title={`${lane.nodeType} · ${lane.title}`}
              type="button"
            >
              <small>{lane.kind === 'subagent' ? 'subagent · child' : lane.nodeType}</small>
              <strong>{lane.title}</strong>
              <span>
                {lane.blocks.length} {lane.kind === 'subagent' ? 'call' : 'invocation'}
                {lane.blocks.length === 1 ? '' : 's'}
              </span>
            </button>
            <div
              className="timeline-lane-tracks"
              style={{ minHeight: `${lane.rowCount * 40 + 4}px` }}
            >
              {lane.blocks.map((block) => (
                <button
                  aria-pressed={selectedNodeId === block.nodeId}
                  className={`timeline-block timeline-block-${block.kind}${block.queued ? ' queued' : ''}${selectedNodeId === block.nodeId ? ' selected' : ''}`}
                  key={block.id}
                  onClick={() => onSelectNode(block.nodeId)}
                  style={{
                    left: `${((block.invocationSequence - 1) * tickPercent).toFixed(3)}%`,
                    width: `${tickPercent.toFixed(3)}%`,
                    top: `${block.row * 40 + 5}px`,
                    bottom: 'auto',
                    height: '34px',
                  }}
                  title={`#${block.invocationSequence} · ${block.state} · ${block.attemptCount} attempt${block.attemptCount === 1 ? '' : 's'}${block.model ? ` · ${block.model}` : ''}${block.usage ? ` · ${formatTokenCount(block.usage.inputTokens + block.usage.outputTokens)} tokens` : ''}${block.costUsd !== undefined ? ` · ${formatUsd(block.costUsd)} est.` : ''}`}
                  type="button"
                >
                  <span className={`timeline-block-fill state-${block.state.replaceAll('_', '-')}`} />
                  <span className="timeline-block-label">
                    <span>
                      #{block.invocationSequence}
                      {block.kind === 'subagent'
                        ? ` · ${block.callId ?? block.subagentId ?? 'child'}`
                        : block.attemptCount > 0
                          ? ` · ×${block.attemptCount}`
                          : ''}
                    </span>
                    {timelineUsageLabel(block) ? <small>{timelineUsageLabel(block)}</small> : null}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <footer className="timeline-legend">
        <span>Horizontal order is the durable activation sequence, not wall-clock time.</span>
        <span className="timeline-legend-swatch state-succeeded">succeeded</span>
        <span className="timeline-legend-swatch state-active">active</span>
        <span className="timeline-legend-swatch state-waiting-for-approval">waiting</span>
        <span className="timeline-legend-swatch state-failed">failed</span>
        <span className="timeline-legend-swatch queued">queued</span>
      </footer>
    </div>
  );
}

function RunCostStat({ run }: { readonly run: RunDetails }) {
  const usage = runUsage(run);
  if (!usage) return null;
  const cost = runCostUsd(run);
  return (
    <div className="run-stat run-stat-cost">
      <span>{cost !== undefined ? formatUsd(cost) : 'unpriced'}</span>
      <small>
        {formatTokenCount(usage.inputTokens + usage.outputTokens)} tokens est.
      </small>
    </div>
  );
}

function RunList({
  runs,
  selected,
  comparisonSelection,
  comparisonBusy,
  onSelect,
  onToggleComparison,
  onCompare,
}: {
  readonly runs: readonly RunSummary[];
  readonly selected?: string;
  readonly comparisonSelection: ReadonlySet<string>;
  readonly comparisonBusy: boolean;
  readonly onSelect: (id: string) => void;
  readonly onToggleComparison: (id: string) => void;
  readonly onCompare: () => void;
}) {
  return (
    <aside className="run-list">
      <header>
        <p className="eyebrow">Current repository</p>
        <h1>Workflow runs</h1>
      </header>
      <div className="run-list-heading">
        <span>Runs</span>
        <div className="run-list-actions">
          <button
            disabled={comparisonBusy || comparisonSelection.size < 2}
            onClick={onCompare}
            type="button"
          >
            Compare {comparisonSelection.size > 0 ? comparisonSelection.size : ''}
          </button>
          <span className="count">{runs.length}</span>
        </div>
      </div>
      <nav>
        {runs.map((run) => {
          const included = comparisonSelection.has(run.id);
          return (
            <div className="run-list-item" key={run.id}>
              <button
                className={run.id === selected ? 'run selected' : 'run'}
                onClick={() => onSelect(run.id)}
                type="button"
              >
                <span className="run-name">{run.id}</span>
                <span className="run-meta">
                  {repositoryName(run.repositoryPath)} · {run.workflowId}
                </span>
                <span className={stateClass(run.status)}>{run.status}</span>
              </button>
              <button
                aria-label={`${included ? 'Remove' : 'Add'} ${run.id} ${included ? 'from' : 'to'} comparison`}
                aria-pressed={included}
                className={`run-compare-toggle${included ? ' selected' : ''}`}
                onClick={() => onToggleComparison(run.id)}
                title={included ? 'Remove from comparison' : 'Add to comparison'}
                type="button"
              >
                {included ? '✓' : '+'}
              </button>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function comparisonMetric(
  columns: readonly RunComparisonColumn[],
  label: string,
  value: (column: RunComparisonColumn) => ReactNode,
) {
  return (
    <tr key={label}>
      <th scope="row">{label}</th>
      {columns.map((column) => <td key={column.runId}>{value(column)}</td>)}
    </tr>
  );
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return '—';
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function comparisonUsage(column: RunComparisonColumn): string {
  return column.usage
    ? `${formatTokenCount(column.usage.inputTokens + column.usage.outputTokens)} tokens`
    : '—';
}

function comparisonEvaluation(column: RunComparisonColumn): ReactNode {
  const evaluation = column.evaluation;
  if (!evaluation) return '—';
  return (
    <span className={stateClass(evaluation.status)}>
      {evaluation.status} · {evaluation.passedChecks}/{evaluation.totalChecks} checks
    </span>
  );
}

function comparisonHumanEvidence(column: RunComparisonColumn): string {
  const verdicts = column.evaluation?.humanVerdicts ?? [];
  return verdicts.length === 0 ? '—' : verdicts.join(', ');
}

function ComparisonOverview({ columns }: { readonly columns: readonly RunComparisonColumn[] }) {
  return (
    <div className="comparison-table-scroll">
      <table className="comparison-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            {columns.map((column) => <th scope="col" key={column.runId}>{column.runId}</th>)}
          </tr>
        </thead>
        <tbody>
          {comparisonMetric(columns, 'Status', (column) => <span className={stateClass(column.status)}>{column.status}</span>)}
          {comparisonMetric(columns, 'Workflow', (column) => column.workflowId)}
          {comparisonMetric(columns, 'Workflow checksum', (column) => <code>{column.workflowChecksum.slice(0, 19)}…</code>)}
          {comparisonMetric(columns, 'Starting commit', (column) => <code>{column.startingCommit.slice(0, 12)}</code>)}
          {comparisonMetric(columns, 'Observed duration', (column) => formatDuration(column.durationMs))}
          {comparisonMetric(columns, 'Invocations', (column) => column.invocationCount)}
          {comparisonMetric(columns, 'Attempts', (column) => column.attemptCount)}
          {comparisonMetric(columns, 'Subagent calls', (column) => column.subagentCallCount)}
          {comparisonMetric(columns, 'Reported usage', comparisonUsage)}
          {comparisonMetric(columns, 'Estimated cost', (column) => column.usage ? column.costUsd === undefined ? 'unpriced' : formatUsd(column.costUsd) : '—')}
          {comparisonMetric(columns, 'Evaluation', comparisonEvaluation)}
          {comparisonMetric(columns, 'Dataset case', (column) => column.evaluation ? `${column.evaluation.datasetId}@${column.evaluation.datasetVersion} · ${column.evaluation.caseId}` : '—')}
          {comparisonMetric(columns, 'Experiment', (column) => column.evaluation?.experimentId ?? '—')}
          {comparisonMetric(columns, 'Human evidence', comparisonHumanEvidence)}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonExecutionValue({ column, executionKey }: { readonly column: RunComparisonColumn; readonly executionKey: string }) {
  const execution = column.executions.find(({ key }) => key === executionKey);
  if (!execution) return <>—</>;
  const tokens = execution.usage
    ? `${formatTokenCount(execution.usage.inputTokens + execution.usage.outputTokens)} tok`
    : 'no usage';
  const cost = execution.usage
    ? execution.costUsd === undefined ? 'unpriced' : formatUsd(execution.costUsd)
    : '—';
  return (
    <span className="comparison-execution-value">
      <strong>{execution.count} {execution.kind === 'agent' ? 'invocations' : 'calls'}</strong>
      <small>{execution.failedCount} failed · {tokens} · {cost}</small>
    </span>
  );
}

function ComparisonBreakdown({ columns }: { readonly columns: readonly RunComparisonColumn[] }) {
  const executions = columns.flatMap((column) => column.executions);
  const executionKeys = [...new Set(executions.map(({ key }) => key))].toSorted();
  return (
    <section className="comparison-breakdown">
      <header>
        <p className="eyebrow">Execution breakdown</p>
        <h3>Agents and subordinate calls</h3>
      </header>
      <div className="comparison-table-scroll">
        <table className="comparison-table comparison-executions">
          <thead>
            <tr>
              <th scope="col">Role</th>
              {columns.map((column) => <th scope="col" key={column.runId}>{column.runId}</th>)}
            </tr>
          </thead>
          <tbody>
            {executionKeys.map((key) => (
              <tr key={key}>
                <th scope="row">{executions.find((execution) => execution.key === key)?.label ?? key}</th>
                {columns.map((column) => (
                  <td key={column.runId}><ComparisonExecutionValue column={column} executionKey={key} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RunComparisonModal({ runs, onClose }: { readonly runs: readonly RunDetails[]; readonly onClose: () => void }) {
  const columns = runs.map(runComparisonColumn);
  const warnings = runComparisonWarnings(runs);
  return (
    <InspectorModal contentClassName="run-comparison-content" metadata={`${runs.length} durable runs · read-only projection`} modalClassName="run-comparison-dialog" onClose={onClose} title="Run comparison">
      {warnings.length > 0 ? (
        <div className="comparison-warning"><strong>Inputs are not identical</strong><span>{warnings.join(' ')}</span></div>
      ) : (
        <div className="comparison-compatible">Comparable repository, commit, workflow, and work item.</div>
      )}
      <ComparisonOverview columns={columns} />
      <ComparisonBreakdown columns={columns} />
      <p className="comparison-footnote">Deterministic checks and human evidence remain separate. Cost is shown only when every reported source in that total has known pricing.</p>
    </InspectorModal>
  );
}

type InvocationAction = 'steer' | 'interrupt' | 'retry' | 'skip';

function OperatorConsole({
  activities,
  busy,
  run,
  selectedNodeId,
  onAction,
  onOpenActivity,
}: {
  readonly activities: Readonly<Record<number, InvocationActivityView>>;
  readonly busy: boolean;
  readonly run: RunDetails;
  readonly selectedNodeId: string | null;
  readonly onAction: (
    invocationSequence: number,
    action: InvocationAction,
    value: string,
  ) => Promise<boolean>;
  readonly onOpenActivity: (invocationSequence: number) => void;
}) {
  const preferred = preferredInvocationSequence(run, selectedNodeId);
  const [invocationSequence, setInvocationSequence] = useState<number | null>(preferred);
  const [reason, setReason] = useState('');
  useEffect(() => setInvocationSequence(preferred), [preferred, run.id]);

  const invocation =
    run.state.invocations.find(({ sequence }) => sequence === invocationSequence) ??
    run.state.invocations.at(-1);
  const node = run.nodes.find(({ id }) => id === invocation?.nodeId);
  const attempt = invocation?.attempts.at(-1);

  async function submit(action: InvocationAction, value: string): Promise<void> {
    if (!invocation || !value.trim()) return;
    const completed = await onAction(invocation.sequence, action, value.trim());
    if (!completed) return;
    setReason('');
  }

  if (!invocation) {
    return <p className="empty">No invocation is available to control yet.</p>;
  }
  const { steerable, interruptible, retryable, skippable } = invocationControlAvailability(
    run,
    invocation.sequence,
  );
  const activityAvailable = activities[invocation.sequence] !== undefined;

  return (
    <div className="operator-console">
      <section className="control-target">
        <div>
          <span className="field-label">Target invocation</span>
          <strong>{node?.title ?? invocation.nodeId}</strong>
          <small>
            {node?.type ?? 'node'} · attempt {attempt?.number ?? 'not started'}
          </small>
        </div>
        <label>
          Invocation
          <select
            onChange={(event) => setInvocationSequence(Number(event.target.value))}
            value={invocation.sequence}
          >
            {run.state.invocations
              .toReversed()
              .map((candidate) => (
                <option key={candidate.sequence} value={candidate.sequence}>
                  #{candidate.sequence} · {candidate.nodeId} · {candidate.state}
                </option>
              ))}
          </select>
        </label>
        <span className={stateClass(invocation.state)}>{invocation.state}</span>
      </section>

      <section className="agent-session-card">
        <header>
          <div>
            <span className="field-label">Agent session</span>
            <h3>{node?.type === 'agent' ? 'Follow and guide the active turn' : 'No agent turn'}</h3>
          </div>
          <span className={steerable ? 'connection-live' : 'connection-idle'}>
            {steerable ? 'live' : invocation.state.replaceAll('_', ' ')}
          </span>
        </header>
        <p>
          Open the coding-agent session to watch reasoning, tool calls, and results while adding
          steering in context.
        </p>
        <div className="session-actions">
          <small>Invocation #{invocation.sequence} · {attempt?.harnessId ?? 'native'}</small>
          <button
            className="primary-button"
            disabled={node?.type !== 'agent' || !activityAvailable || busy}
            onClick={() => onOpenActivity(invocation.sequence)}
            type="button"
          >
            {activityAvailable
              ? steerable
                ? 'Open live session'
                : 'View agent session'
              : 'Waiting for stream'}
          </button>
        </div>
      </section>

      <section className="recovery-console">
        <label>
          Operator reason
          <input
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required for interrupt, retry, or skip"
            value={reason}
          />
        </label>
        <div className="recovery-actions">
          <button
            className="danger-button"
            disabled={!interruptible || busy || !reason.trim()}
            onClick={() => void submit('interrupt', reason)}
            type="button"
          >
            Interrupt attempt
          </button>
          <button
            disabled={!retryable || busy || !reason.trim()}
            onClick={() => void submit('retry', reason)}
            type="button"
          >
            Retry invocation
          </button>
          <button
            disabled={!skippable || busy || !reason.trim()}
            onClick={() => void submit('skip', reason)}
            title={node?.skipOutcome ? `Select outcome ${node.skipOutcome}` : 'Node is not skippable'}
            type="button"
          >
            Skip{node?.skipOutcome ? ` → ${node.skipOutcome}` : ''}
          </button>
        </div>
      </section>
    </div>
  );
}

function AttemptUsage({
  run,
  invocationSequence,
  attemptNumber,
}: {
  readonly run: RunDetails;
  readonly invocationSequence: number;
  readonly attemptNumber: number;
}) {
  const invocation = run.state.invocations.find(({ sequence }) => sequence === invocationSequence);
  const attempt = invocation?.attempts.find(({ number }) => number === attemptNumber);
  const usage = attempt?.usage;
  if (!usage) return null;
  const cost = attemptCostUsd(run, invocationSequence, attemptNumber);
  const parts = [
    `${formatTokenCount(usage.inputTokens)} in`,
    `${formatTokenCount(usage.outputTokens)} out`,
    ...(usage.cacheReadTokens !== undefined ? [`${formatTokenCount(usage.cacheReadTokens)} cache`] : []),
    ...(usage.cacheWriteTokens !== undefined
      ? [`${formatTokenCount(usage.cacheWriteTokens)} cache write`]
      : []),
    ...(usage.reasoningTokens !== undefined ? [`${formatTokenCount(usage.reasoningTokens)} reasoning`] : []),
  ];
  return (
    <span className="attempt-usage">
      {parts.join(' · ')}
      {cost !== undefined ? ` · ${formatUsd(cost)} est.` : ''}
    </span>
  );
}

function NodeDetails({
  node,
  run,
  artifacts,
  activities,
  onOpenActivity,
  onOpenArtifact,
}: {
  readonly node: WorkflowNodeView | null;
  readonly run: RunDetails;
  readonly artifacts: readonly ArtifactView[];
  readonly activities: Readonly<Record<number, InvocationActivityView>>;
  readonly onOpenActivity: (invocationSequence: number) => void;
  readonly onOpenArtifact: (artifact: ArtifactView) => void;
}) {
  if (!node) return <p className="empty">Select a node to inspect its durable execution state.</p>;
  const invocations = run.state.invocations.filter(({ nodeId }) => nodeId === node.id);
  const workItem = workItemFor(run);
  return (
    <div className="detail-stack">
      {workItem ? (
        <article className="definition work-item">
          <span className="node-type">
            {workItem.provider} · {workItem.reference}
          </span>
          <h3>{workItem.title}</h3>
          <p>{workItem.description}</p>
          {workItem.acceptanceCriteria.length > 0 ? (
            <ul>
              {workItem.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          ) : null}
          <small>{workItem.checksum}</small>
        </article>
      ) : null}
      <div className="definition">
        <span className="node-type">{node.type}</span>
        <h3>{node.title}</h3>
        <p>{invocations.length} invocation(s)</p>
      </div>
      {invocations.map((invocation) => (
        <article className="invocation" key={invocation.sequence}>
          <div className="invocation-header">
            <strong>Invocation {invocation.sequence}</strong>
            <span className={stateClass(displayedInvocationState(run, node, invocation))}>
              {displayedInvocationState(run, node, invocation)}
            </span>
          </div>
          <p>
            Outcome:{' '}
            {node.type === 'complete' && isTerminalRun(run)
              ? run.status
              : (invocation.outcome ?? 'pending')}
          </p>
          {invocation.attempts.map((attempt) => (
            <div className="attempt" key={attempt.number}>
              <p>
                Attempt {attempt.number} · {attempt.harnessId ?? 'native'}
                {attempt.model ? ` · ${attempt.model}` : ''} ·{' '}
                {invocation.outcome === 'failure' ? 'failed' : attempt.state}
              </p>
              <AttemptUsage
                attemptNumber={attempt.number}
                invocationSequence={invocation.sequence}
                run={run}
              />
              {attempt.failure ? (
                <div className="invocation-failure">
                  <strong>{attempt.failure.kind.replaceAll('_', ' ')}</strong>
                  <p>{attempt.failure.message}</p>
                </div>
              ) : null}
            </div>
          ))}
          <InvocationFailureDetails invocation={invocation} />
          {activities[invocation.sequence] ? (
            <button
              className="activity-button"
              onClick={() => onOpenActivity(invocation.sequence)}
              type="button"
            >
              <span className={invocation.state === 'active' ? 'live-dot' : ''} />
              {invocation.state === 'active' ? 'Watch live activity' : 'View activity'}
            </button>
          ) : null}
          <InvocationOutputSection
            artifacts={artifacts}
            invocationSequence={invocation.sequence}
            onOpen={onOpenArtifact}
          />
        </article>
      ))}
    </div>
  );
}

function InvocationFailureDetails({
  invocation,
}: {
  readonly invocation: RunDetails['state']['invocations'][number];
}) {
  if (invocation.attempts.some(({ failure }) => failure !== undefined)) return null;
  const failure = invocationFailure(invocation);
  if (!failure) return null;
  return (
    <div className="invocation-failure">
      <strong>{failure.kind}</strong>
      <p>{failure.message}</p>
    </div>
  );
}

function EventLog({ events }: { readonly events: readonly ReplayedEvent[] }) {
  if (events.length === 0) return <p className="empty">No replayed events yet.</p>;
  return (
    <ol className="event-log">
      {events.map((event) => (
        <li key={event.id}>
          <span>{event.id}</span>
          <strong>{event.event}</strong>
          <code>{JSON.stringify(event.data)}</code>
        </li>
      ))}
    </ol>
  );
}

function entryLabel(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
      return 'User';
    case 'agent':
      return 'Agent';
    case 'reasoning':
      return 'Reasoning';
    case 'tool_call':
      return entry.toolName ? `Tool call · ${entry.toolName}` : 'Tool call';
    case 'tool_result':
      return entry.toolName ? `Tool result · ${entry.toolName}` : 'Tool result';
    case 'subagent':
      return entry.subagentId ? `Subagent · ${entry.subagentId}` : 'Subagent';
  }
  return 'Activity';
}

function TranscriptCard({
  entry,
  nested = false,
}: {
  readonly entry: TranscriptEntry;
  readonly nested?: boolean;
}) {
  const markdown = jsonMarkdown(entry.text);
  const shellInput = entry.kind === 'tool_call' && entry.toolName === 'shell';
  const subagentCostUsd =
    entry.kind === 'subagent' && entry.usage
      ? estimateCostUsd(entry.usage, entry.model)
      : undefined;
  return (
    <article className={`message message-${entry.kind}${nested ? ' message-nested' : ''}`}>
      <header>
        <span className="message-role">{entryLabel(entry)}</span>
        {entry.callId ? <code className="call-id">{entry.callId}</code> : null}
        {entry.status ? <span className="tool-status">{entry.status}</span> : null}
      </header>
      <div className="message-text">
        {entry.kind === 'subagent' ? (
          <div className="subagent-session">
            <dl>
              {entry.harnessId ? (
                <>
                  <dt>Harness</dt>
                  <dd>{entry.harnessId}</dd>
                </>
              ) : null}
              {entry.model ? (
                <>
                  <dt>Model</dt>
                  <dd>{entry.model}</dd>
                </>
              ) : null}
              {entry.reasoningEffort ? (
                <>
                  <dt>Effort</dt>
                  <dd>{entry.reasoningEffort}</dd>
                </>
              ) : null}
              {entry.usage ? (
                <>
                  <dt>Usage</dt>
                  <dd>
                    {formatTokenCount(entry.usage.inputTokens + entry.usage.outputTokens)} tokens
                    {' · '}
                    {subagentCostUsd === undefined
                      ? 'unpriced'
                      : `${formatUsd(subagentCostUsd)} est.`}
                  </dd>
                </>
              ) : null}
            </dl>
            {entry.task ? (
              <section>
                <span className="field-label">Delegated task</span>
                <MarkdownContent content={entry.task} />
              </section>
            ) : null}
            {entry.childTranscript ? (
              <details open>
                <summary>Subagent session</summary>
                <TranscriptViewer content={entry.childTranscript} userPrompt={entry.task} />
              </details>
            ) : null}
            <section>
              <span className="field-label">
                {entry.status === 'failed'
                  ? 'Failure'
                  : entry.status === 'running'
                    ? 'Status'
                    : 'Structured output'}
              </span>
              <MarkdownContent content={markdown ?? entry.text} />
            </section>
          </div>
        ) : shellInput ? (
          <CodeViewer
            compact
            content={entry.text}
            label="command"
            language="shell"
          />
        ) : (
          <MarkdownContent content={markdown ?? entry.text} />
        )}
      </div>
    </article>
  );
}

function TranscriptViewer({
  content,
  userPrompt,
}: {
  readonly content: string;
  readonly userPrompt?: string;
}) {
  const groups = useMemo(
    () => groupTranscript(parseTranscript(content, userPrompt)),
    [content, userPrompt],
  );
  if (groups.length === 0) {
    return <CodeViewer content={content} label="transcript.ndjson" language="json" />;
  }
  return (
    <div className="transcript-viewer">
      {groups.map(({ primary, results }) => (
        <section className="transcript-group" key={primary.id}>
          <TranscriptCard entry={primary} />
          {results.length > 0 ? (
            <div className="tool-results">
              {results.map((result) => (
                <TranscriptCard entry={result} key={result.id} nested />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function AgentOutputViewer({ content }: { readonly content: string }) {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(content);
    if (isRecord(value)) parsed = value;
  } catch {
    // fall through
  }
  if (!parsed) return <CodeViewer content={content} label="agent-output.txt" language="text" />;
  const result = typeof parsed.result === 'string' ? parsed.result : null;
  const output = 'structured_output' in parsed ? parsed.structured_output : null;
  return (
    <div className="agent-output-viewer">
      {result ? (
        <div className="output-field">
          <span className="field-label">Result</span>
          <div className="field-value">
            <MarkdownContent content={result} />
          </div>
        </div>
      ) : null}
      {output !== null && output !== undefined ? (
        <details>
          <summary>Structured output</summary>
          <CodeViewer
            content={JSON.stringify(output, null, 2)}
            label="structured-output.json"
            language="json"
          />
        </details>
      ) : null}
      <details open={!result}>
        <summary>Raw JSON</summary>
        <CodeViewer content={content} label="agent-output.json" language="json" />
      </details>
    </div>
  );
}

function ArtifactContent({
  artifact,
  userPrompt,
}: {
  readonly artifact: ArtifactView;
  readonly userPrompt?: string;
}) {
  if (artifact.content === undefined) return <p className="empty">No content available.</p>;
  const json = formattedJson(artifact.content);
  switch (artifact.kind) {
    case 'harness_transcript':
      return <TranscriptViewer content={artifact.content} userPrompt={userPrompt} />;
    case 'agent_output':
      return <AgentOutputViewer content={artifact.content} />;
    case 'command_output':
      return (
        <CodeViewer
          content={json ?? artifact.content}
          label={artifact.id}
          language={json ? 'json' : 'text'}
        />
      );
    case 'git_diff':
      return <CodeViewer content={artifact.content} label={artifact.id} language="diff" />;
    case 'git_status':
      return <CodeViewer content={artifact.content} label={artifact.id} language="text" />;
    default:
      return (
        <CodeViewer
          content={json ?? artifact.content}
          label={artifact.id}
          language={json ? 'json' : 'text'}
        />
      );
  }
}

function InvocationOutputSection({
  invocationSequence,
  artifacts,
  onOpen,
}: {
  readonly invocationSequence: number;
  readonly artifacts: readonly ArtifactView[];
  readonly onOpen: (artifact: ArtifactView) => void;
}) {
  const invocationArtifacts = artifacts.filter((a) => a.invocationSequence === invocationSequence);
  if (invocationArtifacts.length === 0) return null;
  return (
    <div className="invocation-output">
      {invocationArtifacts.map((artifact) => (
        <button key={artifact.id} onClick={() => onOpen(artifact)} type="button">
          <span>{artifact.kind.replaceAll('_', ' ')}</span>
          <small>{formatByteSize(artifact.size)} · open</small>
        </button>
      ))}
    </div>
  );
}

function InspectorModal({
  title,
  metadata,
  onClose,
  contentClassName,
  modalClassName,
  closeDisabled = false,
  children,
}: {
  readonly title: string;
  readonly metadata: string;
  readonly onClose: () => void;
  readonly contentClassName?: string;
  readonly modalClassName?: string;
  readonly closeDisabled?: boolean;
  readonly children: ReactNode;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !closeDisabled) onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [closeDisabled, onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !closeDisabled) onClose();
      }}
      role="presentation"
    >
      <section
        aria-modal="true"
        className={`inspector-modal${modalClassName ? ` ${modalClassName}` : ''}`}
        role="dialog"
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">{metadata}</p>
            <h2>{title}</h2>
          </div>
          <button
            aria-label="Close"
            className="modal-close"
            disabled={closeDisabled}
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>
        <div className={`modal-content${contentClassName ? ` ${contentClassName}` : ''}`}>
          {children}
        </div>
      </section>
    </div>
  );
}

function ActivityModal({
  activity,
  busy,
  interruptible,
  onClose,
  onAction,
  steerable,
}: {
  readonly activity: InvocationActivityView;
  readonly busy: boolean;
  readonly interruptible: boolean;
  readonly onClose: () => void;
  readonly onAction: (action: 'steer' | 'interrupt', value: string) => Promise<boolean>;
  readonly steerable: boolean;
}) {
  const [message, setMessage] = useState('');
  const [actionFailed, setActionFailed] = useState(false);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream && stickToBottomRef.current) stream.scrollTop = stream.scrollHeight;
  }, [activity.transcript]);

  async function submitSteering(): Promise<void> {
    const value = message.trim();
    if (!steerable || busy || !value) return;
    setActionFailed(false);
    const completed = await onAction('steer', value);
    if (completed) setMessage('');
    else setActionFailed(true);
  }

  async function interrupt(): Promise<void> {
    if (!interruptible || busy) return;
    setActionFailed(false);
    const completed = await onAction(
      'interrupt',
      'Interrupted by the operator from the live agent session',
    );
    if (!completed) setActionFailed(true);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitSteering();
  }

  return (
    <InspectorModal
      contentClassName="agent-session-content"
      metadata={`${activity.harnessId} · invocation ${activity.invocationSequence} · attempt ${activity.attemptNumber}`}
      onClose={onClose}
      title={activity.complete ? 'Agent session' : 'Agent session · live'}
    >
      <div className="agent-session">
        <div
          className="agent-session-stream"
          onScroll={(event) => {
            const stream = event.currentTarget;
            stickToBottomRef.current =
              stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
          }}
          ref={streamRef}
        >
          <TranscriptViewer content={activity.transcript} userPrompt={activity.prompt} />
        </div>
        <footer className="agent-composer">
          <div className="agent-composer-status">
            <span className={steerable ? 'connection-live' : 'connection-idle'}>
              {steerable ? 'ready for steering' : activity.complete ? 'turn complete' : 'read only'}
            </span>
            <small>Steering is durably bound to invocation {activity.invocationSequence}.</small>
          </div>
          <div className="composer-input">
            <textarea
              aria-label="Steering message"
              disabled={!steerable || busy}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                steerable
                  ? 'Add direction while the agent works…'
                  : 'This agent turn is not currently steerable.'
              }
              rows={3}
              value={message}
            />
            <div className="composer-actions">
              <button
                className="stop-button"
                disabled={!interruptible || busy}
                onClick={() => void interrupt()}
                type="button"
              >
                Stop
              </button>
              <button
                className="primary-button"
                disabled={!steerable || busy || !message.trim()}
                onClick={() => void submitSteering()}
                type="button"
              >
                Send
              </button>
            </div>
          </div>
          <div className="composer-hint">
            <small>Enter to send · Shift+Enter for a new line</small>
            {actionFailed ? <span>Control request failed. Check the run status and retry.</span> : null}
          </div>
        </footer>
      </div>
    </InspectorModal>
  );
}

function ArtifactModal({
  activity,
  artifact,
  onClose,
}: {
  readonly activity?: InvocationActivityView;
  readonly artifact: ArtifactView;
  readonly onClose: () => void;
}) {
  return (
    <InspectorModal
      metadata={[
        artifact.kind.replaceAll('_', ' '),
        artifact.invocationSequence ? `invocation ${artifact.invocationSequence}` : '',
        formatByteSize(artifact.size),
      ]
        .filter(Boolean)
        .join(' · ')}
      onClose={onClose}
      title={artifact.id}
    >
      <ArtifactContent artifact={artifact} userPrompt={activity?.prompt} />
    </InspectorModal>
  );
}

function Artifacts({
  artifacts,
  onOpen,
}: {
  readonly artifacts: readonly ArtifactView[];
  readonly onOpen: (artifact: ArtifactView) => void;
}) {
  return (
    <div className="artifact-layout">
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <button key={artifact.id} onClick={() => onOpen(artifact)} type="button">
            <strong>{artifact.kind.replaceAll('_', ' ')}</strong>
            <span>{artifact.id}</span>
            <small>
              {formatByteSize(artifact.size)}
              {artifact.invocationSequence
                ? ` · invocation ${artifact.invocationSequence}`
                : ''}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

function ApprovalControl({
  approval,
  busy,
  delivery,
  diffArtifact,
  onDecision,
}: {
  readonly approval: ApprovalView;
  readonly busy: boolean;
  readonly delivery?: DeliveryState;
  readonly diffArtifact?: ArtifactView;
  readonly onDecision: (
    decision: 'grant' | 'reject' | 'request_changes',
    reason: string,
    metadata?: DeliveryMetadata,
  ) => void;
}) {
  const [reason, setReason] = useState('');
  const [metadata, setMetadata] = useState(delivery?.proposal?.metadata);
  const [diff, setDiff] = useState<string>();
  const [diffError, setDiffError] = useState<string>();
  const [selectedFile, setSelectedFile] = useState(0);
  useEffect(() => {
    setMetadata(delivery?.proposal?.metadata);
  }, [delivery?.proposal?.checksum]);
  useEffect(() => {
    setDiff(undefined);
    setDiffError(undefined);
    setSelectedFile(0);
    if (!diffArtifact) {
      setDiff('');
      return;
    }
    void fetchArtifact(approval.runId, diffArtifact.id)
      .then((artifact) => setDiff(artifact.content ?? ''))
      .catch((cause: unknown) =>
        setDiffError(cause instanceof Error ? cause.message : 'The bound diff could not be read'),
      );
  }, [approval.runId, diffArtifact?.id]);
  const files = (diff ?? '')
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith('diff --git '));
  const activeDiff = files[selectedFile] ?? diff ?? '';
  const activeFile =
    files[selectedFile]?.match(/^diff --git a\/(.+?) b\//m)?.[1] ?? 'complete.diff';
  const deliveryReview = approval.binding.preparedTree !== undefined && metadata !== undefined;
  return (
    <article className="approval-card">
      <header className="approval-summary">
        <div>
          <span className="node-type">Review required</span>
          <h3>{approval.binding.resolvedAction}</h3>
          <p>
            {approval.nodeId} · invocation {approval.invocationSequence}
          </p>
        </div>
        <span className={stateClass(approval.state)}>{approval.state}</span>
      </header>
      <details className="approval-binding">
        <summary>Approval binding</summary>
        <dl>
          <dt>Repository HEAD</dt>
          <dd>{approval.binding.repositoryHead}</dd>
          <dt>Bound artifacts</dt>
          <dd>{approval.binding.artifactChecksums.length}</dd>
          {approval.binding.preparedTree ? (
            <>
              <dt>Prepared tree</dt>
              <dd>{approval.binding.preparedTree}</dd>
            </>
          ) : null}
        </dl>
      </details>
      {deliveryReview && metadata ? (
        <div className="delivery-review">
          <section className="diff-review">
            <header>
              <div>
                <h4>Changed files</h4>
                <span>{files.length} files in the bound tree</span>
              </div>
            </header>
            <div className="diff-workspace">
              {files.length > 0 ? (
                <nav aria-label="Changed files" className="changed-files">
                  {files.map((file, index) => {
                    const filename =
                      file.match(/^diff --git a\/(.+?) b\//m)?.[1] ?? `Change ${index + 1}`;
                    return (
                      <button
                        aria-pressed={selectedFile === index}
                        className={selectedFile === index ? 'active' : ''}
                        key={file.slice(0, 80)}
                        onClick={() => setSelectedFile(index)}
                        title={filename}
                        type="button"
                      >
                        {filename}
                      </button>
                    );
                  })}
                </nav>
              ) : null}
              <div className="diff-editor">
                {diffError ? <p className="diff-error">{diffError}</p> : null}
                {!diffError && diff === undefined ? (
                  <p className="empty">Loading the bound diff…</p>
                ) : null}
                {!diffError && diff !== undefined ? (
                  <CodeViewer
                    content={activeDiff || 'The bound diff is empty.'}
                    label={activeFile}
                    language="diff"
                  />
                ) : null}
              </div>
            </div>
          </section>
          <section className="proposal-form">
            <header>
              <h4>Delivery metadata</h4>
              <span>{delivery?.repairsUsed ?? 0} of 2 repair returns used</span>
            </header>
            <label>
              Commit title
              <input
                value={metadata.commitTitle}
                onChange={(event) =>
                  setMetadata({ ...metadata, commitTitle: event.target.value })
                }
              />
            </label>
            <label>
              Commit body
              <textarea
                value={metadata.commitBody ?? ''}
                onChange={(event) =>
                  setMetadata({ ...metadata, commitBody: event.target.value })
                }
              />
            </label>
            <label>
              Pull request title
              <input
                value={metadata.pullRequestTitle}
                onChange={(event) =>
                  setMetadata({ ...metadata, pullRequestTitle: event.target.value })
                }
              />
            </label>
            <label>
              Pull request body
              <textarea
                value={metadata.pullRequestBody ?? ''}
                onChange={(event) =>
                  setMetadata({ ...metadata, pullRequestBody: event.target.value })
                }
              />
            </label>
            <label className="checkbox-label">
              <input
                checked={metadata.draft}
                onChange={(event) => setMetadata({ ...metadata, draft: event.target.checked })}
                type="checkbox"
              />
              Open as draft pull request
            </label>
          </section>
        </div>
      ) : null}
      {!deliveryReview && approval.proposal ? (
        <section className="approval-proposal">
          <header>
            <div>
              <h4>Plan to review</h4>
              <span>
                {approval.proposal.nodeId} · invocation {approval.proposal.invocationSequence}
              </span>
            </div>
          </header>
          <div className="approval-proposal-content">
            <MarkdownContent content={structuredValueMarkdown(approval.proposal.output)} />
          </div>
        </section>
      ) : null}
      {approval.state === 'waiting_for_approval' ? (
        <footer className="approval-decision">
          <label>
            Review note
            <textarea
              placeholder="Explain why this tree is ready, or what needs to change."
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="approval-actions">
            <button
              className="reject"
              disabled={busy || !reason.trim()}
              onClick={() => onDecision('reject', reason, metadata)}
              type="button"
            >
              Fail
            </button>
            {deliveryReview && (delivery?.repairsUsed ?? 0) < 2 ? (
              <button
                disabled={busy || !reason.trim()}
                onClick={() => onDecision('request_changes', reason, metadata)}
                type="button"
              >
                Request changes
              </button>
            ) : null}
            <button
              className="approve"
              disabled={busy || !reason.trim()}
              onClick={() => onDecision('grant', reason, metadata)}
              type="button"
            >
              Approve
            </button>
          </div>
        </footer>
      ) : (
        <span className={stateClass(approval.state)}>{approval.state}</span>
      )}
    </article>
  );
}

const autoRefreshEvents = new Set([
  'run.cancelled',
  'invocation.activated',
  'attempt.started',
  'attempt.resumed',
  'attempt.resume_token_recorded',
  'attempt.artifact_published',
  'attempt.usage_recorded',
  'attempt.subagents_recorded',
  'attempt.failed',
  'attempt.interrupt_requested',
  'attempt.interrupted',
  'agent.steering_requested',
  'agent.steering_applied',
  'agent.steering_rejected',
  'invocation.retry_requested',
  'invocation.skipped',
  'invocation.completed',
  'run.completed',
  'run.paused',
  'run.resumed',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'approval.changes_requested',
  'delivery.proposed',
  'delivery.metadata_updated',
  'delivery.committed',
  'delivery.publication_started',
  'delivery.publication_succeeded',
  'delivery.publication_failed',
]);

function storedDiagramMode(): DiagramMode {
  try {
    const stored = localStorage.getItem('kouro:diagram-mode');
    return diagramModeForStoredValue(stored);
  } catch {
    return 'flowchart';
  }
}

function storedDiagramDirection(): DiagramDirection {
  try {
    return localStorage.getItem('kouro:diagram-direction') === 'LR' ? 'LR' : 'TB';
  } catch {
    return 'TB';
  }
}

function storeDiagramPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Device-local preferences are optional when browser storage is unavailable.
  }
}

function maximumInspectorHeight(): number {
  return typeof window === 'undefined' ? 720 : Math.max(240, window.innerHeight - 340);
}

function constrainedInspectorHeight(value: number): number {
  return Math.min(maximumInspectorHeight(), Math.max(240, value));
}

function storedInspectorHeight(): number {
  try {
    const stored = Number(localStorage.getItem('kouro:inspector-height'));
    return Number.isFinite(stored) && stored > 0
      ? constrainedInspectorHeight(stored)
      : constrainedInspectorHeight(380);
  } catch {
    return constrainedInspectorHeight(380);
  }
}

function workspaceStyle(inspectorHeight: number): WorkspaceStyle {
  return { '--inspector-height': `${inspectorHeight}px` };
}

function ExecutionConsole({ initialRunId }: { readonly initialRunId?: string }) {
  const [runs, setRuns] = useState<readonly RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(initialRunId);
  const [comparisonRunIds, setComparisonRunIds] = useState<ReadonlySet<string>>(new Set());
  const [comparisonRuns, setComparisonRuns] = useState<readonly RunDetails[]>();
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [run, setRun] = useState<RunDetails>();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [events, setEvents] = useState<readonly ReplayedEvent[]>([]);
  const [artifacts, setArtifacts] = useState<readonly ArtifactView[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactView | null>(null);
  const [activities, setActivities] = useState<
    Readonly<Record<number, InvocationActivityView>>
  >({});
  const [activeActivitySequence, setActiveActivitySequence] = useState<number | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [diagramMode, setDiagramMode] = useState<DiagramMode>(storedDiagramMode);
  const [diagramDirection, setDiagramDirection] =
    useState<DiagramDirection>(storedDiagramDirection);
  const [inspectorHeight, setInspectorHeight] = useState(storedInspectorHeight);
  const drawerDragRef = useRef<DrawerDrag | undefined>(undefined);

  useEffect(() => {
    if (initialRunId) setSelectedRunId(initialRunId);
  }, [initialRunId]);

  useEffect(() => {
    fetchRuns()
      .then((next) => {
        setRuns(next);
        setSelectedRunId((current) => current ?? next[0]?.id);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Load failed'));
  }, []);

  const refreshTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    setEvents([]);
    setActiveArtifact(null);
    setActivities({});
    setActiveActivitySequence(null);
    Promise.all([
      fetchRun(selectedRunId),
      fetchArtifacts(selectedRunId),
      fetchApprovals(selectedRunId),
    ])
      .then(([nextRun, nextArtifacts, nextApprovals]) => {
        setRun(nextRun);
        setArtifacts(nextArtifacts);
        setApprovals(nextApprovals);
        setSelectedNode(nextRun.nodes[0]?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Load failed'));
    const runId = selectedRunId;
    const closeEvents = reconnectEvents(runId, 0, (event) => {
      setEvents((current) =>
        current.some(({ id }) => id === event.id) ? current : [...current, event],
      );
      if (!autoRefreshEvents.has(event.event)) return;
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        Promise.all([
          fetchRun(runId),
          fetchArtifacts(runId),
          fetchApprovals(runId),
          fetchRuns(),
        ])
          .then(([nextRun, nextArtifacts, nextApprovals, nextRuns]) => {
            setRun(nextRun);
            setArtifacts(nextArtifacts);
            setApprovals(nextApprovals);
            setRuns(nextRuns);
          })
          .catch(() => {});
      }, 100);
    });
    return () => {
      closeEvents();
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!run) return undefined;
    const sequences = run.state.invocations
      .filter(
        ({ state, attempts }) =>
          state === 'active' && attempts.some((attempt) => attempt.state === 'running'),
      )
      .map(({ sequence }) => sequence);
    if (sequences.length === 0) return undefined;
    async function refreshActivities(): Promise<void> {
      if (!run) return;
      try {
        const observed = await Promise.all(
          sequences.map(async (sequence) => ({
            sequence,
            activity: await fetchInvocationActivity(run.id, sequence),
          })),
        );
        setActivities((current) => {
          const next = { ...current };
          for (const { sequence, activity } of observed) {
            if (activity) next[sequence] = activity;
          }
          return next;
        });
      } catch {
        // The durable run stream remains usable if best-effort activity is unavailable.
      }
    }
    void refreshActivities();
    const timer = window.setInterval(() => void refreshActivities(), 750);
    return () => window.clearInterval(timer);
  }, [run]);

  const nodes = useMemo(
    () => (run && diagramMode !== 'timeline' ? flowchartNodes(run, diagramDirection) : []),
    [diagramDirection, diagramMode, run],
  );
  const edges = useMemo(
    () => (run && diagramMode !== 'timeline' ? flowEdges(run, diagramDirection) : []),
    [diagramDirection, diagramMode, run],
  );
  const node = run?.nodes.find(({ id }) => id === selectedNode) ?? null;
  const activeActivity =
    activeActivitySequence === null ? undefined : activities[activeActivitySequence];

  async function refreshExecution(runId: string): Promise<void> {
    const [nextRun, nextArtifacts, nextApprovals, nextRuns] = await Promise.all([
      fetchRun(runId),
      fetchArtifacts(runId),
      fetchApprovals(runId),
      fetchRuns(),
    ]);
    setRun(nextRun);
    setArtifacts(nextArtifacts);
    setApprovals(nextApprovals);
    setRuns(nextRuns);
  }

  function toggleComparison(runId: string): void {
    const next = new Set(comparisonRunIds);
    if (next.delete(runId)) {
      setComparisonRunIds(next);
      return;
    }
    if (next.size >= 4) {
      setError('Compare up to four runs at a time.');
      return;
    }
    next.add(runId);
    setComparisonRunIds(next);
  }

  async function openComparison(): Promise<void> {
    if (comparisonRunIds.size < 2) return;
    setComparisonBusy(true);
    setError(undefined);
    try {
      const details = await Promise.all([...comparisonRunIds].map(fetchRun));
      setComparisonRuns(details);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Run comparison could not be loaded');
    } finally {
      setComparisonBusy(false);
    }
  }

  async function submitRunAction(
    action: 'pause' | 'resume' | 'cancel',
    reason?: string,
  ): Promise<void> {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      await controlRun(run.id, action, {
        actor: 'web-user',
        ...(reason ? { reason } : {}),
        idempotencyKey: newIdempotencyKey(),
      });
      await refreshExecution(run.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Run could not be ${action}d`);
    } finally {
      setBusy(false);
    }
  }

  async function submitInvocationAction(
    invocationSequence: number,
    action: InvocationAction,
    value: string,
  ): Promise<boolean> {
    if (!run) return false;
    setBusy(true);
    setError(undefined);
    try {
      await controlInvocation(
        run.id,
        invocationSequence,
        action,
        action === 'steer'
          ? {
              actor: 'web-user',
              message: value,
              idempotencyKey: newIdempotencyKey(),
            }
          : {
              actor: 'web-user',
              reason: value,
              idempotencyKey: newIdempotencyKey(),
            },
      );
      await refreshExecution(run.id);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Invocation could not be ${action}ed`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openArtifact(artifact: ArtifactView): Promise<void> {
    if (!run) return;
    try {
      const [loadedArtifact, activity] = await Promise.all([
        fetchArtifact(run.id, artifact.id),
        artifact.invocationSequence === undefined
          ? Promise.resolve(undefined)
          : fetchInvocationActivity(run.id, artifact.invocationSequence),
      ]);
      if (activity) {
        setActivities((current) => ({
          ...current,
          [activity.invocationSequence]: activity,
        }));
      }
      setActiveArtifact(loadedArtifact);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Artifact load failed');
    }
  }

  async function openActivity(invocationSequence: number): Promise<void> {
    if (!run) return;
    setActiveActivitySequence(invocationSequence);
    try {
      const activity = await fetchInvocationActivity(run.id, invocationSequence);
      if (activity) {
        setActivities((current) => ({ ...current, [invocationSequence]: activity }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Activity load failed');
    }
  }

  async function submitDecision(
    approval: ApprovalView,
    decision: 'grant' | 'reject' | 'request_changes',
    reason: string,
    metadata?: DeliveryMetadata,
  ): Promise<void> {
    if (!run) return;
    setBusy(true);
    try {
      await decideApproval(run.id, approval.invocationSequence, {
        decision,
        actor: 'web-user',
        reason,
        idempotencyKey: newIdempotencyKey(),
        binding: approval.binding,
        expectedEventSequence: approval.expectedEventSequence,
        ...(metadata ? { metadata } : {}),
      });
      const [nextRun, nextApprovals, nextRuns] = await Promise.all([
        fetchRun(run.id),
        fetchApprovals(run.id),
        fetchRuns(),
      ]);
      setRun(nextRun);
      setApprovals(nextApprovals);
      setRuns(nextRuns);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval failed');
    } finally {
      setBusy(false);
    }
  }

  async function removeSelectedRun(): Promise<void> {
    if (!run || !isTerminalRun(run)) return;
    const confirmed = window.confirm(
      `Permanently delete ${run.id} and its Kouro-owned worktree, artifacts, and history?`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await deleteRun(run.id);
      const nextRuns = await fetchRuns();
      setRuns(nextRuns);
      setRun(undefined);
      setEvents([]);
      setArtifacts([]);
      setApprovals([]);
      setActiveArtifact(null);
      setActivities({});
      setActiveActivitySequence(null);
      setSelectedNode(null);
      setSelectedRunId(nextRuns[0]?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Run deletion failed');
    } finally {
      setBusy(false);
    }
  }

  function setAndStoreInspectorHeight(value: number): void {
    const next = constrainedInspectorHeight(value);
    setInspectorHeight(next);
    storeDiagramPreference('kouro:inspector-height', String(next));
  }

  function startDrawerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    drawerDragRef.current = {
      pointerId: event.pointerId,
      startHeight: inspectorHeight,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeDrawer(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = drawerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setInspectorHeight(constrainedInspectorHeight(drag.startHeight + drag.startY - event.clientY));
  }

  function finishDrawerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = drawerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = constrainedInspectorHeight(drag.startHeight + drag.startY - event.clientY);
    drawerDragRef.current = undefined;
    setInspectorHeight(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeDiagramPreference('kouro:inspector-height', String(next));
  }

  function cancelDrawerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drawerDragRef.current?.pointerId !== event.pointerId) return;
    drawerDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeDiagramPreference('kouro:inspector-height', String(inspectorHeight));
  }

  function resizeDrawerWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') {
      setAndStoreInspectorHeight(240);
      return;
    }
    if (event.key === 'End') {
      setAndStoreInspectorHeight(maximumInspectorHeight());
      return;
    }
    setAndStoreInspectorHeight(inspectorHeight + (event.key === 'ArrowUp' ? 40 : -40));
  }

  return (
    <div className="execution-layout">
      <RunList
        comparisonBusy={comparisonBusy}
        comparisonSelection={comparisonRunIds}
        onCompare={() => void openComparison()}
        onSelect={setSelectedRunId}
        onToggleComparison={toggleComparison}
        runs={runs}
        selected={selectedRunId}
      />
      <section className="workspace" style={workspaceStyle(inspectorHeight)}>
        {error ? <div className="error-banner">{error}</div> : null}
        {run ? (
          <>
            <header className="run-header">
              <div>
                <p className="eyebrow">{run.workflowId}</p>
                <h2>{run.id}</h2>
                <small className="repository-path">{run.repositoryPath}</small>
              </div>
              <div className="run-header-actions">
                <div aria-label="Run controls" className="run-controls" role="group">
                  {run.status === 'paused' ? (
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void submitRunAction('resume')}
                      type="button"
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      disabled={
                        busy ||
                        !['running', 'waiting_for_approval'].includes(run.status)
                      }
                      onClick={() => void submitRunAction('pause')}
                      type="button"
                    >
                      Pause
                    </button>
                  )}
                  {!isTerminalRun(run) ? (
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Cancel ${run.id}? The durable history and worktree will be retained.`,
                          )
                        ) {
                          void submitRunAction('cancel', 'Cancelled from the web workspace');
                        }
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
                <div className="run-stat">
                  <span className={stateClass(run.status)}>{run.status}</span>
                  <small>{run.eventCount} durable events</small>
                </div>
                <RunCostStat run={run} />
                {isTerminalRun(run) ? (
                  <button
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void removeSelectedRun()}
                    type="button"
                  >
                    Delete run
                  </button>
                ) : null}
              </div>
            </header>
            <section className="graph">
              <div className="graph-toolbar">
                <div aria-label="Diagram style" className="segmented-control" role="group">
                  {(['flowchart', 'timeline'] as const).map((mode) => (
                    <button
                      aria-pressed={diagramMode === mode}
                      className={diagramMode === mode ? 'active' : ''}
                      key={mode}
                      onClick={() => {
                        setDiagramMode(mode);
                        storeDiagramPreference('kouro:diagram-mode', mode);
                      }}
                      title={mode === 'timeline' ? 'Swimlane waterfall of invocations in activation order' : mode}
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <div aria-label="Flow direction" className="segmented-control" role="group">
                  {(['TB', 'LR'] as const).map((direction) => (
                    <button
                      aria-pressed={diagramDirection === direction}
                      className={diagramDirection === direction ? 'active' : ''}
                      disabled={diagramMode !== 'flowchart'}
                      key={direction}
                      onClick={() => {
                        setDiagramDirection(direction);
                        storeDiagramPreference('kouro:diagram-direction', direction);
                      }}
                      title={direction === 'TB' ? 'Top to bottom' : 'Left to right'}
                      type="button"
                    >
                      {direction}
                    </button>
                  ))}
                </div>
              </div>
              {diagramMode === 'timeline' ? (
                <RunTimeline
                  activities={activities}
                  onSelectNode={(nodeId) => {
                    setSelectedNode(nodeId);
                    setTab('details');
                  }}
                  run={run}
                  selectedNodeId={selectedNode}
                />
              ) : (
                <ReactFlow
                  edges={edges}
                  edgeTypes={workflowEdgeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.24 }}
                  key={`${run.id}:${diagramMode}:${diagramDirection}`}
                  nodes={nodes}
                  nodeTypes={workflowNodeTypes}
                  nodesConnectable={false}
                  nodesDraggable={false}
                  onNodeClick={(_, selected) => {
                    setSelectedNode(
                      typeof selected.data.parentNodeId === 'string'
                        ? selected.data.parentNodeId
                        : selected.id,
                    );
                    setTab('details');
                  }}
                >
                  <Background color="#30363d" gap={24} />
                  <MiniMap nodeColor="#388bfd" pannable zoomable />
                  <Controls showInteractive={false} />
                </ReactFlow>
              )}
            </section>
            <section className="inspector">
              <div
                aria-label="Resize bottom drawer"
                aria-orientation="horizontal"
                aria-valuemax={maximumInspectorHeight()}
                aria-valuemin={240}
                aria-valuenow={inspectorHeight}
                className="drawer-resize-handle"
                onKeyDown={resizeDrawerWithKeyboard}
                onPointerCancel={cancelDrawerResize}
                onPointerDown={startDrawerResize}
                onPointerMove={resizeDrawer}
                onPointerUp={finishDrawerResize}
                role="separator"
                tabIndex={0}
                title="Drag to resize the bottom drawer"
              >
                <span />
              </div>
              <nav className="tabs">
                {(['control', 'details', 'events', 'artifacts', 'approval'] as const).map((name) => (
                  <button
                    className={tab === name ? 'active' : ''}
                    key={name}
                    onClick={() => setTab(name)}
                    type="button"
                  >
                    {name}
                    {name === 'approval' && approvals.length > 0 ? (
                      <span>{approvals.length}</span>
                    ) : null}
                  </button>
                ))}
              </nav>
              <div className="panel">
                {tab === 'control' ? (
                  <OperatorConsole
                    activities={activities}
                    busy={busy}
                    onAction={submitInvocationAction}
                    onOpenActivity={(sequence) => void openActivity(sequence)}
                    run={run}
                    selectedNodeId={selectedNode}
                  />
                ) : null}
                {tab === 'details' ? (
                  <NodeDetails
                    activities={activities}
                    artifacts={artifacts}
                    node={node}
                    onOpenActivity={(sequence) => void openActivity(sequence)}
                    onOpenArtifact={(artifact) => void openArtifact(artifact)}
                    run={run}
                  />
                ) : null}
                {tab === 'events' ? <EventLog events={events} /> : null}
                {tab === 'artifacts' ? (
                  <Artifacts
                    artifacts={artifacts}
                    onOpen={(artifact) => void openArtifact(artifact)}
                  />
                ) : null}
                {tab === 'approval' ? (
                  approvals.length > 0 ? (
                    approvals.map((approval) => (
                      <ApprovalControl
                        approval={approval}
                        busy={busy}
                        delivery={run.state.delivery}
                        diffArtifact={approvalDiffArtifact(
                          artifacts,
                          approval.invocationSequence,
                        )}
                        key={approval.invocationSequence}
                        onDecision={(decision, reason, metadata) =>
                          void submitDecision(approval, decision, reason, metadata)
                        }
                      />
                    ))
                  ) : (
                    <p className="empty">This run has no approval records.</p>
                  )
                ) : null}
                {run.state.delivery?.commit &&
                run.state.delivery.publication.status !== 'published' ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void publishRun(run.id)
                        .then(() => fetchRun(run.id))
                        .then(setRun)
                        .catch((cause: unknown) =>
                          setError(
                            cause instanceof Error ? cause.message : 'Publication failed',
                          ),
                        )
                        .finally(() => setBusy(false));
                    }}
                    type="button"
                  >
                    Publish PR
                  </button>
                ) : null}
                {run.state.delivery?.publication.status === 'published' ? (
                  <a
                    href={run.state.delivery.publication.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    PR #{run.state.delivery.publication.number}
                  </a>
                ) : null}
              </div>
            </section>
            <footer className="ide-status-bar">
              <span>Kouro workspace</span>
              <span>{repositoryName(run.repositoryPath)}</span>
              <span>{run.workflowVersion}</span>
              <span>{run.workflowChecksum.slice(0, 19)}…</span>
              <span className="status-spacer" />
              <span>{run.invocationCount} invocations</span>
              <span>{run.pendingApprovalCount} approvals</span>
            </footer>
          </>
        ) : (
          <div className="loading">Waiting for durable run state…</div>
        )}
      </section>
      {activeArtifact ? (
        <ArtifactModal
          activity={
            activeArtifact.invocationSequence === undefined
              ? undefined
              : activities[activeArtifact.invocationSequence]
          }
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
        />
      ) : null}
      {activeActivity ? (
        <ActivityModal
          activity={activeActivity}
          busy={busy}
          interruptible={
            run
              ? invocationControlAvailability(run, activeActivity.invocationSequence).interruptible
              : false
          }
          onAction={(action, value) =>
            submitInvocationAction(activeActivity.invocationSequence, action, value)
          }
          onClose={() => setActiveActivitySequence(null)}
          steerable={
            run
              ? invocationControlAvailability(run, activeActivity.invocationSequence).steerable
              : false
          }
        />
      ) : null}
      {comparisonRuns ? (
        <RunComparisonModal onClose={() => setComparisonRuns(undefined)} runs={comparisonRuns} />
      ) : null}
    </div>
  );
}

const boardColumns = [
  'backlog',
  'ready',
  'planning',
  'waiting_for_plan_approval',
  'implementing',
  'validating',
  'repairing',
  'reviewing',
  'waiting_for_delivery_approval',
  'blocked',
  'failed',
  'done',
  'cancelled',
] as const;

const RELATIONSHIP_LABELS = {
  blocks: 'blocks',
  blocked_by: 'blocked by',
  parent: 'parent of',
  child: 'child of',
  related: 'related to',
} as const satisfies Record<TicketDetails['relationships'][number]['kind'], string>;

function relationshipKindLabel(kind: TicketDetails['relationships'][number]['kind']): string {
  return RELATIONSHIP_LABELS[kind];
}

function TicketHistory({ details }: { readonly details: TicketDetails }) {
  const { ticket, relationships } = details;
  const outgoing = relationships.filter(({ sourceTicketId }) => sourceTicketId === ticket.id);
  const incoming = relationships.filter(({ targetTicketId }) => targetTicketId === ticket.id);
  return (
    <div className="ticket-history">
      <section>
        <h4>Relationships</h4>
        {relationships.length === 0 ? <p className="empty">No linked tickets.</p> : null}
        {outgoing.map((relationship) => (
          <article className="ticket-relationship" key={`${relationship.sourceTicketId}:${relationship.kind}:${relationship.targetTicketId}`}>
            <strong>{relationshipKindLabel(relationship.kind)}</strong>
            <code>{relationship.targetTicketId}</code>
          </article>
        ))}
        {incoming.map((relationship) => (
          <article className="ticket-relationship" key={`${relationship.sourceTicketId}:${relationship.kind}:${relationship.targetTicketId}`}>
            <strong>{
              relationship.kind === 'blocks'
                ? 'blocked by'
                : relationship.kind === 'blocked_by'
                  ? 'blocks'
                  : relationship.kind === 'parent'
                    ? 'child of'
                    : relationship.kind === 'child'
                      ? 'parent of'
                      : 'related to'
            }</strong>
            <code>{relationship.sourceTicketId}</code>
          </article>
        ))}
      </section>
      <section>
        <h4>Comments</h4>
        {details.comments.length === 0 ? <p className="empty">No comments.</p> : null}
        {details.comments.map((comment) => (
          <article className="ticket-comment" key={comment.id}>
            <strong>{comment.author}</strong>
            <time>{comment.updatedAt ?? comment.createdAt}</time>
            <div className="ticket-comment-body">
              <MarkdownContent content={comment.body} />
            </div>
          </article>
        ))}
      </section>
      <section>
        <h4>Runs</h4>
        {details.runs.length === 0 ? <p className="empty">No linked runs.</p> : null}
        {details.runs.map((run) => (
          <article key={run.runId}>
            <strong>{run.runId}</strong>
            <span>{run.kind}</span>
            <span className={stateClass(run.execution?.column ?? 'unavailable')}>
              {run.execution?.column ?? 'unavailable'}
            </span>
            {run.execution?.usage ? (
              <span className="ticket-run-cost">
                {formatTokenCount(
                  run.execution.usage.inputTokens + run.execution.usage.outputTokens,
                )}{' '}
                tokens
                {run.execution.costUsd !== undefined
                  ? ` · ${formatUsd(run.execution.costUsd)} est.`
                  : ''}
              </span>
            ) : null}
            <time>{run.createdAt}</time>
          </article>
        ))}
      </section>
      <section>
        <h4>Snapshots</h4>
        {details.snapshots.length === 0 ? <p className="empty">No captured snapshots.</p> : null}
        {details.snapshots.map((snapshot) => (
          <article key={snapshot.id}>
            <strong>Revision {snapshot.providerRevision}</strong>
            <span>{snapshot.provider}</span>
            <span>{snapshot.runId}</span>
            <time>{snapshot.capturedAt}</time>
          </article>
        ))}
      </section>
      <section>
        <h4>Synchronization</h4>
        <article>
          <strong>{details.syncState.provider}</strong>
          <span className={stateClass(details.syncState.status)}>{details.syncState.status}</span>
          <span>{details.syncState.lastError ?? 'No synchronization error'}</span>
          <time>{details.syncState.lastSyncedAt ?? 'Never synchronized'}</time>
        </article>
        {details.syncOperations.map((operation) => (
          <article key={operation.idempotencyKey}>
            <strong>{operation.operation}</strong>
            <span>{operation.provider}</span>
            <span className={stateClass(operation.status)}>{operation.status}</span>
            <time>{operation.updatedAt}</time>
          </article>
        ))}
      </section>
      <section>
        <h4>Migration</h4>
        {details.migrations.length === 0 ? <p className="empty">No migration history.</p> : null}
        {details.migrations.map((migration) => (
          <article key={`${migration.ticketId}:${migration.stage}`}>
            <strong>{migration.stage.replaceAll('_', ' ')}</strong>
            <span>{migration.targetProvider}</span>
            <span>{migration.lastError ?? 'Checkpoint durable'}</span>
            <time>{migration.updatedAt}</time>
          </article>
        ))}
      </section>
    </div>
  );
}

function TicketInspector({
  details,
  onLaunch,
  onOpenRun,
}: {
  readonly details: TicketDetails;
  readonly onLaunch: () => void;
  readonly onOpenRun: (runId: string) => void;
}) {
  const { ticket } = details;
  const activeRun = details.activeRun;
  return (
    <aside className="ticket-inspector">
      <header>
        <div>
          <p className="eyebrow">
            {ticket.binding.kind} · revision {ticket.revision}
          </p>
          <h2>{ticket.title}</h2>
        </div>
        <div className="ticket-inspector-actions">
          <span className={stateClass(details.column)}>{details.column.replaceAll('_', ' ')}</span>
          {activeRun ? (
            <button
              className="primary-button"
              onClick={() => onOpenRun(activeRun.runId)}
              type="button"
            >
              Open active run
            </button>
          ) : (
            <button className="primary-button" onClick={onLaunch} type="button">
              Run workflow
            </button>
          )}
        </div>
      </header>
      <div className="ticket-description">
        <MarkdownContent content={ticket.description || 'No description provided.'} />
      </div>
      <dl className="ticket-metadata">
        <dt>Priority</dt>
        <dd>{ticket.priority ?? 'none'}</dd>
        <dt>Labels</dt>
        <dd>{ticket.labels.join(', ') || 'none'}</dd>
        <dt>Assignees</dt>
        <dd>{ticket.assignees.join(', ') || 'none'}</dd>
        <dt>Updated</dt>
        <dd>{ticket.updatedAt}</dd>
      </dl>
      <TicketHistory details={details} />
    </aside>
  );
}

function ProviderConfigurations({
  configurations,
}: {
  readonly configurations: readonly TicketProviderConfigurationView[];
}) {
  return (
    <section className="provider-configurations">
      <div>
        <p className="eyebrow">Provider configuration</p>
        <h3>Ticket authorities</h3>
      </div>
      <p className="provider-note">
        Credentials stay in server composition and are never returned to the browser.
      </p>
      {configurations.map((configuration) => (
        <article key={configuration.id}>
          <div>
            <strong>{configuration.displayName}</strong>
            <span className={stateClass(configuration.configured ? 'succeeded' : 'pending')}>
              {configuration.configured ? 'configured' : 'not configured'}
            </span>
          </div>
          <p>{configuration.message}</p>
          {configuration.endpoint ? <small>{configuration.endpoint}</small> : null}
          {configuration.owner && configuration.repository ? (
            <small>
              {configuration.owner}/{configuration.repository}
            </small>
          ) : null}
          <small>Credentials: {configuration.credentialSource.replaceAll('_', ' ')}</small>
        </article>
      ))}
    </section>
  );
}

interface TicketRunOptions {
  readonly workflow: string;
  readonly repositoryPath: string;
  readonly harness: string;
  readonly reasoningEffort: string;
  readonly base: string;
}

function portableReasoningEffort(value: string): 'low' | 'medium' | 'high' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function TicketRunFields({
  busy,
  options,
  repositories,
  onChange,
}: {
  readonly busy: boolean;
  readonly options: TicketRunOptions;
  readonly repositories: readonly RepositorySummary[];
  readonly onChange: (field: keyof TicketRunOptions, value: string) => void;
}) {
  return (
    <div className="ticket-run-fields">
      <label>
        <span>Workflow</span>
        <input
          disabled={busy}
          list="ticket-workflow-options"
          onChange={(event) => onChange('workflow', event.target.value)}
          placeholder="Bundled workflow ID or local package path"
          required
          value={options.workflow}
        />
        <small>Use the bundled workflow ID or a package path visible to the Kouro host.</small>
      </label>
      <datalist id="ticket-workflow-options">
        <option value="feature-development">Feature development</option>
      </datalist>
      <label>
        <span>Repository</span>
        <select
          disabled={busy || repositories.length === 0}
          onChange={(event) => onChange('repositoryPath', event.target.value)}
          required
          value={options.repositoryPath}
        >
          {repositories.length === 0 ? <option value="">No repository available</option> : null}
          {repositories.map((repository) => (
            <option key={repository.id} value={repository.path}>
              {repository.path}
            </option>
          ))}
        </select>
        <small>The run and its worktree stay scoped to this repository.</small>
      </label>
      <label>
        <span>Harness routing</span>
        <select
          disabled={busy}
          onChange={(event) => onChange('harness', event.target.value)}
          value={options.harness}
        >
          <option value="automatic">Automatic fallback</option>
          <option value="codex">Codex</option>
          <option value="claude-code">Claude Code</option>
          <option value="opencode">OpenCode</option>
          <option value="pi">Pi</option>
        </select>
        <small>Workflow-level harness pins still take precedence.</small>
      </label>
      <label>
        <span>Reasoning effort</span>
        <select
          disabled={busy}
          onChange={(event) => onChange('reasoningEffort', event.target.value)}
          value={options.reasoningEffort}
        >
          <option value="automatic">Provider default</option>
          <option value="low">Low · faster</option>
          <option value="medium">Medium · balanced</option>
          <option value="high">High · deeper</option>
        </select>
        <small>Fallback for agents and subagents without a workflow-level effort.</small>
      </label>
      <label>
        <span>Base branch</span>
        <input
          disabled={busy}
          onChange={(event) => onChange('base', event.target.value)}
          placeholder="Current branch at launch"
          value={options.base}
        />
        <small>Leave empty to snapshot the repository's current named branch.</small>
      </label>
    </div>
  );
}

function TicketRunDialog({
  details,
  repositories,
  onClose,
  onCreated,
}: {
  readonly details: TicketDetails;
  readonly repositories: readonly RepositorySummary[];
  readonly onClose: () => void;
  readonly onCreated: (runId: string) => void;
}) {
  const [options, setOptions] = useState<TicketRunOptions>({
    workflow: 'feature-development',
    repositoryPath: repositories[0]?.path ?? '',
    harness: 'automatic',
    reasoningEffort: 'automatic',
    base: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  function updateOption(field: keyof TicketRunOptions, value: string): void {
    setOptions((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const selectedWorkflow = options.workflow.trim();
    if (busy || !selectedWorkflow || !options.repositoryPath) return;
    setBusy(true);
    setError(undefined);
    const reasoningEffort = portableReasoningEffort(options.reasoningEffort);
    try {
      const created = await createRun({
        adw: selectedWorkflow,
        repositoryPath: options.repositoryPath,
        ticket: `kouro:${details.ticket.id}`,
        ...(options.harness === 'automatic' ? {} : { harnesses: [options.harness] }),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        actor: 'web-user',
        ...(options.base.trim() ? { base: options.base.trim() } : {}),
      });
      onCreated(created.runId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workflow launch failed');
      setBusy(false);
    }
  }

  return (
    <InspectorModal
      closeDisabled={busy}
      contentClassName="ticket-run-modal"
      metadata={`${details.ticket.id} · revision ${details.ticket.revision}`}
      modalClassName="ticket-run-dialog"
      onClose={onClose}
      title="Run workflow"
    >
      <form className="ticket-run-form" onSubmit={(event) => void submit(event)}>
        <section className="ticket-run-summary">
          <p className="eyebrow">Immutable work item</p>
          <strong>{details.ticket.title}</strong>
          <p>
            Kouro snapshots this ticket revision before creating the worktree. Later ticket edits do
            not change the active run.
          </p>
        </section>
        <TicketRunFields
          busy={busy}
          onChange={updateOption}
          options={options}
          repositories={repositories}
        />
        {repositories.length === 0 ? (
          <p className="ticket-run-error">
            Serve a repository with <code>kouro serve --repo &lt;path&gt;</code> or register one before
            launching.
          </p>
        ) : null}
        {error ? <p className="ticket-run-error">{error}</p> : null}
        <footer className="ticket-run-actions">
          <button disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || !options.workflow.trim() || !options.repositoryPath}
            type="submit"
          >
            {busy ? 'Starting workflow…' : 'Start workflow'}
          </button>
        </footer>
      </form>
    </InspectorModal>
  );
}

function TicketBoard({
  tickets,
  selectedTicketId,
  onSelect,
}: {
  readonly tickets: readonly TicketListItem[];
  readonly selectedTicketId?: string;
  readonly onSelect: (ticketId: string) => void;
}) {
  return (
    <div className="ticket-board">
      {boardColumns.map((column) => {
        const cards = tickets.filter((ticket) => ticket.column === column);
        return (
          <section className="ticket-column" key={column}>
            <header>
              <strong>{column.replaceAll('_', ' ')}</strong>
              <span className="count">{cards.length}</span>
            </header>
            {cards.map(({ ticket, activeRun }) => (
              <button
                className={ticket.id === selectedTicketId ? 'ticket-card selected' : 'ticket-card'}
                key={ticket.id}
                onClick={() => onSelect(ticket.id)}
                type="button"
              >
                <small>{ticket.id}</small>
                <strong>{ticket.title}</strong>
                <span>{ticket.priority ?? 'no priority'}</span>
                {activeRun ? <span>{activeRun.runId}</span> : null}
                {activeRun?.costUsd !== undefined ? (
                  <span className="ticket-card-cost">
                    {formatUsd(activeRun.costUsd)} est.
                  </span>
                ) : null}
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function TicketConsole({ onOpenRun }: { readonly onOpenRun: (runId: string) => void }) {
  const [projects, setProjects] = useState<readonly TicketProjectView[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [tickets, setTickets] = useState<readonly TicketListItem[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string>();
  const [details, setDetails] = useState<TicketDetails>();
  const [providers, setProviders] = useState<readonly TicketProviderConfigurationView[]>([]);
  const [repositories, setRepositories] = useState<readonly RepositorySummary[]>([]);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [error, setError] = useState<string>();
  const detailsPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    Promise.all([
      fetchTicketProjects(),
      fetchTicketProviderConfigurations(),
      fetchRepositories(),
    ])
      .then(([nextProjects, nextProviders, nextRepositories]) => {
        setProjects(nextProjects);
        setProviders(nextProviders);
        setRepositories(nextRepositories);
        setProjectId((current) => current ?? nextProjects[0]?.id);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Ticket configuration load failed'),
      );
  }, []);

  useEffect(() => {
    if (!projectId) {
      setTickets([]);
      setSelectedTicketId(undefined);
      return;
    }
    fetchTickets(projectId)
      .then((nextTickets) => {
        setTickets(nextTickets);
        setSelectedTicketId((current) =>
          nextTickets.some(({ ticket }) => ticket.id === current)
            ? current
            : nextTickets[0]?.ticket.id,
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Ticket load failed'),
      );
  }, [projectId]);

  useEffect(() => {
    if (!selectedTicketId) {
      setDetails(undefined);
      return undefined;
    }
    let cancelled = false;
    setDetails(undefined);
    fetchTicket(selectedTicketId)
      .then((nextDetails) => {
        if (!cancelled) setDetails(nextDetails);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Ticket detail load failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTicketId]);

  useEffect(() => {
    detailsPanelRef.current?.scrollTo({ top: 0 });
  }, [selectedTicketId]);

  return (
    <div className="ticket-console">
      {error ? <div className="error-banner">{error}</div> : null}
      <header className="ticket-console-header">
        <div>
          <p className="eyebrow">Planning and execution</p>
          <h1>Ticket board</h1>
        </div>
        <label>
          Project
          <select value={projectId ?? ''} onChange={(event) => setProjectId(event.target.value)}>
            {projects.length === 0 ? <option value="">No ticket projects</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.id} · {project.ticketCount}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="ticket-workspace">
        <TicketBoard
          tickets={tickets}
          selectedTicketId={selectedTicketId}
          onSelect={setSelectedTicketId}
        />
        <div className="ticket-lower" ref={detailsPanelRef}>
          {details ? (
            <TicketInspector
              details={details}
              onLaunch={() => setLaunchOpen(true)}
              onOpenRun={onOpenRun}
            />
          ) : (
            <div className="ticket-empty">Select a ticket to inspect its durable history.</div>
          )}
          <ProviderConfigurations configurations={providers} />
        </div>
      </div>
      {launchOpen && details ? (
        <TicketRunDialog
          details={details}
          onClose={() => setLaunchOpen(false)}
          onCreated={onOpenRun}
          repositories={repositories}
        />
      ) : null}
    </div>
  );
}

export function App() {
  const [surface, setSurface] = useState<'tickets' | 'runs'>('tickets');
  const [targetRunId, setTargetRunId] = useState<string>();

  function openRun(runId: string): void {
    setTargetRunId(runId);
    setSurface('runs');
  }

  return (
    <main className="app-shell">
      <header className="surface-nav">
        <div className="product-mark" aria-hidden="true">
          K
        </div>
        <div className="product-name">
          <strong>Kouro</strong>
          <span>Developer workflows</span>
        </div>
        <nav aria-label="Primary">
          <button
            aria-current={surface === 'tickets' ? 'page' : undefined}
            className={surface === 'tickets' ? 'active' : ''}
            onClick={() => setSurface('tickets')}
            type="button"
          >
            Tickets
          </button>
          <button
            aria-current={surface === 'runs' ? 'page' : undefined}
            className={surface === 'runs' ? 'active' : ''}
            onClick={() => {
              setTargetRunId(undefined);
              setSurface('runs');
            }}
            type="button"
          >
            Actions
          </button>
        </nav>
        <span className="environment-badge">
          <span aria-hidden="true" />
          Local
        </span>
      </header>
      {surface === 'tickets' ? (
        <TicketConsole onOpenRun={openRun} />
      ) : (
        <ExecutionConsole initialRunId={targetRunId} />
      )}
    </main>
  );
}
