import type {
  AgentSteeringRequest,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalView,
  ArtifactView,
  CreateRunRequest,
  CreateRunResponse,
  DeleteRunResponse,
  EvaluationRecordView,
  InvocationActivityView,
  LifecycleRequest,
  LifecycleResponse,
  PublishRunResponse,
  RepositorySummary,
  RunDetails,
  RunSummary,
  TicketDetails,
  TicketListItem,
  TicketProjectView,
  TicketProviderConfigurationView,
} from '@kouro/api-contracts';

export interface ReplayedEvent {
  readonly id: number;
  readonly event: string;
  readonly data: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function apiErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== 'string') {
    return undefined;
  }
  const message = value.error.message.trim();
  return message || undefined;
}

function isRunSummary(value: unknown): value is RunSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.repositoryId === 'string' &&
    typeof value.repositoryPath === 'string' &&
    typeof value.workflowId === 'string' &&
    typeof value.status === 'string' &&
    typeof value.eventCount === 'number'
  );
}

function isEvaluationRecordView(value: unknown): value is EvaluationRecordView {
  return (
    isRecord(value) &&
    isRecord(value.binding) &&
    typeof value.binding.reportId === 'string' &&
    typeof value.binding.experimentId === 'string' &&
    typeof value.binding.datasetId === 'string' &&
    typeof value.binding.caseId === 'string' &&
    typeof value.binding.createdAt === 'string' &&
    isRecord(value.report) &&
    typeof value.report.status === 'string' &&
    Array.isArray(value.report.checks) &&
    Array.isArray(value.annotations)
  );
}

function isRunDetails(value: unknown): value is RunDetails {
  return (
    isRecord(value) &&
    isRecord(value.state) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    (value.evaluations === undefined ||
      (Array.isArray(value.evaluations) && value.evaluations.every(isEvaluationRecordView))) &&
    isRunSummary(value)
  );
}

function isApprovalView(value: unknown): value is ApprovalView {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.nodeId === 'string' &&
    typeof value.invocationSequence === 'number' &&
    typeof value.expectedEventSequence === 'number' &&
    isRecord(value.binding)
  );
}

function isArtifactView(value: unknown): value is ArtifactView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.checksum === 'string' &&
    typeof value.size === 'number'
  );
}

function isInvocationActivityView(value: unknown): value is InvocationActivityView {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.nodeId === 'string' &&
    typeof value.invocationSequence === 'number' &&
    typeof value.attemptNumber === 'number' &&
    typeof value.state === 'string' &&
    typeof value.harnessId === 'string' &&
    typeof value.role === 'string' &&
    typeof value.prompt === 'string' &&
    typeof value.transcript === 'string' &&
    typeof value.complete === 'boolean'
  );
}

function isApprovalDecisionResponse(value: unknown): value is ApprovalDecisionResponse {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.invocationSequence === 'number' &&
    typeof value.status === 'string'
  );
}

function isLifecycleResponse(value: unknown): value is LifecycleResponse {
  return isRecord(value) && typeof value.runId === 'string' && typeof value.status === 'string';
}

function isCreateRunResponse(value: unknown): value is CreateRunResponse {
  return isRecord(value) && typeof value.runId === 'string' && typeof value.status === 'string';
}

function isRepositorySummary(value: unknown): value is RepositorySummary {
  return isRecord(value) && typeof value.id === 'string' && typeof value.path === 'string';
}

function isTicketListItem(value: unknown): value is TicketListItem {
  return (
    isRecord(value) &&
    isRecord(value.ticket) &&
    typeof value.ticket.id === 'string' &&
    typeof value.ticket.projectId === 'string' &&
    typeof value.ticket.title === 'string' &&
    typeof value.ticket.status === 'string' &&
    typeof value.column === 'string'
  );
}

function isTicketDetails(value: unknown): value is TicketDetails {
  return (
    isRecord(value) &&
    isTicketListItem(value) &&
    Array.isArray(value.comments) &&
    Array.isArray(value.relationships) &&
    Array.isArray(value.runs) &&
    Array.isArray(value.snapshots) &&
    isRecord(value.syncState) &&
    Array.isArray(value.syncOperations) &&
    Array.isArray(value.migrations)
  );
}

