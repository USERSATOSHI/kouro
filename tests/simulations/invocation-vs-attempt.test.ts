import { describe, expect, test } from 'bun:test';

import { reduceRun, RuntimeErrorKind, scheduleRun } from '@kouro/runtime';
import { compileOrThrow, interruptedEvents, workflowSource } from './fixtures.ts';

describe('ADR-0002: definition, invocation, and attempt', () => {
  test('durably projects a valid wall-clock span', () => {
    const artifact = compileOrThrow();
    const state = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'command',
        activatedAt: '2026-08-14T10:00:00.000Z',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
        finishedAt: '2026-08-14T10:00:12.000Z',
      },
    ]);

    expect(state.isOk()).toBe(true);
    expect(state.isOk() ? state.value.invocations[0] : undefined).toMatchObject({
      activatedAt: '2026-08-14T10:00:00.000Z',
      finishedAt: '2026-08-14T10:00:12.000Z',
    });
  });

  test('rejects an invocation finish before its activation', () => {
    const artifact = compileOrThrow();
    const state = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'command',
        activatedAt: '2026-08-14T10:00:10.000Z',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
        finishedAt: '2026-08-14T10:00:09.000Z',
      },
    ]);

    expect(state.isErr()).toBe(true);
    if (state.isErr()) expect(state.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
  });

  test('an interruption schedules another attempt of the same invocation', () => {
    const artifact = compileOrThrow();
    const state = reduceRun(artifact, interruptedEvents(artifact));

    expect(state.isOk()).toBe(true);
    if (state.isErr()) return;

    expect(state.unwrap().invocations).toHaveLength(1);
    expect(state.unwrap().invocations[0]?.attempts).toHaveLength(1);
    expect(state.unwrap().counters).toEqual({});

    const scheduled = scheduleRun(artifact, state.unwrap());
    expect(scheduled.isOk()).toBe(true);
    if (scheduled.isOk()) {
      expect(scheduled.unwrap()).toEqual([
        {
          type: 'attempt.schedule',
          invocationSequence: 1,
          attemptNumber: 2,
        },
      ]);
    }
  });

  test('a graph traversal creates another invocation', () => {
    const artifact = compileOrThrow(
      workflowSource({
        nodes: [
          {
            id: 'test',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
        ],
        entryNodeId: 'test',
        counterLimits: { repairs: 1 },
        transitions: [
          {
            id: 'test.failed.retry',
            from: { nodeId: 'test', outcome: 'failed' },
            toNodeId: 'test',
            increment: 'repairs',
            condition: {
              op: 'lt',
              left: { scope: 'counter', name: 'repairs' },
              right: 1,
            },
          },
        ],
      }),
    );
    const state = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'test',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'failed',
      },
      {
        sequence: 5,
        type: 'invocation.activated',
        invocationSequence: 2,
        nodeId: 'test',
        sourceInvocationSequence: 1,
        transitionId: 'test.failed.retry',
      },
    ]);

    expect(state.isOk()).toBe(true);
    if (state.isOk()) {
      expect(state.unwrap().invocations.map(({ sequence }) => sequence)).toEqual([1, 2]);
      expect(state.unwrap().counters.repairs).toBe(1);
    }
  });

  test('a succeeded invocation cannot receive another attempt', () => {
    const artifact = compileOrThrow();
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'command',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
      },
      {
        sequence: 5,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 2,
      },
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.InvalidAttemptNumber);
    }
  });
});
