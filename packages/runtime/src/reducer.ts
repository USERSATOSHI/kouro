import { ok, type Result } from '@usersatoshi/results';

import type {
  ApprovalBinding,
  ArtifactReference,
  CompiledWorkflowArtifact,
  DeliveryMetadata,
  NodeAttempt,
  NodeInvocation,
  RunEvent,
  RunState,
  SkipBinding,
  SubagentExecutionSummary,
  TokenUsage,
} from '@kouro/domain';
import { RuntimeErrorKind, toRuntimeError, type RuntimeError } from './errors.ts';
import { agentHarnessesForNode } from './harness-routing.ts';
import { selectTransition } from './transitions.ts';

function approvalBindingsEqual(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return (
    left.workflowChecksum === right.workflowChecksum &&
    left.invocationSequence === right.invocationSequence &&
    left.resolvedAction === right.resolvedAction &&
    left.repositoryHead === right.repositoryHead &&
    left.preparedTree === right.preparedTree &&
    left.proposalChecksum === right.proposalChecksum &&
    left.artifactChecksums.length === right.artifactChecksums.length &&
    left.artifactChecksums.every((checksum, index) => checksum === right.artifactChecksums[index])
  );
}

function validArtifactReference(artifact: ArtifactReference): boolean {
  return (
    artifact.id.trim().length > 0 &&
    artifact.mediaType.trim().length > 0 &&
    /^sha256:[0-9a-f]{64}$/.test(artifact.checksum) &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0
  );
}

function validTokenUsage(usage: TokenUsage): boolean {
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? [usage.cacheReadTokens] : []),
    ...(usage.cacheWriteTokens !== undefined ? [usage.cacheWriteTokens] : []),
    ...(usage.reasoningTokens !== undefined ? [usage.reasoningTokens] : []),
  ];
  return counts.length >= 2 && counts.every((count) => Number.isSafeInteger(count) && count >= 0);
}

function validJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(validJsonValue);
  if (typeof value !== 'object') return false;
  return Object.values(value).every(validJsonValue);
}

function validSubagentSummaries(subagents: readonly SubagentExecutionSummary[]): boolean {
  const callIds = new Set<string>();
  return subagents.every((subagent, index) => {
    if (callIds.has(subagent.callId)) return false;
    callIds.add(subagent.callId);
    return (
      subagent.sequence === index + 1 &&
      subagent.callId.trim().length > 0 &&
      subagent.subagentId.trim().length > 0 &&
      subagent.task.trim().length > 0 &&
      subagent.harnessId.trim().length > 0 &&
      (subagent.model === undefined || subagent.model.trim().length > 0) &&
      (subagent.reasoningEffort === undefined ||
        ['low', 'medium', 'high'].includes(subagent.reasoningEffort)) &&
      (subagent.state === 'succeeded' || subagent.state === 'failed') &&
      (subagent.error === undefined || subagent.error.trim().length > 0) &&
      (subagent.usage === undefined || validTokenUsage(subagent.usage)) &&
      (subagent.output === undefined || validJsonValue(subagent.output))
    );
  });
}

function validDeliveryMetadata(metadata: DeliveryMetadata): boolean {
  return (
    Boolean(metadata.commitTitle.trim()) &&
    !/[\r\n]/.test(metadata.commitTitle) &&
    Boolean(metadata.pullRequestTitle.trim()) &&
    !/[\r\n]/.test(metadata.pullRequestTitle) &&
    typeof metadata.draft === 'boolean'
  );
}

function artifactChecksums(state: RunState): readonly string[] {
  return [
    ...(state.artifacts ?? []).map(({ checksum }) => checksum),
    ...state.invocations.flatMap(({ attempts }) =>
      attempts.flatMap(({ artifacts }) => artifacts?.map(({ checksum }) => checksum) ?? []),
    ),
  ].toSorted();
}