function isTicketProject(value: unknown): value is TicketProjectView {
  return isRecord(value) && typeof value.id === 'string' && typeof value.ticketCount === 'number';
}

function isTicketProviderConfiguration(value: unknown): value is TicketProviderConfigurationView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.configured === 'boolean' &&
    typeof value.credentialSource === 'string' &&
    typeof value.message === 'string'
  );
}

async function json(response: Response): Promise<unknown> {
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = apiErrorMessage(value);
    throw new Error(
      detail
        ? `Kouro API request failed (${response.status}): ${detail}`
        : `Kouro API request failed (${response.status})`,
    );
  }
  return value;
}

export async function fetchRuns(): Promise<readonly RunSummary[]> {
  const value = await json(await fetch('/api/runs'));
  if (!Array.isArray(value) || !value.every(isRunSummary)) {
    throw new Error('Kouro API returned malformed run summaries');
  }
  return value;
}

export async function fetchRepositories(): Promise<readonly RepositorySummary[]> {
  const value = await json(await fetch('/api/repositories'));
  if (!Array.isArray(value) || !value.every(isRepositorySummary)) {
    throw new Error('Kouro API returned malformed repository summaries');
  }
  return value;
}

export async function createRun(request: CreateRunRequest): Promise<CreateRunResponse> {
  const value = await json(
    await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
  if (!isCreateRunResponse(value)) {
    throw new Error('Kouro API returned a malformed run creation response');
  }
  return value;
}

export async function fetchTicketProjects(): Promise<readonly TicketProjectView[]> {
  const value = await json(await fetch('/api/ticket-projects'));
  if (!Array.isArray(value) || !value.every(isTicketProject)) {
    throw new Error('Kouro API returned malformed ticket projects');
  }
  return value;
}

export async function fetchTickets(projectId: string): Promise<readonly TicketListItem[]> {
  const value = await json(await fetch(`/api/tickets?projectId=${encodeURIComponent(projectId)}`));
  if (!Array.isArray(value) || !value.every(isTicketListItem)) {
    throw new Error('Kouro API returned malformed tickets');
  }
  return value;
}

export async function fetchTicket(ticketId: string): Promise<TicketDetails> {
  const value = await json(await fetch(`/api/tickets/${encodeURIComponent(ticketId)}`));
  if (!isTicketDetails(value)) throw new Error('Kouro API returned malformed ticket details');
  return value;
}

export async function fetchTicketProviderConfigurations(): Promise<
  readonly TicketProviderConfigurationView[]
> {
  const value = await json(await fetch('/api/ticket-providers'));
  if (!Array.isArray(value) || !value.every(isTicketProviderConfiguration)) {
    throw new Error('Kouro API returned malformed ticket provider configurations');
  }
  return value;
}

export async function fetchRun(runId: string): Promise<RunDetails> {
  const value = await json(await fetch(`/api/runs/${encodeURIComponent(runId)}`));
  if (!isRunDetails(value)) throw new Error('Kouro API returned malformed run details');
  return value;
}

export async function deleteRun(runId: string): Promise<DeleteRunResponse> {
  const value = await json(
    await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
  );
  if (!isRecord(value) || value.runId !== runId || value.deleted !== true) {
    throw new Error('Kouro API returned a malformed deletion response');
  }
  return { runId, deleted: true };
}

export async function publishRun(runId: string): Promise<PublishRunResponse> {
  const value = await json(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  if (
    !isRecord(value) ||
    (value.provider !== 'github' && value.provider !== 'forgejo') ||
    typeof value.number !== 'number' ||
    typeof value.url !== 'string'
  ) {
    throw new Error('Kouro API returned a malformed publication response');
  }
  return {
    provider: value.provider,
    number: value.number,
    url: value.url,
  };
}

export async function fetchApprovals(runId: string): Promise<readonly ApprovalView[]> {
  const value = await json(await fetch(`/api/runs/${encodeURIComponent(runId)}/approvals`));
  if (!Array.isArray(value) || !value.every(isApprovalView)) {
    throw new Error('Kouro API returned malformed approvals');
  }
  return value;
}

export async function fetchArtifacts(runId: string): Promise<readonly ArtifactView[]> {
  const value = await json(await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts`));
  if (!Array.isArray(value) || !value.every(isArtifactView)) {
    throw new Error('Kouro API returned malformed artifacts');
  }
  return value;
}

export async function fetchArtifact(runId: string, artifactId: string): Promise<ArtifactView> {
  const value = await json(
    await fetch(
      `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    ),
  );
  if (!isArtifactView(value)) throw new Error('Kouro API returned a malformed artifact');
  return value;
}

export async function fetchInvocationActivity(
  runId: string,
  invocationSequence: number,
): Promise<InvocationActivityView | undefined> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/invocations/${invocationSequence}/activity`,
  );
  if (response.status === 404) return undefined;
  const value = await json(response);
  if (!isInvocationActivityView(value)) {
    throw new Error('Kouro API returned malformed invocation activity');
  }
  return value;
}

export async function decideApproval(
  runId: string,
  invocationSequence: number,
  request: ApprovalDecisionRequest,
): Promise<ApprovalDecisionResponse> {
  const value = await json(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/approvals/${invocationSequence}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
  if (!isApprovalDecisionResponse(value)) {
    throw new Error('Kouro API returned a malformed approval response');
  }
  return value;
}

export async function controlRun(
  runId: string,
  action: 'pause' | 'resume' | 'cancel',
  request: LifecycleRequest,
): Promise<LifecycleResponse> {
  const value = await json(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
  if (!isLifecycleResponse(value) || value.runId !== runId) {
    throw new Error('Kouro API returned a malformed run control response');
  }
  return value;
}

export async function controlInvocation(
  runId: string,
  invocationSequence: number,
  action: 'steer' | 'interrupt' | 'retry' | 'skip',
  request: LifecycleRequest | AgentSteeringRequest,
): Promise<LifecycleResponse> {
  const value = await json(
    await fetch(
      `/api/runs/${encodeURIComponent(runId)}/invocations/${invocationSequence}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    ),
  );
  if (!isLifecycleResponse(value) || value.runId !== runId) {
    throw new Error('Kouro API returned a malformed invocation control response');
  }
  return value;
}

