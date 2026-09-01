import type { RunDetails } from '@kouro/api-contracts';
import { estimateCostUsd, sumUsage, type TokenUsage } from '@kouro/domain';

import { invocationDisplayState } from './execution-presentation.ts';

/**
 * Deterministic swimlane timeline for a run.
 *
 * New histories carry durable invocation wall-clock spans. Older histories
 * fall back to logical activation sequence because elapsed time cannot be
 * reconstructed without inventing data.
 */

export interface TimelineBlock {
  readonly id: string;
  readonly invocationSequence: number;
  readonly nodeId: string;
  readonly kind: 'workflow' | 'subagent';
  readonly callId?: string;
  readonly subagentId?: string;
  readonly row: number;
  /** Offset from the model origin, in milliseconds or fallback sequence units. */
  readonly offset: number;
  /** Real elapsed milliseconds or one fallback sequence unit. */
  readonly duration: number;
  readonly activatedAt?: string;
  readonly finishedAt?: string;
  readonly parallelGroupId?: string;
  readonly branchId?: string;
  readonly workspaceId?: string;
  readonly state: string;
  readonly attemptCount: number;
  readonly model?: string;
  readonly harnessId?: string;
  /** Token usage reported by the latest attempt, when any harness reported it. */
  readonly usage?: TokenUsage;
  /** Estimated USD cost of the latest attempt, when its model is priced. */
  readonly costUsd?: number;
  /** True when the invocation was reserved but never activated. */
  readonly queued: boolean;
}

export interface TimelineLane {
  readonly laneId: string;
  readonly nodeId: string;
  readonly title: string;
  readonly nodeType: string;
  readonly ordinal: number;
  readonly kind: 'workflow' | 'subagent';
  readonly rowCount: number;
  readonly blocks: readonly TimelineBlock[];
}

export interface TimelineModel {
  readonly lanes: readonly TimelineLane[];
  /** Highest reserved invocation sequence; the waterfall spans 1..tickCount. */
  readonly tickCount: number;
  readonly span: number;
  readonly timeBased: boolean;
}

/** Best-effort child activity layered onto the parent's durable timeline tick. */
export interface TimelineSubagentObservation {
  readonly invocationSequence: number;
  readonly attemptNumber: number;
  readonly nodeId: string;
  readonly callId: string;
  readonly subagentId: string;
  readonly state: 'active' | 'succeeded' | 'failed';
  readonly harnessId?: string;
  readonly model?: string;
  readonly usage?: TokenUsage;
}

export function isTerminalRun(status: RunDetails['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function isTimelineBlockSelected(selectedBlockId: string | null, blockId: string): boolean {
  return selectedBlockId === blockId;
}

function displayedState(
  run: RunDetails,
  node: RunDetails['nodes'][number] | undefined,
  invocation: RunDetails['state']['invocations'][number],
): string {
  if (node?.type === 'complete' && invocation.state === 'pending' && isTerminalRun(run.status)) {
    return run.status;
  }
  return invocationDisplayState(invocation);
}

type TimelineBlockSource = Omit<TimelineBlock, 'duration' | 'offset'>;
type TimelineSubagentBlockSource = TimelineBlockSource & { readonly laneId: string };

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function terminalBlock(block: TimelineBlockSource): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(block.state);
}

