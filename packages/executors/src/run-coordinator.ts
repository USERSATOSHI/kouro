import type {
  AgentReasoningEffort,
  ApprovalBinding,
  ArtifactReference,
  DeliveryMetadata,
  DeliveryProposal,
  JsonValue,
  NodeDefinition,
  NodeInvocation,
  OrchestrationIntent,
  RunEventInput,
  SkipBinding,
  SubagentExecutionSummary,
  TokenUsage,
} from '@kouro/domain';
import { agentHarnessesForNode, scheduleRun } from '@kouro/runtime';
import { ok, type Result } from '@usersatoshi/results';

import { ExecutorErrorKind, toExecutorError, type ExecutorError } from './errors.ts';
import {
  AgentExecutor,
  AgentExecutorErrorKind,
  type AgentExecutorError,
} from './agent-executor.ts';
import type {
  AgentControlChannel,
  CommandRunner,
  Clock,
  CreateRunInput,
  RunAggregate,
  RunStore,
  RunStoreError,
} from './ports.ts';
import { RunStoreErrorKind } from './ports.ts';

const systemClock: Clock = {
  now(): string {
    return new Date().toISOString();
  },
};

function fromStore<T>(result: Result<T, RunStoreError>): Result<T, ExecutorError> {
  return result.isErr()
    ? toExecutorError(ExecutorErrorKind.RunStore, { error: result.error })
    : result;
}

function appendLatestEvent(
  store: RunStore,
  runId: string,
  idempotencyKey: string,
  event: RunEventInput,
): Result<RunAggregate, ExecutorError> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const loaded = fromStore(store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const appended = store.appendEvent({
      runId,
      expectedSequence: loaded.unwrap().nextEventSequence,
      idempotencyKey,
      event,
    });
    if (appended.isOk() || appended.error.kind !== RunStoreErrorKind.EventSequenceConflict) {
      return fromStore(appended);
    }
  }
  return toExecutorError(ExecutorErrorKind.RunStore, {
    error: {
      kind: RunStoreErrorKind.DatabaseFailure,
      operation: 'appendLatestEvent',
      message: 'Event sequence remained unstable after bounded retries',
    },
  });
}

function definitionFor(
  aggregate: RunAggregate,
  invocationSequence: number,
): Result<{ definition: NodeDefinition; invocation: NodeInvocation }, ExecutorError> {
  const invocation = aggregate.state.invocations.find(
    ({ sequence }) => sequence === invocationSequence,
  );
  const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === invocation?.nodeId);
  if (!invocation || !definition) {
    return toExecutorError(ExecutorErrorKind.UnknownNode, {
      nodeId: invocation?.nodeId ?? `invocation:${invocationSequence}`,
    });
  }
  return ok({ definition, invocation });
}

function unexpectedIntent(intent: never): never {
  throw new Error(`Unsupported orchestration intent: ${JSON.stringify(intent)}`);
}

function agentHarnesses(
  aggregate: RunAggregate,
  definition: NodeDefinition,
): Result<readonly string[], ExecutorError> {
  const configured = agentHarnessesForNode(
    aggregate.state.configuration,
    definition.id,
    definition.harness,
  );
  if (!configured) {
    return toExecutorError(ExecutorErrorKind.InvalidInput, {
      field: 'configuration.agentHarnessesByNode',
      reason: `agent node ${definition.id} must resolve to a non-empty harness policy`,
    });
  }
  return ok(configured);
}

function agentReasoningEffort(
  aggregate: RunAggregate,
  compiledEffort?: AgentReasoningEffort,
): Result<{ readonly value?: AgentReasoningEffort }, ExecutorError> {
  if (compiledEffort !== undefined) return ok({ value: compiledEffort });
  const configured = aggregate.state.configuration.agentReasoningEffort;
  if (configured === undefined) return ok({});
  if (configured === 'low' || configured === 'medium' || configured === 'high') {
    return ok({ value: configured });
  }
  return toExecutorError(ExecutorErrorKind.InvalidInput, {
    field: 'configuration.agentReasoningEffort',
    reason: 'agent reasoning effort must be low, medium, or high',
  });
}

function reusableAgentSession(
  aggregate: RunAggregate,
  definition: NodeDefinition,
  harnessId: string,
): string | undefined {
  if (definition.clearContext) {
    return undefined;
  }
  return aggregate.state.invocations
    .filter(({ nodeId, state }) => nodeId === definition.id && state === 'succeeded')
    .toSorted((left, right) => right.sequence - left.sequence)
    .flatMap(({ attempts }) => attempts.toReversed())
    .find(
      ({ harnessId: attemptHarness, resumeToken, state }) =>
        state === 'succeeded' && attemptHarness === harnessId && resumeToken !== undefined,
    )?.resumeToken;
}

