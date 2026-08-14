import type {
  AgentSteeringRequest,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalView,
  ArtifactView,
  CreateRunRequest,
  CreateRunResponse,
  DeleteRunResponse,
  EventStreamMessage,
  InvocationActivityView,
  LifecycleRequest,
  LifecycleResponse,
  RepositorySummary,
  PublishRunRequest,
  PublishRunResponse,
  RunDetails,
  RunSummary,
  WorkflowDetails,
  WorkflowEdgeView,
  WorkflowNodeView,
  WorkflowSubagentView,
  WorkflowSummary,
} from '@kouro/api-contracts';
import type { ApprovalBinding, ArtifactReference, NodeInvocation } from '@kouro/domain';
import { deliveryMetadataChecksum, validateDeliveryMetadata } from '@kouro/delivery';
import {
  RunStoreErrorKind,
  type RunAggregate,
  type RunCoordinator,
  type RunStoreError,
} from '@kouro/executors';
import { ok, type Result } from '@usersatoshi/results';

import { ApiErrorKind, apiErr, type ApiError } from './errors.ts';
import { listRunEvaluations } from './evaluation-use-cases.ts';
import type {
  ArtifactContentReader,
  InvocationActivityReader,
  LocalRunCreator,
  LocalRunDeleter,
  LocalRunPublisher,
  ObservableRunStore,
  RepositoryQuery,
  TicketProviderConfigurationQuery,
  TicketReadServices,
  EvaluationServices,
} from './ports.ts';

export interface ApiServices {
  readonly runs: ObservableRunStore;
  readonly coordinator: RunCoordinator;
  readonly artifacts?: ArtifactContentReader;
  readonly activities?: InvocationActivityReader;
  readonly repositories?: RepositoryQuery;
  readonly runCreator?: LocalRunCreator;
  readonly runDeleter?: LocalRunDeleter;
  readonly runPublisher?: LocalRunPublisher;
  readonly tickets?: TicketReadServices;
  readonly ticketProviders?: TicketProviderConfigurationQuery;
  readonly evaluations?: EvaluationServices;
}

function fromStore<T>(result: Result<T, RunStoreError>): Result<T, ApiError> {
  if (result.isOk()) return result;
  const error = result.error;
  if (error.kind === RunStoreErrorKind.RunNotFound) {
    return apiErr(ApiErrorKind.NotFound, 'run_not_found', `Run ${error.runId} was not found`);
  }
  return apiErr(ApiErrorKind.Persistence, 'run_store_failure', 'Run state could not be read');
}

function pendingApprovalCount(invocations: readonly NodeInvocation[]): number {
  return invocations.filter(
    ({ state, approval }) => state === 'waiting_for_approval' && approval !== undefined,
  ).length;
}

