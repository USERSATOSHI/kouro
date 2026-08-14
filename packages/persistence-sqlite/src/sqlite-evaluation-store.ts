import { Database } from 'bun:sqlite';

import { canonicalJson } from '@kouro/adw';
import type { JsonValue } from '@kouro/domain';
import {
  EvaluationStoreErrorKind,
  type EvaluationAnnotation,
  type EvaluationPreference,
  type EvaluationRecord,
  type EvaluationRecordQuery,
  type EvaluationStore,
  type EvaluationStoreError,
  type SaveEvaluationRecordInput,
} from '@kouro/evaluations';
import { err, ok, safeCall, type Result } from '@usersatoshi/results';

interface JsonRow {
  readonly value_json: string;
}

interface IdempotencyRow {
  readonly operation: string;
  readonly request_json: string;
  readonly entity_id: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExpectation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'run_status') {
    return value.value === 'succeeded' || value.value === 'failed' || value.value === 'cancelled';
  }
  if (value.type === 'max_invocations' || value.type === 'max_total_tokens') {
    return typeof value.value === 'number' && Number.isSafeInteger(value.value) && value.value > 0;
  }
  return (
    value.type === 'node_outcome' &&
    typeof value.nodeId === 'string' &&
    typeof value.outcome === 'string'
  );
}

function isCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    isExpectation(value.expectation) &&
    (value.status === 'passed' || value.status === 'failed' || value.status === 'unavailable') &&
    typeof value.message === 'string'
  );
}

function isUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.inputTokens === 'number' &&
    Number.isSafeInteger(value.inputTokens) &&
    value.inputTokens >= 0 &&
    typeof value.outputTokens === 'number' &&
    Number.isSafeInteger(value.outputTokens) &&
    value.outputTokens >= 0
  );
}

function isEvaluationRecord(value: unknown): value is EvaluationRecord {
  return (
    isRecord(value) &&
    isRecord(value.binding) &&
    typeof value.binding.reportId === 'string' &&
    typeof value.binding.experimentId === 'string' &&
    typeof value.binding.runId === 'string' &&
    typeof value.binding.repositoryId === 'string' &&
    typeof value.binding.startingCommit === 'string' &&
    typeof value.binding.workflowChecksum === 'string' &&
    typeof value.binding.configurationChecksum === 'string' &&
    typeof value.binding.datasetId === 'string' &&
    typeof value.binding.datasetVersion === 'string' &&
    typeof value.binding.datasetChecksum === 'string' &&
    typeof value.binding.caseId === 'string' &&
    value.binding.evaluatorVersion === '1' &&
    typeof value.binding.createdBy === 'string' &&
    typeof value.binding.createdAt === 'string' &&
    isRecord(value.report) &&
    value.report.datasetId === value.binding.datasetId &&
    value.report.datasetVersion === value.binding.datasetVersion &&
    value.report.datasetChecksum === value.binding.datasetChecksum &&
    value.report.caseId === value.binding.caseId &&
    (value.report.status === 'passed' ||
      value.report.status === 'failed' ||
      value.report.status === 'incomplete') &&
    Array.isArray(value.report.checks) &&
    value.report.checks.every(isCheck) &&
    (value.report.usage === undefined || isUsage(value.report.usage))
  );
}

function isAnnotation(value: unknown): value is EvaluationAnnotation {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.reportId === 'string' &&
    typeof value.actor === 'string' &&
    (value.verdict === 'pass' || value.verdict === 'fail' || value.verdict === 'unsure') &&
    typeof value.note === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isPreference(value: unknown): value is EvaluationPreference {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.experimentId === 'string' &&
    typeof value.leftReportId === 'string' &&
    typeof value.rightReportId === 'string' &&
    (value.preferredReportId === undefined ||
      value.preferredReportId === value.leftReportId ||
      value.preferredReportId === value.rightReportId) &&
    value.leftReportId !== value.rightReportId &&
    typeof value.actor === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function storeError(
  kind: EvaluationStoreErrorKind,
  message: string,
  entityId?: string,
): EvaluationStoreError {
  return { kind, message, ...(entityId ? { entityId } : {}) };
}

function databaseError(operation: string, cause: unknown): EvaluationStoreError {
  const detail = cause instanceof Error ? cause.message : 'SQLite evaluation operation failed';
  return storeError(EvaluationStoreErrorKind.DatabaseFailure, `${operation}: ${detail}`);
}

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
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, jsonValue(child)]),
    );
  }
  return null;
}

function serialized(value: unknown): string {
  return canonicalJson(jsonValue(value));
}

function decoded<T>(
  row: JsonRow | null,
  guard: (value: unknown) => value is T,
  entityId: string,
): Result<T, EvaluationStoreError> {
  if (!row) {
    return err(
      storeError(
        EvaluationStoreErrorKind.RecordNotFound,
        `Record ${entityId} was not found`,
        entityId,
      ),
    );
  }
  const parsed = safeCall(
    (): unknown => JSON.parse(row.value_json),
    () =>
      storeError(
        EvaluationStoreErrorKind.InvalidRecord,
        `Record ${entityId} is not valid JSON`,
        entityId,
      ),
  );
  if (parsed.isErr()) return parsed;
  return guard(parsed.value)
    ? ok(parsed.value)
    : err(
        storeError(
          EvaluationStoreErrorKind.InvalidRecord,
          `Record ${entityId} is malformed`,
          entityId,
        ),
      );
}

