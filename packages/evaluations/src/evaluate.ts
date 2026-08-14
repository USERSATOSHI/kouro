import { sumUsage, type RunState, type TokenUsage } from '@kouro/domain';
import { ok, type Result } from '@usersatoshi/results';

import { EvaluationErrorKind, toEvaluationError, type EvaluationError } from './errors.ts';
import type {
  CompiledEvaluationDataset,
  EvaluationCheckResult,
  EvaluationExpectation,
  EvaluationReport,
  EvaluationTarget,
} from './types.ts';

interface UsageObservation {
  readonly usage?: TokenUsage;
  readonly complete: boolean;
}

function usageObservation(state: RunState): UsageObservation {
  const attempts = state.invocations.flatMap(
    ({ attempts: invocationAttempts }) => invocationAttempts,
  );
  const subagents = attempts.flatMap(({ subagents: calls }) => calls ?? []);
  const usage = [
    ...attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : [])),
    ...subagents.flatMap((subagent) => (subagent.usage ? [subagent.usage] : [])),
  ];
  const missingParentUsage = attempts.some(
    ({ harnessId, usage: attemptUsage }) => harnessId !== undefined && attemptUsage === undefined,
  );
  const missingSubagentUsage = subagents.some(({ usage: childUsage }) => childUsage === undefined);
  return {
    ...(usage.length > 0 ? { usage: sumUsage(usage) } : {}),
    complete: !missingParentUsage && !missingSubagentUsage,
  };
}

function result(
  expectation: EvaluationExpectation,
  status: EvaluationCheckResult['status'],
  message: string,
  observed?: EvaluationCheckResult['observed'],
): EvaluationCheckResult {
  return { expectation, status, message, ...(observed === undefined ? {} : { observed }) };
}

function evaluateRunStatus(
  expectation: Extract<EvaluationExpectation, { readonly type: 'run_status' }>,
  state: RunState,
): EvaluationCheckResult {
  if (!['succeeded', 'failed', 'cancelled'].includes(state.status)) {
    return result(expectation, 'unavailable', 'Run is not terminal', state.status);
  }
  return state.status === expectation.value
    ? result(expectation, 'passed', `Run status is ${state.status}`, state.status)
    : result(
        expectation,
        'failed',
        `Expected ${expectation.value}, observed ${state.status}`,
        state.status,
      );
}

function evaluateMaximumInvocations(
  expectation: Extract<EvaluationExpectation, { readonly type: 'max_invocations' }>,
  state: RunState,
): EvaluationCheckResult {
  const observed = state.invocations.length;
  return observed <= expectation.value
    ? result(expectation, 'passed', `${observed} invocations are within the limit`, observed)
    : result(
        expectation,
        'failed',
        `${observed} invocations exceed ${expectation.value}`,
        observed,
      );
}

function evaluateTokenBudget(
  expectation: Extract<EvaluationExpectation, { readonly type: 'max_total_tokens' }>,
  usage: UsageObservation,
): EvaluationCheckResult {
  if (!usage.complete) {
    return result(expectation, 'unavailable', 'One or more model executions did not report usage');
  }
  const observed = usage.usage ? usage.usage.inputTokens + usage.usage.outputTokens : 0;
  return observed <= expectation.value
    ? result(expectation, 'passed', `${observed} reported tokens are within the limit`, observed)
    : result(
        expectation,
        'failed',
        `${observed} reported tokens exceed ${expectation.value}`,
        observed,
      );
}

function evaluateNodeOutcome(
  expectation: Extract<EvaluationExpectation, { readonly type: 'node_outcome' }>,
  state: RunState,
): EvaluationCheckResult {
  const invocation = state.invocations
    .filter(({ nodeId }) => nodeId === expectation.nodeId)
    .toSorted((left, right) => right.sequence - left.sequence)[0];
  if (!invocation?.outcome) {
    return result(
      expectation,
      'unavailable',
      `Node ${expectation.nodeId} has no completed outcome`,
    );
  }
  return invocation.outcome === expectation.outcome
    ? result(
        expectation,
        'passed',
        `${expectation.nodeId} produced ${invocation.outcome}`,
        invocation.outcome,
      )
    : result(
        expectation,
        'failed',
        `Expected ${expectation.nodeId} to produce ${expectation.outcome}, observed ${invocation.outcome}`,
        invocation.outcome,
      );
}

function evaluateExpectation(
  expectation: EvaluationExpectation,
  state: RunState,
  usage: UsageObservation,
): EvaluationCheckResult {
  if (expectation.type === 'run_status') {
    return evaluateRunStatus(expectation, state);
  }
  if (expectation.type === 'max_invocations') {
    return evaluateMaximumInvocations(expectation, state);
  }
  if (expectation.type === 'max_total_tokens') {
    return evaluateTokenBudget(expectation, usage);
  }
  return evaluateNodeOutcome(expectation, state);
}

/** Evaluates one durable run projection against one exact compiled dataset case. */
export function evaluateRun(
  dataset: CompiledEvaluationDataset,
  caseId: string,
  target: EvaluationTarget,
): Result<EvaluationReport, EvaluationError> {
  const evaluationCase = dataset.dataset.cases.find(({ id }) => id === caseId);
  if (!evaluationCase) {
    return toEvaluationError(EvaluationErrorKind.UnknownCase, `Unknown evaluation case: ${caseId}`);
  }
  const usage = usageObservation(target.state);
  const checks = evaluationCase.expectations.map((expectation) =>
    evaluateExpectation(expectation, target.state, usage),
  );
  const status = checks.some((check) => check.status === 'failed')
    ? 'failed'
    : checks.some((check) => check.status === 'unavailable')
      ? 'incomplete'
      : 'passed';
  return ok({
    datasetId: dataset.dataset.id,
    datasetVersion: dataset.dataset.version,
    datasetChecksum: dataset.checksum,
    caseId,
    status,
    checks,
    ...(usage.usage ? { usage: usage.usage } : {}),
  });
}
