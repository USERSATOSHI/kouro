import type { Result } from '@usersatoshi/results';

import type { EvaluationAnnotation, EvaluationPreference, EvaluationRecord } from './types.ts';

export const enum EvaluationStoreErrorKind {
  DatabaseFailure = 0,
  RecordNotFound = 1,
  IdempotencyConflict = 2,
  InvalidRecord = 3,
}

export interface EvaluationStoreError {
  readonly kind: EvaluationStoreErrorKind;
  readonly message: string;
  readonly entityId?: string;
}

export interface SaveEvaluationRecordInput {
  readonly record: EvaluationRecord;
  readonly idempotencyKey: string;
  readonly requestFingerprint: `sha256:${string}`;
}

export interface EvaluationRecordQuery {
  readonly runId?: string;
  readonly experimentId?: string;
}

export interface EvaluationStore {
  saveRecord(input: SaveEvaluationRecordInput): Result<EvaluationRecord, EvaluationStoreError>;
  getRecord(reportId: string): Result<EvaluationRecord, EvaluationStoreError>;
  listRecords(
    query?: EvaluationRecordQuery,
  ): Result<readonly EvaluationRecord[], EvaluationStoreError>;
  addAnnotation(
    annotation: EvaluationAnnotation,
    idempotencyKey: string,
    requestFingerprint: `sha256:${string}`,
  ): Result<EvaluationAnnotation, EvaluationStoreError>;
  listAnnotations(reportId: string): Result<readonly EvaluationAnnotation[], EvaluationStoreError>;
  addPreference(
    preference: EvaluationPreference,
    idempotencyKey: string,
    requestFingerprint: `sha256:${string}`,
  ): Result<EvaluationPreference, EvaluationStoreError>;
  listPreferences(
    experimentId: string,
  ): Result<readonly EvaluationPreference[], EvaluationStoreError>;
}
