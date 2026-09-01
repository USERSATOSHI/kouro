import { createHash } from 'node:crypto';

import type {
  CompiledWorkflowArtifact,
  NodeInvocation,
  RunState,
  RunTrace,
  TraceSpan,
} from '@kouro/domain';

function hash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function invocationStatus(invocation: NodeInvocation): TraceSpan['status'] {
  return invocation.state === 'failed' ||
    invocation.state === 'cancelled' ||
    invocation.outcome === 'failed' ||
    invocation.outcome === 'conflict'
    ? 'error'
    : invocation.state === 'succeeded'
      ? 'ok'
      : 'unset';
}

function invocationParentSequence(state: RunState, invocation: NodeInvocation): number | undefined {
  if (invocation.parallelGroupId) {
    return state.parallelGroups?.find(({ id }) => id === invocation.parallelGroupId)
      ?.ownerInvocationSequence;
  }
  return invocation.sourceInvocationSequence;
}

/** Derives stable portable spans without reading clocks or mutable infrastructure. */
export function deriveRunTrace(
  runId: string,
  artifact: CompiledWorkflowArtifact,
  state: RunState,
): RunTrace {
  const traceId = hash(`kouro:trace:${runId}:${artifact.checksum}`, 32);
  const runSpanId = hash(`kouro:span:${traceId}:run`, 16);
  const invocationSpanIds = new Map(
    state.invocations.map((invocation) => [
      invocation.sequence,
      hash(`kouro:span:${traceId}:invocation:${invocation.sequence}`, 16),
    ]),
  );
  const spans: TraceSpan[] = [
    {
      traceId,
      spanId: runSpanId,
      name: `kouro.run ${artifact.bundle.manifest.id}`,
      kind: 'run',
      status:
        state.status === 'succeeded'
          ? 'ok'
          : state.status === 'failed' || state.status === 'cancelled'
            ? 'error'
            : 'unset',
      ...(state.startedAt ? { startedAt: state.startedAt } : {}),
      ...(state.finishedAt
        ? { finishedAt: state.finishedAt }
        : state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled'
          ? {
              finishedAt: state.invocations
                .map(({ finishedAt }) => finishedAt)
                .filter((value) => value !== undefined)
                .toSorted()
                .at(-1),
            }
          : {}),
      attributes: {
        'kouro.run.id': runId,
        'kouro.workflow.id': artifact.bundle.manifest.id,
        'kouro.workflow.version': artifact.bundle.manifest.version,
        'kouro.workflow.checksum': artifact.checksum,
      },
    },
  ];
  for (const invocation of state.invocations.toSorted(
    (left, right) => left.sequence - right.sequence,
  )) {
    const invocationSpanId = invocationSpanIds.get(invocation.sequence);
    if (!invocationSpanId) throw new Error(`Missing invocation span ID: ${invocation.sequence}`);
    const parentSequence = invocationParentSequence(state, invocation);
    const branch = invocation.parallelGroupId
      ? state.parallelGroups
          ?.find(({ id }) => id === invocation.parallelGroupId)
          ?.branches.find(({ id }) => id === invocation.branchId)
      : undefined;
    spans.push({
      traceId,
      spanId: invocationSpanId,
      parentSpanId: parentSequence
        ? (invocationSpanIds.get(parentSequence) ?? runSpanId)
        : runSpanId,
      name: `kouro.invocation ${invocation.nodeId}`,
      kind: 'invocation',
      status: invocationStatus(invocation),
      ...(invocation.activatedAt ? { startedAt: invocation.activatedAt } : {}),
      ...(invocation.finishedAt ? { finishedAt: invocation.finishedAt } : {}),
      attributes: {
        'kouro.run.id': runId,
        'kouro.node.id': invocation.nodeId,
        'kouro.invocation.sequence': invocation.sequence,
        ...(invocation.parallelGroupId
          ? { 'kouro.parallel.group_id': invocation.parallelGroupId }
          : {}),
        ...(invocation.branchId ? { 'kouro.parallel.branch_id': invocation.branchId } : {}),
        ...(branch?.workspaceId ? { 'kouro.workspace.id': branch.workspaceId } : {}),
        ...(invocation.scope ? { 'kouro.invocation.scope': invocation.scope.kind } : {}),
      },
    });
    for (const attempt of invocation.attempts) {
      spans.push({
        traceId,
        spanId: hash(`kouro:span:${traceId}:attempt:${invocation.sequence}:${attempt.number}`, 16),
        parentSpanId: invocationSpanId,
        name: `kouro.attempt ${invocation.nodeId}#${attempt.number}`,
        kind: 'attempt',
        status:
          attempt.state === 'succeeded'
            ? 'ok'
            : attempt.state === 'failed' || attempt.state === 'cancelled'
              ? 'error'
              : 'unset',
        ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
        ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
        attributes: {
          'kouro.run.id': runId,
          'kouro.invocation.sequence': invocation.sequence,
          'kouro.attempt.number': attempt.number,
          ...(attempt.harnessId ? { 'kouro.harness.id': attempt.harnessId } : {}),
          ...(attempt.model ? { 'kouro.model': attempt.model } : {}),
        },
      });
    }
  }
  return { runId, traceId, spans };
}