function skipBindingsEqual(left: SkipBinding, right: SkipBinding): boolean {
  return (
    left.workflowChecksum === right.workflowChecksum &&
    left.invocationSequence === right.invocationSequence &&
    left.selectedOutcome === right.selectedOutcome &&
    left.repositoryHead === right.repositoryHead &&
    left.artifactChecksums.length === right.artifactChecksums.length &&
    left.artifactChecksums.every((checksum, index) => checksum === right.artifactChecksums[index])
  );
}

function timestampMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value
    ? undefined
    : milliseconds;
}

function durationLimitReached(artifact: CompiledWorkflowArtifact, state: RunState): boolean {
  const limit = artifact.bundle.runLimits?.maxDurationMs;
  const startedAt = timestampMilliseconds(state.startedAt);
  const observedAt = timestampMilliseconds(state.observedAt);
  return (
    limit !== undefined &&
    startedAt !== undefined &&
    observedAt !== undefined &&
    observedAt - startedAt >= limit
  );
}

function replaceInvocation(
  state: RunState,
  sequence: number,
  update: (invocation: NodeInvocation) => Result<NodeInvocation, RuntimeError>,
): Result<RunState, RuntimeError> {
  const invocation = state.invocations.find((candidate) => candidate.sequence === sequence);
  if (!invocation) {
    return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
      invocationSequence: sequence,
    });
  }
  const updated = update(invocation);
  if (updated.isErr()) {
    return updated;
  }
  const updatedInvocation = updated.unwrap();
  const invocations = state.invocations.map((candidate) =>
    candidate.sequence === sequence ? updatedInvocation : candidate,
  );
  return ok({ ...state, invocations });
}