function sameApprovalBinding(left: ApprovalBinding, right: ApprovalBinding): boolean {
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

function summarizeRun(aggregate: RunAggregate): RunSummary {
  const repositoryId =
    typeof aggregate.state.configuration.repositoryId === 'string'
      ? aggregate.state.configuration.repositoryId
      : '';
  const repositoryPath =
    typeof aggregate.state.configuration.repositoryPath === 'string'
      ? aggregate.state.configuration.repositoryPath
      : '';
  return {
    id: aggregate.runId,
    repositoryId,
    repositoryPath,
    workflowId: aggregate.artifact.bundle.manifest.id,
    workflowVersion: aggregate.artifact.bundle.manifest.version,
    workflowChecksum: aggregate.artifact.checksum,
    status: aggregate.state.status,
    startingCommit: aggregate.state.startingCommit,
    eventCount: aggregate.events.length,
    invocationCount: aggregate.state.invocations.length,
    pendingApprovalCount: pendingApprovalCount(aggregate.state.invocations),
  };
}

function workflowNodes(aggregate: RunAggregate): readonly WorkflowNodeView[] {
  return aggregate.artifact.bundle.nodes.map((node) => {
    const invocations = aggregate.state.invocations.filter(({ nodeId }) => nodeId === node.id);
    const latest = invocations.at(-1);
    return {
      id: node.id,
      type: node.type,
      title: node.title ?? node.id,
      ordinal: node.ordinal,
      invocations: invocations.map(({ sequence }) => sequence),
      ...(node.recoveryPolicy ? { recoveryPolicy: node.recoveryPolicy } : {}),
      ...(node.skipOutcome ? { skipOutcome: node.skipOutcome } : {}),
      ...(latest ? { latestState: latest.state } : {}),
    };
  });
}

function workflowSubagents(aggregate: RunAggregate): readonly WorkflowSubagentView[] {
  return (aggregate.artifact.bundle.subagents ?? []).map((subagent) => ({
    id: subagent.id,
    role: subagent.role,
    parentNodeIds: aggregate.artifact.bundle.nodes
      .filter((node) => node.allowedSubagents?.includes(subagent.id))
      .map(({ id }) => id),
    ...(subagent.harness ? { harness: subagent.harness } : {}),
    ...(subagent.models ? { models: subagent.models } : {}),
    ...(subagent.reasoningEffort ? { reasoningEffort: subagent.reasoningEffort } : {}),
    maxInvocations: subagent.maxInvocations,
    maxConcurrent: subagent.maxConcurrent,
  }));
}

function workflowEdges(aggregate: RunAggregate): readonly WorkflowEdgeView[] {
  return aggregate.artifact.bundle.transitions.map((transition) => ({
    id: transition.id,
    source: transition.from.nodeId,
    target: transition.toNodeId,
    outcome: transition.from.outcome,
  }));
}

function findArtifact(
  aggregate: RunAggregate,
  artifactId: string,
): {
  readonly artifact: ArtifactReference;
  readonly invocationSequence?: number;
  readonly attemptNumber?: number;
} | null {
  const runArtifact = aggregate.state.artifacts?.find(({ id }) => id === artifactId);
  if (runArtifact) return { artifact: runArtifact };
  for (const invocation of aggregate.state.invocations) {
    for (const attempt of invocation.attempts) {
      const artifact = attempt.artifacts?.find(({ id }) => id === artifactId);
      if (artifact) {
        return {
          artifact,
          invocationSequence: invocation.sequence,
          attemptNumber: attempt.number,
        };
      }
    }
  }
  return null;
}

function artifactView(
  runId: string,
  match: NonNullable<ReturnType<typeof findArtifact>>,
): ArtifactView {
  return {
    ...match.artifact,
    runId,
    ...(match.invocationSequence === undefined
      ? {}
      : { invocationSequence: match.invocationSequence }),
    ...(match.attemptNumber === undefined ? {} : { attemptNumber: match.attemptNumber }),
  };
}

export function listRuns(services: ApiServices): Result<readonly RunSummary[], ApiError> {
  const listed = fromStore(services.runs.listRuns());
  return listed.isErr() ? listed : ok(listed.unwrap().map(summarizeRun));
}

export function getRun(services: ApiServices, runId: string): Result<RunDetails, ApiError> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.unwrap();
  const details: RunDetails = {
    ...summarizeRun(aggregate),
    entryNodeId: aggregate.artifact.bundle.entryNodeId,
    repositoryHead: aggregate.state.repositoryHead,
    state: aggregate.state,
    nodes: workflowNodes(aggregate),
    subagents: workflowSubagents(aggregate),
    edges: workflowEdges(aggregate),
  };
  if (!services.evaluations) return ok(details);
  const evaluations = listRunEvaluations(services.evaluations, runId);
  return evaluations.isErr() ? evaluations : ok({ ...details, evaluations: evaluations.value });
}

export function listEvents(
  services: ApiServices,
  runId: string,
  after: number,
): Result<readonly EventStreamMessage[], ApiError> {
  if (!Number.isSafeInteger(after) || after < 0) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_event_sequence',
      'after must be non-negative',
    );
  }
  const loaded = fromStore(services.runs.loadRun(runId));
  return loaded.isErr()
    ? loaded
    : ok(
        loaded
          .unwrap()
          .events.filter(({ sequence }) => sequence > after)
          .map((event) => ({ id: event.sequence, event: event.type, data: event })),
      );
}

export function listArtifacts(
  services: ApiServices,
  runId: string,
): Result<readonly ArtifactView[], ApiError> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.unwrap();
  const artifacts: ArtifactView[] = [];
  for (const artifact of aggregate.state.artifacts ?? []) {
    artifacts.push(artifactView(runId, { artifact }));
  }
  for (const invocation of aggregate.state.invocations) {
    for (const attempt of invocation.attempts) {
      for (const artifact of attempt.artifacts ?? []) {
        artifacts.push(
          artifactView(runId, {
            artifact,
            invocationSequence: invocation.sequence,
            attemptNumber: attempt.number,
          }),
        );
      }
    }
  }
  return ok(artifacts);
}

