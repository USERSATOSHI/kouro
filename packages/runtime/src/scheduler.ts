import { ok, type Result } from '@usersatoshi/results';

import type {
  CompiledWorkflowArtifact,
  NodeDefinition,
  NodeInvocation,
  OrchestrationIntent,
  RunState,
  JsonValue,
  ParallelGroup,
} from '@kouro/domain';
import type { RuntimeError } from './errors.ts';
import { selectTransition } from './transitions.ts';

function durationLimitReached(artifact: CompiledWorkflowArtifact, state: RunState): boolean {
  const limit = artifact.bundle.runLimits?.maxDurationMs;
  if (limit === undefined || !state.startedAt || !state.observedAt) return false;
  return Date.parse(state.observedAt) - Date.parse(state.startedAt) >= limit;
}

function activationIntent(
  artifact: CompiledWorkflowArtifact,
  intent: Extract<OrchestrationIntent, { type: 'invocation.activate' }>,
): OrchestrationIntent {
  const limit = artifact.bundle.runLimits?.maxNodeInvocations;
  return limit !== undefined && intent.invocationSequence > limit
    ? { type: 'run.complete', result: 'failed' }
    : intent;
}

function approvalArtifactChecksums(state: RunState): readonly string[] {
  return [
    ...(state.artifacts ?? []).map(({ checksum }) => checksum),
    ...state.invocations.flatMap(({ attempts }) =>
      attempts.flatMap(({ artifacts }) => artifacts?.map(({ checksum }) => checksum) ?? []),
    ),
  ].toSorted();
}

function definitionFor(
  artifact: CompiledWorkflowArtifact,
  invocation: NodeInvocation,
): NodeDefinition {
  const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
  if (!definition) {
    throw new Error(`Projected invocation references unknown node: ${invocation.nodeId}`);
  }
  return definition;
}

function sortInvocations(
  artifact: CompiledWorkflowArtifact,
  invocations: readonly NodeInvocation[],
): NodeInvocation[] {
  return invocations.toSorted((left, right) => {
    const leftDefinition = definitionFor(artifact, left);
    const rightDefinition = definitionFor(artifact, right);
    return (
      leftDefinition.priority - rightDefinition.priority ||
      leftDefinition.ordinal - rightDefinition.ordinal ||
      left.sequence - right.sequence
    );
  });
}

