import { canonicalJson, compareCanonicalText, sha256 } from '@kouro/adw';
import type { JsonValue } from '@kouro/domain';
import { ok, type Result } from '@usersatoshi/results';

import { EvaluationErrorKind, toEvaluationError, type EvaluationError } from './errors.ts';
import type {
  CompiledEvaluationDataset,
  EvaluationCase,
  EvaluationDataset,
  EvaluationExpectation,
} from './types.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted(compareCanonicalText);
  const expected = [...keys].toSorted(compareCanonicalText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function terminalStatus(value: unknown): 'succeeded' | 'failed' | 'cancelled' | undefined {
  return value === 'succeeded' || value === 'failed' || value === 'cancelled' ? value : undefined;
}

function expectation(value: unknown): EvaluationExpectation | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'run_status') {
    const status = terminalStatus(value.value);
    return hasExactKeys(value, ['type', 'value']) && status
      ? { type: 'run_status', value: status }
      : undefined;
  }
  if (value.type === 'max_invocations' || value.type === 'max_total_tokens') {
    return hasExactKeys(value, ['type', 'value']) && isPositiveInteger(value.value)
      ? { type: value.type, value: value.value }
      : undefined;
  }
  if (value.type === 'node_outcome') {
    return hasExactKeys(value, ['type', 'nodeId', 'outcome']) &&
      typeof value.nodeId === 'string' &&
      value.nodeId.trim().length > 0 &&
      typeof value.outcome === 'string' &&
      value.outcome.trim().length > 0
      ? { type: 'node_outcome', nodeId: value.nodeId, outcome: value.outcome }
      : undefined;
  }
  return undefined;
}

function expectationKey(value: EvaluationExpectation): string {
  return value.type === 'node_outcome' ? `${value.type}:${value.nodeId}` : value.type;
}

function expectationJson(value: EvaluationExpectation): JsonValue {
  if (value.type === 'node_outcome') {
    return { type: value.type, nodeId: value.nodeId, outcome: value.outcome };
  }
  return { type: value.type, value: value.value };
}

function datasetJson(dataset: EvaluationDataset): JsonValue {
  return {
    schemaVersion: dataset.schemaVersion,
    id: dataset.id,
    version: dataset.version,
    cases: dataset.cases.map((evaluationCase) => ({
      id: evaluationCase.id,
      workItem: evaluationCase.workItem,
      expectations: evaluationCase.expectations.map(expectationJson),
    })),
  };
}

function parsedCase(value: unknown, index: number): Result<EvaluationCase, EvaluationError> {
  const path = `cases[${index}]`;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'workItem', 'expectations']) ||
    typeof value.id !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(value.id) ||
    !isJsonValue(value.workItem) ||
    !Array.isArray(value.expectations) ||
    value.expectations.length === 0
  ) {
    return toEvaluationError(EvaluationErrorKind.InvalidDataset, 'Invalid evaluation case', path);
  }
  const expectations = value.expectations.map(expectation);
  if (expectations.some((candidate) => candidate === undefined)) {
    return toEvaluationError(
      EvaluationErrorKind.InvalidDataset,
      'Invalid evaluation expectation',
      `${path}.expectations`,
    );
  }
  const normalized = expectations.flatMap((candidate) => (candidate ? [candidate] : []));
  const keys = normalized.map(expectationKey);
  if (new Set(keys).size !== keys.length) {
    return toEvaluationError(
      EvaluationErrorKind.DuplicateExpectation,
      'Each expectation type or node outcome may appear only once per case',
      `${path}.expectations`,
    );
  }
  return ok({
    id: value.id,
    workItem: value.workItem,
    expectations: normalized.toSorted((left, right) =>
      compareCanonicalText(expectationKey(left), expectationKey(right)),
    ),
  });
}

/** Validates and content-addresses one repository-local evaluation dataset. */
export function compileEvaluationDataset(
  value: unknown,
): Result<CompiledEvaluationDataset, EvaluationError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'id', 'version', 'cases']) ||
    value.schemaVersion !== '1' ||
    typeof value.id !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(value.id) ||
    typeof value.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0
  ) {
    return toEvaluationError(
      EvaluationErrorKind.InvalidDataset,
      'Dataset must declare schema version 1, stable IDs, a semantic version, and cases',
    );
  }
  const cases: EvaluationCase[] = [];
  for (const [index, candidate] of value.cases.entries()) {
    const parsed = parsedCase(candidate, index);
    if (parsed.isErr()) return parsed;
    cases.push(parsed.value);
  }
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) {
    return toEvaluationError(EvaluationErrorKind.DuplicateCase, 'Case IDs must be unique', 'cases');
  }
  const dataset: EvaluationDataset = {
    schemaVersion: '1',
    id: value.id,
    version: value.version,
    cases: cases.toSorted((left, right) => compareCanonicalText(left.id, right.id)),
  };
  const canonical = canonicalJson(datasetJson(dataset));
  return ok({ dataset, canonical, checksum: sha256(canonical) });
}
