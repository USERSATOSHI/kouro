import { canonicalJson, sha256 } from '@kouro/adw';
import type {
  EvaluateRunRequest,
  EvaluationAnnotationRequest,
  EvaluationDatasetSummary,
  EvaluationExperimentView,
  EvaluationPreferenceRequest,
  EvaluationRecordView,
} from '@kouro/api-contracts';
import type { JsonValue } from '@kouro/domain';
import {
  createEvaluationRecord,
  EvaluationErrorKind,
  EvaluationStoreErrorKind,
  type EvaluationAnnotation,
  type EvaluationPreference,
  type EvaluationRecord,
  type EvaluationStoreError,
} from '@kouro/evaluations';
import { RunStoreErrorKind, type RunStoreError } from '@kouro/executors';
import { ok, type Result } from '@usersatoshi/results';

import { ApiErrorKind, apiErr, type ApiError } from './errors.ts';
import {
  EvaluationDatasetSourceErrorKind,
  type EvaluationDatasetSourceError,
  type EvaluationServices,
  type ObservableRunStore,
  type RepositoryQuery,
} from './ports.ts';

function jsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, jsonValue(child)]),
    );
  }
  return null;
}

function identifier(prefix: string, input: unknown): string {
  return `${prefix}-${sha256(canonicalJson(jsonValue(input))).slice('sha256:'.length, 30)}`;
}

function fingerprint(input: unknown): `sha256:${string}` {
  return sha256(canonicalJson(jsonValue(input)));
}

function fromRunStore<T>(result: Result<T, RunStoreError>): Result<T, ApiError> {
  if (result.isOk()) return result;
  return result.error.kind === RunStoreErrorKind.RunNotFound
    ? apiErr(ApiErrorKind.NotFound, 'run_not_found', 'The evaluation run was not found')
    : apiErr(ApiErrorKind.Persistence, 'run_store_failure', 'Run state could not be read');
}

function fromEvaluationStore<T>(result: Result<T, EvaluationStoreError>): Result<T, ApiError> {
  if (result.isOk()) return result;
  if (result.error.kind === EvaluationStoreErrorKind.RecordNotFound) {
    return apiErr(ApiErrorKind.NotFound, 'evaluation_not_found', result.error.message);
  }
  if (result.error.kind === EvaluationStoreErrorKind.IdempotencyConflict) {
    return apiErr(ApiErrorKind.Conflict, 'evaluation_idempotency_conflict', result.error.message);
  }
  if (result.error.kind === EvaluationStoreErrorKind.InvalidRecord) {
    return apiErr(ApiErrorKind.Persistence, 'evaluation_record_corrupt', result.error.message);
  }
  return apiErr(ApiErrorKind.Persistence, 'evaluation_store_failure', result.error.message);
}

function fromDatasetSource<T>(
  result: Result<T, EvaluationDatasetSourceError>,
): Result<T, ApiError> {
  if (result.isOk()) return result;
  if (result.error.kind === EvaluationDatasetSourceErrorKind.NotFound) {
    return apiErr(ApiErrorKind.NotFound, 'evaluation_dataset_not_found', result.error.message);
  }
  if (result.error.kind === EvaluationDatasetSourceErrorKind.ReadFailure) {
    return apiErr(ApiErrorKind.Persistence, 'evaluation_dataset_read_failed', result.error.message);
  }
  return apiErr(ApiErrorKind.InvalidInput, 'evaluation_dataset_invalid', result.error.message);
}