export async function getArtifact(
  services: ApiServices,
  runId: string,
  artifactId: string,
): Promise<Result<ArtifactView, ApiError>> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const match = findArtifact(loaded.unwrap(), artifactId);
  if (!match) {
    return apiErr(
      ApiErrorKind.NotFound,
      'artifact_not_found',
      `Artifact ${artifactId} was not found`,
    );
  }
  const view = artifactView(runId, match);
  if (!services.artifacts) return ok(view);
  const content = await services.artifacts.read(
    runId,
    match.artifact,
    match.invocationSequence,
    match.attemptNumber,
  );
  return content.isErr()
    ? apiErr(ApiErrorKind.ArtifactRead, 'artifact_read_failed', content.error.message)
    : ok({ ...view, content: content.unwrap().content });
}

export async function getInvocationActivity(
  services: ApiServices,
  runId: string,
  invocationSequence: number,
): Promise<Result<InvocationActivityView, ApiError>> {
  if (!Number.isSafeInteger(invocationSequence) || invocationSequence < 1) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_invocation_sequence',
      'invocationSequence must be a positive integer',
    );
  }
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const invocation = loaded
    .unwrap()
    .state.invocations.find(({ sequence }) => sequence === invocationSequence);
  const attempt = invocation?.attempts.at(-1);
  if (!invocation || !attempt) {
    return apiErr(
      ApiErrorKind.NotFound,
      'invocation_activity_not_found',
      `Invocation ${invocationSequence} has no attempt activity`,
    );
  }
  if (!services.activities) {
    return apiErr(
      ApiErrorKind.NotFound,
      'invocation_activity_unavailable',
      'Invocation activity is not configured',
    );
  }
  const activity = await services.activities.read(runId, invocationSequence, attempt.number);
  if (activity.isErr()) {
    return apiErr(
      ApiErrorKind.ArtifactRead,
      'invocation_activity_read_failed',
      'Invocation activity could not be read',
    );
  }
  if (!activity.value) {
    return apiErr(
      ApiErrorKind.NotFound,
      'invocation_activity_not_found',
      `Invocation ${invocationSequence} has no observed activity`,
    );
  }
  return ok({
    runId,
    nodeId: invocation.nodeId,
    invocationSequence,
    attemptNumber: attempt.number,
    state: invocation.state,
    ...activity.value,
  });
}

export function listApprovals(
  services: ApiServices,
  runId: string,
): Result<readonly ApprovalView[], ApiError> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.unwrap();
  function proposalFor(invocationSequence: number): ApprovalView['proposal'] {
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
    return source?.output === undefined
      ? undefined
      : {
          nodeId: source.nodeId,
          invocationSequence: source.sequence,
          output: source.output,
        };
  }
  return ok(
    aggregate.state.invocations.flatMap((invocation) => {
      if (!invocation.approval) return [];
      const proposal = proposalFor(invocation.sequence);
      return [
        {
          runId,
          nodeId: invocation.nodeId,
          invocationSequence: invocation.sequence,
          state: invocation.state,
          binding: invocation.approval,
          expectedEventSequence: aggregate.nextEventSequence,
          ...(proposal ? { proposal } : {}),
        },
      ];
    }),
  );
}

