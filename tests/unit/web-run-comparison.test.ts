import { describe, expect, test } from 'bun:test';

import type { RunDetails } from '@kouro/api-contracts';

import {
  runComparisonColumn,
  runComparisonWarnings,
} from '../../packages/web/src/run-comparison.ts';

function comparisonRun(id = 'run-a'): RunDetails {
  return {
    id,
    repositoryId: 'kouro',
    repositoryPath: '/repositories/kouro',
    workflowId: 'feature-development',
    workflowVersion: '1.0.0',
    workflowChecksum: 'sha256:workflow',
    status: 'succeeded',
    startingCommit: 'abc123',
    eventCount: 12,
    invocationCount: 1,
    pendingApprovalCount: 0,
    entryNodeId: 'implement',
    repositoryHead: 'def456',
    state: {
      workflowChecksum: 'sha256:workflow',
      startingCommit: 'abc123',
      repositoryHead: 'def456',
      configuration: { workItem: { id: 'ticket-1', title: 'Add comparison' } },
      startedAt: '2026-08-14T10:00:00.000Z',
      observedAt: '2026-08-14T10:02:30.000Z',
      status: 'succeeded',
      nextInvocationSequence: 2,
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
              usage: { inputTokens: 1000, outputTokens: 200 },
              subagents: [
                {
                  sequence: 1,
                  callId: 'scout:1',
                  subagentId: 'scout',
                  task: 'Inspect repository',
                  harnessId: 'codex',
                  model: 'gpt-4o-mini',
                  state: 'succeeded',
                  usage: { inputTokens: 300, outputTokens: 50 },
                },
              ],
            },
          ],
        },
      ],
    },
    nodes: [{ id: 'implement', type: 'agent', title: 'Implement', ordinal: 0, invocations: [1] }],
    subagents: [
      {
        id: 'scout',
        role: 'repository-scout',
        parentNodeIds: ['implement'],
        maxInvocations: 1,
        maxConcurrent: 1,
      },
    ],
    edges: [],
  };
}

describe('run comparison projection', () => {
  test('attributes usage, cost, duration, and failures to agents and subagents', () => {
    const column = runComparisonColumn(comparisonRun());

    expect(column.durationMs).toBe(150_000);
    expect(column.attemptCount).toBe(1);
    expect(column.subagentCallCount).toBe(1);
    expect(column.usage).toEqual({ inputTokens: 1300, outputTokens: 250 });
    expect(column.costUsd).toBeDefined();
    expect(column.executions).toEqual([
      expect.objectContaining({
        key: 'agent:implement',
        count: 1,
        failedCount: 0,
        usage: { inputTokens: 1000, outputTokens: 200 },
      }),
      expect.objectContaining({
        key: 'subagent:implement:scout',
        count: 1,
        failedCount: 0,
        usage: { inputTokens: 300, outputTokens: 50 },
      }),
    ]);
  });

  test('fails closed for an unpriced execution source', () => {
    const run = comparisonRun();
    const unpriced: RunDetails = {
      ...run,
      state: {
        ...run.state,
        invocations: run.state.invocations.map((invocation) => ({
          ...invocation,
          attempts: invocation.attempts.map((attempt) => ({
            ...attempt,
            model: 'private-model',
          })),
        })),
      },
    };

    const column = runComparisonColumn(unpriced);
    expect(column.usage).toBeDefined();
    expect(column.costUsd).toBeUndefined();
    expect(column.executions[0]?.costUsd).toBeUndefined();
  });

  test('warns when experiment-defining inputs differ but ignores object key order', () => {
    const first = comparisonRun('run-a');
    const reordered: RunDetails = {
      ...comparisonRun('run-b'),
      state: {
        ...comparisonRun('run-b').state,
        configuration: { workItem: { title: 'Add comparison', id: 'ticket-1' } },
      },
    };
    expect(runComparisonWarnings([first, reordered])).toEqual([]);

    const changed: RunDetails = {
      ...reordered,
      startingCommit: 'different',
      state: {
        ...reordered.state,
        configuration: { workItem: { id: 'ticket-2' } },
      },
    };
    expect(runComparisonWarnings([first, changed])).toEqual([
      'Starting commits differ.',
      'Immutable work items differ.',
    ]);
  });

  test('projects the latest deterministic and human evaluation evidence', () => {
    const run = comparisonRun();
    const evaluated: RunDetails = {
      ...run,
      evaluations: [
        {
          binding: {
            reportId: 'report-a',
            experimentId: 'experiment-a',
            runId: run.id,
            repositoryId: run.repositoryId,
            startingCommit: run.startingCommit,
            workflowChecksum: run.workflowChecksum,
            configurationChecksum: 'sha256:configuration',
            datasetId: 'feature-regression',
            datasetVersion: '1.0.0',
            datasetChecksum: 'sha256:dataset',
            caseId: 'comparison',
            evaluatorVersion: '1',
            createdBy: 'operator',
            createdAt: '2026-08-14T12:00:00.000Z',
          },
          report: {
            datasetId: 'feature-regression',
            datasetVersion: '1.0.0',
            datasetChecksum: 'sha256:dataset',
            caseId: 'comparison',
            status: 'failed',
            checks: [
              {
                expectation: { type: 'run_status', value: 'succeeded' },
                status: 'passed',
                message: 'passed',
              },
              {
                expectation: { type: 'max_invocations', value: 1 },
                status: 'failed',
                message: 'failed',
              },
            ],
          },
          annotations: [
            {
              id: 'annotation-a',
              reportId: 'report-a',
              actor: 'reviewer',
              verdict: 'unsure',
              note: 'Needs inspection',
              createdAt: '2026-08-14T12:01:00.000Z',
            },
          ],
        },
      ],
    };

    expect(runComparisonColumn(evaluated).evaluation).toEqual({
      reportId: 'report-a',
      experimentId: 'experiment-a',
      datasetId: 'feature-regression',
      datasetVersion: '1.0.0',
      datasetChecksum: 'sha256:dataset',
      caseId: 'comparison',
      status: 'failed',
      passedChecks: 1,
      totalChecks: 2,
      humanVerdicts: ['unsure'],
    });
    expect(runComparisonWarnings([evaluated, comparisonRun('run-b')])).toContain(
      'Only some runs have evaluation evidence.',
    );
  });
});
