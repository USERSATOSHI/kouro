import { describe, expect, test } from 'bun:test';

import type { RunEvent } from '@kouro/domain';
import { reduceRun, RuntimeErrorKind } from '@kouro/runtime';
import { compileOrThrow, workflowSource } from '../simulations/fixtures.ts';

function agentEvents(artifact: ReturnType<typeof compileOrThrow>): readonly RunEvent[] {
  return [
    {
      sequence: 1,
      type: 'run.created',
      workflowChecksum: artifact.checksum,
      startingCommit: '0123456789abcdef',
      configuration: { agentHarnesses: ['codex'] },
    },
    {
      sequence: 2,
      type: 'invocation.activated',
      invocationSequence: 1,
      nodeId: 'agent',
    },
    {
      sequence: 3,
      type: 'attempt.started',
      invocationSequence: 1,
      attemptNumber: 1,
      harnessId: 'codex',
    },
  ];
}

function agentArtifact() {
  return compileOrThrow(
    workflowSource({
      entryNodeId: 'agent',
      nodes: [
        {
          id: 'agent',
          type: 'agent',
          role: 'implementer',
          prompt: 'Implement.',
          capabilities: ['repository.read'],
          allowedSubagents: ['scout'],
          recoveryPolicy: 'resume_supported',
        },
      ],
      transitions: [],
      subagents: [
        {
          id: 'scout',
          role: 'scout',
          prompt: 'Inspect.',
          capabilities: ['repository.read'],
          maxInvocations: 2,
          maxConcurrent: 1,
        },
      ],
      permissions: ['repository.read'],
    }),
  );
}

describe('ADR: durable attempt usage', () => {
  test('records token usage on the matching active attempt', () => {
    const artifact = agentArtifact();
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'attempt.usage_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800 },
      },
    ]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const attempt = result.unwrap().invocations[0]?.attempts[0];
    expect(attempt?.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
    });
  });

  test('preserves usage when the attempt then succeeds', () => {
    const artifact = agentArtifact();
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'attempt.usage_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        usage: { inputTokens: 90, outputTokens: 30 },
      },
      {
        sequence: 5,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
      },
    ]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const invocation = result.unwrap().invocations[0];
    expect(invocation?.state).toBe('succeeded');
    expect(invocation?.attempts[0]).toMatchObject({
      state: 'succeeded',
      usage: { inputTokens: 90, outputTokens: 30 },
    });
  });

  test('rejects invalid token usage', () => {
    const artifact = agentArtifact();
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'attempt.usage_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        usage: { inputTokens: -1, outputTokens: 30 },
      },
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
  });

  test('rejects usage for a non-existent attempt number', () => {
    const artifact = agentArtifact();
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'attempt.usage_recorded',
        invocationSequence: 1,
        attemptNumber: 2,
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
  });

  test('rejects usage recorded after the invocation completed', () => {
    const artifact = agentArtifact();
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
      },
      {
        sequence: 5,
        type: 'attempt.usage_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
  });

  test('rejects usage recorded for a command attempt', () => {
    const artifact = compileOrThrow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
        ],
        transitions: [],
      }),
    );
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
        type: 'attempt.usage_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
  });
});

describe('ADR: durable subordinate execution summaries', () => {
  test('records ordered subagent usage on the matching active parent attempt', () => {
    const artifact = agentArtifact();
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'attempt.subagents_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        subagents: [
          {
            sequence: 1,
            callId: 'scout:1',
            subagentId: 'scout',
            task: 'Inspect the repository',
            harnessId: 'codex',
            model: 'gpt-5',
            state: 'succeeded',
            usage: { inputTokens: 1200, outputTokens: 300 },
          },
        ],
      },
    ]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.unwrap().invocations[0]?.attempts[0]?.subagents).toEqual([
      expect.objectContaining({
        callId: 'scout:1',
        state: 'succeeded',
        usage: { inputTokens: 1200, outputTokens: 300 },
      }),
    ]);
  });

  test('rejects duplicate call IDs and non-contiguous child sequence numbers', () => {
    const artifact = agentArtifact();
    const subagent = {
      callId: 'scout:1',
      subagentId: 'scout',
      task: 'Inspect the repository',
      harnessId: 'codex',
      state: 'succeeded' as const,
    };
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'attempt.subagents_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        subagents: [
          { ...subagent, sequence: 1 },
          { ...subagent, sequence: 3 },
        ],
      },
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
  });

  test('rejects subordinate summaries after the parent invocation completes', () => {
    const artifact = agentArtifact();
    const result = reduceRun(artifact, [
      ...agentEvents(artifact),
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
      },
      {
        sequence: 5,
        type: 'attempt.subagents_recorded',
        invocationSequence: 1,
        attemptNumber: 1,
        subagents: [],
      },
    ]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
  });
});