function sourceFeedback(aggregate: RunAggregate, invocationSequence: number): string | undefined {
  const activation = aggregate.events.find(
    (event) =>
      event.type === 'invocation.activated' && event.invocationSequence === invocationSequence,
  );
  if (
    activation?.type !== 'invocation.activated' ||
    activation.sourceInvocationSequence === undefined
  ) {
    return undefined;
  }
  const source = aggregate.state.invocations.find(
    ({ sequence }) => sequence === activation.sourceInvocationSequence,
  );
  if (!source || source.output === undefined) {
    return undefined;
  }
  return `Workflow feedback from ${source.nodeId} (${source.outcome ?? 'completed'}):\n${JSON.stringify(source.output, null, 2)}`;
}

function activationSourceSequence(
  aggregate: RunAggregate,
  invocationSequence: number,
): number | undefined {
  const activation = aggregate.events.find(
    (event) =>
      event.type === 'invocation.activated' && event.invocationSequence === invocationSequence,
  );
  return activation?.type === 'invocation.activated'
    ? activation.sourceInvocationSequence
    : undefined;
}

function previousSuccessfulInvocationSequence(
  aggregate: RunAggregate,
  nodeId: string,
  invocationSequence: number,
): number {
  return (
    aggregate.state.invocations
      .filter(
        ({ nodeId: candidateId, sequence, state }) =>
          candidateId === nodeId && sequence < invocationSequence && state === 'succeeded',
      )
      .toSorted((left, right) => right.sequence - left.sequence)[0]?.sequence ?? 0
  );
}

function priorInvocations(
  aggregate: RunAggregate,
  afterSequence: number,
  invocationSequence: number,
): readonly NodeInvocation[] {
  return aggregate.state.invocations
    .filter(({ sequence }) => sequence > afterSequence && sequence < invocationSequence)
    .toSorted((left, right) => left.sequence - right.sequence);
}

function agentContextSection(
  invocations: readonly NodeInvocation[],
  sourceId: string,
  immediateSourceSequence: number | undefined,
): string | undefined {
  const invocation = invocations
    .filter(
      ({ nodeId, sequence, state, output }) =>
        nodeId === sourceId &&
        sequence !== immediateSourceSequence &&
        state === 'succeeded' &&
        output !== undefined,
    )
    .toSorted((left, right) => right.sequence - left.sequence)[0];
  return invocation?.output === undefined
    ? undefined
    : `Agent ${sourceId} (invocation ${invocation.sequence}):\n${JSON.stringify(invocation.output, null, 2)}`;
}

function subagentContextSections(
  invocations: readonly NodeInvocation[],
  sourceId: string,
): readonly string[] {
  const sections: string[] = [];
  for (const invocation of invocations) {
    for (const attempt of invocation.attempts.toSorted(
      (left, right) => left.number - right.number,
    )) {
      for (const subagent of attempt.subagents ?? []) {
        if (
          subagent.subagentId === sourceId &&
          subagent.state === 'succeeded' &&
          subagent.output !== undefined
        ) {
          sections.push(
            `Subagent ${sourceId} (invocation ${invocation.sequence}, call ${subagent.callId}):\n${JSON.stringify(subagent.output, null, 2)}`,
          );
        }
      }
    }
  }
  return sections;
}

function sharedAgentContext(
  aggregate: RunAggregate,
  definition: NodeDefinition,
  invocationSequence: number,
  resumesExistingSession: boolean,
): string | undefined {
  if (!definition.contextSources?.length) return undefined;
  const afterSequence = resumesExistingSession
    ? previousSuccessfulInvocationSequence(aggregate, definition.id, invocationSequence)
    : 0;
  const immediateSourceSequence = activationSourceSequence(aggregate, invocationSequence);
  const invocations = priorInvocations(aggregate, afterSequence, invocationSequence);
  const sections: string[] = [];

  for (const source of definition.contextSources) {
    if (source.type === 'agent') {
      const section = agentContextSection(invocations, source.id, immediateSourceSequence);
      if (section) sections.push(section);
      continue;
    }
    sections.push(...subagentContextSections(invocations, source.id));
  }

  return sections.length > 0
    ? `Declared context from prior agents:\n\n${sections.join('\n\n')}`
    : undefined;
}

function promptWithWorkItem(aggregate: RunAggregate, basePrompt: string): string {
  const workItem = aggregate.state.configuration.workItem;
  if (workItem === undefined) return basePrompt;
  return `${basePrompt}\n\nImmutable work item for this run:\n${JSON.stringify(workItem, null, 2)}`;
}

function promptForAgent(
  aggregate: RunAggregate,
  definition: NodeDefinition,
  invocationSequence: number,
  declaredPrompt: string,
  resumesExistingSession: boolean,
): string {
  const feedback = sourceFeedback(aggregate, invocationSequence);
  const sharedContext = sharedAgentContext(
    aggregate,
    definition,
    invocationSequence,
    resumesExistingSession,
  );
  if (resumesExistingSession) {
    return (
      [sharedContext, feedback].filter((section) => section !== undefined).join('\n\n') ||
      'Continue the interrupted work.'
    );
  }
  const basePrompt = promptWithWorkItem(aggregate, declaredPrompt);
  return [basePrompt, sharedContext, feedback]
    .filter((section) => section !== undefined)
    .join('\n\n');
}

