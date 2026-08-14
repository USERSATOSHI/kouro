import { describe, expect, test } from 'bun:test';

import {
  all,
  any,
  CAPABILITY,
  HARNESS,
  not,
  output,
  REASONING_EFFORT,
  RECOVERY_POLICY,
  WorkflowAuthoringError,
  WorkflowAuthoringErrorKind,
  WorkflowBuilder,
} from '@kouro/adw';

function expectAuthoringError(operation: () => unknown, kind: WorkflowAuthoringErrorKind): void {
  try {
    operation();
    throw new Error('Expected authoring operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowAuthoringError);
    if (error instanceof WorkflowAuthoringError) {
      expect(error.kind).toBe(kind);
    }
  }
}

describe('class-based ADW authoring SDK', () => {
  test('exports exact authoring constants', () => {
    expect(CAPABILITY).toEqual({
      REPOSITORY_READ: 'repository.read',
      REPOSITORY_WRITE: 'repository.write',
      TERMINAL_EXECUTE: 'terminal.execute',
      NETWORK_ACCESS: 'network.access',
    });
    expect(HARNESS).toEqual({
      CLAUDE_CODE: 'claude-code',
      CODEX: 'codex',
      OPENCODE: 'opencode',
      PI: 'pi',
    });
    expect(RECOVERY_POLICY).toEqual({
      REPLAY_SAFE: 'replay_safe',
      VERIFY_THEN_REPLAY: 'verify_then_replay',
      RESUME_SUPPORTED: 'resume_supported',
      MANUAL_RECONCILIATION: 'manual_reconciliation',
      NEVER_AUTOMATICALLY_RETRY: 'never_automatically_retry',
    });
    expect(REASONING_EFFORT).toEqual({
      LOW: 'low',
      MEDIUM: 'medium',
      HIGH: 'high',
    });
  });

  test('emits the existing plain definition shape from fluent declarations', () => {
    const workflow = new WorkflowBuilder({ id: 'repair', version: '1.0.0' });
    workflow.permissions('repository.read', 'terminal.execute');
    workflow.defaults({ model: 'coding' });
    workflow.runLimits({ maxDurationMs: 10_000, maxNodeInvocations: 12 });
    workflow.subworkflow('shared', { package: '../shared', version: '2.0.0' });

    const repairs = workflow.counter('repairs', 2);
    const run = workflow.command('run', {
      command: 'bun test',
      capabilities: ['repository.read', 'terminal.execute'],
      recoveryPolicy: 'replay_safe',
    });
    const repair = workflow.agent('repair', {
      role: 'repairer',
      prompt: './repair.md',
      harness: 'pi',
      models: { pi: 'anthropic/claude-sonnet' },
      reasoningEffort: REASONING_EFFORT.MEDIUM,
      clearContext: true,
      recoveryPolicy: 'resume_supported',
    });
    const complete = workflow.complete('complete');
    const failed = workflow.complete('failed', { result: 'failed' });

    workflow.startAt(run);
    run.on('success').to(complete);
    run.on('failure').when(repairs.belowLimit()).increment(repairs).to(repair);
    run.on('failure').otherwise().to(failed);
    repair.on('success').to(run);

    expect(workflow.build()).toEqual({
      id: 'repair',
      version: '1.0.0',
      entry: 'run',
      nodes: {
        run: {
          type: 'command',
          command: 'bun test',
          capabilities: ['repository.read', 'terminal.execute'],
          recoveryPolicy: 'replay_safe',
        },
        repair: {
          type: 'agent',
          role: 'repairer',
          prompt: './repair.md',
          harness: 'pi',
          models: { pi: 'anthropic/claude-sonnet' },
          reasoningEffort: 'medium',
          clearContext: true,
          recoveryPolicy: 'resume_supported',
        },
        complete: { type: 'complete' },
        failed: { type: 'complete', result: 'failed' },
      },
      transitions: [
        {
          id: 'run.success.complete',
          from: { nodeId: 'run', outcome: 'success' },
          toNodeId: 'complete',
        },
        {
          id: 'run.failure.repair',
          from: { nodeId: 'run', outcome: 'failure' },
          toNodeId: 'repair',
          condition: {
            op: 'lt',
            left: { scope: 'counter', name: 'repairs' },
            right: 2,
          },
          increment: 'repairs',
        },
        {
          id: 'run.failure.failed',
          from: { nodeId: 'run', outcome: 'failure' },
          toNodeId: 'failed',
          default: true,
        },
        {
          id: 'repair.success.run',
          from: { nodeId: 'repair', outcome: 'success' },
          toNodeId: 'run',
        },
      ],
      permissions: ['repository.read', 'terminal.execute'],
      defaults: { model: 'coding' },
      limits: {
        counters: { repairs: 2 },
        maxDurationMs: 10_000,
        maxNodeInvocations: 12,
      },
      subworkflows: {
        shared: { package: '../shared', version: '2.0.0' },
      },
    });
  });

  test('creates data-only expressions for outputs, counters, and boolean composition', () => {
    const workflow = new WorkflowBuilder({ id: 'expressions', version: '1.0.0' });
    const attempts = workflow.counter('attempts', 3);

    expect(output('result', 'approved').equals(true)).toEqual({
      op: 'eq',
      left: { scope: 'output', path: ['result', 'approved'] },
      right: true,
    });
    expect(attempts.lessThan(2)).toEqual({
      op: 'lt',
      left: { scope: 'counter', name: 'attempts' },
      right: 2,
    });
    expect(attempts.atLeast(2)).toEqual({
      op: 'gte',
      left: { scope: 'counter', name: 'attempts' },
      right: 2,
    });
    expect(
      all(output('approved').equals(false), any(attempts.belowLimit(), not(attempts.atLimit()))),
    ).toEqual({
      op: 'and',
      expressions: [
        {
          op: 'eq',
          left: { scope: 'output', path: ['approved'] },
          right: false,
        },
        {
          op: 'or',
          expressions: [
            {
              op: 'lt',
              left: { scope: 'counter', name: 'attempts' },
              right: 3,
            },
            {
              op: 'not',
              expression: {
                op: 'gte',
                left: { scope: 'counter', name: 'attempts' },
                right: 3,
              },
            },
          ],
        },
      ],
    });
  });

  test('declares multiple bounded subagents without adding graph nodes', () => {
    const workflow = new WorkflowBuilder({ id: 'subagents', version: '1.0.0' });
    workflow.permissions(CAPABILITY.REPOSITORY_READ);
    const architecture = workflow.subagent('architecture', {
      role: 'architecture-scout',
      prompt: './prompts/architecture.md',
      reasoningEffort: REASONING_EFFORT.LOW,
      capabilities: [CAPABILITY.REPOSITORY_READ],
      maxInvocations: 2,
      maxConcurrent: 2,
    });
    const tests = workflow.subagent('tests', {
      role: 'test-scout',
      prompt: './prompts/tests.md',
      harness: HARNESS.PI,
      models: { [HARNESS.PI]: 'anthropic/claude-sonnet' },
      reasoningEffort: REASONING_EFFORT.HIGH,
      capabilities: [CAPABILITY.REPOSITORY_READ],
      maxInvocations: 3,
      maxConcurrent: 1,
    });
    const plan = workflow
      .agent('plan', {
        role: 'planner',
        prompt: './prompts/plan.md',
        capabilities: [CAPABILITY.REPOSITORY_READ],
        recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
      })
      .uses(architecture, tests);
    const implement = workflow.agent('implement', {
      role: 'implementer',
      prompt: './prompts/implement.md',
      capabilities: [CAPABILITY.REPOSITORY_READ],
      recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
    });
    implement.withContextFrom(plan, architecture, tests);
    const complete = workflow.complete('complete');
    workflow.startAt(plan);
    plan.on('success').to(implement);
    implement.on('success').to(complete);

    expect(workflow.build()).toMatchObject({
      nodes: {
        plan: {
          type: 'agent',
          allowedSubagents: ['architecture', 'tests'],
        },
        implement: {
          type: 'agent',
          contextSources: [
            { type: 'agent', id: 'plan' },
            { type: 'subagent', id: 'architecture' },
            { type: 'subagent', id: 'tests' },
          ],
        },
        complete: { type: 'complete' },
      },
      subagents: {
        architecture: {
          role: 'architecture-scout',
          reasoningEffort: 'low',
          maxInvocations: 2,
          maxConcurrent: 2,
        },
        tests: {
          role: 'test-scout',
          harness: 'pi',
          reasoningEffort: 'high',
          maxInvocations: 3,
          maxConcurrent: 1,
        },
      },
    });
  });

  test('fails fast for duplicate declarations and entry assignment', () => {
    const workflow = new WorkflowBuilder({ id: 'duplicates', version: '1.0.0' });
    const start = workflow.command('start', {
      command: 'true',
      recoveryPolicy: 'replay_safe',
    });
    workflow.counter('attempts', 2);
    workflow.subagent('scout', {
      role: 'scout',
      prompt: './scout.md',
      capabilities: [CAPABILITY.REPOSITORY_READ],
      maxInvocations: 1,
      maxConcurrent: 1,
    });
    workflow.startAt(start);

    expectAuthoringError(
      () => workflow.complete('start'),
      WorkflowAuthoringErrorKind.DuplicateNode,
    );
    expectAuthoringError(
      () => workflow.counter('attempts', 3),
      WorkflowAuthoringErrorKind.DuplicateCounter,
    );
    expectAuthoringError(
      () =>
        workflow.subagent('scout', {
          role: 'scout',
          prompt: './scout.md',
          capabilities: [CAPABILITY.REPOSITORY_READ],
          maxInvocations: 1,
          maxConcurrent: 1,
        }),
      WorkflowAuthoringErrorKind.DuplicateSubagent,
    );
    expectAuthoringError(() => workflow.startAt(start), WorkflowAuthoringErrorKind.DuplicateEntry);
  });

  test('rejects foreign node and counter handles', () => {
    const first = new WorkflowBuilder({ id: 'first', version: '1.0.0' });
    const second = new WorkflowBuilder({ id: 'second', version: '1.0.0' });
    const firstNode = first.command('first', {
      command: 'true',
      recoveryPolicy: 'replay_safe',
    });
    const secondNode = second.complete('second');
    const secondCounter = second.counter('attempts', 1);
    const firstAgent = first.agent('agent', {
      role: 'agent',
      prompt: './agent.md',
      capabilities: [CAPABILITY.REPOSITORY_READ],
      recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
    });
    const secondSubagent = second.subagent('scout', {
      role: 'scout',
      prompt: './scout.md',
      capabilities: [CAPABILITY.REPOSITORY_READ],
      maxInvocations: 1,
      maxConcurrent: 1,
    });
    const secondAgent = second.agent('agent', {
      role: 'agent',
      prompt: './agent.md',
      capabilities: [CAPABILITY.REPOSITORY_READ],
      recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
    });

    expectAuthoringError(
      () => first.startAt(secondNode),
      WorkflowAuthoringErrorKind.ForeignNodeHandle,
    );
    expectAuthoringError(
      () => firstNode.on('success').to(secondNode),
      WorkflowAuthoringErrorKind.ForeignNodeHandle,
    );
    expectAuthoringError(
      () => firstNode.on('failure').increment(secondCounter),
      WorkflowAuthoringErrorKind.ForeignCounterHandle,
    );
    expectAuthoringError(
      () => firstAgent.uses(secondSubagent),
      WorkflowAuthoringErrorKind.ForeignSubagentHandle,
    );
    expectAuthoringError(
      () => firstAgent.withContextFrom(secondSubagent),
      WorkflowAuthoringErrorKind.ForeignSubagentHandle,
    );
    expectAuthoringError(
      () => firstAgent.withContextFrom(secondAgent),
      WorkflowAuthoringErrorKind.ForeignNodeHandle,
    );
    expectAuthoringError(
      () => firstAgent.withContextFrom(firstAgent),
      WorkflowAuthoringErrorKind.InvalidContextSource,
    );
    expectAuthoringError(
      () => firstAgent.withContextFrom(),
      WorkflowAuthoringErrorKind.InvalidContextSource,
    );
  });

  test('rejects missing entries and unfinished transition chains', () => {
    const missingEntry = new WorkflowBuilder({ id: 'missing', version: '1.0.0' });
    missingEntry.complete('complete');
    expectAuthoringError(() => missingEntry.build(), WorkflowAuthoringErrorKind.MissingEntry);

    const incomplete = new WorkflowBuilder({ id: 'incomplete', version: '1.0.0' });
    const start = incomplete.command('start', {
      command: 'true',
      recoveryPolicy: 'replay_safe',
    });
    incomplete.complete('complete');
    incomplete.startAt(start);
    start.on('success');
    expectAuthoringError(() => incomplete.build(), WorkflowAuthoringErrorKind.IncompleteTransition);
  });
});

function compileTimeHandleContracts(): void {
  const workflow = new WorkflowBuilder({ id: 'types', version: '1.0.0' });
  const counter = workflow.counter('attempts', 1);
  const command = workflow.command('command', {
    command: 'true',
    recoveryPolicy: 'replay_safe',
  });
  const complete = workflow.complete('complete');
  const scout = workflow.subagent('scout', {
    role: 'scout',
    prompt: './scout.md',
    capabilities: [CAPABILITY.REPOSITORY_READ],
    maxInvocations: 1,
    maxConcurrent: 1,
  });

  command.on('success').increment(counter).to(complete);

  // @ts-expect-error Complete nodes are terminal and do not expose transitions.
  complete.on('success');
  // @ts-expect-error Counter handles cannot be transition targets.
  command.on('failure').to(counter);
  // @ts-expect-error Node handles cannot be used as counters.
  command.on('failure').increment(complete);
  // @ts-expect-error Subagents are not graph nodes.
  workflow.startAt(scout);
  // @ts-expect-error Subagents cannot declare graph transitions.
  scout.on('success');
  // @ts-expect-error Only agent-node handles authorize subagents.
  command.uses(scout);

  workflow.agent('portable', {
    role: 'portable',
    prompt: './portable.md',
    models: {
      [HARNESS.CODEX]: 'gpt-5.2-codex',
      [HARNESS.OPENCODE]: 'openai/gpt-5.2',
    },
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  });
  workflow.agent('pinned', {
    role: 'pinned',
    prompt: './pinned.md',
    harness: HARNESS.PI,
    models: { [HARNESS.PI]: 'anthropic/claude-sonnet' },
    capabilities: [CAPABILITY.REPOSITORY_READ],
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  });

  // @ts-expect-error Workflow permissions use Kouro's declared capability vocabulary.
  workflow.permissions('repository.admin');
  workflow.agent('unknown-harness', {
    role: 'invalid',
    prompt: './invalid.md',
    // @ts-expect-error Harness IDs are limited to the built-in harness registry.
    harness: 'unknown',
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  });
  workflow.agent('mismatched-model', {
    role: 'invalid',
    prompt: './invalid.md',
    harness: HARNESS.PI,
    // @ts-expect-error A pinned harness accepts model configuration only for itself.
    models: { [HARNESS.CODEX]: 'gpt-5.2-codex' },
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  });
  workflow.agent('invalid-opencode-model', {
    role: 'invalid',
    prompt: './invalid.md',
    harness: HARNESS.OPENCODE,
    // @ts-expect-error OpenCode model IDs require provider/model syntax.
    models: { [HARNESS.OPENCODE]: 'gpt-5.2' },
    recoveryPolicy: RECOVERY_POLICY.RESUME_SUPPORTED,
  });
}

void compileTimeHandleContracts;