function recoveryIntent(
  definition: NodeDefinition,
  invocation: NodeInvocation,
): OrchestrationIntent {
  const lastAttempt = invocation.attempts.at(-1);
  const attemptNumber = (lastAttempt?.number ?? 0) + 1;

  switch (definition.recoveryPolicy) {
    case 'replay_safe':
      return {
        type: 'attempt.schedule',
        invocationSequence: invocation.sequence,
        attemptNumber,
      };
    case 'verify_then_replay':
      return {
        type: 'effect.verify',
        invocationSequence: invocation.sequence,
        attemptNumber: lastAttempt?.number ?? 1,
      };
    case 'resume_supported':
      return lastAttempt?.resumeToken
        ? {
            type: 'session.resume',
            invocationSequence: invocation.sequence,
            token: lastAttempt.resumeToken,
          }
        : {
            type: 'reconciliation.request',
            invocationSequence: invocation.sequence,
          };
    case 'manual_reconciliation':
      return {
        type: 'reconciliation.request',
        invocationSequence: invocation.sequence,
      };
    case 'never_automatically_retry':
    default:
      return {
        type: 'recovery.halt',
        invocationSequence: invocation.sequence,
      };
  }
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueAtPath(value: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  let current = value;
  for (const segment of path) {
    if (current === undefined) {
      return undefined;
    }
    if (isJsonObject(current)) {
      current = current[segment];
      continue;
    }
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    return undefined;
  }
  return current;
}

function collectionItems(
  state: RunState,
  invocation: NodeInvocation,
  definition: NodeDefinition,
): readonly JsonValue[] | undefined {
  if (!definition.itemsFrom) return undefined;
  const source = state.invocations
    .filter(
      (candidate) =>
        candidate.sequence < invocation.sequence &&
        candidate.nodeId === definition.itemsFrom?.nodeId &&
        candidate.state === 'succeeded',
    )
    .at(-1);
  const value = valueAtPath(source?.output, definition.itemsFrom.path);
  return Array.isArray(value) ? value : undefined;
}

function overlappingPaths(group: ParallelGroup): boolean {
  const paths = new Set<string>();
  for (const branch of group.branches) {
    for (const path of branch.changedPaths ?? []) {
      if (paths.has(path)) return true;
      paths.add(path);
    }
  }
  return false;
}

function groupIntents(
  artifact: CompiledWorkflowArtifact,
  state: RunState,
  group: ParallelGroup,
): readonly OrchestrationIntent[] {
  // Observe branch failures before filling another slot. A failed branch is
  // still marked active until its durable branch-completed event is reduced;
  // activating siblings first could otherwise leave the group unable to reach
  // its terminal join state when the run is interrupted between events.
  const failedBranch = group.branches.find((branch) => {
    if (branch.state !== 'active' || branch.invocationSequence === undefined) return false;
    return (
      state.invocations.find(({ sequence }) => sequence === branch.invocationSequence)?.state ===
      'failed'
    );
  });
  if (failedBranch?.invocationSequence !== undefined) {
    return [
      {
        type: 'parallel.branch.complete',
        groupId: group.id,
        branchId: failedBranch.id,
        invocationSequence: failedBranch.invocationSequence,
        outcome: 'failed',
      },
    ];
  }
  const terminal = group.branches.every(
    ({ state: branchState }) => branchState === 'succeeded' || branchState === 'failed',
  );
  if (terminal) {
    const outcome = group.branches.some(({ state: branchState }) => branchState === 'failed')
      ? 'failed'
      : overlappingPaths(group)
        ? 'conflict'
        : 'succeeded';
    return [{ type: 'parallel.join', groupId: group.id, outcome }];
  }
  const active = group.branches.filter(({ state: branchState }) => branchState === 'active').length;
  const globalLimit = artifact.bundle.runLimits?.maxConcurrentInvocations ?? group.maxConcurrent;
  const available = Math.max(0, Math.min(group.maxConcurrent, globalLimit) - active);
  return group.branches
    .filter(({ state: branchState }) => branchState === 'pending')
    .slice(0, available)
    .map((branch, index) => ({
      type: 'invocation.activate' as const,
      nodeId: branch.entryNodeId,
      invocationSequence: state.nextInvocationSequence + index,
      parallelGroupId: group.id,
      branchId: branch.id,
      ...(branch.input === undefined ? {} : { input: branch.input }),
    }));
}

function branchIsActive(state: RunState, invocation: NodeInvocation): boolean {
  if (!invocation.parallelGroupId || !invocation.branchId) return false;
  const group = state.parallelGroups?.find(({ id }) => id === invocation.parallelGroupId);
  return (
    group?.state === 'active' &&
    group.branches.find(({ id }) => id === invocation.branchId)?.state === 'active'
  );
}

function parallelAttemptIntents(
  artifact: CompiledWorkflowArtifact,
  state: RunState,
  firstPending: NodeInvocation,
): readonly Extract<OrchestrationIntent, { type: 'attempt.schedule' }>[] | undefined {
  if (!firstPending.parallelGroupId || !branchIsActive(state, firstPending)) return undefined;
  const firstDefinition = definitionFor(artifact, firstPending);
  if (firstDefinition.type !== 'agent' && firstDefinition.type !== 'command') return undefined;

  return sortInvocations(
    artifact,
    state.invocations.filter((invocation) => {
      if (
        invocation.state !== 'pending' ||
        invocation.parallelGroupId !== firstPending.parallelGroupId ||
        !branchIsActive(state, invocation)
      ) {
        return false;
      }
      const definition = definitionFor(artifact, invocation);
      return definition.type === 'agent' || definition.type === 'command';
    }),
  ).map((invocation) => ({
    type: 'attempt.schedule',
    invocationSequence: invocation.sequence,
    attemptNumber: invocation.attempts.length + 1,
  }));
}

export function scheduleRun(
  artifact: CompiledWorkflowArtifact,
  state: RunState,
): Result<readonly OrchestrationIntent[], RuntimeError> {
  if (state.status !== 'running' && state.status !== 'waiting') {
    return ok([]);
  }

  if (durationLimitReached(artifact, state)) {
    return ok([{ type: 'run.complete', result: 'failed' }]);
  }

  if (state.invocations.length === 0) {
    return ok([
      activationIntent(artifact, {
        type: 'invocation.activate',
        nodeId: artifact.bundle.entryNodeId,
        invocationSequence: state.nextInvocationSequence,
      }),
    ]);
  }

  const waitingTimer = sortInvocations(
    artifact,
    state.invocations.filter(
      (invocation) =>
        invocation.state === 'waiting' &&
        invocation.wait?.dueAt !== undefined &&
        state.observedAt !== undefined &&
        Date.parse(state.observedAt) >= Date.parse(invocation.wait.dueAt),
    ),
  )[0];
  if (waitingTimer?.wait?.kind === 'timer') {
    return ok([{ type: 'timer.elapse', invocationSequence: waitingTimer.sequence }]);
  }
  if (waitingTimer?.wait?.kind === 'event') {
    return ok([{ type: 'event.timeout', invocationSequence: waitingTimer.sequence }]);
  }

  const interrupted = sortInvocations(
    artifact,
    state.invocations.filter(({ state: invocationState }) => invocationState === 'interrupted'),
  )[0];
  if (interrupted) {
    return ok([recoveryIntent(definitionFor(artifact, interrupted), interrupted)]);
  }

  const failed = sortInvocations(
    artifact,
    state.invocations.filter(
      (invocation) =>
        invocation.state === 'failed' &&
        (!invocation.parallelGroupId || branchIsActive(state, invocation)),
    ),
  )[0];
  if (failed?.parallelGroupId && failed.branchId) {
    return ok([
      {
        type: 'parallel.branch.complete',
        groupId: failed.parallelGroupId,
        branchId: failed.branchId,
        invocationSequence: failed.sequence,
        outcome: 'failed',
      },
    ]);
  }
  if (failed) {
    return ok([{ type: 'run.complete', result: 'failed' }]);
  }

  const pending = sortInvocations(
    artifact,
    state.invocations.filter(({ state: invocationState }) => invocationState === 'pending'),
  )[0];
  if (pending) {
    const definition = definitionFor(artifact, pending);
    const parallelAttempts = parallelAttemptIntents(artifact, state, pending);
    if (parallelAttempts) return ok(parallelAttempts);
    if (definition.type === 'gateway') {
      return ok([
        {
          type: 'invocation.complete',
          invocationSequence: pending.sequence,
          outcome: definition.automaticOutcome ?? 'failed',
        },
      ]);
    }
    if (definition.type === 'branch_return') {
      if (!pending.parallelGroupId || !pending.branchId) return ok([]);
      return ok([
        {
          type: 'parallel.branch.complete',
          groupId: pending.parallelGroupId,
          branchId: pending.branchId,
          invocationSequence: pending.sequence,
          outcome: definition.automaticOutcome === 'failed' ? 'failed' : 'succeeded',
        },
      ]);
    }
    if (definition.type === 'parallel') {
      const branches = Array.isArray(definition.branches) ? definition.branches : [];
      return ok([
        {
          type: 'parallel.fork',
          invocationSequence: pending.sequence,
          groupId: `group:${pending.sequence}`,
          branches: branches.map(({ id, entryNodeId }) => ({ id, entryNodeId })),
          maxConcurrent: definition.maxConcurrent ?? 1,
        },
      ]);
    }
    if (definition.type === 'for_each') {
      const items = collectionItems(state, pending, definition);
      if (!items || items.length > (definition.maxItems ?? 0) || !definition.template) {
        return ok([
          { type: 'invocation.complete', invocationSequence: pending.sequence, outcome: 'failed' },
        ]);
      }
      return ok([
        {
          type: 'collection.expand',
          invocationSequence: pending.sequence,
          groupId: `group:${pending.sequence}`,
          items,
          entryNodeId: definition.template.entryNodeId,
          maxConcurrent: definition.maxConcurrent ?? 1,
        },
      ]);
    }
    if (definition.type === 'sleep') {
      return ok([
        {
          type: 'timer.schedule',
          invocationSequence: pending.sequence,
          durationMs: definition.durationMs ?? 0,
        },
      ]);
    }
    if (definition.type === 'wait_for_event') {
      return ok([
        {
          type: 'event.wait',
          invocationSequence: pending.sequence,
          event: definition.event ?? '',
          ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
        },
      ]);
    }
    if (definition.type === 'approval' || definition.type === 'delivery_review') {
      const proposal = state.delivery?.proposal;
      if (definition.type === 'delivery_review' && !proposal) {
        return ok([]);
      }
      return ok([
        {
          type: 'approval.request',
          invocationSequence: pending.sequence,
          binding: {
            workflowChecksum: artifact.checksum,
            invocationSequence: pending.sequence,
            artifactChecksums: approvalArtifactChecksums(state),
            resolvedAction: definition.title ?? '',
            repositoryHead: state.repositoryHead,
            ...(definition.type === 'delivery_review' && proposal
              ? {
                  preparedTree: proposal.preparedTree,
                  proposalChecksum: proposal.checksum,
                }
              : {}),
          },
        },
      ]);
    }
    if (definition.type === 'complete') {
      return ok([{ type: 'run.complete', result: definition.result ?? 'succeeded' }]);
    }
    return ok([
      {
        type: 'attempt.schedule',
        invocationSequence: pending.sequence,
        attemptNumber: pending.attempts.length + 1,
      },
    ]);
  }

  const completed = sortInvocations(
    artifact,
    state.invocations.filter(
      (invocation) =>
        invocation.state === 'succeeded' &&
        !invocation.selectedTransitionId &&
        (!invocation.parallelGroupId || branchIsActive(state, invocation)),
    ),
  )[0];
  if (!completed) {
    const group = (state.parallelGroups ?? []).find(
      ({ state: groupState }) => groupState === 'active',
    );
    return group ? ok(groupIntents(artifact, state, group)) : ok([]);
  }

  if (completed.parallelGroupId && completed.branchId) {
    const definition = definitionFor(artifact, completed);
    if (definition.type === 'branch_return') {
      return ok([
        {
          type: 'parallel.branch.complete',
          groupId: completed.parallelGroupId,
          branchId: completed.branchId,
          invocationSequence: completed.sequence,
          outcome: completed.outcome === 'failed' ? 'failed' : 'succeeded',
        },
      ]);
    }
  }

  const transition = selectTransition(artifact.bundle, state, completed);
  if (transition.isErr()) {
    return transition;
  }
  const selectedTransition = transition.unwrap();

  return ok([
    activationIntent(artifact, {
      type: 'invocation.activate',
      nodeId: selectedTransition.toNodeId,
      invocationSequence: state.nextInvocationSequence,
      sourceInvocationSequence: completed.sequence,
      transitionId: selectedTransition.id,
      ...(completed.parallelGroupId ? { parallelGroupId: completed.parallelGroupId } : {}),
      ...(completed.branchId ? { branchId: completed.branchId } : {}),
      ...(completed.input === undefined ? {} : { input: completed.input }),
    }),
  ]);
}
