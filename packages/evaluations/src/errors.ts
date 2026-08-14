import { err, type Result } from '@usersatoshi/results';

export const enum EvaluationErrorKind {
  InvalidDataset = 0,
  DuplicateCase = 1,
  DuplicateExpectation = 2,
  UnknownCase = 3,
}

export interface EvaluationError {
  readonly kind: EvaluationErrorKind;
  readonly message: string;
  readonly path?: string;
}

export function toEvaluationError(
  kind: EvaluationErrorKind,
  message: string,
  path?: string,
): Result<never, EvaluationError> {
  return err({ kind, message, ...(path ? { path } : {}) });
}
