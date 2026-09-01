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
import { agentHarnessesForNode, deriveRunTrace, scheduleRun } from '@kouro/runtime';
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
  ParallelWorkspaceManager,
  TraceExporter,
} from './ports.ts';
import { CommandRunnerErrorKind, RunStoreErrorKind } from './ports.ts';

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
  const invocationInput = aggregate.state.invocations.find(
    ({ sequence }) => sequence === invocationSequence,
  )?.input;
  const inputSection =
    invocationInput === undefined
      ? undefined
      : `Immutable invocation input:\n${JSON.stringify(invocationInput, null, 2)}`;
  const sharedContext = sharedAgentContext(
    aggregate,
    definition,
    invocationSequence,
    resumesExistingSession,
  );
  if (resumesExistingSession) {
    return (
      [inputSection, sharedContext, feedback]
        .filter((section) => section !== undefined)
        .join('\n\n') || 'Continue the interrupted work.'
    );
  }
  const basePrompt = promptWithWorkItem(aggregate, declaredPrompt);
  return [basePrompt, inputSection, sharedContext, feedback]
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

function recordsAttemptSpans(aggregate: RunAggregate): boolean {
  return Number(aggregate.artifact.bundle.semanticVersions.ir) >= 5;
}

function timestampAtOrAfter(clock: Clock, lowerBound: string | undefined): string {
  const now = clock.now();
  if (lowerBound === undefined) return now;
  const nowMs = Date.parse(now);
  const lowerMs = Date.parse(lowerBound);
  return !Number.isNaN(nowMs) && !Number.isNaN(lowerMs) && nowMs < lowerMs ? lowerBound : now;
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
  const appended = appendLatestEvent(
    store,
    aggregate.runId,
    `agent:failed:${invocationSequence}:${attemptNumber}`,
    {
      type: 'attempt.failed',
      invocationSequence,
      attemptNumber,
      failure: serializedAgentFailure(error),
      retry: hasFallback ? 'fallback' : 'none',
      ...(hasFallback ? {} : { finishedAt }),
      ...(recordsAttemptSpans(aggregate) ? { attemptFinishedAt: finishedAt } : {}),
    },
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
  return appendLatestEvent(
    store,
    aggregate.runId,
    `agent:resume-token:${invocationSequence}:${attemptNumber}`,
    {
      type: 'attempt.resume_token_recorded',
      invocationSequence,
      attemptNumber,
      resumeToken: token,
    },
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
    current = appendLatestEvent(store, before.runId, `agent:artifact:${artifact.id}`, {
      type: 'attempt.artifact_published',
      invocationSequence,
      attemptNumber,
      artifact,
    });
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
  return appendLatestEvent(
    store,
    aggregate.runId,
    `agent:completed:${invocation.sequence}:${attemptNumber}`,
    {
      type: 'invocation.completed',
      invocationSequence,
      outcome: 'success',
      output,
      finishedAt,
      ...(recordsAttemptSpans(aggregate) ? { attemptFinishedAt: finishedAt } : {}),
    },
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
  return appendLatestEvent(
    store,
    aggregate.runId,
    `agent:usage:${invocationSequence}:${attemptNumber}`,
    {
      type: 'attempt.usage_recorded',
      invocationSequence,
      attemptNumber,
      usage,
    },
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
  return appendLatestEvent(
    store,
    aggregate.runId,
    `agent:subagents:${invocationSequence}:${attemptNumber}`,
    {
      type: 'attempt.subagents_recorded',
      invocationSequence,
      attemptNumber,
      subagents,
    },
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
    case 'parallel.fork':
    case 'collection.expand':
      return `intent:${intent.type}:${intent.groupId}`;
    case 'parallel.branch.complete':
      return `intent:parallel.branch.complete:${intent.groupId}:${intent.branchId}`;
    case 'parallel.join':
      return `intent:parallel.join:${intent.groupId}`;
    case 'timer.schedule':
    case 'timer.elapse':
    case 'event.wait':
    case 'event.timeout':
    case 'invocation.complete':
      return `intent:${intent.type}:${intent.invocationSequence}`;
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
        ...(intent.parallelGroupId === undefined
          ? {}
          : { parallelGroupId: intent.parallelGroupId }),
        ...(intent.branchId === undefined ? {} : { branchId: intent.branchId }),
        ...(intent.input === undefined ? {} : { input: intent.input }),
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

interface PreparedAttemptExecution {
  readonly aggregate: RunAggregate;
  execute(): Promise<Result<RunAggregate, ExecutorError>>;
}

export class RunCoordinator {
  constructor(
    private readonly store: RunStore,
    private readonly commandRunner: CommandRunner,
    private readonly agentExecutor?: AgentExecutor,
    private readonly workingDirectory = process.cwd(),
    private readonly clock: Clock = systemClock,
    private readonly parallelWorkspaces?: ParallelWorkspaceManager,
    private readonly traceExporter?: TraceExporter,
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
    const prepared = await this.prepareAdvance(runId);
    if (prepared.isErr()) return prepared;
    const aggregate = prepared.unwrap();
    const scheduled = scheduleRun(aggregate.artifact, aggregate.state);
    if (scheduled.isErr()) {
      return toExecutorError(ExecutorErrorKind.Runtime, { error: scheduled.error });
    }
    const intent = scheduled.unwrap()[0];
    return intent ? this.executeIntent(aggregate, intent) : prepared;
  }

  /**
   * Executes every deterministic intent currently available to one parallel
   * group. Starts are committed canonically before isolated effects run, while
   * completion events are serialized in the order the effects actually end.
   */
  async advanceAvailable(runId: string): Promise<Result<RunAggregate, ExecutorError>> {
    const prepared = await this.prepareAdvance(runId);
    if (prepared.isErr()) return prepared;
    const aggregate = prepared.unwrap();
    const scheduled = scheduleRun(aggregate.artifact, aggregate.state);
    if (scheduled.isErr()) {
      return toExecutorError(ExecutorErrorKind.Runtime, { error: scheduled.error });
    }
    const intents = scheduled.unwrap();
    if (intents.length === 0) return prepared;
    if (intents.every(({ type }) => type === 'invocation.activate')) {
      let current = aggregate;
      for (const intent of intents) {
        if (intent.type !== 'invocation.activate') continue;
        const advanced = await this.executeIntent(current, intent);
        if (advanced.isErr()) return advanced;
        current = advanced.unwrap();
      }
      return ok(current);
    }
    if (intents.every(({ type }) => type === 'attempt.schedule')) {
      return this.executeAttemptsConcurrently(
        aggregate,
        intents.filter(
          (intent): intent is Extract<OrchestrationIntent, { type: 'attempt.schedule' }> =>
            intent.type === 'attempt.schedule',
        ),
      );
    }
    const intent = intents[0];
    return intent ? this.executeIntent(aggregate, intent) : prepared;
  }

  private async prepareAdvance(runId: string): Promise<Result<RunAggregate, ExecutorError>> {
    let loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    let aggregate = loaded.unwrap();

    const activeGroup = aggregate.state.parallelGroups?.find(({ state }) => state === 'active');
    if (activeGroup && this.parallelWorkspaces) {
      const recovered = await this.parallelWorkspaces.recover(
        runId,
        activeGroup.id,
        activeGroup.baseHead,
        activeGroup.baseTree,
        activeGroup.checkpoint,
        activeGroup.branches.flatMap((branch) =>
          branch.workspaceId ? [{ branchId: branch.id, workspaceId: branch.workspaceId }] : [],
        ),
      );
      if (recovered.isErr()) {
        return toExecutorError(ExecutorErrorKind.Command, {
          invocationSequence: activeGroup.ownerInvocationSequence,
          error: recovered.error,
        });
      }
    }

    if (
      aggregate.artifact.bundle.runLimits?.maxDurationMs !== undefined ||
      aggregate.state.status === 'waiting'
    ) {
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
    return ok(aggregate);
  }

  private async executeIntent(
    aggregate: RunAggregate,
    intent: OrchestrationIntent,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    switch (intent.type) {
      case 'attempt.schedule':
        return this.executeAttempt(aggregate, intent);
      case 'invocation.activate':
      case 'approval.request':
      case 'run.complete':
        return this.appendAndExport(
          aggregate,
          intentKey(intent),
          intentEvent(intent, this.clock.now()),
        );
      case 'timer.schedule': {
        const scheduledAt = this.clock.now();
        return this.appendAndExport(aggregate, intentKey(intent), {
          type: 'timer.scheduled',
          invocationSequence: intent.invocationSequence,
          scheduledAt,
          dueAt: new Date(Date.parse(scheduledAt) + intent.durationMs).toISOString(),
        });
      }
      case 'timer.elapse':
        return this.appendAndExport(aggregate, intentKey(intent), {
          type: 'timer.elapsed',
          invocationSequence: intent.invocationSequence,
          observedAt: aggregate.state.observedAt ?? this.clock.now(),
        });
      case 'event.wait': {
        const scheduledAt = this.clock.now();
        return this.appendAndExport(aggregate, intentKey(intent), {
          type: 'event.waiting',
          invocationSequence: intent.invocationSequence,
          event: intent.event,
          scheduledAt,
          ...(intent.timeoutMs === undefined
            ? {}
            : {
                timeoutAt: new Date(Date.parse(scheduledAt) + intent.timeoutMs).toISOString(),
              }),
        });
      }
      case 'event.timeout':
        return this.appendAndExport(aggregate, intentKey(intent), {
          type: 'event.timed_out',
          invocationSequence: intent.invocationSequence,
          observedAt: aggregate.state.observedAt ?? this.clock.now(),
        });
      case 'invocation.complete':
        return this.appendAndExport(aggregate, intentKey(intent), {
          type: 'invocation.completed',
          invocationSequence: intent.invocationSequence,
          outcome: intent.outcome,
          ...(intent.output === undefined ? {} : { output: intent.output }),
          finishedAt: this.clock.now(),
        });
      case 'parallel.fork':
      case 'collection.expand':
        return this.prepareParallel(aggregate, intent);
      case 'parallel.branch.complete':
        return this.completeParallelBranch(aggregate, intent);
      case 'parallel.join':
        return this.joinParallel(aggregate, intent);
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

  receiveEvent(
    runId: string,
    invocationSequence: number,
    event: string,
    payload: JsonValue,
    actor: string,
    idempotencyKey: string,
    expectedSequence?: number,
  ): Result<RunAggregate, ExecutorError> {
    const loaded = fromStore(this.store.loadRun(runId));
    if (loaded.isErr()) return loaded;
    const aggregate = loaded.unwrap();
    const existing = aggregate.events.find(
      (candidate) =>
        candidate.type === 'external_event.received' && candidate.idempotencyKey === idempotencyKey,
    );
    if (existing?.type === 'external_event.received') {
      return existing.invocationSequence === invocationSequence &&
        existing.event === event &&
        existing.actor === actor &&
        JSON.stringify(existing.payload) === JSON.stringify(payload)
        ? ok(aggregate)
        : toExecutorError(ExecutorErrorKind.RunStore, {
            error: { kind: RunStoreErrorKind.IdempotencyConflict, runId, idempotencyKey },
          });
    }
    if (expectedSequence !== undefined && expectedSequence !== aggregate.nextEventSequence) {
      return toExecutorError(ExecutorErrorKind.RunStore, {
        error: {
          kind: RunStoreErrorKind.EventSequenceConflict,
          runId,
          expected: aggregate.nextEventSequence,
          received: expectedSequence,
        },
      });
    }
    return fromStore(
      this.store.appendEvent({
        runId,
        expectedSequence: expectedSequence ?? aggregate.nextEventSequence,
        idempotencyKey,
        event: {
          type: 'external_event.received',
          invocationSequence,
          event,
          payload,
          actor,
          receivedAt: this.clock.now(),
          idempotencyKey,
        },
      }),
    );
  }

  private async appendAndExport(
    aggregate: RunAggregate,
    idempotencyKey: string,
    event: RunEventInput,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const appended = fromStore(
      this.store.appendEvent({
        runId: aggregate.runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey,
        event,
      }),
    );
    if (appended.isOk() && this.traceExporter) {
      try {
        // Trace delivery is deliberately outside the scheduling transaction.
        // A collector outage must remain observable at the exporter boundary
        // without changing the durable run result or blocking the next intent.
        const exported = await this.traceExporter.export(
          deriveRunTrace(appended.value.runId, appended.value.artifact, appended.value.state),
        );
        if (exported.isErr()) this.traceExporter.observeFailure(exported.error);
      } catch (cause) {
        this.traceExporter.observeFailure({
          kind: CommandRunnerErrorKind.ProcessFailure,
          message: cause instanceof Error ? cause.message : 'Trace exporter threw',
        });
      }
    }
    return appended;
  }

  private async prepareParallel(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'parallel.fork' | 'collection.expand' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    if (!this.parallelWorkspaces) {
      return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
        nodeId: `invocation:${intent.invocationSequence}`,
        nodeType: intent.type,
      });
    }
    const branches =
      intent.type === 'parallel.fork'
        ? intent.branches
        : intent.items.map((_, index) => ({ id: String(index), entryNodeId: intent.entryNodeId }));
    const prepared = await this.parallelWorkspaces.prepare(
      aggregate.runId,
      intent.groupId,
      aggregate.state.repositoryHead,
      branches.map(({ id }) => id),
    );
    if (prepared.isErr()) {
      return toExecutorError(ExecutorErrorKind.Command, {
        invocationSequence: intent.invocationSequence,
        error: prepared.error,
      });
    }
    const preparation = prepared.unwrap();
    const effectiveMax = Math.min(
      intent.maxConcurrent,
      aggregate.artifact.bundle.runLimits?.maxConcurrentInvocations ?? Number.MAX_SAFE_INTEGER,
    );
    const workspace = (branchId: string): string | undefined =>
      preparation.workspaces.find((candidate) => candidate.branchId === branchId)?.workspaceId;
    const missingWorkspace = branches.find((branch) => workspace(branch.id) === undefined);
    if (missingWorkspace) {
      return toExecutorError(ExecutorErrorKind.Command, {
        invocationSequence: intent.invocationSequence,
        error: {
          kind: CommandRunnerErrorKind.ProcessFailure,
          message: `workspace preparation omitted branch ${missingWorkspace.id}`,
        },
      });
    }
    return this.appendAndExport(
      aggregate,
      intentKey(intent),
      intent.type === 'parallel.fork'
        ? {
            type: 'parallel.forked',
            groupId: intent.groupId,
            invocationSequence: intent.invocationSequence,
            kind: 'parallel',
            branches: branches.map((branch) => ({
              ...branch,
              workspaceId: workspace(branch.id) ?? '',
            })),
            maxConcurrent: effectiveMax,
            baseHead: aggregate.state.repositoryHead,
            baseTree: preparation.baseTree,
            checkpoint: preparation.checkpoint,
          }
        : {
            type: 'collection.expanded',
            invocationSequence: intent.invocationSequence,
            groupId: intent.groupId,
            items: intent.items,
            workspaces: branches.flatMap((branch) => {
              const workspaceId = workspace(branch.id);
              return workspaceId ? [{ branchId: branch.id, workspaceId }] : [];
            }),
            maxConcurrent: effectiveMax,
            baseHead: aggregate.state.repositoryHead,
            baseTree: preparation.baseTree,
            checkpoint: preparation.checkpoint,
          },
    );
  }

  private async completeParallelBranch(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'parallel.branch.complete' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const inspected =
      intent.outcome === 'succeeded' && this.parallelWorkspaces
        ? await this.parallelWorkspaces.inspectBranch(
            aggregate.runId,
            intent.groupId,
            intent.branchId,
          )
        : undefined;
    if (inspected?.isErr()) {
      return toExecutorError(ExecutorErrorKind.Command, {
        invocationSequence: intent.invocationSequence,
        error: inspected.error,
      });
    }
    const invocation = aggregate.state.invocations.find(
      ({ sequence }) => sequence === intent.invocationSequence,
    );
    const branchOutput =
      invocation?.output ??
      aggregate.state.invocations
        .filter(
          (candidate) =>
            candidate.parallelGroupId === intent.groupId &&
            candidate.branchId === intent.branchId &&
            candidate.output !== undefined,
        )
        .toSorted((left, right) => right.sequence - left.sequence)[0]?.output;
    return this.appendAndExport(aggregate, intentKey(intent), {
      type: 'parallel.branch_completed',
      groupId: intent.groupId,
      branchId: intent.branchId,
      invocationSequence: intent.invocationSequence,
      outcome: intent.outcome,
      ...(branchOutput === undefined ? {} : { output: branchOutput }),
      ...(inspected?.isOk() ? { changedPaths: inspected.value.changedPaths } : {}),
      finishedAt: this.clock.now(),
    });
  }

  private async joinParallel(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'parallel.join' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const group = aggregate.state.parallelGroups?.find(({ id }) => id === intent.groupId);
    if (!group) {
      return toExecutorError(ExecutorErrorKind.UnknownNode, { nodeId: intent.groupId });
    }
    if (intent.outcome !== 'succeeded') {
      return this.appendAndExport(aggregate, intentKey(intent), {
        type: 'parallel.joined',
        groupId: intent.groupId,
        outcome: intent.outcome,
        finishedAt: this.clock.now(),
      });
    }
    if (!this.parallelWorkspaces) {
      return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
        nodeId: group.ownerNodeId,
        nodeType: intent.type,
      });
    }
    const joined = await this.parallelWorkspaces.join(
      aggregate.runId,
      group.id,
      group.branches.map(({ id }) => id),
      group.baseHead,
    );
    if (joined.isErr()) {
      return toExecutorError(ExecutorErrorKind.Command, {
        invocationSequence: group.ownerInvocationSequence,
        error: joined.error,
      });
    }
    const result = joined.unwrap();
    const appended = await this.appendAndExport(aggregate, intentKey(intent), {
      type: 'parallel.joined',
      groupId: group.id,
      outcome: result.outcome,
      ...(result.outcome === 'succeeded' && result.head && result.tree
        ? { joinedHead: result.head, joinedTree: result.tree }
        : {}),
      finishedAt: this.clock.now(),
    });
    if (appended.isOk() && result.outcome === 'succeeded') {
      await this.parallelWorkspaces.cleanupSuccessful(aggregate.runId, group.id);
    }
    return appended;
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
            ...(recordsAttemptSpans(aggregate) ? { finishedAt: this.clock.now() } : {}),
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
    const prepared = this.prepareCommandAttempt(aggregate, intent);
    return prepared.isErr() ? prepared : prepared.unwrap().execute();
  }

  private prepareCommandAttempt(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'attempt.schedule' }>,
  ): Result<PreparedAttemptExecution, ExecutorError> {
    const target = definitionFor(aggregate, intent.invocationSequence);
    if (target.isErr()) return target;
    const { definition, invocation } = target.unwrap();
    if (definition.type !== 'command' || !definition.command) {
      return toExecutorError(ExecutorErrorKind.UnsupportedNode, {
        nodeId: definition.id,
        nodeType: definition.type,
      });
    }
    const workingDirectory = this.workingDirectoryFor(aggregate, invocation);
    if (workingDirectory.isErr()) return workingDirectory;

    const started = fromStore(
      this.store.appendEvent({
        runId: aggregate.runId,
        expectedSequence: aggregate.nextEventSequence,
        idempotencyKey: intentKey(intent),
        event: {
          type: 'attempt.started',
          invocationSequence: intent.invocationSequence,
          attemptNumber: intent.attemptNumber,
          ...(recordsAttemptSpans(aggregate)
            ? {
                startedAt: timestampAtOrAfter(this.clock, target.unwrap().invocation.activatedAt),
              }
            : {}),
        },
      }),
    );
    if (started.isErr()) return started;
    const startedAggregate = started.unwrap();
    return ok({
      aggregate: startedAggregate,
      execute: async () => {
        const executed = await this.commandRunner.execute(
          definition.command ?? '',
          workingDirectory.unwrap(),
        );
        if (executed.isErr()) {
          const interrupted = appendLatestEvent(
            this.store,
            aggregate.runId,
            `command:interrupted:${intent.invocationSequence}:${intent.attemptNumber}`,
            {
              type: 'attempt.interrupted',
              invocationSequence: intent.invocationSequence,
              attemptNumber: intent.attemptNumber,
              ...(recordsAttemptSpans(aggregate)
                ? {
                    finishedAt: timestampAtOrAfter(this.clock, invocation.activatedAt),
                  }
                : {}),
            },
          );
          if (interrupted.isErr()) return interrupted;
          return toExecutorError(ExecutorErrorKind.Command, {
            invocationSequence: intent.invocationSequence,
            error: executed.error,
          });
        }
        const commandExecution = executed.unwrap();
        const finishedAt = this.clock.now();
        return appendLatestEvent(
          this.store,
          aggregate.runId,
          `command:completed:${intent.invocationSequence}:${intent.attemptNumber}`,
          {
            type: 'invocation.completed',
            invocationSequence: intent.invocationSequence,
            outcome: commandExecution.outcome,
            output: commandExecution.output,
            finishedAt,
            ...(recordsAttemptSpans(aggregate) ? { attemptFinishedAt: finishedAt } : {}),
          },
        );
      },
    });
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

  private prepareAttempt(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'attempt.schedule' }>,
  ): Result<PreparedAttemptExecution, ExecutorError> {
    const target = definitionFor(aggregate, intent.invocationSequence);
    if (target.isErr()) return target;
    return target.unwrap().definition.type === 'agent'
      ? this.prepareAgentAttempt(aggregate, intent)
      : this.prepareCommandAttempt(aggregate, intent);
  }

  private async executeAttemptsConcurrently(
    aggregate: RunAggregate,
    intents: readonly Extract<OrchestrationIntent, { type: 'attempt.schedule' }>[],
  ): Promise<Result<RunAggregate, ExecutorError>> {
    let current = aggregate;
    const prepared: PreparedAttemptExecution[] = [];
    for (const intent of intents) {
      const attempt = this.prepareAttempt(current, intent);
      if (attempt.isErr()) {
        await this.executePreparedAttempts(aggregate, intents.slice(0, prepared.length), prepared);
        return attempt;
      }
      prepared.push(attempt.unwrap());
      current = attempt.unwrap().aggregate;
    }

    const results = await this.executePreparedAttempts(aggregate, intents, prepared);
    const latest = fromStore(this.store.loadRun(aggregate.runId));
    if (latest.isErr()) return latest;
    const finalAggregate = latest.unwrap();
    const unresolvedError = results.find((result, index) => {
      if (result.isOk()) return false;
      const intent = intents[index];
      return (
        finalAggregate.state.invocations.find(
          ({ sequence }) => sequence === intent?.invocationSequence,
        )?.state === 'active'
      );
    });
    return unresolvedError?.isErr() ? unresolvedError : ok(finalAggregate);
  }

  private async executePreparedAttempts(
    aggregate: RunAggregate,
    intents: readonly Extract<OrchestrationIntent, { type: 'attempt.schedule' }>[],
    prepared: readonly PreparedAttemptExecution[],
  ): Promise<readonly Result<RunAggregate, ExecutorError>[]> {
    const settled = await Promise.allSettled(prepared.map((attempt) => attempt.execute()));
    return settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      const intent = intents[index];
      if (!intent) throw result.reason;
      const interrupted = appendLatestEvent(
        this.store,
        aggregate.runId,
        `attempt:threw:${intent.invocationSequence}:${intent.attemptNumber}`,
        {
          type: 'attempt.interrupted',
          invocationSequence: intent.invocationSequence,
          attemptNumber: intent.attemptNumber,
          ...(recordsAttemptSpans(aggregate) ? { finishedAt: this.clock.now() } : {}),
        },
      );
      return interrupted.isErr()
        ? interrupted
        : toExecutorError(ExecutorErrorKind.Command, {
            invocationSequence: intent.invocationSequence,
            error: {
              kind: CommandRunnerErrorKind.ProcessFailure,
              message: result.reason instanceof Error ? result.reason.message : 'Effect threw',
            },
          });
    });
  }

  private async executeAgent(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'attempt.schedule' }>,
  ): Promise<Result<RunAggregate, ExecutorError>> {
    const prepared = this.prepareAgentAttempt(aggregate, intent);
    return prepared.isErr() ? prepared : prepared.unwrap().execute();
  }

  private prepareAgentAttempt(
    aggregate: RunAggregate,
    intent: Extract<OrchestrationIntent, { type: 'attempt.schedule' }>,
  ): Result<PreparedAttemptExecution, ExecutorError> {
    const target = definitionFor(aggregate, intent.invocationSequence);
    if (target.isErr()) return target;
    const { definition, invocation } = target.unwrap();
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
    const workingDirectory = this.workingDirectoryFor(aggregate, invocation);
    if (workingDirectory.isErr()) return workingDirectory;

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
          ...(recordsAttemptSpans(aggregate)
            ? {
                startedAt: timestampAtOrAfter(this.clock, target.unwrap().invocation.activatedAt),
              }
            : {}),
        },
      }),
    );
    if (started.isErr()) return started;
    const startedAggregate = started.unwrap();
    return ok({
      aggregate: startedAggregate,
      execute: () =>
        this.completeAgentAttempt(
          startedAggregate,
          definition,
          intent.invocationSequence,
          intent.attemptNumber,
          harnessId,
          model,
          harnesses.length > intent.attemptNumber,
          workingDirectory.unwrap(),
          resumeToken,
        ),
    });
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
    const workingDirectory = this.workingDirectoryFor(aggregate, invocation);
    if (workingDirectory.isErr()) return workingDirectory;

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
      workingDirectory.unwrap(),
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
    workingDirectory: string,
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
      workingDirectory,
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

  private workingDirectoryFor(
    aggregate: RunAggregate,
    invocation: NodeInvocation | undefined,
  ): Result<string, ExecutorError> {
    if (!invocation?.parallelGroupId || !invocation.branchId) return ok(this.workingDirectory);
    const isolated = this.parallelWorkspaces?.workingDirectory(
      aggregate.runId,
      invocation.parallelGroupId,
      invocation.branchId,
    );
    return isolated
      ? ok(isolated)
      : toExecutorError(ExecutorErrorKind.Command, {
          invocationSequence: invocation.sequence,
          error: {
            kind: CommandRunnerErrorKind.ProcessFailure,
            message: `isolated workspace is unavailable for ${invocation.parallelGroupId}/${invocation.branchId}`,
          },
        });
  }
}