export function timelineModel(
  run: RunDetails,
  observations: readonly TimelineSubagentObservation[] = [],
  observedAt = new Date().toISOString(),
): TimelineModel {
  const blockSources: TimelineBlockSource[] = run.state.invocations.map((invocation) => {
    const node = run.nodes.find(({ id }) => id === invocation.nodeId);
    const attempt = invocation.attempts.at(-1);
    const branch = invocation.parallelGroupId
      ? run.state.parallelGroups
          ?.find(({ id }) => id === invocation.parallelGroupId)
          ?.branches.find(({ id }) => id === invocation.branchId)
      : undefined;
    const attemptsWithUsage = invocation.attempts.filter(
      (candidate): candidate is typeof candidate & { readonly usage: TokenUsage } =>
        candidate.usage !== undefined,
    );
    const usage =
      attemptsWithUsage.length > 0
        ? sumUsage(attemptsWithUsage.map((candidate) => candidate.usage))
        : undefined;
    const costs = attemptsWithUsage.map((candidate) =>
      estimateCostUsd(candidate.usage, candidate.model),
    );
    const costUsd =
      costs.length > 0 && costs.every((cost): cost is number => cost !== undefined)
        ? costs.reduce((total, cost) => total + cost, 0)
        : undefined;
    return {
      id: `invocation:${invocation.sequence}`,
      invocationSequence: invocation.sequence,
      nodeId: invocation.nodeId,
      kind: 'workflow' as const,
      row: 0,
      ...(invocation.activatedAt === undefined ? {} : { activatedAt: invocation.activatedAt }),
      ...(invocation.finishedAt === undefined ? {} : { finishedAt: invocation.finishedAt }),
      ...(invocation.parallelGroupId === undefined
        ? {}
        : { parallelGroupId: invocation.parallelGroupId }),
      ...(invocation.branchId === undefined ? {} : { branchId: invocation.branchId }),
      ...(branch?.workspaceId === undefined ? {} : { workspaceId: branch.workspaceId }),
      state: displayedState(run, node, invocation),
      attemptCount: invocation.attempts.length,
      model: attempt?.model,
      harnessId: attempt?.harnessId,
      ...(usage ? { usage } : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
      queued: invocation.state === 'pending',
    };
  });
  const subagentBlocks: TimelineSubagentBlockSource[] = run.state.invocations.flatMap(
    (invocation) =>
      invocation.attempts.flatMap((attempt) =>
        (attempt.subagents ?? []).map((subagent) => {
          const laneId = `subagent:${invocation.nodeId}:${subagent.subagentId}`;
          const costUsd = subagent.usage
            ? estimateCostUsd(subagent.usage, subagent.model)
            : undefined;
          return {
            id: `${invocation.sequence}:${attempt.number}:${subagent.callId}`,
            attemptNumber: attempt.number,
            invocationSequence: invocation.sequence,
            nodeId: invocation.nodeId,
            kind: 'subagent' as const,
            callId: subagent.callId,
            subagentId: subagent.subagentId,
            row: 0,
            ...(invocation.activatedAt === undefined
              ? {}
              : { activatedAt: invocation.activatedAt }),
            ...(invocation.finishedAt === undefined ? {} : { finishedAt: invocation.finishedAt }),
            state: subagent.state,
            attemptCount: 1,
            model: subagent.model,
            harnessId: subagent.harnessId,
            ...(subagent.usage ? { usage: subagent.usage } : {}),
            ...(costUsd === undefined ? {} : { costUsd }),
            queued: false,
            laneId,
          };
        }),
      ),
  );
  const durableSubagentIds = new Set(subagentBlocks.map(({ id }) => id));
  const observedSubagentBlocks: TimelineSubagentBlockSource[] = observations
    .filter(
      (observation) =>
        !durableSubagentIds.has(
          `${observation.invocationSequence}:${observation.attemptNumber}:${observation.callId}`,
        ),
    )
    .map((observation) => {
      const parent = run.state.invocations.find(
        ({ sequence }) => sequence === observation.invocationSequence,
      );
      const costUsd = observation.usage
        ? estimateCostUsd(observation.usage, observation.model)
        : undefined;
      return {
        id: `${observation.invocationSequence}:${observation.attemptNumber}:${observation.callId}`,
        invocationSequence: observation.invocationSequence,
        attemptNumber: observation.attemptNumber,
        nodeId: observation.nodeId,
        kind: 'subagent' as const,
        callId: observation.callId,
        subagentId: observation.subagentId,
        row: 0,
        ...(parent?.activatedAt === undefined ? {} : { activatedAt: parent.activatedAt }),
        ...(parent?.finishedAt === undefined ? {} : { finishedAt: parent.finishedAt }),
        state: observation.state,
        attemptCount: 1,
        model: observation.model,
        harnessId: observation.harnessId,
        ...(observation.usage ? { usage: observation.usage } : {}),
        ...(costUsd === undefined ? {} : { costUsd }),
        queued: false,
        laneId: `subagent:${observation.nodeId}:${observation.subagentId}`,
      };
    });
  const allSubagentBlocks = [...subagentBlocks, ...observedSubagentBlocks];
  blockSources.sort((left, right) => left.invocationSequence - right.invocationSequence);
  const timeBased =
    blockSources.length > 0 &&
    blockSources.every(
      (block) =>
        timestamp(block.activatedAt) !== undefined &&
        (!terminalBlock(block) || timestamp(block.finishedAt) !== undefined),
    );
  const origin = timeBased
    ? Math.min(...blockSources.map((block) => timestamp(block.activatedAt) ?? 0))
    : 0;
  const observation = timestamp(observedAt);
  const end = timeBased
    ? Math.max(
        ...blockSources.map((block) =>
          Math.max(
            timestamp(block.activatedAt) ?? origin,
            timestamp(block.finishedAt) ?? observation ?? timestamp(block.activatedAt) ?? origin,
          ),
        ),
      )
    : blockSources.reduce((maximum, block) => Math.max(maximum, block.invocationSequence), 0);
  const span = Math.max(1, end - origin);
  function positionBlock(block: TimelineBlockSource): TimelineBlock {
    if (!timeBased) {
      return { ...block, offset: block.invocationSequence - 1, duration: 1 };
    }
    const start = timestamp(block.activatedAt) ?? origin;
    if (block.kind === 'subagent') {
      return { ...block, offset: start - origin, duration: 0 };
    }
    const finish = timestamp(block.finishedAt) ?? observation ?? start;
    return { ...block, offset: start - origin, duration: Math.max(0, finish - start) };
  }
  const blocks = blockSources.map(positionBlock);
  const positionedSubagentBlocks = allSubagentBlocks.map((block) => ({
    ...positionBlock(block),
    laneId: block.laneId,
  }));
  const workflowLanes: TimelineLane[] = run.nodes
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((node) => ({
      laneId: node.id,
      nodeId: node.id,
      title: node.title,
      nodeType: node.type,
      ordinal: node.ordinal,
      kind: 'workflow' as const,
      rowCount: 1,
      blocks: blocks.filter((block) => block.nodeId === node.id),
    }));
  const subagentLanes: TimelineLane[] = (run.subagents ?? []).flatMap((subagent, subagentIndex) =>
    subagent.parentNodeIds.map((parentNodeId, parentIndex) => {
      const parent = run.nodes.find(({ id }) => id === parentNodeId);
      const laneId = `subagent:${parentNodeId}:${subagent.id}`;
      const laneBlocks = positionedSubagentBlocks
        .filter((block) => block.laneId === laneId)
        .toSorted(
          (left, right) =>
            left.invocationSequence - right.invocationSequence || left.id.localeCompare(right.id),
        )
        .map((block, index, siblings) => ({
          ...block,
          row: siblings
            .slice(0, index)
            .filter(({ invocationSequence }) => invocationSequence === block.invocationSequence)
            .length,
        }));
      return {
        laneId,
        nodeId: parentNodeId,
        title: subagent.role,
        nodeType: 'subagent',
        ordinal:
          (parent?.ordinal ?? run.nodes.length) + (subagentIndex + 1) / 100 + parentIndex / 10_000,
        kind: 'subagent' as const,
        rowCount: Math.max(1, ...laneBlocks.map(({ row }) => row + 1)),
        blocks: laneBlocks,
      };
    }),
  );
  const lanes = [...workflowLanes, ...subagentLanes].toSorted(
    (left, right) => left.ordinal - right.ordinal || left.laneId.localeCompare(right.laneId),
  );
  const tickCount = blocks.reduce(
    (maximum, block) => Math.max(maximum, block.invocationSequence),
    0,
  );
  return { lanes, tickCount, span, timeBased };
}