function reduceEvent(
  artifact: CompiledWorkflowArtifact,
  state: RunState | undefined,
  event: RunEvent,
): Result<RunState, RuntimeError> {
  if (event.type === 'run.created') {
    if (event.workflowChecksum !== artifact.checksum) {
      return toRuntimeError(RuntimeErrorKind.WorkflowChecksumMismatch, {
        expected: artifact.checksum,
        received: event.workflowChecksum,
      });
    }
    if (state) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    if (event.startedAt !== undefined && timestampMilliseconds(event.startedAt) === undefined) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run-clock',
        from: 'uninitialized',
        event: event.type,
      });
    }
    return ok({
      workflowChecksum: artifact.checksum,
      startingCommit: event.startingCommit,
      repositoryHead: event.startingCommit,
      configuration: event.configuration,
      ...(event.startedAt === undefined
        ? {}
        : { startedAt: event.startedAt, observedAt: event.startedAt }),
      status: 'running',
      nextInvocationSequence: 1,
      counters: Object.fromEntries(
        Object.keys(artifact.bundle.counterLimits)
          .toSorted()
          .map((counter) => [counter, 0]),
      ),
      invocations: [],
    });
  }

  if (!state) {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: 'uninitialized',
      event: event.type,
    });
  }

  if (event.type === 'delivery.publication_started') {
    if (!state.delivery?.commit || !event.remote.trim()) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'delivery-publication',
        from: state.status,
        event: event.type,
      });
    }
    return ok({
      ...state,
      delivery: {
        ...state.delivery,
        publication: {
          status: 'publishing',
          provider: event.provider,
          remote: event.remote,
        },
      },
    });
  }

  if (event.type === 'delivery.publication_succeeded') {
    if (
      !state.delivery?.commit ||
      state.delivery.publication.status !== 'publishing' ||
      !event.remote.trim() ||
      !event.url.trim() ||
      !Number.isSafeInteger(event.number) ||
      event.number <= 0
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'delivery-publication',
        from: state.status,
        event: event.type,
      });
    }
    return ok({
      ...state,
      delivery: {
        ...state.delivery,
        publication: {
          status: 'published',
          provider: event.provider,
          remote: event.remote,
          number: event.number,
          url: event.url,
        },
      },
    });
  }

  if (event.type === 'delivery.publication_failed') {
    if (!state.delivery?.commit || !event.remote.trim() || !event.error.trim()) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'delivery-publication',
        from: state.status,
        event: event.type,
      });
    }
    return ok({
      ...state,
      delivery: {
        ...state.delivery,
        publication: {
          status: 'failed',
          provider: event.provider,
          remote: event.remote,
          error: event.error,
        },
      },
    });
  }

  if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: state.status,
      event: event.type,
    });
  }

  if (event.type === 'run.time_observed') {
    const observedAt = timestampMilliseconds(event.observedAt);
    const previous = timestampMilliseconds(state.observedAt ?? state.startedAt);
    if (
      state.status !== 'running' ||
      observedAt === undefined ||
      (previous !== undefined && observedAt < previous)
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run-clock',
        from: state.status,
        event: event.type,
      });
    }
    return ok({ ...state, observedAt: event.observedAt });
  }

  if (event.type === 'run.paused') {
    if (
      !event.actor.trim() ||
      (state.status !== 'running' && state.status !== 'waiting_for_approval')
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    return ok({ ...state, status: 'paused' });
  }

  if (event.type === 'run.resumed') {
    if (state.status !== 'paused' || !event.actor.trim()) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    const waiting = state.invocations.some(
      ({ state: invocationState }) => invocationState === 'waiting_for_approval',
    );
    return ok({ ...state, status: waiting ? 'waiting_for_approval' : 'running' });
  }

  if (event.type === 'run.cancelled') {
    if (!event.actor.trim() || !event.reason.trim()) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    return ok({
      ...state,
      status: 'cancelled',
      invocations: state.invocations.map((invocation) =>
        ['succeeded', 'failed', 'cancelled'].includes(invocation.state)
          ? invocation
          : {
              ...invocation,
              state: 'cancelled',
              attempts: invocation.attempts.map((attempt) =>
                attempt.state === 'running' ? { ...attempt, state: 'cancelled' } : attempt,
              ),
            },
      ),
    });
  }

  if (
    state.status === 'waiting_for_approval' &&
    event.type !== 'approval.granted' &&
    event.type !== 'approval.rejected' &&
    event.type !== 'approval.changes_requested' &&
    event.type !== 'delivery.metadata_updated' &&
    event.type !== 'invocation.skipped'
  ) {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: state.status,
      event: event.type,
    });
  }

  if (event.type === 'invocation.activated') {
    if (state.status !== 'running') {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    if (event.invocationSequence !== state.nextInvocationSequence) {
      return toRuntimeError(RuntimeErrorKind.InvalidInvocationSequence, {
        expected: state.nextInvocationSequence,
        received: event.invocationSequence,
      });
    }
    if (!artifact.bundle.nodes.some(({ id }) => id === event.nodeId)) {
      return toRuntimeError(RuntimeErrorKind.UnknownNode, {
        nodeId: event.nodeId,
      });
    }

    let counters = state.counters;
    let invocations = state.invocations;
    if (event.transitionId === undefined) {
      if (
        state.invocations.length !== 0 ||
        event.nodeId !== artifact.bundle.entryNodeId ||
        event.sourceInvocationSequence !== undefined
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: 'invocation',
          from: state.status,
          event: event.type,
        });
      }
    } else {
      const transition = artifact.bundle.transitions.find(({ id }) => id === event.transitionId);
      const source =
        event.sourceInvocationSequence === undefined
          ? undefined
          : state.invocations.find(({ sequence }) => sequence === event.sourceInvocationSequence);
      if (
        !transition ||
        !source ||
        source.selectedTransitionId ||
        transition.from.nodeId !== source.nodeId ||
        transition.from.outcome !== source.outcome ||
        transition.toNodeId !== event.nodeId
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: 'transition',
          from: source?.state ?? 'unknown',
          event: event.type,
        });
      }
      const selected = selectTransition(artifact.bundle, state, source);
      if (selected.isErr()) {
        return selected;
      }
      if (selected.unwrap().id !== transition.id) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: 'transition',
          from: source.state,
          event: event.type,
        });
      }
      if (transition.increment) {
        const current = counters[transition.increment];
        if (current === undefined) {
          return toRuntimeError(RuntimeErrorKind.UnknownCounter, {
            counter: transition.increment,
          });
        }
        counters = {
          ...counters,
          [transition.increment]: current + 1,
        };
      }
      invocations = invocations.map((invocation) =>
        invocation.sequence === source.sequence
          ? { ...invocation, selectedTransitionId: transition.id }
          : invocation,
      );
    }

    return ok({
      ...state,
      counters,
      invocations: [
        ...invocations,
        {
          sequence: event.invocationSequence,
          nodeId: event.nodeId,
          state: 'pending',
          attempts: [],
        },
      ],
      nextInvocationSequence: state.nextInvocationSequence + 1,
    });
  }

  if (event.type === 'attempt.started') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const expected = invocation.attempts.length + 1;
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (definition?.type !== 'agent' && definition?.type !== 'command') {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `invocation:${invocation.sequence}`,
          from: invocation.state,
          event: event.type,
        });
      }
      if (
        event.attemptNumber !== expected ||
        !['pending', 'interrupted'].includes(invocation.state) ||
        (invocation.state === 'interrupted' && definition?.recoveryPolicy !== 'replay_safe')
      ) {
        return toRuntimeError(RuntimeErrorKind.InvalidAttemptNumber, {
          invocationSequence: invocation.sequence,
          expected,
          received: event.attemptNumber,
        });
      }
      if (definition.type === 'agent') {
        const expectedHarness = agentHarnessesForNode(
          state.configuration,
          definition.id,
          definition.harness,
        )?.[event.attemptNumber - 1];
        const expectedModel = expectedHarness ? definition.models?.[expectedHarness] : undefined;
        if (
          !expectedHarness ||
          event.harnessId !== expectedHarness ||
          event.model !== expectedModel
        ) {
          return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
            entity: `attempt:${event.attemptNumber}`,
            from: invocation.state,
            event: 'attempt.started:execution_selection_mismatch',
          });
        }
      } else if (event.harnessId !== undefined || event.model !== undefined) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: 'attempt.started:unexpected_agent_selection',
        });
      }
      const attempt: NodeAttempt = {
        number: event.attemptNumber,
        state: 'running',
        ...(event.harnessId ? { harnessId: event.harnessId } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.resumeToken ? { resumeToken: event.resumeToken } : {}),
      };
      return ok({
        ...invocation,
        state: 'active',
        attempts: [...invocation.attempts, attempt],
      });
    });
  }

  if (event.type === 'attempt.resumed') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'interrupted' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        attempt.resumeToken !== event.resumeToken ||
        attempt.harnessId !== event.harnessId
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: 'active',
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number ? { ...candidate, state: 'running' } : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.resume_token_recorded') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        attempt.resumeToken !== undefined ||
        !event.resumeToken.trim()
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? { ...candidate, resumeToken: event.resumeToken }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.artifact_published') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        !validArtifactReference(event.artifact) ||
        attempt.artifacts?.some(({ id }) => id === event.artifact.id)
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? { ...candidate, artifacts: [...(candidate.artifacts ?? []), event.artifact] }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.usage_recorded') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        !validTokenUsage(event.usage)
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number ? { ...candidate, usage: event.usage } : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.subagents_recorded') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        attempt.subagents !== undefined ||
        !validSubagentSummaries(event.subagents) ||
        event.subagents.some(({ subagentId }) => !definition.allowedSubagents?.includes(subagentId))
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? { ...candidate, subagents: event.subagents }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'run.artifact_published') {
    if (
      !validArtifactReference(event.artifact) ||
      state.artifacts?.some(({ id }) => id === event.artifact.id)
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run-artifact',
        from: state.status,
        event: event.type,
      });
    }
    return ok({ ...state, artifacts: [...(state.artifacts ?? []), event.artifact] });
  }

  if (event.type === 'attempt.failed') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      const fallbackExists =
        definition?.type === 'agent' &&
        typeof agentHarnessesForNode(state.configuration, definition.id, definition.harness)?.[
          event.attemptNumber
        ] === 'string';
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        !event.failure.kind.trim() ||
        !event.failure.message.trim() ||
        (event.retry === 'fallback' && !fallbackExists)
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: event.retry === 'fallback' ? 'pending' : 'failed',
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? { ...candidate, state: 'failed', failure: event.failure }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.interrupted' || event.type === 'attempt.interrupt_requested') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      if (
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        (event.type === 'attempt.interrupt_requested' &&
          (!event.actor.trim() || !event.reason.trim()))
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: 'interrupted',
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number ? { ...candidate, state: 'interrupted' } : candidate,
        ),
      });
    });
  }

  if (event.type === 'agent.steering_requested') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      const attempt = invocation.attempts.at(-1);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.state !== 'running' ||
        attempt.number !== event.attemptNumber ||
        !event.actor.trim() ||
        !event.message.trim()
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? {
                ...candidate,
                steering: [
                  ...(candidate.steering ?? []),
                  {
                    requestSequence: event.sequence,
                    actor: event.actor,
                    message: event.message,
                    state: 'pending' as const,
                  },
                ],
              }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'agent.steering_applied' || event.type === 'agent.steering_rejected') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const steering = attempt?.steering?.find(
        ({ requestSequence }) => requestSequence === event.requestSequence,
      );
      if (
        !attempt ||
        attempt.number !== event.attemptNumber ||
        steering?.state !== 'pending' ||
        (event.type === 'agent.steering_rejected' && !event.reason.trim())
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `steering:${event.requestSequence}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? {
                ...candidate,
                steering: candidate.steering?.map((request) =>
                  request.requestSequence === event.requestSequence
                    ? {
                        ...request,
                        state:
                          event.type === 'agent.steering_applied'
                            ? ('applied' as const)
                            : ('rejected' as const),
                        ...(event.type === 'agent.steering_rejected'
                          ? { reason: event.reason }
                          : {}),
                      }
                    : request,
                ),
              }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'invocation.retry_requested') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        invocation.state !== 'interrupted' ||
        definition?.recoveryPolicy !== 'replay_safe' ||
        !event.actor.trim() ||
        !event.reason.trim()
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `invocation:${invocation.sequence}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({ ...invocation, state: 'pending' });
    });
  }

  if (event.type === 'invocation.skipped') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.binding.invocationSequence,
    );
    if (!invocation) {
      return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
        invocationSequence: event.binding.invocationSequence,
      });
    }
    const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
    const expected: SkipBinding = {
      workflowChecksum: artifact.checksum,
      invocationSequence: invocation.sequence,
      artifactChecksums: artifactChecksums(state),
      selectedOutcome: definition?.skipOutcome ?? '',
      repositoryHead: state.repositoryHead,
    };
    if (
      !['pending', 'interrupted', 'waiting_for_approval'].includes(invocation.state) ||
      !definition?.skipOutcome ||
      !event.actor.trim() ||
      !event.reason.trim() ||
      !skipBindingsEqual(event.binding, expected)
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: `invocation:${invocation.sequence}`,
        from: invocation.state,
        event: event.type,
      });
    }
    const updated = replaceInvocation(state, invocation.sequence, (current) =>
      ok({
        ...current,
        state: 'succeeded',
        outcome: event.binding.selectedOutcome,
      }),
    );
    if (updated.isErr()) return updated;
    return ok({ ...updated.unwrap(), status: 'running' });
  }

  if (event.type === 'invocation.completed') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        invocation.state !== 'active' ||
        !attempt ||
        (definition?.type !== 'agent' && definition?.type !== 'command')
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `invocation:${invocation.sequence}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: 'succeeded',
        outcome: event.outcome,
        ...(event.output !== undefined ? { output: event.output } : {}),
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number ? { ...candidate, state: 'succeeded' } : candidate,
        ),
      });
    });
  }

  if (event.type === 'delivery.proposed') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.proposal.invocationSequence,
    );
    const definition = artifact.bundle.nodes.find(({ id }) => id === invocation?.nodeId);
    if (
      invocation?.state !== 'pending' ||
      definition?.type !== 'delivery_review' ||
      state.delivery?.commit !== undefined ||
      !event.proposal.preparedHead.trim() ||
      !event.proposal.preparedTree.trim() ||
      !/^sha256:[0-9a-f]{64}$/.test(event.proposal.checksum) ||
      !validDeliveryMetadata(event.proposal.metadata) ||
      event.proposal.artifactChecksums.some((checksum) => !checksum.trim())
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'delivery-proposal',
        from: invocation?.state ?? 'unknown',
        event: event.type,
      });
    }
    return ok({
      ...state,
      delivery: {
        proposal: event.proposal,
        repairsUsed: state.delivery?.repairsUsed ?? 0,
        publication: state.delivery?.publication ?? { status: 'not_published' },
      },
    });
  }

  if (event.type === 'delivery.metadata_updated') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.invocationSequence,
    );
    if (
      invocation?.state !== 'waiting_for_approval' ||
      !state.delivery?.proposal ||
      state.delivery.proposal.invocationSequence !== event.invocationSequence ||
      !event.actor.trim() ||
      !validDeliveryMetadata(event.metadata) ||
      !/^sha256:[0-9a-f]{64}$/.test(event.checksum)
    ) {
      return toRuntimeError(RuntimeErrorKind.StaleApproval, {
        invocationSequence: event.invocationSequence,
        reason: 'delivery metadata update is stale or incomplete',
      });
    }
    const proposal = {
      ...state.delivery.proposal,
      metadata: event.metadata,
      checksum: event.checksum,
    };
    return ok({
      ...state,
      delivery: { ...state.delivery, proposal },
      invocations: state.invocations.map((candidate) =>
        candidate.sequence === invocation.sequence
          ? {
              ...candidate,
              approval: candidate.approval
                ? { ...candidate.approval, proposalChecksum: event.checksum }
                : candidate.approval,
            }
          : candidate,
      ),
    });
  }

  if (event.type === 'delivery.committed') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.invocationSequence,
    );
    if (
      invocation?.state !== 'succeeded' ||
      invocation.outcome !== 'approved' ||
      !state.delivery?.proposal ||
      state.delivery.proposal.preparedTree !== event.preparedTree ||
      state.delivery.commit !== undefined ||
      !event.commit.trim() ||
      !event.branch.trim()
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'delivery-commit',
        from: invocation?.state ?? 'unknown',
        event: event.type,
      });
    }
    return ok({
      ...state,
      repositoryHead: event.commit,
      delivery: {
        ...state.delivery,
        commit: event.commit,
        branch: event.branch,
      },
    });
  }

  if (event.type === 'approval.requested') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.binding.invocationSequence,
    );
    if (!invocation) {
      return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
        invocationSequence: event.binding.invocationSequence,
      });
    }
    const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
    const proposal = definition?.type === 'delivery_review' ? state.delivery?.proposal : undefined;
    const expected: ApprovalBinding = {
      workflowChecksum: artifact.checksum,
      invocationSequence: invocation.sequence,
      artifactChecksums: artifactChecksums(state),
      resolvedAction: definition?.title ?? '',
      repositoryHead: state.repositoryHead,
      ...(proposal
        ? { preparedTree: proposal.preparedTree, proposalChecksum: proposal.checksum }
        : {}),
    };
    if (
      invocation.state !== 'pending' ||
      (definition?.type !== 'approval' && definition?.type !== 'delivery_review') ||
      (definition.type === 'delivery_review' && !proposal) ||
      !approvalBindingsEqual(event.binding, expected)
    ) {
      return toRuntimeError(RuntimeErrorKind.StaleApproval, {
        invocationSequence: invocation.sequence,
        reason: 'approval request does not match projected action',
      });
    }
    const updated = replaceInvocation(state, invocation.sequence, (current) =>
      ok({
        ...current,
        state: 'waiting_for_approval',
        approval: event.binding,
      }),
    );
    if (updated.isErr()) return updated;
    return ok({
      ...updated.unwrap(),
      status: 'waiting_for_approval',
    });
  }

  if (
    event.type === 'approval.granted' ||
    event.type === 'approval.rejected' ||
    event.type === 'approval.changes_requested'
  ) {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.binding.invocationSequence,
    );
    if (!invocation) {
      return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
        invocationSequence: event.binding.invocationSequence,
      });
    }
    if (
      state.status !== 'waiting_for_approval' ||
      invocation.state !== 'waiting_for_approval' ||
      !invocation.approval ||
      !approvalBindingsEqual(event.binding, invocation.approval) ||
      !event.actor.trim() ||
      !event.reason.trim()
    ) {
      return toRuntimeError(RuntimeErrorKind.StaleApproval, {
        invocationSequence: invocation.sequence,
        reason: 'approval decision is stale or incomplete',
      });
    }
    const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
    if (
      event.type === 'approval.changes_requested' &&
      (definition?.type !== 'delivery_review' || (state.delivery?.repairsUsed ?? 0) >= 2)
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: `invocation:${invocation.sequence}`,
        from: invocation.state,
        event: event.type,
      });
    }
    const outcome =
      event.type === 'approval.granted'
        ? 'approved'
        : event.type === 'approval.changes_requested'
          ? 'changes_requested'
          : 'rejected';
    const updated = replaceInvocation(state, invocation.sequence, (current) =>
      ok({
        ...current,
        state: 'succeeded',
        outcome,
        output: { reason: event.reason },
      }),
    );
    if (updated.isErr()) return updated;
    const next = updated.unwrap();
    return ok({
      ...next,
      status: 'running',
      ...(event.type === 'approval.changes_requested' && next.delivery
        ? {
            delivery: {
              ...next.delivery,
              proposal: undefined,
              repairsUsed: next.delivery.repairsUsed + 1,
            },
          }
        : {}),
    });
  }

  if (event.type === 'run.completed') {
    const completeInvocation = state.invocations.find((invocation) => {
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      return invocation.state === 'pending' && definition?.type === 'complete';
    });
    const completeResult = completeInvocation
      ? (artifact.bundle.nodes.find(({ id }) => id === completeInvocation.nodeId)?.result ??
        'succeeded')
      : undefined;
    const failedInvocation = state.invocations.some(
      ({ state: invocationState }) => invocationState === 'failed',
    );
    const invocationLimitReached =
      artifact.bundle.runLimits?.maxNodeInvocations !== undefined &&
      state.nextInvocationSequence > artifact.bundle.runLimits.maxNodeInvocations &&
      state.invocations.some(
        ({ state: invocationState, selectedTransitionId }) =>
          invocationState === 'succeeded' && selectedTransitionId === undefined,
      ) &&
      !state.invocations.some(({ state: invocationState }) =>
        ['pending', 'active', 'interrupted', 'waiting_for_approval'].includes(invocationState),
      );
    const expectedTerminalResult =
      completeResult ??
      (failedInvocation || invocationLimitReached || durationLimitReached(artifact, state)
        ? 'failed'
        : undefined);
    if (state.status !== 'running' || event.result !== expectedTerminalResult) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    return ok({
      ...state,
      status: event.result,
    });
  }

  return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
    entity: 'run-event',
    from: state.status,
    event: 'unknown',
  });
}

export function reduceRun(
  artifact: CompiledWorkflowArtifact,
  events: readonly RunEvent[],
): Result<RunState, RuntimeError> {
  let state: RunState | undefined;

  let expected = 1;
  for (const event of events) {
    if (event.sequence !== expected) {
      return toRuntimeError(RuntimeErrorKind.InvalidEventSequence, {
        expected,
        received: event.sequence,
      });
    }

    const next = reduceEvent(artifact, state, event);
    if (next.isErr()) {
      return next;
    }
    state = next.unwrap();
    expected += 1;
  }

  if (!state) {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: 'uninitialized',
      event: 'history.ended',
    });
  }

  return ok(state);
}
