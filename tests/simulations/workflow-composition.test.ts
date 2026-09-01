import { describe, expect, test } from 'bun:test';

import { compileWorkflow, expandWorkflowComposition, WorkflowBuilder } from '@kouro/adw';
import type { CompiledWorkflowArtifact, RunEvent, WorkflowSourceBundle } from '@kouro/domain';
import { deriveRunTrace, reduceRun, scheduleRun } from '@kouro/runtime';

function compiled(input: WorkflowSourceBundle): CompiledWorkflowArtifact {
  const result = compileWorkflow(input);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function source(
  nodes: WorkflowSourceBundle['nodes'],
  transitions: WorkflowSourceBundle['transitions'],
  entryNodeId = nodes[0]?.id ?? '',
): WorkflowSourceBundle {
  return {
    manifest: { id: 'composition-test', version: '1.0.0' },
    semanticVersions: { compiler: '0.5.0', ir: '5', expressions: '1' },
    entryNodeId,
    nodes,
    transitions,
    counterLimits: {},
    permissions: [],
  };
}

describe('IR 5 workflow composition', () => {
  test('authors every composition and wait node as plain data', () => {
    const workflow = new WorkflowBuilder({ id: 'composed', version: '1.0.0' });
    workflow.subworkflow('child', { package: '../child', version: '1.0.0' });
    const seed = workflow.agent('seed', {
      role: 'seed',
      prompt: './seed.md',
      recoveryPolicy: 'resume_supported',
    });
    const call = workflow.call('call', { workflow: 'child' });
    const parallel = workflow.parallel('parallel', {
      branches: { b: 'child', a: 'child' },
      maxConcurrent: 2,
      workspace: 'isolated',
      join: 'disjoint',
    });
    const each = workflow.forEach('each', {
      workflow: 'child',
      itemsFrom: { node: seed, path: ['items'] },
      maxItems: 4,
      maxConcurrent: 2,
      workspace: 'isolated',
      join: 'disjoint',
    });
    const sleep = workflow.sleep('sleep', { durationMs: 10 });
    const waiting = workflow.waitForEvent('wait', { event: 'reviewed', timeoutMs: 20 });
    const done = workflow.complete('done');
    workflow.startAt(seed);
    seed.on('success').to(call);
    call.on('succeeded').to(parallel);
    parallel.on('succeeded').to(each);
    each.on('succeeded').to(sleep);
    sleep.on('elapsed').to(waiting);
    waiting.on('received').to(done);

    expect(workflow.build().nodes).toMatchObject({
      call: { type: 'call', workflow: 'child' },
      parallel: { type: 'parallel', maxConcurrent: 2 },
      each: { type: 'for_each', maxItems: 4 },
      sleep: { type: 'sleep', durationMs: 10 },
      wait: { type: 'wait_for_event', event: 'reviewed', timeoutMs: 20 },
    });
  });

  test('expands calls into stable compiler-reserved namespaces', () => {
    const child = compiled(source([{ id: 'done', type: 'complete' }], []));
    const parent = source(
      [
        { id: 'invoke', type: 'call', workflow: 'child' },
        { id: 'done', type: 'complete' },
      ],
      [
        {
          id: 'invoke.succeeded.done',
          from: { nodeId: 'invoke', outcome: 'succeeded' },
          toNodeId: 'done',
        },
      ],
      'invoke',
    );
    const expanded = expandWorkflowComposition({
      ...parent,
      subworkflows: { child: { checksum: child.checksum, bundle: child.bundle } },
    });
    expect(expanded.isOk()).toBe(true);
    if (expanded.isErr()) return;
    const artifact = compiled(expanded.value);
    expect(artifact.bundle.entryNodeId).toBe('@call/invoke/done');
    expect(artifact.bundle.nodes.map(({ id, type }) => ({ id, type }))).toContainEqual({
      id: '@call/invoke/done',
      type: 'gateway',
    });
    expect(artifact.bundle.transitions).toContainEqual(
      expect.objectContaining({
        from: { nodeId: '@call/invoke/done', outcome: 'succeeded' },
        toNodeId: 'done',
      }),
    );
  });

  test('records timer decisions and wakes only from durable observed time', () => {
    const artifact = compiled(
      source(
        [
          { id: 'sleep', type: 'sleep', durationMs: 100 },
          { id: 'done', type: 'complete' },
        ],
        [
          {
            id: 'sleep.elapsed.done',
            from: { nodeId: 'sleep', outcome: 'elapsed' },
            toNodeId: 'done',
          },
        ],
      ),
    );
    const initial: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: 'head',
        configuration: {},
        startedAt: '2026-08-31T00:00:00.000Z',
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'sleep',
        activatedAt: '2026-08-31T00:00:00.000Z',
      },
    ];
    const pending = reduceRun(artifact, initial).unwrap();
    expect(scheduleRun(artifact, pending).unwrap()).toEqual([
      { type: 'timer.schedule', invocationSequence: 1, durationMs: 100 },
    ]);
    const waiting = reduceRun(artifact, [
      ...initial,
      {
        sequence: 3,
        type: 'timer.scheduled',
        invocationSequence: 1,
        scheduledAt: '2026-08-31T00:00:00.000Z',
        dueAt: '2026-08-31T00:00:00.100Z',
      },
      { sequence: 4, type: 'run.time_observed', observedAt: '2026-08-31T00:00:00.100Z' },
    ]).unwrap();
    expect(waiting.status).toBe('waiting');
    expect(scheduleRun(artifact, waiting).unwrap()).toEqual([
      { type: 'timer.elapse', invocationSequence: 1 },
    ]);
  });

  test('activates isolated parallel branches in canonical order under the global limit', () => {
    const child = compiled(
      source(
        [
          { id: 'work', type: 'command', command: 'true', recoveryPolicy: 'replay_safe' },
          { id: 'done', type: 'complete' },
        ],
        [
          {
            id: 'work.success.done',
            from: { nodeId: 'work', outcome: 'success' },
            toNodeId: 'done',
          },
        ],
      ),
    );
    const parent = source(
      [
        {
          id: 'parallel',
          type: 'parallel',
          branches: { z: 'child', a: 'child' },
          maxConcurrent: 2,
          workspace: 'isolated',
          join: 'disjoint',
        },
        { id: 'done', type: 'complete' },
      ],
      ['succeeded', 'failed', 'conflict'].map((outcome) => ({
        id: `parallel.${outcome}.done`,
        from: { nodeId: 'parallel', outcome },
        toNodeId: 'done',
      })),
    );
    const expanded = expandWorkflowComposition({
      ...parent,
      runLimits: { maxConcurrentInvocations: 1 },
      subworkflows: { child: { checksum: child.checksum, bundle: child.bundle } },
    });
    if (expanded.isErr()) throw new Error(JSON.stringify(expanded.error));
    const artifact = compiled(expanded.value);
    const events: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: 'head',
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'parallel',
      },
    ];
    const pending = reduceRun(artifact, events).unwrap();
    expect(scheduleRun(artifact, pending).unwrap()).toEqual([
      {
        type: 'parallel.fork',
        invocationSequence: 1,
        groupId: 'group:1',
        branches: [
          { id: 'a', entryNodeId: '@parallel/parallel/a/work' },
          { id: 'z', entryNodeId: '@parallel/parallel/z/work' },
        ],
        maxConcurrent: 2,
      },
    ]);
    const forked = reduceRun(artifact, [
      ...events,
      {
        sequence: 3,
        type: 'parallel.forked',
        groupId: 'group:1',
        invocationSequence: 1,
        kind: 'parallel',
        branches: [
          { id: 'a', entryNodeId: '@parallel/parallel/a/work', workspaceId: 'a-worktree' },
          { id: 'z', entryNodeId: '@parallel/parallel/z/work', workspaceId: 'z-worktree' },
        ],
        maxConcurrent: 1,
        baseHead: 'head',
        baseTree: 'tree',
        checkpoint: 'checkpoint',
      },
    ]).unwrap();
    expect(scheduleRun(artifact, forked).unwrap()).toEqual([
      {
        type: 'invocation.activate',
        nodeId: '@parallel/parallel/a/work',
        invocationSequence: 2,
        parallelGroupId: 'group:1',
        branchId: 'a',
      },
    ]);

    const branchCompleted = reduceRun(artifact, [
      ...events,
      {
        sequence: 3,
        type: 'parallel.forked',
        groupId: 'group:1',
        invocationSequence: 1,
        kind: 'parallel',
        branches: [
          { id: 'a', entryNodeId: '@parallel/parallel/a/work', workspaceId: 'a-worktree' },
          { id: 'z', entryNodeId: '@parallel/parallel/z/work', workspaceId: 'z-worktree' },
        ],
        maxConcurrent: 1,
        baseHead: 'head',
        baseTree: 'tree',
        checkpoint: 'checkpoint',
      },
      {
        sequence: 4,
        type: 'invocation.activated',
        invocationSequence: 2,
        nodeId: '@parallel/parallel/a/work',
        parallelGroupId: 'group:1',
        branchId: 'a',
      },
      {
        sequence: 5,
        type: 'attempt.started',
        invocationSequence: 2,
        attemptNumber: 1,
      },
      {
        sequence: 6,
        type: 'invocation.completed',
        invocationSequence: 2,
        outcome: 'success',
      },
    ]).unwrap();
    expect(scheduleRun(artifact, branchCompleted).unwrap()).toEqual([
      {
        type: 'invocation.activate',
        nodeId: '@parallel/parallel/a/done',
        invocationSequence: 3,
        sourceInvocationSequence: 2,
        transitionId: '@parallel/parallel/a/work.success.done',
        parallelGroupId: 'group:1',
        branchId: 'a',
      },
    ]);
  });

  test('records duplicate forEach items by index and preserves their order', () => {
    const child = compiled(source([{ id: 'done', type: 'complete' }], []));
    const parent = source(
      [
        {
          id: 'seed',
          type: 'agent',
          role: 'seed',
          prompt: 'seed',
          recoveryPolicy: 'resume_supported',
        },
        {
          id: 'each',
          type: 'for_each',
          workflow: 'child',
          itemsFrom: { nodeId: 'seed', path: ['items'] },
          maxItems: 3,
          maxConcurrent: 2,
          workspace: 'isolated',
          join: 'disjoint',
        },
        { id: 'done', type: 'complete' },
      ],
      [
        { id: 'seed.success.each', from: { nodeId: 'seed', outcome: 'success' }, toNodeId: 'each' },
        ...['succeeded', 'failed', 'conflict'].map((outcome) => ({
          id: `each.${outcome}.done`,
          from: { nodeId: 'each', outcome },
          toNodeId: 'done',
        })),
      ],
    );
    const expanded = expandWorkflowComposition({
      ...parent,
      subworkflows: { child: { checksum: child.checksum, bundle: child.bundle } },
    });
    if (expanded.isErr()) throw new Error(JSON.stringify(expanded.error));
    const artifact = compiled(expanded.value);
    const state = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: 'head',
        configuration: { agentHarnesses: ['fake'] },
      },
      { sequence: 2, type: 'invocation.activated', invocationSequence: 1, nodeId: 'seed' },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
        harnessId: 'fake',
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
        output: { items: ['same', 'same'] },
      },
      {
        sequence: 5,
        type: 'invocation.activated',
        invocationSequence: 2,
        nodeId: 'each',
        sourceInvocationSequence: 1,
        transitionId: 'seed.success.each',
      },
    ]).unwrap();
    expect(scheduleRun(artifact, state).unwrap()).toEqual([
      {
        type: 'collection.expand',
        invocationSequence: 2,
        groupId: 'group:2',
        items: ['same', 'same'],
        entryNodeId: '@forEach/each/done',
        maxConcurrent: 2,
      },
    ]);
  });

  test('validates targeted event payloads and makes the first durable resolution win', () => {
    const artifact = compiled({
      ...source(
        [
          {
            id: 'wait',
            type: 'wait_for_event',
            event: 'reviewed',
            payloadSchema: 'review',
            timeoutMs: 100,
          },
          { id: 'done', type: 'complete' },
        ],
        ['received', 'timed_out'].map((outcome) => ({
          id: `wait.${outcome}.done`,
          from: { nodeId: 'wait', outcome },
          toNodeId: 'done',
        })),
      ),
      schemas: {
        review: {
          type: 'object',
          required: ['approved'],
          properties: { approved: { type: 'boolean' } },
        },
      },
    });
    const waitingEvents: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: 'head',
        configuration: {},
      },
      { sequence: 2, type: 'invocation.activated', invocationSequence: 1, nodeId: 'wait' },
      {
        sequence: 3,
        type: 'event.waiting',
        invocationSequence: 1,
        event: 'reviewed',
        scheduledAt: '2026-08-31T00:00:00.000Z',
        timeoutAt: '2026-08-31T00:00:00.100Z',
      },
    ];
    expect(
      reduceRun(artifact, [
        ...waitingEvents,
        {
          sequence: 4,
          type: 'external_event.received',
          invocationSequence: 1,
          event: 'reviewed',
          payload: { approved: 'yes' },
          actor: 'reviewer',
          receivedAt: '2026-08-31T00:00:00.050Z',
          idempotencyKey: 'event-1',
        },
      ]).isErr(),
    ).toBe(true);
    const received = [
      ...waitingEvents,
      {
        sequence: 4,
        type: 'external_event.received' as const,
        invocationSequence: 1,
        event: 'reviewed',
        payload: { approved: true },
        actor: 'reviewer',
        receivedAt: '2026-08-31T00:00:00.050Z',
        idempotencyKey: 'event-1',
      },
    ];
    expect(reduceRun(artifact, received).unwrap().invocations[0]?.outcome).toBe('received');
    expect(
      reduceRun(artifact, [
        ...received,
        {
          sequence: 5,
          type: 'event.timed_out',
          invocationSequence: 1,
          observedAt: '2026-08-31T00:00:00.100Z',
        },
      ]).isErr(),
    ).toBe(true);
  });

  test('derives stable run, invocation, and attempt trace identities', () => {
    const artifact = compiled(
      source(
        [
          { id: 'command', type: 'command', command: 'true', recoveryPolicy: 'replay_safe' },
          { id: 'done', type: 'complete' },
        ],
        [
          {
            id: 'command.success.done',
            from: { nodeId: 'command', outcome: 'success' },
            toNodeId: 'done',
          },
        ],
      ),
    );
    const state = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: 'head',
        configuration: {},
        startedAt: '2026-08-31T00:00:00.000Z',
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'command',
        activatedAt: '2026-08-31T00:00:01.000Z',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
        startedAt: '2026-08-31T00:00:01.000Z',
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
        finishedAt: '2026-08-31T00:00:02.000Z',
        attemptFinishedAt: '2026-08-31T00:00:02.000Z',
      },
    ]).unwrap();
    const first = deriveRunTrace('run-1', artifact, state);
    const second = deriveRunTrace('run-1', artifact, state);
    expect(first).toEqual(second);
    expect(first.spans.map(({ kind }) => kind)).toEqual(['run', 'invocation', 'attempt']);
    expect(first.spans[2]?.parentSpanId).toBe(first.spans[1]?.spanId);
  });
});