export function decideApproval(
  services: ApiServices,
  runId: string,
  invocationSequence: number,
  request: ApprovalDecisionRequest,
): Result<ApprovalDecisionResponse, ApiError> {
  if (!request.actor.trim() || !request.reason.trim() || !request.idempotencyKey.trim()) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_approval_decision',
      'actor, reason, and idempotencyKey are required',
    );
  }
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.unwrap();
  const invocation = aggregate.state.invocations.find(
    ({ sequence }) => sequence === invocationSequence,
  );
  if (invocation?.state !== 'waiting_for_approval' || !invocation.approval) {
    const decision = aggregate.events.findLast(
      (event) =>
        (event.type === 'approval.granted' ||
          event.type === 'approval.rejected' ||
          event.type === 'approval.changes_requested') &&
        event.binding.invocationSequence === invocationSequence,
    );
    return apiErr(
      ApiErrorKind.Conflict,
      'approval_not_pending',
      decision && 'actor' in decision
        ? `${decision.actor} already decided invocation ${invocationSequence}`
        : `Invocation ${invocationSequence} is not waiting for approval`,
    );
  }
  if (
    (request.expectedEventSequence !== undefined &&
      request.expectedEventSequence !== aggregate.nextEventSequence) ||
    (request.binding !== undefined && !sameApprovalBinding(request.binding, invocation.approval))
  ) {
    return apiErr(
      ApiErrorKind.Conflict,
      'approval_decision_stale',
      'Another operator updated or decided this approval',
    );
  }
  let binding = invocation.approval;
  if (request.metadata) {
    const proposal = aggregate.state.delivery?.proposal;
    if (!proposal || proposal.invocationSequence !== invocationSequence) {
      return apiErr(
        ApiErrorKind.InvalidInput,
        'delivery_metadata_not_allowed',
        'Metadata can only be edited during delivery review',
      );
    }
    const metadata = validateDeliveryMetadata(request.metadata);
    if (metadata.isErr()) {
      return apiErr(ApiErrorKind.InvalidInput, metadata.error.code, metadata.error.message);
    }
    const checksum = deliveryMetadataChecksum(
      proposal.preparedHead,
      proposal.preparedTree,
      proposal.artifactChecksums,
      metadata.value,
    );
    const updated = services.coordinator.updateDeliveryMetadata(
      runId,
      invocationSequence,
      metadata.value,
      checksum,
      request.actor,
      `${request.idempotencyKey}:metadata`,
    );
    if (updated.isErr()) {
      return apiErr(
        ApiErrorKind.Conflict,
        'delivery_metadata_update_failed',
        'Delivery metadata could not be updated',
      );
    }
    binding =
      updated.value.state.invocations.find(({ sequence }) => sequence === invocationSequence)
        ?.approval ?? binding;
  }
  const decided = services.coordinator.decideApproval(
    runId,
    binding,
    request.decision,
    request.actor,
    request.reason,
    request.idempotencyKey,
  );
  if (decided.isErr()) {
    return apiErr(
      ApiErrorKind.Conflict,
      'approval_decision_failed',
      'Approval could not be decided',
    );
  }
  return ok({
    runId,
    invocationSequence,
    status: decided.unwrap().state.status,
  });
}

export async function createRun(
  services: ApiServices,
  request: CreateRunRequest,
): Promise<Result<CreateRunResponse, ApiError>> {
  const task = request.task?.trim();
  const ticket = request.ticket?.trim();
  if (
    !services.runCreator ||
    !request.adw.trim() ||
    !request.repositoryPath.trim() ||
    !request.actor.trim() ||
    (request.task !== undefined && !task) ||
    (request.ticket !== undefined && !ticket) ||
    (task !== undefined && ticket !== undefined) ||
    (request.adw === 'feature-development' && task === undefined && ticket === undefined)
  ) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_run_request',
      'adw, repositoryPath, actor, and exactly one feature-development work item are required',
    );
  }
  const created = await services.runCreator.create(request);
  return created.isErr()
    ? apiErr(ApiErrorKind.Conflict, 'run_creation_failed', created.error.message)
    : created;
}

export async function deleteRun(
  services: ApiServices,
  runId: string,
): Promise<Result<DeleteRunResponse, ApiError>> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  if (!services.runDeleter) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'run_deletion_unavailable',
      'Run deletion is disabled',
    );
  }
  const deleted = await services.runDeleter.delete(runId);
  return deleted.isErr()
    ? apiErr(ApiErrorKind.Conflict, 'run_deletion_failed', deleted.error.message)
    : deleted;
}

export async function publishRun(
  services: ApiServices,
  runId: string,
  request: PublishRunRequest,
): Promise<Result<PublishRunResponse, ApiError>> {
  if (!services.runPublisher || (request.remote !== undefined && !request.remote.trim())) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'run_publication_unavailable',
      'Run publication is unavailable or the remote is invalid',
    );
  }
  const published = await services.runPublisher.publish(
    runId,
    request.provider,
    request.remote ?? 'origin',
  );
  return published.isErr()
    ? apiErr(ApiErrorKind.Conflict, 'run_publication_failed', published.error.message)
    : published;
}