function flatten<T>(
  result: Result<Result<T, EvaluationStoreError>, EvaluationStoreError>,
): Result<T, EvaluationStoreError> {
  return result.isErr() ? result : result.value;
}

/** SQLite adapter for durable evaluation reports and additive human evidence. */
export class SqliteEvaluationStore implements EvaluationStore {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
  }

  initialize(): Result<void, EvaluationStoreError> {
    return safeCall(
      () => {
        this.database.exec('PRAGMA foreign_keys = ON');
        this.database.exec('PRAGMA journal_mode = WAL');
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS evaluation_records (
            report_id TEXT PRIMARY KEY,
            experiment_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            dataset_id TEXT NOT NULL,
            dataset_checksum TEXT NOT NULL,
            case_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'incomplete')),
            value_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS evaluation_records_run
            ON evaluation_records(run_id, created_at, report_id);
          CREATE INDEX IF NOT EXISTS evaluation_records_experiment
            ON evaluation_records(experiment_id, created_at, report_id);

          CREATE TABLE IF NOT EXISTS evaluation_annotations (
            id TEXT PRIMARY KEY,
            report_id TEXT NOT NULL,
            value_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (report_id) REFERENCES evaluation_records(report_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS evaluation_annotations_report
            ON evaluation_annotations(report_id, created_at, id);

          CREATE TABLE IF NOT EXISTS evaluation_preferences (
            id TEXT PRIMARY KEY,
            experiment_id TEXT NOT NULL,
            left_report_id TEXT NOT NULL,
            right_report_id TEXT NOT NULL,
            value_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (left_report_id) REFERENCES evaluation_records(report_id) ON DELETE CASCADE,
            FOREIGN KEY (right_report_id) REFERENCES evaluation_records(report_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS evaluation_preferences_experiment
            ON evaluation_preferences(experiment_id, created_at, id);

          CREATE TABLE IF NOT EXISTS evaluation_idempotency (
            idempotency_key TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            request_json TEXT NOT NULL,
            entity_id TEXT NOT NULL
          );
        `);
      },
      (cause) => databaseError('initializeEvaluations', cause),
    );
  }

  dispose(): void {
    this.database.close();
  }

  saveRecord(input: SaveEvaluationRecordInput): Result<EvaluationRecord, EvaluationStoreError> {
    return this.idempotentWrite(
      'record',
      input.idempotencyKey,
      input.record.binding.reportId,
      input.requestFingerprint,
      () => {
        this.database
          .query(
            `INSERT INTO evaluation_records (
              report_id, experiment_id, run_id, dataset_id, dataset_checksum,
              case_id, status, value_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.record.binding.reportId,
            input.record.binding.experimentId,
            input.record.binding.runId,
            input.record.binding.datasetId,
            input.record.binding.datasetChecksum,
            input.record.binding.caseId,
            input.record.report.status,
            serialized(input.record),
            input.record.binding.createdAt,
          );
      },
      () => this.getRecord(input.record.binding.reportId),
    );
  }

  getRecord(reportId: string): Result<EvaluationRecord, EvaluationStoreError> {
    return flatten(
      safeCall(
        () =>
          decoded(
            this.database
              .query<JsonRow, [string]>(
                'SELECT value_json FROM evaluation_records WHERE report_id = ?',
              )
              .get(reportId),
            isEvaluationRecord,
            reportId,
          ),
        (cause) => databaseError('getEvaluationRecord', cause),
      ),
    );
  }

  listRecords(
    query: EvaluationRecordQuery = {},
  ): Result<readonly EvaluationRecord[], EvaluationStoreError> {
    return flatten(
      safeCall(
        () => {
          let rows: readonly JsonRow[];
          if (query.runId !== undefined) {
            rows = this.database
              .query<JsonRow, [string]>(
                `SELECT value_json FROM evaluation_records
               WHERE run_id = ? ORDER BY created_at, report_id`,
              )
              .all(query.runId);
          } else if (query.experimentId !== undefined) {
            rows = this.database
              .query<JsonRow, [string]>(
                `SELECT value_json FROM evaluation_records
               WHERE experiment_id = ? ORDER BY created_at, report_id`,
              )
              .all(query.experimentId);
          } else {
            rows = this.database
              .query<JsonRow, []>(
                'SELECT value_json FROM evaluation_records ORDER BY created_at, report_id',
              )
              .all();
          }
          return this.decodeMany(rows, isEvaluationRecord, 'evaluation record');
        },
        (cause) => databaseError('listEvaluationRecords', cause),
      ),
    );
  }

  addAnnotation(
    annotation: EvaluationAnnotation,
    idempotencyKey: string,
    requestFingerprint: `sha256:${string}`,
  ): Result<EvaluationAnnotation, EvaluationStoreError> {
    return this.idempotentWrite(
      'annotation',
      idempotencyKey,
      annotation.id,
      requestFingerprint,
      () => {
        this.database
          .query(
            `INSERT INTO evaluation_annotations (id, report_id, value_json, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(annotation.id, annotation.reportId, serialized(annotation), annotation.createdAt);
      },
      () => this.annotation(annotation.id),
    );
  }

  listAnnotations(reportId: string): Result<readonly EvaluationAnnotation[], EvaluationStoreError> {
    return flatten(
      safeCall(
        () => {
          const rows = this.database
            .query<JsonRow, [string]>(
              `SELECT value_json FROM evaluation_annotations
             WHERE report_id = ? ORDER BY created_at, id`,
            )
            .all(reportId);
          return this.decodeMany(rows, isAnnotation, 'evaluation annotation');
        },
        (cause) => databaseError('listEvaluationAnnotations', cause),
      ),
    );
  }

  addPreference(
    preference: EvaluationPreference,
    idempotencyKey: string,
    requestFingerprint: `sha256:${string}`,
  ): Result<EvaluationPreference, EvaluationStoreError> {
    return this.idempotentWrite(
      'preference',
      idempotencyKey,
      preference.id,
      requestFingerprint,
      () => {
        this.database
          .query(
            `INSERT INTO evaluation_preferences (
              id, experiment_id, left_report_id, right_report_id, value_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            preference.id,
            preference.experimentId,
            preference.leftReportId,
            preference.rightReportId,
            serialized(preference),
            preference.createdAt,
          );
      },
      () => this.preference(preference.id),
    );
  }

  listPreferences(
    experimentId: string,
  ): Result<readonly EvaluationPreference[], EvaluationStoreError> {
    return flatten(
      safeCall(
        () => {
          const rows = this.database
            .query<JsonRow, [string]>(
              `SELECT value_json FROM evaluation_preferences
             WHERE experiment_id = ? ORDER BY created_at, id`,
            )
            .all(experimentId);
          return this.decodeMany(rows, isPreference, 'evaluation preference');
        },
        (cause) => databaseError('listEvaluationPreferences', cause),
      ),
    );
  }

  private annotation(id: string): Result<EvaluationAnnotation, EvaluationStoreError> {
    return flatten(
      safeCall(
        () =>
          decoded(
            this.database
              .query<JsonRow, [string]>(
                'SELECT value_json FROM evaluation_annotations WHERE id = ?',
              )
              .get(id),
            isAnnotation,
            id,
          ),
        (cause) => databaseError('getEvaluationAnnotation', cause),
      ),
    );
  }

  private preference(id: string): Result<EvaluationPreference, EvaluationStoreError> {
    return flatten(
      safeCall(
        () =>
          decoded(
            this.database
              .query<JsonRow, [string]>(
                'SELECT value_json FROM evaluation_preferences WHERE id = ?',
              )
              .get(id),
            isPreference,
            id,
          ),
        (cause) => databaseError('getEvaluationPreference', cause),
      ),
    );
  }

  private decodeMany<T>(
    rows: readonly JsonRow[],
    guard: (value: unknown) => value is T,
    entity: string,
  ): Result<readonly T[], EvaluationStoreError> {
    const values: T[] = [];
    for (const [index, row] of rows.entries()) {
      const value = decoded(row, guard, `${entity}:${index}`);
      if (value.isErr()) return value;
      values.push(value.value);
    }
    return ok(values);
  }

  private idempotentWrite<T>(
    operation: string,
    key: string,
    entityId: string,
    requestFingerprint: `sha256:${string}`,
    write: () => void,
    read: () => Result<T, EvaluationStoreError>,
  ): Result<T, EvaluationStoreError> {
    return flatten(
      safeCall(
        () => {
          const requestJson = requestFingerprint;
          const existing = this.database
            .query<IdempotencyRow, [string]>(
              `SELECT operation, request_json, entity_id FROM evaluation_idempotency
             WHERE idempotency_key = ?`,
            )
            .get(key);
          if (existing) {
            if (
              existing.operation !== operation ||
              existing.request_json !== requestJson ||
              existing.entity_id !== entityId
            ) {
              return err(
                storeError(
                  EvaluationStoreErrorKind.IdempotencyConflict,
                  `Idempotency key ${key} was already used for a different evaluation write`,
                  entityId,
                ),
              );
            }
            return read();
          }
          const transaction = this.database.transaction(() => {
            write();
            this.database
              .query(
                `INSERT INTO evaluation_idempotency (
                idempotency_key, operation, request_json, entity_id
              ) VALUES (?, ?, ?, ?)`,
              )
              .run(key, operation, requestJson, entityId);
          });
          transaction();
          return read();
        },
        (cause) => databaseError(`writeEvaluation${operation}`, cause),
      ),
    );
  }
}
