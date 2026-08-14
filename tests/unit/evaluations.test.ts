import { describe, expect, test } from 'bun:test';

import type { RunState } from '@kouro/domain';
import { compileEvaluationDataset, evaluateRun, EvaluationErrorKind } from '@kouro/evaluations';

function dataset(
  cases: readonly unknown[] = [evaluationCase()],
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: '1',
    id: 'feature-regression',
    version: '1.0.0',
    cases,
  };
}

function evaluationCase(): Readonly<Record<string, unknown>> {
  return {
    id: 'health-check',
    workItem: { title: 'Add a health check' },
    expectations: [
      { type: 'node_outcome', nodeId: 'test', outcome: 'success' },
      { type: 'run_status', value: 'succeeded' },
      { type: 'max_total_tokens', value: 2000 },
      { type: 'max_invocations', value: 4 },
    ],
  };
}

function runState(): RunState {
  return {
    workflowChecksum: 'sha256:workflow',
    startingCommit: 'abc123',
    repositoryHead: 'def456',
    configuration: {},
    status: 'succeeded',
    nextInvocationSequence: 3,
    counters: {},
    invocations: [
      {
        sequence: 1,
        nodeId: 'implement',
        state: 'succeeded',
        outcome: 'success',
        attempts: [
          {
            number: 1,
            state: 'succeeded',
            harnessId: 'codex',
            usage: { inputTokens: 1000, outputTokens: 200 },
            subagents: [
              {
                sequence: 1,
                callId: 'scout:1',
                subagentId: 'scout',
                task: 'Inspect repository',
                harnessId: 'codex',
                state: 'succeeded',
                usage: { inputTokens: 300, outputTokens: 50 },
              },
            ],
          },
        ],
      },
      {
        sequence: 2,
        nodeId: 'test',
        state: 'succeeded',
        outcome: 'success',
        attempts: [{ number: 1, state: 'succeeded' }],
      },
    ],
  };
}

describe('repository-local evaluation datasets', () => {
  test('compiles source ordering into one stable checksum', () => {
    const first = compileEvaluationDataset(dataset());
    const definition = evaluationCase();
    const expectations = Array.isArray(definition.expectations) ? definition.expectations : [];
    const reversed = compileEvaluationDataset(
      dataset([{ ...definition, expectations: expectations.toReversed() }]),
    );

    expect(first.isOk()).toBe(true);
    expect(reversed.isOk()).toBe(true);
    if (first.isOk() && reversed.isOk()) {
      expect(first.value.canonical).toBe(reversed.value.canonical);
      expect(first.value.checksum).toBe(reversed.value.checksum);
      expect(first.value.dataset.cases[0]?.expectations.map(({ type }) => type)).toEqual([
        'max_invocations',
        'max_total_tokens',
        'node_outcome',
        'run_status',
      ]);
    }
  });

  test('rejects duplicate cases, duplicate rules, and unknown fields', () => {
    const duplicateCase = compileEvaluationDataset(dataset([evaluationCase(), evaluationCase()]));
    expect(duplicateCase.isErr()).toBe(true);
    if (duplicateCase.isErr()) {
      expect(duplicateCase.error.kind).toBe(EvaluationErrorKind.DuplicateCase);
    }

    const duplicateRule = compileEvaluationDataset(
      dataset([
        {
          id: 'duplicate-rule',
          workItem: {},
          expectations: [
            { type: 'run_status', value: 'succeeded' },
            { type: 'run_status', value: 'failed' },
          ],
        },
      ]),
    );
    expect(duplicateRule.isErr()).toBe(true);
    if (duplicateRule.isErr()) {
      expect(duplicateRule.error.kind).toBe(EvaluationErrorKind.DuplicateExpectation);
    }

    expect(compileEvaluationDataset({ ...dataset(), remoteMemory: 'kyuki' }).isErr()).toBe(true);
  });

  test('passes exact durable evidence and reports aggregate usage', () => {
    const compiled = compileEvaluationDataset(dataset()).unwrap();
    const report = evaluateRun(compiled, 'health-check', { state: runState() }).unwrap();

    expect(report.status).toBe('passed');
    expect(report.checks.every(({ status }) => status === 'passed')).toBe(true);
    expect(report.usage).toEqual({ inputTokens: 1300, outputTokens: 250 });
  });

  test('distinguishes failed expectations from unavailable telemetry', () => {
    const compiled = compileEvaluationDataset(dataset()).unwrap();
    const state = runState();
    const failed = evaluateRun(compiled, 'health-check', {
      state: { ...state, status: 'failed' },
    }).unwrap();
    expect(failed.status).toBe('failed');

    const incomplete = evaluateRun(compiled, 'health-check', {
      state: {
        ...state,
        invocations: state.invocations.map((invocation, index) =>
          index === 0
            ? {
                ...invocation,
                attempts: invocation.attempts.map(({ usage: _usage, ...attempt }) => attempt),
              }
            : invocation,
        ),
      },
    }).unwrap();
    expect(incomplete.status).toBe('incomplete');
    expect(
      incomplete.checks.find(({ expectation }) => expectation.type === 'max_total_tokens')?.status,
    ).toBe('unavailable');
  });

  test('returns a typed error for an unknown case', () => {
    const result = evaluateRun(compileEvaluationDataset(dataset()).unwrap(), 'missing', {
      state: runState(),
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(EvaluationErrorKind.UnknownCase);
  });
});