function serializedAgentFailure(error: AgentExecutorError): {
  readonly kind: string;
  readonly message: string;
} {
  switch (error.kind) {
    case AgentExecutorErrorKind.Harness:
      return {
        kind: 'harness_failure',
        message:
          'message' in error.error
            ? error.error.message
            : `Harness ${error.harnessId} cannot resume`,
      };
    case AgentExecutorErrorKind.StructuredOutput:
      return {
        kind: 'invalid_structured_output',
        message: `${error.issue.path}: ${error.issue.message}`,
      };
    case AgentExecutorErrorKind.Artifact:
      return {
        kind: 'artifact_failure',
        message: error.error.message,
      };
  }
  throw new Error(`Unsupported agent executor error: ${JSON.stringify(error)}`);
}

function artifactChecksums(aggregate: RunAggregate): readonly string[] {
  return [
    ...(aggregate.state.artifacts ?? []).map(({ checksum }) => checksum),
    ...aggregate.state.invocations.flatMap(({ attempts }) =>
      attempts.flatMap(({ artifacts }) => artifacts?.map(({ checksum }) => checksum) ?? []),
    ),
  ].toSorted();
}

function appendAgentFailure(
  store: RunStore,
  aggregate: RunAggregate,
  invocationSequence: number,
  attemptNumber: number,
  error: AgentExecutorError,
  hasFallback: boolean,
  finishedAt: string,
): Result<RunAggregate, ExecutorError> {
  const appended = fromStore(
    store.appendEvent({
      runId: aggregate.runId,
      expectedSequence: aggregate.nextEventSequence,
      idempotencyKey: `agent:failed:${invocationSequence}:${attemptNumber}`,
      event: {
        type: 'attempt.failed',
        invocationSequence,
        attemptNumber,
        failure: serializedAgentFailure(error),
        retry: hasFallback ? 'fallback' : 'none',
        ...(hasFallback ? {} : { finishedAt }),
      },
    }),
  );
  return appended.isErr()
    ? appended
    : toExecutorError(ExecutorErrorKind.Agent, { invocationSequence, error });
}

function recordResumeToken(
  store: RunStore,
  aggregate: RunAggregate,
  invocationSequence: number,
  attemptNumber: number,
  token: string,
): Result<RunAggregate, ExecutorError> {
  return fromStore(
    store.appendEvent({
      runId: aggregate.runId,
      expectedSequence: aggregate.nextEventSequence,
      idempotencyKey: `agent:resume-token:${invocationSequence}:${attemptNumber}`,
      event: {
        type: 'attempt.resume_token_recorded',
        invocationSequence,
        attemptNumber,
        resumeToken: token,
      },
    }),
  );
}

function activeAgentControlChannel(
  store: RunStore,
  runId: string,
  invocationSequence: number,
  attemptNumber: number,
): AgentControlChannel {
  function loadAttempt(): {
    readonly aggregate: RunAggregate;
    readonly invocation: NodeInvocation;
    readonly attempt: NonNullable<NodeInvocation['attempts'][number]>;
  } {
    const loaded = store.loadRun(runId);
    if (loaded.isErr()) throw new Error('Agent control state could not be loaded');
    const aggregate = loaded.unwrap();
    const invocation = aggregate.state.invocations.find(
      ({ sequence }) => sequence === invocationSequence,
    );
    const attempt = invocation?.attempts.find(({ number }) => number === attemptNumber);
    if (!invocation || !attempt) throw new Error('Active agent attempt no longer exists');
    return { aggregate, invocation, attempt };
  }

  async function appendSteeringOutcome(
    requestSequence: number,
    outcome: 'applied' | 'rejected',
    reason?: string,
  ): Promise<void> {
    const appended = appendLatestEvent(
      store,
      runId,
      `agent:steering:${requestSequence}:${outcome}`,
      outcome === 'applied'
        ? {
            type: 'agent.steering_applied',
            invocationSequence,
            attemptNumber,
            requestSequence,
          }
        : {
            type: 'agent.steering_rejected',
            invocationSequence,
            attemptNumber,
            requestSequence,
            reason: reason ?? 'Agent runtime rejected steering',
          },
    );
    if (appended.isErr()) throw new Error('Agent steering outcome could not be recorded');
  }

  return {
    async read() {
      const { invocation, attempt } = loadAttempt();
      return {
        steering: (attempt.steering ?? [])
          .filter(({ state }) => state === 'pending')
          .map(({ requestSequence, message }) => ({ requestSequence, message })),
        interruptRequested: invocation.state === 'interrupted',
      };
    },
    steeringApplied(requestSequence: number) {
      return appendSteeringOutcome(requestSequence, 'applied');
    },
    steeringRejected(requestSequence: number, reason: string) {
      return appendSteeringOutcome(requestSequence, 'rejected', reason);
    },
  };
}

