import { describe, expect, test } from 'bun:test';

import type { RunDetails } from '@kouro/api-contracts';

import {
  formatTokenCount,
  formatUsd,
  runCostUsd,
  runUsage,
} from '../../packages/web/src/execution-presentation.ts';

function runDetails(): RunDetails {
  return {
    id: 'run-1',
    repositoryId: 'kouro',
    repositoryPath: '/repositories/kouro',
    workflowId: 'chore',
    workflowVersion: '1.0.0',
    workflowChecksum: 'sha256:workflow',
    status: 'succeeded',
    startingCommit: 'abc123',
    eventCount: 7,
    invocationCount: 2,
    pendingApprovalCount: 0,
    entryNodeId: 'implement',
    repositoryHead: 'abc123',
    state: {
      workflowChecksum: 'sha256:workflow',
      startingCommit: 'abc123',
      repositoryHead: 'abc123',
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
              model: 'gpt-4o',
              usage: { inputTokens: 1_000_000, outputTokens: 200_000 },
            },
          ],
        },
        {
          sequence: 2,
          nodeId: 'validate',
          state: 'cancelled',
          attempts: [],
        },
      ],
    },
    nodes: [
      { id: 'implement', type: 'agent', title: 'Implement', ordinal: 0, invocations: [1] },
      { id: 'validate', type: 'command', title: 'Validate', ordinal: 1, invocations: [2] },
    ],
    edges: [],
  };
}

describe('web cost presentation', () => {
  test('sums run usage across attempts with reported tokens', () => {
    expect(runUsage(runDetails())).toEqual({ inputTokens: 1_000_000, outputTokens: 200_000 });
  });

  test('estimates run cost from priced attempts only', () => {
    expect(runCostUsd(runDetails())).toBeCloseTo(4.5, 5);
  });

  test('includes subordinate execution usage and cost in run totals', () => {
    const run = runDetails();
    const withSubagent = {
      ...run,
      state: {
        ...run.state,
        invocations: run.state.invocations.map((invocation, index) =>
          index === 0
            ? {
                ...invocation,
                attempts: invocation.attempts.map((attempt) => ({
                  ...attempt,
                  subagents: [
                    {
                      sequence: 1,
                      callId: 'scout:1',
                      subagentId: 'scout',
                      task: 'Inspect the repository',
                      harnessId: 'codex',
                      model: 'gpt-4o-mini',
                      state: 'succeeded' as const,
                      usage: { inputTokens: 100_000, outputTokens: 20_000 },
                    },
                  ],
                })),
              }
            : invocation,
        ),
      },
    };
    expect(runUsage(withSubagent)).toEqual({
      inputTokens: 1_100_000,
      outputTokens: 220_000,
    });
    expect(runCostUsd(withSubagent)).toBeCloseTo(4.527, 5);
  });

  test('does not present a partial run total when an attempt is unpriced', () => {
    const run = runDetails();
    const mixedPricing = {
      ...run,
      state: {
        ...run.state,
        invocations: run.state.invocations.map((invocation, index) =>
          index === 1
            ? {
                ...invocation,
                attempts: [
                  {
                    number: 1,
                    state: 'cancelled' as const,
                    model: 'private-model',
                    usage: { inputTokens: 100, outputTokens: 20 },
                  },
                ],
              }
            : invocation,
        ),
      },
    };
    expect(runCostUsd(mixedPricing)).toBeUndefined();
  });

  test('returns no usage when no attempt reported tokens', () => {
    const run = runDetails();
    const stripped = {
      ...run,
      state: {
        ...run.state,
        invocations: run.state.invocations.map((invocation, index) =>
          index === 0
            ? {
                ...invocation,
                attempts: [{ number: 1, state: 'succeeded' as const, model: 'gpt-4o' }],
              }
            : invocation,
        ),
      },
    };
    expect(runUsage(stripped)).toBeUndefined();
    expect(runCostUsd(stripped)).toBeUndefined();
  });

  test('formats token counts with SI units', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
  });

  test('formats USD with two decimals', () => {
    expect(formatUsd(4.5)).toBe('$4.50');
    expect(formatUsd(0.001)).toBe('$0.00');
  });
});