export function controlRun(
  services: ApiServices,
  runId: string,
  action: 'pause' | 'resume' | 'cancel',
  request: LifecycleRequest,
): Result<LifecycleResponse, ApiError> {
  if (!request.actor.trim() || !request.idempotencyKey.trim()) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_lifecycle_request',
      'actor and idempotencyKey are required',
    );
  }
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const result =
    action === 'pause'
      ? services.coordinator.pauseRun(runId, request.actor, request.idempotencyKey)
      : action === 'resume'
        ? services.coordinator.resumeRun(runId, request.actor, request.idempotencyKey)
        : services.coordinator.cancelRun(
            runId,
            request.actor,
            request.reason ?? 'cancelled by operator',
            request.idempotencyKey,
          );
  return result.isErr()
    ? apiErr(ApiErrorKind.Conflict, 'lifecycle_action_failed', `Run could not be ${action}d`)
    : ok({ runId, status: result.unwrap().state.status });
}

export function controlInvocation(
  services: ApiServices,
  runId: string,
  invocationSequence: number,
  action: 'interrupt' | 'retry' | 'skip' | 'steer',
  request: LifecycleRequest | AgentSteeringRequest,
): Result<LifecycleResponse, ApiError> {
  if (!request.actor.trim() || !request.idempotencyKey.trim()) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_lifecycle_request',
      'actor and idempotencyKey are required',
    );
  }
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  if (action === 'steer') {
    if (!('message' in request) || !request.message.trim()) {
      return apiErr(ApiErrorKind.InvalidInput, 'invalid_steering_request', 'message is required');
    }
    const steered = services.coordinator.steerInvocation(
      runId,
      invocationSequence,
      request.actor,
      request.message,
      request.idempotencyKey,
    );
    return steered.isErr()
      ? apiErr(ApiErrorKind.Conflict, 'invocation_action_failed', 'Invocation could not be steered')
      : ok({ runId, status: steered.unwrap().state.status });
  }
  if (!('reason' in request) || !request.reason?.trim()) {
    return apiErr(ApiErrorKind.InvalidInput, 'invalid_lifecycle_request', 'reason is required');
  }
  const result =
    action === 'interrupt'
      ? services.coordinator.interruptInvocation(
          runId,
          invocationSequence,
          request.actor,
          request.reason,
          request.idempotencyKey,
        )
      : action === 'retry'
        ? services.coordinator.retryInvocation(
            runId,
            invocationSequence,
            request.actor,
            request.reason,
            request.idempotencyKey,
          )
        : services.coordinator.skipInvocation(
            runId,
            invocationSequence,
            request.actor,
            request.reason,
            request.idempotencyKey,
          );
  return result.isErr()
    ? apiErr(
        ApiErrorKind.Conflict,
        'invocation_action_failed',
        `Invocation could not be ${action}ed`,
      )
    : ok({ runId, status: result.unwrap().state.status });
}

export function listWorkflows(services: ApiServices): Result<readonly WorkflowSummary[], ApiError> {
  const listed = fromStore(services.runs.listRuns());
  if (listed.isErr()) return listed;
  const workflows = new Map<string, WorkflowSummary>();
  for (const aggregate of listed.unwrap()) {
    workflows.set(aggregate.artifact.checksum, {
      checksum: aggregate.artifact.checksum,
      id: aggregate.artifact.bundle.manifest.id,
      version: aggregate.artifact.bundle.manifest.version,
      nodeCount: aggregate.artifact.bundle.nodes.length,
    });
  }
  return ok([...workflows.values()].toSorted((left, right) => left.id.localeCompare(right.id)));
}

export function getWorkflow(
  services: ApiServices,
  checksum: string,
): Result<WorkflowDetails, ApiError> {
  const listed = fromStore(services.runs.listRuns());
  if (listed.isErr()) return listed;
  const aggregate = listed.unwrap().find(({ artifact }) => artifact.checksum === checksum);
  return aggregate
    ? ok({
        checksum,
        id: aggregate.artifact.bundle.manifest.id,
        version: aggregate.artifact.bundle.manifest.version,
        nodeCount: aggregate.artifact.bundle.nodes.length,
        bundle: aggregate.artifact.bundle,
      })
    : apiErr(ApiErrorKind.NotFound, 'workflow_not_found', `Workflow ${checksum} was not found`);
}

export async function listRepositories(
  services: ApiServices,
): Promise<readonly RepositorySummary[]> {
  return services.repositories?.list() ?? [];
}

export async function getRepository(
  services: ApiServices,
  repositoryId: string,
): Promise<Result<RepositorySummary, ApiError>> {
  const repositories = await listRepositories(services);
  const repository = repositories.find(({ id }) => id === repositoryId);
  return repository
    ? ok(repository)
    : apiErr(
        ApiErrorKind.NotFound,
        'repository_not_found',
        `Repository ${repositoryId} was not found`,
      );
}
