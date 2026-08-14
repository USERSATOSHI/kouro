import { describe, expect, test } from 'bun:test';

import { compileWorkflow, CompilerErrorKind } from '@kouro/adw';
import type { AgentReasoningEffort, RecoveryPolicy } from '@kouro/domain';
import { workflowSource } from './fixtures.ts';

describe('M1 compiler validation', () => {
  test('rejects unreachable nodes', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
          { id: 'complete', type: 'complete' },
          { id: 'orphan', type: 'complete' },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: CompilerErrorKind.UnreachableNode,
        nodeIds: ['orphan'],
      });
    }
  });

  test('rejects capabilities absent from workflow permissions', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
            capabilities: ['terminal.execute'],
          },
          { id: 'complete', type: 'complete' },
        ],
        permissions: [],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.PermissionNotDeclared);
    }
  });

  test('validates bounded subagent authorization and capability subsets', () => {
    const valid = compileWorkflow(
      workflowSource({
        entryNodeId: 'plan',
        permissions: ['repository.read'],
        nodes: [
          {
            id: 'plan',
            type: 'agent',
            role: 'planner',
            prompt: 'Plan.',
            recoveryPolicy: 'resume_supported',
            capabilities: ['repository.read'],
            allowedSubagents: ['tests', 'architecture'],
          },
          { id: 'complete', type: 'complete' },
        ],
        subagents: [
          {
            id: 'tests',
            role: 'test-scout',
            prompt: 'Find tests.',
            capabilities: ['repository.read'],
            maxInvocations: 3,
            maxConcurrent: 2,
          },
          {
            id: 'architecture',
            role: 'architecture-scout',
            prompt: 'Map architecture.',
            capabilities: ['repository.read'],
            maxInvocations: 2,
            maxConcurrent: 2,
          },
        ],
        transitions: [
          {
            id: 'plan.success.complete',
            from: { nodeId: 'plan', outcome: 'success' },
            toNodeId: 'complete',
          },
        ],
      }),
    );
    expect(valid.isOk()).toBe(true);
    if (valid.isOk()) {
      expect(valid.unwrap().bundle.subagents?.map(({ id }) => id)).toEqual([
        'architecture',
        'tests',
      ]);
      expect(valid.unwrap().bundle.nodes.find(({ id }) => id === 'plan')?.allowedSubagents).toEqual(
        ['architecture', 'tests'],
      );
    }

    for (const [subagents, kind] of [
      [
        [
          {
            id: 'scout',
            role: 'scout',
            prompt: 'Scout.',
            capabilities: ['repository.write'],
            maxInvocations: 1,
            maxConcurrent: 1,
          },
        ],
        CompilerErrorKind.InvalidSubagentConfiguration,
      ],
      [
        [
          {
            id: 'scout',
            role: 'scout',
            prompt: 'Scout.',
            capabilities: ['repository.read'],
            maxInvocations: 1,
            maxConcurrent: 2,
          },
        ],
        CompilerErrorKind.InvalidSubagentConfiguration,
      ],
    ] as const) {
      const result = compileWorkflow(
        workflowSource({
          entryNodeId: 'plan',
          permissions: ['repository.read', 'repository.write'],
          nodes: [
            {
              id: 'plan',
              type: 'agent',
              role: 'planner',
              prompt: 'Plan.',
              recoveryPolicy: 'resume_supported',
              capabilities: ['repository.read'],
              allowedSubagents: ['scout'],
            },
            { id: 'complete', type: 'complete' },
          ],
          subagents,
          transitions: [
            {
              id: 'plan.success.complete',
              from: { nodeId: 'plan', outcome: 'success' },
              toNodeId: 'complete',
            },
          ],
        }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.kind).toBe(kind);
    }
  });

  test('rejects unknown and capability-escalating subagent authorization', () => {
    const definition = {
      id: 'scout',
      role: 'scout',
      prompt: 'Scout.',
      capabilities: ['repository.read'],
      maxInvocations: 1,
      maxConcurrent: 1,
    } as const;
    for (const [allowedSubagents, subagents, kind] of [
      [['missing'], [definition], CompilerErrorKind.UnknownSubagent],
      [['scout'], [definition], CompilerErrorKind.SubagentCapabilityEscalation],
    ] as const) {
      const result = compileWorkflow(
        workflowSource({
          entryNodeId: 'plan',
          permissions: ['repository.read'],
          nodes: [
            {
              id: 'plan',
              type: 'agent',
              role: 'planner',
              prompt: 'Plan.',
              recoveryPolicy: 'resume_supported',
              capabilities: [],
              allowedSubagents,
            },
            { id: 'complete', type: 'complete' },
          ],
          subagents,
          transitions: [
            {
              id: 'plan.success.complete',
              from: { nodeId: 'plan', outcome: 'success' },
              toNodeId: 'complete',
            },
          ],
        }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.kind).toBe(kind);
    }
  });

  test('validates and canonically orders declared agent context sources', () => {
    const source = workflowSource({
      entryNodeId: 'scout',
      permissions: ['repository.read'],
      nodes: [
        {
          id: 'scout',
          type: 'agent',
          role: 'scout',
          prompt: 'Scout.',
          recoveryPolicy: 'resume_supported',
          capabilities: ['repository.read'],
        },
        {
          id: 'implement',
          type: 'agent',
          role: 'implementer',
          prompt: 'Implement.',
          recoveryPolicy: 'resume_supported',
          capabilities: ['repository.read'],
          contextSources: [
            { type: 'subagent', id: 'testScout' },
            { type: 'agent', id: 'scout' },
          ],
        },
        { id: 'complete', type: 'complete' },
      ],
      subagents: [
        {
          id: 'testScout',
          role: 'test-scout',
          prompt: 'Find tests.',
          capabilities: ['repository.read'],
          maxInvocations: 1,
          maxConcurrent: 1,
        },
      ],
      transitions: [
        {
          id: 'scout.success.implement',
          from: { nodeId: 'scout', outcome: 'success' },
          toNodeId: 'implement',
        },
        {
          id: 'implement.success.complete',
          from: { nodeId: 'implement', outcome: 'success' },
          toNodeId: 'complete',
        },
      ],
    });
    const compiled = compileWorkflow(source);
    expect(compiled.isOk()).toBe(true);
    if (compiled.isOk()) {
      expect(
        compiled.unwrap().bundle.nodes.find(({ id }) => id === 'implement')?.contextSources,
      ).toEqual([
        { type: 'agent', id: 'scout' },
        { type: 'subagent', id: 'testScout' },
      ]);
    }

    const invalid = compileWorkflow({
      ...source,
      nodes: source.nodes.map((node) =>
        node.id === 'implement'
          ? { ...node, contextSources: [{ type: 'agent' as const, id: 'missing' }] }
          : node,
      ),
    });
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr()) {
      expect(invalid.error.kind).toBe(CompilerErrorKind.InvalidNodeConfiguration);
    }
  });

  test('rejects invalid expression references', () => {
    const result = compileWorkflow(
      workflowSource({
        transitions: [
          {
            id: 'command.success.complete',
            from: { nodeId: 'command', outcome: 'success' },
            toNodeId: 'complete',
            condition: {
              op: 'lt',
              left: {
                scope: 'counter',
                name: 'missing',
              },
              right: 1,
            },
          },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.InvalidExpression);
    }
  });

  test('rejects malformed transition outcomes with a typed error', () => {
    const result = compileWorkflow(
      workflowSource({
        transitions: [
          {
            id: 'invalid',
            from: { nodeId: 'command', outcome: '' },
            toNodeId: 'complete',
          },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.InvalidTransition);
    }
  });

  test('rejects nondeterministic numeric priorities', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
            priority: Number.NaN,
          },
          { id: 'complete', type: 'complete' },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.InvalidNodeConfiguration);
    }
  });

  test('rejects invalid workflow harness pins', () => {
    for (const nodes of [
      [
        {
          id: 'command',
          type: 'command' as const,
          command: 'bun test',
          harness: 'codex',
          recoveryPolicy: 'replay_safe' as const,
        },
        { id: 'complete', type: 'complete' as const },
      ],
      [
        {
          id: 'agent',
          type: 'agent' as const,
          role: 'reviewer',
          prompt: 'Review.',
          harness: ' ',
          recoveryPolicy: 'resume_supported' as const,
        },
        { id: 'complete', type: 'complete' as const },
      ],
    ]) {
      const result = compileWorkflow(
        workflowSource({
          entryNodeId: nodes[0]?.id ?? '',
          nodes,
          transitions: [
            {
              id: 'entry.success.complete',
              from: { nodeId: nodes[0]?.id ?? '', outcome: 'success' },
              toNodeId: 'complete',
            },
          ],
        }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe(CompilerErrorKind.InvalidNodeConfiguration);
      }
    }
  });

  test('rejects invalid workflow model selections', () => {
    for (const nodes of [
      [
        {
          id: 'command',
          type: 'command' as const,
          command: 'bun test',
          models: { codex: 'gpt-5' },
          recoveryPolicy: 'replay_safe' as const,
        },
        { id: 'complete', type: 'complete' as const },
      ],
      [
        {
          id: 'agent',
          type: 'agent' as const,
          role: 'reviewer',
          prompt: 'Review.',
          models: {},
          recoveryPolicy: 'resume_supported' as const,
        },
        { id: 'complete', type: 'complete' as const },
      ],
      [
        {
          id: 'agent',
          type: 'agent' as const,
          role: 'reviewer',
          prompt: 'Review.',
          models: { codex: ' ' },
          recoveryPolicy: 'resume_supported' as const,
        },
        { id: 'complete', type: 'complete' as const },
      ],
    ]) {
      const result = compileWorkflow(
        workflowSource({
          entryNodeId: nodes[0]?.id ?? '',
          nodes,
          transitions: [
            {
              id: 'entry.success.complete',
              from: { nodeId: nodes[0]?.id ?? '', outcome: 'success' },
              toNodeId: 'complete',
            },
          ],
        }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe(CompilerErrorKind.InvalidNodeConfiguration);
      }
    }
  });

  test('rejects an unsupported recovery policy', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            // Deliberately cross the static boundary to test runtime validation.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            recoveryPolicy: 'automatic' as RecoveryPolicy,
          },
          { id: 'complete', type: 'complete' },
        ],
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: CompilerErrorKind.InvalidNodeConfiguration,
        nodeId: 'command',
        reason: 'command recoveryPolicy is unsupported',
      });
    }
  });

  test('accepts reasoning effort only on agents and validates portable values', () => {
    const invalidNodeEffort = compileWorkflow(
      workflowSource({
        entryNodeId: 'agent',
        nodes: [
          {
            id: 'agent',
            type: 'agent',
            role: 'planner',
            prompt: 'Plan.',
            // Deliberately cross the static boundary to test runtime validation.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            reasoningEffort: 'maximum' as AgentReasoningEffort,
            recoveryPolicy: 'resume_supported',
          },
          { id: 'complete', type: 'complete' },
        ],
        transitions: [
          {
            id: 'agent.success.complete',
            from: { nodeId: 'agent', outcome: 'success' },
            toNodeId: 'complete',
          },
        ],
      }),
    );
    expect(invalidNodeEffort.isErr()).toBe(true);
    if (invalidNodeEffort.isErr()) {
      expect(invalidNodeEffort.error).toMatchObject({
        kind: CompilerErrorKind.InvalidNodeConfiguration,
        nodeId: 'agent',
        reason: 'reasoningEffort must be low, medium, or high',
      });
    }

    const invalidSubagentEffort = compileWorkflow(
      workflowSource({
        subagents: [
          {
            id: 'scout',
            role: 'scout',
            prompt: 'Inspect.',
            // Deliberately cross the static boundary to test runtime validation.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            reasoningEffort: 'maximum' as AgentReasoningEffort,
            capabilities: ['repository.read'],
            maxInvocations: 1,
            maxConcurrent: 1,
          },
        ],
      }),
    );
    expect(invalidSubagentEffort.isErr()).toBe(true);
    if (invalidSubagentEffort.isErr()) {
      expect(invalidSubagentEffort.error).toMatchObject({
        kind: CompilerErrorKind.InvalidSubagentConfiguration,
        subagentId: 'scout',
        reason: 'reasoningEffort must be low, medium, or high',
      });
    }

    const commandEffort = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            reasoningEffort: 'low',
            recoveryPolicy: 'replay_safe',
          },
          { id: 'complete', type: 'complete' },
        ],
      }),
    );
    expect(commandEffort.isErr()).toBe(true);
    if (commandEffort.isErr()) {
      expect(commandEffort.error).toMatchObject({
        kind: CompilerErrorKind.InvalidNodeConfiguration,
        nodeId: 'command',
        reason: 'reasoningEffort is supported only on agent nodes',
      });
    }
  });

  test('rejects non-positive global run limits', () => {
    const result = compileWorkflow(
      workflowSource({
        runLimits: { maxNodeInvocations: 0 },
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: CompilerErrorKind.InvalidRunLimit,
        limit: 'maxNodeInvocations',
        value: 0,
      });
    }
  });

  test('rejects a cycle that can bypass its bounded edge', () => {
    const result = compileWorkflow(
      workflowSource({
        entryNodeId: 'a',
        nodes: [
          {
            id: 'a',
            type: 'command',
            command: 'a',
            recoveryPolicy: 'replay_safe',
          },
          {
            id: 'b',
            type: 'command',
            command: 'b',
            recoveryPolicy: 'replay_safe',
          },
          {
            id: 'c',
            type: 'command',
            command: 'c',
            recoveryPolicy: 'replay_safe',
          },
        ],
        counterLimits: { bounded: 1 },
        transitions: [
          {
            id: 'a.b',
            from: { nodeId: 'a', outcome: 'b' },
            toNodeId: 'b',
            increment: 'bounded',
            condition: {
              op: 'lt',
              left: {
                scope: 'counter',
                name: 'bounded',
              },
              right: 1,
            },
          },
          {
            id: 'b.a',
            from: { nodeId: 'b', outcome: 'a' },
            toNodeId: 'a',
          },
          {
            id: 'a.c',
            from: { nodeId: 'a', outcome: 'c' },
            toNodeId: 'c',
          },
          {
            id: 'c.a',
            from: { nodeId: 'c', outcome: 'a' },
            toNodeId: 'a',
          },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.UnboundedCycle);
    }
  });
});
