import type {
  AgentReasoningEffort,
  ApprovalBinding,
  ArtifactReference,
  CompiledWorkflowBundle,
  DeliveryMetadata,
  JsonValue,
  RunEvent,
  RunState,
} from '@kouro/domain';
import type {
  Ticket,
  TicketBoardCard,
  TicketComment,
  TicketMigration,
  TicketRelationship,
  TicketRunLink,
  TicketRunView,
  TicketSnapshot,
  TicketSyncOperation,
  TicketSyncState,
} from '@kouro/tickets';
import type {
  EvaluationAnnotation,
  EvaluationPreference,
  EvaluationRecord,
} from '@kouro/evaluations';

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface RunSummary {
  readonly id: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowChecksum: string;
  readonly status: RunState['status'];
  readonly startingCommit: string;
  readonly eventCount: number;
  readonly invocationCount: number;
  readonly pendingApprovalCount: number;
}

export interface RunDetails extends RunSummary {
  readonly entryNodeId: string;
  readonly repositoryHead: string;
  readonly state: RunState;
  readonly nodes: readonly WorkflowNodeView[];
  readonly subagents?: readonly WorkflowSubagentView[];
  readonly edges: readonly WorkflowEdgeView[];
  readonly evaluations?: readonly EvaluationRecordView[];
}

export interface EvaluationDatasetSummary {
  readonly id: string;
  readonly version: string;
  readonly checksum: `sha256:${string}`;
  readonly caseIds: readonly string[];
}

export interface EvaluationRecordView extends EvaluationRecord {
  readonly annotations: readonly EvaluationAnnotation[];
}

export interface EvaluateRunRequest {
  readonly datasetId: string;
  readonly caseId: string;
  readonly experimentId: string;
  readonly actor: string;
  readonly idempotencyKey: string;
}

export interface EvaluationAnnotationRequest {
  readonly verdict: EvaluationAnnotation['verdict'];
  readonly note: string;
  readonly actor: string;
  readonly idempotencyKey: string;
}

export interface EvaluationPreferenceRequest {
  readonly leftReportId: string;
  readonly rightReportId: string;
  readonly preferredReportId?: string;
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface EvaluationExperimentView {
  readonly id: string;
  readonly reports: readonly EvaluationRecordView[];
  readonly preferences: readonly EvaluationPreference[];
}

export interface WorkflowNodeView {
  readonly id: string;
  readonly type: CompiledWorkflowBundle['nodes'][number]['type'];
  readonly title: string;
  readonly ordinal: number;
  readonly invocations: readonly number[];
  readonly recoveryPolicy?: CompiledWorkflowBundle['nodes'][number]['recoveryPolicy'];
  readonly skipOutcome?: string;
  readonly latestState?: RunState['invocations'][number]['state'];
}

/** Declared subordinate role and the workflow agent nodes allowed to invoke it. */
export interface WorkflowSubagentView {
  readonly id: string;
  readonly role: string;
  readonly parentNodeIds: readonly string[];
  readonly harness?: string;
  readonly models?: Readonly<Record<string, string>>;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly maxInvocations: number;
  readonly maxConcurrent: number;
}

export interface WorkflowEdgeView {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly outcome: string;
}

export interface WorkflowSummary {
  readonly checksum: string;
  readonly id: string;
  readonly version: string;
  readonly nodeCount: number;
}

export interface WorkflowDetails extends WorkflowSummary {
  readonly bundle: CompiledWorkflowBundle;
}

export interface RepositorySummary {
  readonly id: string;
  readonly path: string;
  readonly startingCommit?: string;
}

export interface ArtifactView extends ArtifactReference {
  readonly runId: string;
  readonly invocationSequence?: number;
  readonly attemptNumber?: number;
  readonly content?: string;
}

export interface InvocationActivityView {
  readonly runId: string;
  readonly nodeId: string;
  readonly invocationSequence: number;
  readonly attemptNumber: number;
  readonly state: RunState['invocations'][number]['state'];
  readonly harnessId: string;
  readonly role: string;
  readonly prompt: string;
  readonly transcript: string;
  readonly complete: boolean;
}

export interface ApprovalView {
  readonly runId: string;
  readonly nodeId: string;
  readonly invocationSequence: number;
  readonly state: RunState['invocations'][number]['state'];
  readonly binding: ApprovalBinding;
  readonly expectedEventSequence: number;
  readonly proposal?: {
    readonly nodeId: string;
    readonly invocationSequence: number;
    readonly output: JsonValue;
  };
}

export interface ApprovalDecisionRequest {
  readonly decision: 'grant' | 'reject' | 'request_changes';
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly metadata?: DeliveryMetadata;
  readonly binding?: ApprovalBinding;
  readonly expectedEventSequence?: number;
}

export interface ApprovalDecisionResponse {
  readonly runId: string;
  readonly invocationSequence: number;
  readonly status: RunState['status'];
}

export interface CreateRunRequest {
  readonly adw: string;
  readonly repositoryPath: string;
  readonly task?: string;
  readonly ticket?: string;
  readonly harnesses?: readonly string[];
  readonly harnessesByNode?: Readonly<Record<string, readonly string[]>>;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly actor: string;
  readonly base?: string;
}

export interface CreateRunResponse {
  readonly runId: string;
  readonly status: RunState['status'];
}

export interface DeleteRunResponse {
  readonly runId: string;
  readonly deleted: true;
}

export interface PublishRunRequest {
  readonly provider?: 'github' | 'forgejo';
  readonly remote?: string;
}

export interface PublishRunResponse {
  readonly provider: 'github' | 'forgejo';
  readonly number: number;
  readonly url: string;
}

export interface LifecycleRequest {
  readonly actor: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface LifecycleResponse {
  readonly runId: string;
  readonly status: RunState['status'];
}

export interface AgentSteeringRequest {
  readonly actor: string;
  readonly message: string;
  readonly idempotencyKey: string;
}

export interface EventStreamMessage {
  readonly id: number;
  readonly event: RunEvent['type'];
  readonly data: RunEvent;
}

export interface ArtifactContent {
  readonly mediaType: string;
  readonly content: string;
}

export interface TicketListItem {
  readonly ticket: Ticket;
  readonly column: TicketBoardCard['column'];
  readonly activeRun?: TicketRunView;
}

export interface TicketProjectView {
  readonly id: string;
  readonly ticketCount: number;
}

export interface TicketRunHistoryView extends TicketRunLink {
  readonly execution?: TicketRunView;
}

export interface TicketDetails extends TicketListItem {
  readonly comments: readonly TicketComment[];
  readonly relationships: readonly TicketRelationship[];
  readonly runs: readonly TicketRunHistoryView[];
  readonly snapshots: readonly TicketSnapshot[];
  readonly syncState: TicketSyncState;
  readonly syncOperations: readonly TicketSyncOperation[];
  readonly migrations: readonly TicketMigration[];
}

export interface TicketProviderConfigurationView {
  readonly id: 'local' | 'github' | 'forgejo';
  readonly displayName: string;
  readonly configured: boolean;
  readonly credentialSource: 'none' | 'server_environment';
  readonly endpoint?: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly message: string;
}