export function reconnectEvents(
  runId: string,
  after: number,
  onEvent: (event: ReplayedEvent) => void,
): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${after}`);
  source.addEventListener('message', (message) => {
    onEvent({
      id: Number(message.lastEventId),
      event: 'message',
      data: JSON.parse(message.data),
    });
  });
  const eventTypes = [
    'run.created',
    'run.time_observed',
    'run.paused',
    'run.resumed',
    'run.cancelled',
    'invocation.activated',
    'attempt.started',
    'attempt.resumed',
    'attempt.resume_token_recorded',
    'attempt.artifact_published',
    'attempt.usage_recorded',
    'attempt.subagents_recorded',
    'run.artifact_published',
    'delivery.proposed',
    'delivery.metadata_updated',
    'delivery.committed',
    'delivery.publication_started',
    'delivery.publication_succeeded',
    'delivery.publication_failed',
    'attempt.failed',
    'attempt.interrupted',
    'attempt.interrupt_requested',
    'agent.steering_requested',
    'agent.steering_applied',
    'agent.steering_rejected',
    'invocation.retry_requested',
    'invocation.skipped',
    'invocation.completed',
    'approval.requested',
    'approval.granted',
    'approval.rejected',
    'approval.changes_requested',
    'run.completed',
  ] as const;
  for (const eventType of eventTypes) {
    source.addEventListener(eventType, (message) => {
      onEvent({
        id: Number(message.lastEventId),
        event: eventType,
        data: JSON.parse(message.data),
      });
    });
  }
  return () => source.close();
}
