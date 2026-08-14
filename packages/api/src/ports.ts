import type {
  ArtifactContent,
  CreateRunRequest,
  CreateRunResponse,
  DeleteRunResponse,
  PublishRunRequest,
  PublishRunResponse,
  RepositorySummary,
  TicketProviderConfigurationView,
  TicketProjectView,
} from '@kouro/api-contracts';
import type { ArtifactReference } from '@kouro/domain';
import type { CompiledEvaluationDataset, EvaluationStore } from '@kouro/evaluations';
import type { RunAggregate, RunStoreError } from '@kouro/executors';
import type { Result } from '@usersatoshi/results';
import type {
  TicketHistoryStore,
  TicketRepository,
  TicketRunQuery,
  TicketRunStore,
  TicketSyncStore,
} from '@kouro/tickets';

export interface ObservableRunStore {
  loadRun(runId: string): Result<RunAggregate, RunStoreError>;
  listRuns(): Result<readonly RunAggregate[], RunStoreError>;
}

export interface ArtifactContentReader {
  read(
    runId: string,
    artifact: ArtifactReference,
    invocationSequence?: number,
    attemptNumber?: number,
  ): Promise<Result<ArtifactContent, ArtifactContentReaderError>>;
}

export interface ArtifactContentReaderError {
  readonly kind: 0;
  readonly message: string;
}

export interface InvocationActivityContent {
  readonly harnessId: string;
  readonly role: string;
  readonly prompt: string;
  readonly transcript: string;
  readonly complete: boolean;
}

export interface InvocationActivityReader {
  read(
    runId: string,
    invocationSequence: number,
    attemptNumber: number,
  ): Promise<Result<InvocationActivityContent | undefined, InvocationActivityReaderError>>;
}

export interface InvocationActivityReaderError {
  readonly kind: 0;
  readonly message: string;
}

export interface RepositoryQuery {
  list(): Promise<readonly RepositorySummary[]>;
}

export interface LocalRunCreator {
  create(request: CreateRunRequest): Promise<Result<CreateRunResponse, LocalRunCreatorError>>;
}

export interface LocalRunCreatorError {
  readonly kind: number;
  readonly message: string;
}

export interface LocalRunDeleter {
  delete(runId: string): Promise<Result<DeleteRunResponse, LocalRunDeleterError>>;
}

export interface LocalRunDeleterError {
  readonly kind: number;
  readonly message: string;
}

export interface LocalRunPublisher {
  publish(
    runId: string,
    provider?: PublishRunRequest['provider'],
    remote?: string,
  ): Promise<Result<PublishRunResponse, LocalRunPublisherError>>;
}

export interface LocalRunPublisherError {
  readonly kind: number;
  readonly message: string;
}

export interface TicketReadServices {
  readonly repository: Pick<
    TicketRepository,
    'get' | 'list' | 'listComments' | 'listRelationships'
  > & {
    listProjects(): Result<readonly TicketProjectView[], import('@kouro/tickets').TicketError>;
  };
  readonly runs: TicketRunStore;
  readonly runQuery: TicketRunQuery;
  readonly sync: TicketSyncStore & TicketHistoryStore;
}

export interface TicketProviderConfigurationQuery {
  list(): readonly TicketProviderConfigurationView[];
}

export const enum EvaluationDatasetSourceErrorKind {
  NotFound = 0,
  InvalidDataset = 1,
  ReadFailure = 2,
}

export interface EvaluationDatasetSourceError {
  readonly kind: EvaluationDatasetSourceErrorKind;
  readonly message: string;
}

export interface EvaluationDatasetSource {
  list(
    repositoryPath: string,
  ): Promise<Result<readonly CompiledEvaluationDataset[], EvaluationDatasetSourceError>>;
  load(
    repositoryPath: string,
    datasetId: string,
  ): Promise<Result<CompiledEvaluationDataset, EvaluationDatasetSourceError>>;
}

export interface EvaluationClock {
  now(): string;
}

export interface EvaluationServices {
  readonly datasets: EvaluationDatasetSource;
  readonly store: EvaluationStore;
  readonly clock: EvaluationClock;
}