function publishAgentArtifacts(
  store: RunStore,
  aggregate: RunAggregate,
  invocationSequence: number,
  attemptNumber: number,
  artifacts: readonly ArtifactReference[],
): Result<RunAggregate, ExecutorError> {
  let current: Result<RunAggregate, ExecutorError> = ok(aggregate);
  for (const artifact of artifacts) {
    const before = current.unwrap();
    current = fromStore(
      store.appendEvent({
        runId: before.runId,
        expectedSequence: before.nextEventSequence,
        idempotencyKey: `agent:artifact:${artifact.id}`,
        event: {
          type: 'attempt.artifact_published',
          invocationSequence,
          attemptNumber,
          artifact,
        },
      }),
    );
    if (current.isErr()) return current;
  }
  return current;
}

function completeAgentInvocation(
  store: RunStore,
  aggregate: RunAggregate,
  invocationSequence: number,
  attemptNumber: number,
  output: JsonValue,
  finishedAt: string,
): Result<RunAggregate, ExecutorError> {
  const invocation = aggregate.state.invocations.find(
    ({ sequence, state }) => sequence === invocationSequence && state === 'active',
  );
  if (!invocation) {
    throw new Error(`Active invocation disappeared: ${invocationSequence}`);
  }
  return fromStore(
    store.appendEvent({
      runId: aggregate.runId,
      expectedSequence: aggregate.nextEventSequence,
      idempotencyKey: `agent:completed:${invocation.sequence}:${attemptNumber}`,
      event: {
        type: 'invocation.completed',
        invocationSequence,
        outcome: 'success',
        output,
        finishedAt,
      },
    }),
  );
}

function recordAttemptUsage(
  store: RunStore,
  aggregate: RunAggregate,
  invocationSequence: number,
  attemptNumber: number,
  usage: TokenUsage,
): Result<RunAggregate, ExecutorError> {
  if (!validTokenUsage(usage)) return ok(aggregate);
  return fromStore(
    store.appendEvent({
      runId: aggregate.runId,
      expectedSequence: aggregate.nextEventSequence,
      idempotencyKey: `agent:usage:${invocationSequence}:${attemptNumber}`,
      event: {
        type: 'attempt.usage_recorded',
        invocationSequence,
        attemptNumber,
        usage,
      },
    }),
  );
}

function recordSubagentExecutions(
  store: RunStore,
  aggregate: RunAggregate,
  invocationSequence: number,
  attemptNumber: number,
  subagents: readonly SubagentExecutionSummary[],
): Result<RunAggregate, ExecutorError> {
  if (subagents.length === 0) return ok(aggregate);
  return fromStore(
    store.appendEvent({
      runId: aggregate.runId,
      expectedSequence: aggregate.nextEventSequence,
      idempotencyKey: `agent:subagents:${invocationSequence}:${attemptNumber}`,
      event: {
        type: 'attempt.subagents_recorded',
        invocationSequence,
        attemptNumber,
        subagents,
      },
    }),
  );
}

function validTokenUsage(usage: TokenUsage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? [] : [usage.cacheReadTokens]),
    ...(usage.cacheWriteTokens === undefined ? [] : [usage.cacheWriteTokens]),
    ...(usage.reasoningTokens === undefined ? [] : [usage.reasoningTokens]),
  ].every((count) => Number.isSafeInteger(count) && count >= 0);
}

function intentKey(intent: OrchestrationIntent): string {
  switch (intent.type) {
    case 'invocation.activate':
      return `intent:invocation.activate:${intent.invocationSequence}`;
    case 'attempt.schedule':
      return `intent:attempt.schedule:${intent.invocationSequence}:${intent.attemptNumber}`;
    case 'approval.request':
      return `intent:approval.request:${intent.invocationSequence}`;
    case 'run.complete':
      return `intent:run.complete:${intent.result}`;
    case 'effect.verify':
      return `intent:effect.verify:${intent.invocationSequence}:${intent.attemptNumber}`;
    case 'session.resume':
      return `intent:session.resume:${intent.invocationSequence}`;
    case 'reconciliation.request':
      return `intent:reconciliation.request:${intent.invocationSequence}`;
    case 'recovery.halt':
      return `intent:recovery.halt:${intent.invocationSequence}`;
  }
  return unexpectedIntent(intent);
}

function intentEvent(
  intent: Extract<
    OrchestrationIntent,
    { type: 'invocation.activate' | 'approval.request' | 'run.complete' }
  >,
  now: string,
): RunEventInput {
  switch (intent.type) {
    case 'invocation.activate':
      return {
        type: 'invocation.activated',
        invocationSequence: intent.invocationSequence,
        nodeId: intent.nodeId,
        activatedAt: now,
        ...(intent.sourceInvocationSequence === undefined
          ? {}
          : { sourceInvocationSequence: intent.sourceInvocationSequence }),
        ...(intent.transitionId === undefined ? {} : { transitionId: intent.transitionId }),
      };
    case 'approval.request':
      return {
        type: 'approval.requested',
        binding: intent.binding,
      };
    case 'run.complete':
      return {
        type: 'run.completed',
        result: intent.result,
        finishedAt: now,
      };
  }
  return unexpectedIntent(intent);
}