function repositoryPath(configuration: Readonly<Record<string, JsonValue>>): string | undefined {
  const value = configuration.repositoryPath;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function repositoryId(configuration: Readonly<Record<string, JsonValue>>): string | undefined {
  const value = configuration.repositoryId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function recordView(
  services: EvaluationServices,
  record: EvaluationRecord,
): Result<EvaluationRecordView, ApiError> {
  const annotations = fromEvaluationStore(services.store.listAnnotations(record.binding.reportId));
  return annotations.isErr() ? annotations : ok({ ...record, annotations: annotations.value });
}

function recordViews(
  services: EvaluationServices,
  records: readonly EvaluationRecord[],
): Result<readonly EvaluationRecordView[], ApiError> {
  const views: EvaluationRecordView[] = [];
  for (const record of records) {
    const view = recordView(services, record);
    if (view.isErr()) return view;
    views.push(view.value);
  }
  return ok(views);
}

export async function listEvaluationDatasets(
  services: EvaluationServices,
  repositories: RepositoryQuery | undefined,
  requestedRepositoryId: string,
): Promise<Result<readonly EvaluationDatasetSummary[], ApiError>> {
  if (!repositories) {
    return apiErr(
      ApiErrorKind.NotFound,
      'repository_query_unavailable',
      'Repository queries are not configured',
    );
  }
  const repository = (await repositories.list()).find(({ id }) => id === requestedRepositoryId);
  if (!repository) {
    return apiErr(
      ApiErrorKind.NotFound,
      'repository_not_found',
      `Repository ${requestedRepositoryId} was not found`,
    );
  }
  const datasets = fromDatasetSource(await services.datasets.list(repository.path));
  return datasets.isErr()
    ? datasets
    : ok(
        datasets.value.map(({ dataset, checksum }) => ({
          id: dataset.id,
          version: dataset.version,
          checksum,
          caseIds: dataset.cases.map(({ id }) => id),
        })),
      );
}

export async function evaluateStoredRun(
  services: EvaluationServices,
  runs: ObservableRunStore,
  runId: string,
  request: EvaluateRunRequest,
): Promise<Result<EvaluationRecordView, ApiError>> {
  const loaded = fromRunStore(runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.value;
  if (!['succeeded', 'failed', 'cancelled'].includes(aggregate.state.status)) {
    return apiErr(
      ApiErrorKind.Conflict,
      'evaluation_run_not_terminal',
      'Only terminal durable runs can be recorded as experiment results',
    );
  }
  const path = repositoryPath(aggregate.state.configuration);
  const repoId = repositoryId(aggregate.state.configuration);
  if (!path || !repoId) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'evaluation_repository_missing',
      'The run does not contain a repository identity and path',
    );
  }
  const dataset = fromDatasetSource(await services.datasets.load(path, request.datasetId));
  if (dataset.isErr()) return dataset;
  const reportId = identifier('eval', {
    operation: 'evaluate',
    idempotencyKey: request.idempotencyKey,
  });
  const record = createEvaluationRecord(dataset.value, {
    reportId,
    experimentId: request.experimentId,
    runId,
    repositoryId: repoId,
    workflowChecksum: aggregate.artifact.checksum,
    caseId: request.caseId,
    actor: request.actor,
    createdAt: services.clock.now(),
    state: aggregate.state,
  });
  if (record.isErr()) {
    const kind = record.error.kind === EvaluationErrorKind.UnknownCase ? 'unknown_case' : 'invalid';
    return apiErr(ApiErrorKind.InvalidInput, `evaluation_${kind}`, record.error.message);
  }
  const saved = fromEvaluationStore(
    services.store.saveRecord({
      record: record.value,
      idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint({ runId, request }),
    }),
  );
  return saved.isErr() ? saved : recordView(services, saved.value);
}

export function listRunEvaluations(
  services: EvaluationServices,
  runId: string,
): Result<readonly EvaluationRecordView[], ApiError> {
  const records = fromEvaluationStore(services.store.listRecords({ runId }));
  return records.isErr() ? records : recordViews(services, records.value);
}

export function listStoredRunEvaluations(
  services: EvaluationServices,
  runs: ObservableRunStore,
  runId: string,
): Result<readonly EvaluationRecordView[], ApiError> {
  const loaded = fromRunStore(runs.loadRun(runId));
  return loaded.isErr() ? loaded : listRunEvaluations(services, runId);
}

export function getEvaluationExperiment(
  services: EvaluationServices,
  experimentId: string,
): Result<EvaluationExperimentView, ApiError> {
  const records = fromEvaluationStore(services.store.listRecords({ experimentId }));
  if (records.isErr()) return records;
  if (records.value.length === 0) {
    return apiErr(
      ApiErrorKind.NotFound,
      'evaluation_experiment_not_found',
      `Evaluation experiment ${experimentId} was not found`,
    );
  }
  const reports = recordViews(services, records.value);
  if (reports.isErr()) return reports;
  const preferences = fromEvaluationStore(services.store.listPreferences(experimentId));
  return preferences.isErr()
    ? preferences
    : ok({ id: experimentId, reports: reports.value, preferences: preferences.value });
}

export function annotateEvaluation(
  services: EvaluationServices,
  reportId: string,
  request: EvaluationAnnotationRequest,
): Result<EvaluationRecordView, ApiError> {
  const record = fromEvaluationStore(services.store.getRecord(reportId));
  if (record.isErr()) return record;
  const annotation: EvaluationAnnotation = {
    id: identifier('annotation', {
      operation: 'annotation',
      idempotencyKey: request.idempotencyKey,
    }),
    reportId,
    actor: request.actor,
    verdict: request.verdict,
    note: request.note,
    createdAt: services.clock.now(),
  };
  const saved = fromEvaluationStore(
    services.store.addAnnotation(
      annotation,
      request.idempotencyKey,
      fingerprint({ reportId, request }),
    ),
  );
  return saved.isErr() ? saved : recordView(services, record.value);
}

export function preferEvaluation(
  services: EvaluationServices,
  experimentId: string,
  request: EvaluationPreferenceRequest,
): Result<EvaluationExperimentView, ApiError> {
  if (request.leftReportId === request.rightReportId) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'evaluation_preference_same_report',
      'Pairwise preference requires two different reports',
    );
  }
  if (
    request.preferredReportId !== undefined &&
    request.preferredReportId !== request.leftReportId &&
    request.preferredReportId !== request.rightReportId
  ) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'evaluation_preference_invalid_winner',
      'The preferred report must be the left report, right report, or omitted for a tie',
    );
  }
  const left = fromEvaluationStore(services.store.getRecord(request.leftReportId));
  if (left.isErr()) return left;
  const right = fromEvaluationStore(services.store.getRecord(request.rightReportId));
  if (right.isErr()) return right;
  if (
    left.value.binding.experimentId !== experimentId ||
    right.value.binding.experimentId !== experimentId
  ) {
    return apiErr(
      ApiErrorKind.Conflict,
      'evaluation_preference_experiment_mismatch',
      'Both reports must belong to the selected experiment',
    );
  }
  const preference: EvaluationPreference = {
    id: identifier('preference', {
      operation: 'preference',
      idempotencyKey: request.idempotencyKey,
    }),
    experimentId,
    leftReportId: request.leftReportId,
    rightReportId: request.rightReportId,
    ...(request.preferredReportId ? { preferredReportId: request.preferredReportId } : {}),
    actor: request.actor,
    reason: request.reason,
    createdAt: services.clock.now(),
  };
  const saved = fromEvaluationStore(
    services.store.addPreference(
      preference,
      request.idempotencyKey,
      fingerprint({ experimentId, request }),
    ),
  );
  return saved.isErr() ? saved : getEvaluationExperiment(services, experimentId);
}
