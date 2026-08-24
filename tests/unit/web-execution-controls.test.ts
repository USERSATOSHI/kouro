import { describe, expect, test } from 'bun:test';

import type { RunDetails } from '@kouro/api-contracts';

import {
  invocationControlAvailability,
  preferredInvocationSequence,
} from '../../packages/web/src/execution-controls.ts';
import { runFocus } from '../../packages/web/src/execution-presentation.ts';

function runDetails(status: RunDetails['status'] = 'running'): RunDetails {
  return {
    id: 'run-1',
    repositoryId: 'kouro',
    repositoryPath: '/repositories/kouro',
    workflowId: 'chore',
    workflowVersion: '1.0.0',
    workflowChecksum: 'sha256:workflow',
    status,
    startingCommit: 'abc123',
    eventCount: 7,
    invocationCount: 3,
    pendingApprovalCount: 0,
    entryNodeId: 'implement',
    repositoryHead: 'abc123',
    state: {
      workflowChecksum: 'sha256:workflow',
      startingCommit: 'abc123',
      repositoryHead: 'abc123',
      configuration: {},
      status,
      nextInvocationSequence: 4,
      counters: {},
      invocations: [
        {
          sequence: 1,
          nodeId: 'implement',
          state: 'interrupted',
          attempts: [{ number: 1, state: 'interrupted' }],
        },
        {
          sequence: 2,
          nodeId: 'validate',
          state: 'active',
          attempts: [{ number: 1, state: 'running' }],
        },
        {
          sequence: 3,
          nodeId: 'implement',
          state: 'active',
          attempts: [{ number: 2, state: 'running' }],
        },
      ],
    },
    nodes: [
      {
        id: 'implement',
        type: 'agent',
        title: 'Implement',
        ordinal: 0,
        invocations: [1, 3],
        recoveryPolicy: 'replay_safe',
        skipOutcome: 'skipped',
        latestState: 'active',
      },
      {
        id: 'validate',
        type: 'command',
        title: 'Validate',
        ordinal: 1,
        invocations: [2],
        latestState: 'active',
      },
    ],
    edges: [],
  };
}

describe('web execution controls', () => {
  test('targets the latest active invocation for the selected node', () => {
    const run = runDetails();
    expect(preferredInvocationSequence(run, 'implement')).toBe(3);
    expect(preferredInvocationSequence(run, null)).toBe(3);
  });

  test('enables only controls allowed by durable invocation state', () => {
    const run = runDetails();
    expect(invocationControlAvailability(run, 3)).toEqual({
      steerable: true,
      interruptible: true,
      retryable: false,
      skippable: false,
    });
    expect(invocationControlAvailability(run, 1)).toEqual({
      steerable: false,
      interruptible: false,
      retryable: true,
      skippable: true,
    });
    expect(invocationControlAvailability(runDetails('paused'), 3).steerable).toBe(true);
    expect(invocationControlAvailability(run, 2)).toEqual({
      steerable: false,
      interruptible: true,
      retryable: false,
      skippable: false,
    });
  });

  test('summarizes the operator-relevant run position in plain language', () => {
    expect(runFocus(runDetails())).toEqual({
      title: 'Implement',
      detail: 'The workflow is actively working on this step.',
    });
    expect(runFocus(runDetails('waiting_for_approval'))).toEqual({
      title: 'Approval required',
      detail: 'Review Implement to continue.',
    });
    expect(runFocus(runDetails('failed'))).toEqual({
      title: 'Stopped at Implement',
      detail: 'Inspect the latest invocation for the failure and recovery options.',
    });
  });
});