export class RunCoordinator {
  constructor(
    private readonly store: RunStore,
    private readonly commandRunner: CommandRunner,
    private readonly agentExecutor?: AgentExecutor,
    private readonly workingDirectory = process.cwd(),
    private readonly clock: Clock = systemClock,
  ) {}

  createRun(input: CreateRunInput): Result<RunAggregate, ExecutorError> {
    if (!input.runId.trim()) {
      return toExecutorError(ExecutorErrorKind.InvalidInput, {
        field: 'runId',
        reason: 'runId is required',
      });
    }
    if (!input.idempotencyKey.trim()) {
      return toExecutorError(ExecutorErrorKind.InvalidInput, {
        field: 'idempotencyKey',
        reason: 'idempotencyKey is required',
      });
    }
    return fromStore(
      this.store.createRun({
        ...input,
        ...(input.startedAt !== undefined ||
        input.artifact.bundle.runLimits?.maxDurationMs === undefined
          ? {}
          : { startedAt: this.clock.now() }),
      }),
    );
  }

  async advance(runId: string): Promise<Result<RunAggregate, ExecutorError>> {
    let loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    let aggregate = loaded.unwrap();

    if (aggregate.artifact.bundle.runLimits?.maxDurationMs !== undefined) {
      const observedAt = this.clock.now();
      if (aggregate.state.observedAt !== observedAt) {
        loaded = fromStore(
          this.store.appendEvent({
            runId,
            expectedSequence: aggregate.nextEventSequence,
            idempotencyKey: `clock:${aggregate.nextEventSequence}:${observedAt}`,
            event: { type: 'run.time_observed', observedAt },
          }),
        );
        if (loaded.isErr()) return loaded;
        aggregate = loaded.unwrap();
      }
    }

    const scheduled = scheduleRun(aggregate.artifact, aggregate.state);
    if (scheduled.isErr()) {
      return toExecutorError(ExecutorErrorKind.Runtime, {
        error: scheduled.error,
      });
    }
    const intent = scheduled.unwrap()[0];
    if (!intent) return loaded;

    switch (intent.type) {
      case 'attempt.schedule':
        return this.executeAttempt(aggregate, intent);
      case 'invocation.activate':
      case 'approval.request':
      case 'run.complete':
        return fromStore(
          this.store.appendEvent({
            runId,
            expectedSequence: aggregate.nextEventSequence,
            idempotencyKey: intentKey(intent),
            event: intentEvent(intent, this.clock.now()),
          }),
        );
      case 'session.resume':
        return this.resumeAgent(aggregate, intent);
      case 'effect.verify':
      case 'reconciliation.request':
      case 'recovery.halt': {
        const target = definitionFor(aggregate, intent.invocationSequence);
        if (target.isErr()) return target;
        const { definition } = target.unwrap();
        return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
          nodeId: definition.id,
          nodeType: intent.type,
        });
      }
    }
    return unexpectedIntent(intent);
  }

  decideApproval(
    runId: string,
    binding: ApprovalBinding,
    decision: 'grant' | 'reject' | 'request_changes',
    actor: string,
    reason: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    const loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const aggregate = loaded.unwrap();
    const event: RunEventInput =
      decision === 'grant'
        ? { type: 'approval.granted', binding, actor, reason, finishedAt: this.clock.now() }
        : decision === 'request_changes'
          ? {
              type: 'approval.changes_requested',
              binding,
              actor,
              reason,
              finishedAt: this.clock.now(),
            }
          : { type: 'approval.rejected', binding, actor, reason, finishedAt: this.clock.now() };
    return fromStore(
      this.store.appendEvent({
        runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey,
        event,
      }),
    );
  }

  proposeDelivery(
    runId: string,
    proposal: DeliveryProposal,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, {
      type: 'delivery.proposed',
      proposal,
    });
  }

  updateDeliveryMetadata(
    runId: string,
    invocationSequence: number,
    metadata: DeliveryMetadata,
    checksum: `sha256:${string}`,
    actor: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, {
      type: 'delivery.metadata_updated',
      invocationSequence,
      metadata,
      checksum,
      actor,
    });
  }

  recordDeliveryCommit(
    runId: string,
    invocationSequence: number,
    preparedTree: string,
    commit: string,
    branch: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, {
      type: 'delivery.committed',
      invocationSequence,
      preparedTree,
      commit,
      branch,
    });
  }

  recordPublication(
    runId: string,
    event: Extract<
      RunEventInput,
      {
        type:
          | 'delivery.publication_started'
          | 'delivery.publication_succeeded'
          | 'delivery.publication_failed';
      }
    >,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, event);
  }

  pauseRun(
    runId: string,
    actor: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, {
      type: 'run.paused',
      actor,
    });
  }

  resumeRun(
    runId: string,
    actor: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, {
      type: 'run.resumed',
      actor,
    });
  }

  cancelRun(
    runId: string,
    actor: string,
    reason: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, {
      type: 'run.cancelled',
      actor,
      reason,
      finishedAt: this.clock.now(),
    });
  }

  interruptInvocation(
    runId: string,
    invocationSequence: number,
    actor: string,
    reason: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    const loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const aggregate = loaded.unwrap();
    const invocation = aggregate.state.invocations.find(
      ({ sequence }) => sequence === invocationSequence,
    );
    const attempt = invocation?.attempts.at(-1);
    if (!attempt) {
      return toExecutorError(ExecutorErrorKind.InvalidInput, {
        field: 'invocationSequence',
        reason: `invocation ${invocationSequence} has no active attempt`,
      });
    }
    return fromStore(
      this.store.appendEvent({
        runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey,
        event: {
          type: 'attempt.interrupt_requested',
          invocationSequence,
          attemptNumber: attempt.number,
          actor,
          reason,
        },
      }),
    );
  }

  steerInvocation(
    runId: string,
    invocationSequence: number,
    actor: string,
    message: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    const loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const aggregate = loaded.unwrap();
    const invocation = aggregate.state.invocations.find(
      ({ sequence }) => sequence === invocationSequence,
    );
    const attempt = invocation?.attempts.at(-1);
    if (!attempt) {
      return toExecutorError(ExecutorErrorKind.InvalidInput, {
        field: 'invocationSequence',
        reason: `invocation ${invocationSequence} has no active attempt`,
      });
    }
    return fromStore(
      this.store.appendEvent({
        runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey,
        event: {
          type: 'agent.steering_requested',
          invocationSequence,
          attemptNumber: attempt.number,
          actor,
          message,
        },
      }),
    );
  }

  retryInvocation(
    runId: string,
    invocationSequence: number,
    actor: string,
    reason: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    return this.appendOperatorEvent(runId, idempotencyKey, {
      type: 'invocation.retry_requested',
      invocationSequence,
      actor,
      reason,
    });
  }

  skipInvocation(
    runId: string,
    invocationSequence: number,
    actor: string,
    reason: string,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    const loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const aggregate = loaded.unwrap();
    const invocation = aggregate.state.invocations.find(
      ({ sequence }) => sequence === invocationSequence,
    );
    const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === invocation?.nodeId);
    if (!invocation || !definition?.skipOutcome) {
      return toExecutorError(ExecutorErrorKind.InvalidInput, {
        field: 'invocationSequence',
        reason: `invocation ${invocationSequence} is not eligible for skip`,
      });
    }
    const binding: SkipBinding = {
      workflowChecksum: aggregate.artifact.checksum,
      invocationSequence,
      artifactChecksums: artifactChecksums(aggregate),
      selectedOutcome: definition.skipOutcome,
      repositoryHead: aggregate.state.repositoryHead,
    };
    return fromStore(
      this.store.appendEvent({
        runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey,
        event: {
          type: 'invocation.skipped',
          binding,
          actor,
          reason,
          finishedAt: this.clock.now(),
        },
      }),
    );
  }

  publishRunArtifact(
    runId: string,
    artifact: ArtifactReference,
    idempotencyKey: string,
  ): Result<RunAggregate, ExecutorError> {
    const loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const aggregate = loaded.unwrap();
    return fromStore(
      this.store.appendEvent({
        runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey,
        event: { type: 'run.artifact_published', artifact },
      }),
    );
  }

  recoverRun(runId: string): Result<RunAggregate, ExecutorError> {
    let loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;

    for (const invocation of loaded.unwrap().state.invocations) {
      if (invocation.state !== 'active') continue;
      const attempt = invocation.attempts.at(-1);
      if (!attempt) continue;
      const aggregate = loaded.unwrap();
      loaded = fromStore(
        this.store.appendEvent({
          runId,
          expectedSequence: aggregate.nextEventSequence,
          idempotencyKey: `recovery:attempt.interrupted:${invocation.sequence}:${attempt.number}`,
          event: {
            type: 'attempt.interrupted',
            invocationSequence: invocation.sequence,
            attemptNumber: attempt.number,
          },
        }),
      );
      if (loaded.isErr()) return loaded;
    }

    return loaded;
  }

  private appendOperatorEvent(
    runId: string,
    idempotencyKey: string,
    event: RunEventInput,
  ): Result<RunAggregate, ExecutorError> {
    const loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const aggregate = loaded.unwrap();
    return fromStore(
      this.store.appendEvent({
        runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey,
        event,
      }),
    );
  }

  private async executeCommand(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'attempt.schedule' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const target = definitionFor(aggregate, intent.invocationSequence);
    if (target.isErr()) return target;
    const { definition } = target.unwrap();
    if (definition.type !== 'command' || !definition.command) {
      return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
        nodeId: definition.id,
        nodeType: definition.type,
      });
    }

    const started = fromStore(
      this.store.appendEvent({
        runId: aggregate.runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey: intentKey(intent),
        event: {
          type: 'attempt.started',
          invocationSequence: intent.invocationSequence,
          attemptNumber: intent.attemptNumber,
        },
      }),
    );
    if (started.isErr()) return started;
    const startedAggregate = started.unwrap();

    const executed = await this.commandRunner.execute(definition.command);
    if (executed.isErr()) {
      const interrupted = fromStore(
        this.store.appendEvent({
          runId: aggregate.runId,
          expectedSequence: startedAggregate.nextEventSequence,
          idempotencyKey: `command:interrupted:${intent.invocationSequence}:${intent.attemptNumber}`,
          event: {
            type: 'attempt.interrupted',
            invocationSequence: intent.invocationSequence,
            attemptNumber: intent.attemptNumber,
          },
        }),
      );
      if (interrupted.isErr()) return interrupted;
      return toExecutorError(ExecutorErrorKind.Command, {
        invocationSequence: intent.invocationSequence,
        error: executed.error,
      });
    }
    const commandExecution = executed.unwrap();

    return fromStore(
      this.store.appendEvent({
        runId: aggregate.runId,
        expectedSequence: startedAggregate.nextEventSequence,
        idempotencyKey: `command:completed:${intent.invocationSequence}:${intent.attemptNumber}`,
        event: {
          type: 'invocation.completed',
          invocationSequence: intent.invocationSequence,
          outcome: commandExecution.outcome,
          output: commandExecution.output,
          finishedAt: this.clock.now(),
        },
      }),
    );
  }

  private async executeAttempt(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'attempt.schedule' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const target = definitionFor(aggregate, intent.invocationSequence);
    if (target.isErr()) return target;
    return target.unwrap().definition.type === 'agent'
      ? this.executeAgent(aggregate, intent)
      : this.executeCommand(aggregate, intent);
  }

  private async executeAgent(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'attempt.schedule' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const target = definitionFor(aggregate, intent.invocationSequence);
    if (target.isErr()) return target;
    const { definition } = target.unwrap();
    if (definition.type !== 'agent' || !definition.role || !definition.prompt) {
      return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
        nodeId: definition.id,
        nodeType: definition.type,
      });
    }
    if (!this.agentExecutor) {
      return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
        nodeId: definition.id,
        nodeType: definition.type,
      });
    }

    const configured = agentHarnesses(aggregate, definition);
    if (configured.isErr()) return configured;
    const harnesses = configured.unwrap();
    const harnessId = harnesses[intent.attemptNumber - 1];
    if (!harnessId) {
      return toExecutorError(ExecutorErrorKind.InvalidInput, {
        field: 'configuration.agentHarnesses',
        reason: `no harness is configured for node ${definition.id} attempt ${intent.attemptNumber}`,
      });
    }
    const resumeToken = reusableAgentSession(aggregate, definition, harnessId);
    const model = definition.models?.[harnessId];

    const started = fromStore(
      this.store.appendEvent({
        runId: aggregate.runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey: intentKey(intent),
        event: {
          type: 'attempt.started',
          invocationSequence: intent.invocationSequence,
          attemptNumber: intent.attemptNumber,
          harnessId,
          ...(model ? { model } : {}),
          ...(resumeToken ? { resumeToken } : {}),
        },
      }),
    );
    if (started.isErr()) return started;

    return this.completeAgentAttempt(
      started.unwrap(),
      definition,
      intent.invocationSequence,
      intent.attemptNumber,
      harnessId,
      model,
      harnesses.length > intent.attemptNumber,
      resumeToken,
    );
  }

  private async resumeAgent(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'session.resume' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const target = definitionFor(aggregate, intent.invocationSequence);
    if (target.isErr()) return target;
    const { definition, invocation } = target.unwrap();
    const attempt = invocation.attempts.at(-1);
    if (
      definition.type !== 'agent' ||
      !definition.role ||
      !definition.prompt ||
      !attempt?.harnessId ||
      !this.agentExecutor
    ) {
      return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
        nodeId: definition.id,
        nodeType: 'session.resume',
      });
    }

    const resumed = fromStore(
      this.store.appendEvent({
        runId: aggregate.runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey: intentKey(intent),
        event: {
          type: 'attempt.resumed',
          invocationSequence: invocation.sequence,
          attemptNumber: attempt.number,
          harnessId: attempt.harnessId,
          resumeToken: intent.token,
        },
      }),
    );
    if (resumed.isErr()) return resumed;
    return this.completeAgentAttempt(
      resumed.unwrap(),
      definition,
      invocation.sequence,
      attempt.number,
      attempt.harnessId,
      attempt.model,
      false,
      intent.token,
    );
  }

  private async completeAgentAttempt(
    aggregate: RunAggregate,
    definition: NodeDefinition,
    invocationSequence: number,
    attemptNumber: number,
    harnessId: string,
    model: string | undefined,
    hasFallback: boolean,
    resumeToken?: string,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    if (!this.agentExecutor || !definition.role || !definition.prompt) {
      throw new Error('Agent execution dependencies were validated before completion');
    }
    const outputSchema = definition.outputSchema
      ? aggregate.artifact.bundle.schemas?.[definition.outputSchema]
      : undefined;
    const declaredPrompt =
      aggregate.artifact.bundle.prompts?.[definition.prompt] ?? definition.prompt;
    const prompt = promptForAgent(
      aggregate,
      definition,
      invocationSequence,
      declaredPrompt,
      resumeToken !== undefined,
    );
    const controls = activeAgentControlChannel(
      this.store,
      aggregate.runId,
      invocationSequence,
      attemptNumber,
    );
    const effort = agentReasoningEffort(aggregate, definition.reasoningEffort);
    if (effort.isErr()) return effort;
    const reasoningEffort = effort.unwrap().value;
    const subagentDefinitions = (definition.allowedSubagents ?? []).map((subagentId) => {
      const subagent = aggregate.artifact.bundle.subagents?.find(({ id }) => id === subagentId);
      if (!subagent) {
        throw new Error(`Compiled agent references an unknown subagent: ${subagentId}`);
      }
      return {
        ...subagent,
        prompt: aggregate.artifact.bundle.prompts?.[subagent.prompt] ?? subagent.prompt,
        ...(subagent.outputSchema
          ? {
              outputSchemaValue: aggregate.artifact.bundle.schemas?.[subagent.outputSchema],
            }
          : {}),
      };
    });
    const executed = await this.agentExecutor.execute({
      runId: aggregate.runId,
      invocationSequence,
      attemptNumber,
      harnessId,
      workingDirectory: this.workingDirectory,
      role: definition.role,
      prompt,
      capabilities: definition.capabilities ?? [],
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(resumeToken ? { resumeToken } : {}),
      ...(subagentDefinitions.length > 0 ? { subagentDefinitions } : {}),
      controls,
      onResumeToken: async (token: string) => {
        const loaded = fromStore(this.store.loadRun(aggregate.runId));
        if (loaded.isErr()) throw new Error('Agent session token state could not be loaded');
        const current = loaded.unwrap();
        const invocation = current.state.invocations.find(
          ({ sequence }) => sequence === invocationSequence,
        );
        const attempt = invocation?.attempts.find(({ number }) => number === attemptNumber);
        if (attempt?.resumeToken === token) return;
        if (attempt?.resumeToken !== undefined) {
          throw new Error('Agent session token changed during an attempt');
        }
        const recorded = appendLatestEvent(
          this.store,
          aggregate.runId,
          `agent:resume-token:${invocationSequence}:${attemptNumber}`,
          {
            type: 'attempt.resume_token_recorded',
            invocationSequence,
            attemptNumber,
            resumeToken: token,
          },
        );
        if (recorded.isErr()) throw new Error('Agent session token could not be recorded');
      },
    });

    const refreshed = fromStore(this.store.loadRun(aggregate.runId));
    if (refreshed.isErr()) return refreshed;
    let current = refreshed.unwrap();
    const currentInvocation = current.state.invocations.find(
      ({ sequence }) => sequence === invocationSequence,
    );
    if (currentInvocation?.state !== 'active') return ok(current);

    if (executed.isErr()) {
      const failure = executed.error;
      const withSubagents = recordSubagentExecutions(
        this.store,
        current,
        invocationSequence,
        attemptNumber,
        failure.subagents ?? [],
      );
      if (withSubagents.isErr()) return withSubagents;
      return appendAgentFailure(
        this.store,
        withSubagents.unwrap(),
        invocationSequence,
        attemptNumber,
        failure,
        hasFallback,
        this.clock.now(),
      );
    }

    const result = executed.unwrap();
    const currentAttempt = currentInvocation.attempts.find(
      ({ number }) => number === attemptNumber,
    );
    if (result.resumeToken && currentAttempt?.resumeToken !== result.resumeToken) {
      const recorded = recordResumeToken(
        this.store,
        current,
        invocationSequence,
        attemptNumber,
        result.resumeToken,
      );
      if (recorded.isErr()) return recorded;
      current = recorded.unwrap();
    }

    const published = publishAgentArtifacts(
      this.store,
      current,
      invocationSequence,
      attemptNumber,
      result.artifacts,
    );
    if (published.isErr()) return published;
    const withUsage = result.usage
      ? recordAttemptUsage(
          this.store,
          published.unwrap(),
          invocationSequence,
          attemptNumber,
          result.usage,
        )
      : ok(published.unwrap());
    if (withUsage.isErr()) return withUsage;
    const withSubagents = recordSubagentExecutions(
      this.store,
      withUsage.unwrap(),
      invocationSequence,
      attemptNumber,
      result.subagents,
    );
    if (withSubagents.isErr()) return withSubagents;
    return completeAgentInvocation(
      this.store,
      withSubagents.unwrap(),
      invocationSequence,
      attemptNumber,
      result.output,
      this.clock.now(),
    );
  }
}
