import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { compileWorkflow } from '@kouro/adw';
import type { CompiledWorkflowArtifact, TokenUsage, WorkflowSourceBundle } from '@kouro/domain';
import {
  AgentExecutor,
  ExecutorErrorKind,
  HarnessErrorKind,
  RunCoordinator,
  validateStructuredOutput,
  type AgentHarness,
  type CommandRunner,
  type CommandRunnerError,
  type HarnessExecutionRequest,
} from '@kouro/executors';
import {
  BunProcessRunner,
  type ClaudeAgentSdk,
  ClaudeCodeHarness,
  type CodexAppServerMessage,
  type CodexAppServerTransport,
  type CodexAppServerTransportFactory,
  CodexHarness,
  HarnessRegistry,
  LocalArtifactWriter,
  type OpenCodeAgentSdk,
  OpenCodeHarness,
  type PiAgentSdk,
  type PiSdkSession,
  PiHarness,
  ScriptedFakeHarness,
} from '@kouro/harnesses';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { err, ok, type Result } from '@usersatoshi/results';

class UnusedCommandRunner implements CommandRunner {
  execute(): Promise<Result<never, CommandRunnerError>> {
    throw new Error('Command execution is not expected');
  }
}

class ContextDelegatingHarness implements AgentHarness {
  readonly id = 'scout-harness';
  readonly calls: { readonly request: HarnessExecutionRequest }[] = [];

  async execute(request: HarnessExecutionRequest) {
    this.calls.push({ request });
    if (!request.subagents) throw new Error('Expected a declared repository scout');
    await request.subagents.invoke('repositoryScout', 'Map the relevant domain files');
    return ok({ output: { files: ['src/domain.ts'] }, transcript: 'scouted' });
  }

  resume(request: HarnessExecutionRequest) {
    return this.execute(request);
  }
}

class ScriptedCodexAppServerFactory implements CodexAppServerTransportFactory {
  readonly calls: { readonly method: string; readonly params: unknown }[] = [];

  constructor(
    private readonly output: unknown,
    private readonly threadId = 'codex-session',
  ) {}

  open(): Promise<Result<CodexAppServerTransport, never>> {
    const listeners = new Set<(message: CodexAppServerMessage) => void>();
    const transcript: string[] = [];
    const emit = (message: CodexAppServerMessage): void => {
      transcript.push(JSON.stringify(message));
      for (const listener of listeners) listener(message);
    };
    return Promise.resolve(
      ok({
        request: (method: string, params: unknown) => {
          this.calls.push({ method, params });
          if (method === 'thread/start' || method === 'thread/resume') {
            return Promise.resolve(ok({ thread: { id: this.threadId } }));
          }
          if (method === 'turn/start') {
            queueMicrotask(() =>
              emit({
                method: 'turn/completed',
                params: {
                  turn: {
                    id: 'codex-turn',
                    status: 'completed',
                    items: [
                      {
                        type: 'agentMessage',
                        text: JSON.stringify(this.output),
                      },
                    ],
                  },
                },
              }),
            );
            return Promise.resolve(ok({ turn: { id: 'codex-turn' } }));
          }
          return Promise.resolve(ok({}));
        },
        notify: (method: string, params: unknown) => {
          this.calls.push({ method, params });
        },
        respond: () => undefined,
        subscribe: (listener: (message: CodexAppServerMessage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        transcript: () => transcript.join('\n'),
        dispose: () => Promise.resolve(),
      }),
    );
  }
}

class ScriptedClaudeSdk implements ClaudeAgentSdk {
  readonly calls: { readonly options: Readonly<Record<string, unknown>> }[] = [];

  constructor(
    private readonly output: unknown,
    private readonly sessionId = 'claude-session',
  ) {}

  query(
    input: Parameters<ClaudeAgentSdk['query']>[0],
    options: Parameters<ClaudeAgentSdk['query']>[1],
  ) {
    this.calls.push({ options });
    const output = this.output;
    const sessionId = this.sessionId;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of input) {
          void message;
          break;
        }
        yield {
          type: 'result',
          subtype: 'success',
          result: JSON.stringify(output),
          structured_output: output,
          session_id: sessionId,
        };
      },
      interrupt: () => Promise.resolve(),
      close: () => undefined,
    };
  }
}

class ScriptedOpenCodeSdk implements OpenCodeAgentSdk {
  readonly calls: {
    readonly request: HarnessExecutionRequest;
    readonly resumeToken?: string;
  }[] = [];

  constructor(
    private readonly output: unknown,
    private readonly sessionId = 'opencode-session',
  ) {}

  create(
    request: HarnessExecutionRequest,
    resumeToken?: string,
  ): Promise<{
    readonly sessionId: string;
    prompt(text: string): Promise<void>;
    steer(text: string): Promise<void>;
    interrupt(): Promise<void>;
    messages(): Promise<readonly unknown[]>;
    usage(): Promise<TokenUsage | undefined>;
    subscribe(listener: (event: unknown) => Promise<void>): Promise<() => Promise<void>>;
    close(): void;
  }> {
    this.calls.push({ request, ...(resumeToken ? { resumeToken } : {}) });
    return Promise.resolve({
      sessionId: this.sessionId,
      prompt: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      messages: () =>
        Promise.resolve([
          {
            type: 'assistant',
            structured: this.output,
            content: [{ type: 'text', text: JSON.stringify(this.output) }],
          },
        ]),
      usage: () => Promise.resolve({ inputTokens: 500, outputTokens: 100 }),
      subscribe: () => Promise.resolve(() => Promise.resolve()),
      close: () => undefined,
    });
  }
}

class ScriptedPiSdk implements PiAgentSdk {
  readonly calls: {
    readonly request: HarnessExecutionRequest;
    readonly resumeToken?: string;
  }[] = [];

  constructor(
    private readonly output: unknown,
    private readonly sessionId = 'pi-session',
  ) {}

  create(request: HarnessExecutionRequest, resumeToken?: string): Promise<PiSdkSession> {
    this.calls.push({ request, ...(resumeToken ? { resumeToken } : {}) });
    return Promise.resolve({
      sessionId: this.sessionId,
      sessionFile: `/sessions/${this.sessionId}.jsonl`,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify(this.output) }],
        },
      ],
      prompt: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      getSessionStats: () => ({
        tokens: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, total: 250 },
        cost: 0,
      }),
      subscribe: () => () => undefined,
      dispose: () => undefined,
    });
  }
}

function artifact(
  additionalModels: Readonly<Record<string, string>> = {},
): CompiledWorkflowArtifact {
  const schemaPath = './schemas/plan.json';
  const source: WorkflowSourceBundle = {
    manifest: { id: 'm4-agent', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'plan',
    nodes: [
      {
        id: 'plan',
        type: 'agent',
        role: 'planner',
        prompt: './prompts/plan.md',
        outputSchema: schemaPath,
        capabilities: ['repository.read'],
        models: {
          'claude-code': 'claude-model',
          codex: 'codex-model',
          opencode: 'provider/opencode-model',
          pi: 'provider/pi-model',
          ...additionalModels,
        },
        recoveryPolicy: 'resume_supported',
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'plan.success.complete',
        from: { nodeId: 'plan', outcome: 'success' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
    prompts: {
      './prompts/plan.md': 'Return a concise implementation plan.',
    },
    schemas: {
      [schemaPath]: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'steps'],
        properties: {
          summary: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    permissions: ['repository.read'],
  };
  return compileWorkflow(source).unwrap();
}

function loopingAgentArtifact(clearContext: boolean): CompiledWorkflowArtifact {
  return compileWorkflow({
    manifest: { id: `context-${clearContext ? 'clear' : 'preserve'}`, version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'implement',
    nodes: [
      {
        id: 'implement',
        type: 'agent',
        role: 'implementer',
        prompt: 'Implement or repair the change.',
        recoveryPolicy: 'resume_supported',
        ...(clearContext ? { clearContext: true } : {}),
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'implement.success.implement',
        from: { nodeId: 'implement', outcome: 'success' },
        toNodeId: 'implement',
        condition: {
          op: 'lt',
          left: { scope: 'counter', name: 'repairs' },
          right: 1,
        },
        increment: 'repairs',
      },
      {
        id: 'implement.success.complete',
        from: { nodeId: 'implement', outcome: 'success' },
        toNodeId: 'complete',
        condition: {
          op: 'gte',
          left: { scope: 'counter', name: 'repairs' },
          right: 1,
        },
      },
    ],
    counterLimits: { repairs: 1 },
  }).unwrap();
}

function routedAgentArtifact(): CompiledWorkflowArtifact {
  return compileWorkflow({
    manifest: { id: 'routed-agents', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'plan',
    nodes: [
      {
        id: 'plan',
        type: 'agent',
        role: 'planner',
        prompt: 'Plan the change.',
        harness: 'claude-code',
        models: { 'claude-code': 'claude-model' },
        reasoningEffort: 'high',
        recoveryPolicy: 'resume_supported',
      },
      {
        id: 'implement',
        type: 'agent',
        role: 'implementer',
        prompt: 'Implement the plan.',
        models: { opencode: 'provider/opencode-model' },
        reasoningEffort: 'low',
        recoveryPolicy: 'resume_supported',
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'plan.success.implement',
        from: { nodeId: 'plan', outcome: 'success' },
        toNodeId: 'implement',
      },
      {
        id: 'implement.success.complete',
        from: { nodeId: 'implement', outcome: 'success' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
  }).unwrap();
}

function sharedContextArtifact(): CompiledWorkflowArtifact {
  return compileWorkflow({
    manifest: { id: 'shared-agent-context', version: '1.0.0' },
    semanticVersions: { compiler: '0.4.0', ir: '4', expressions: '1' },
    entryNodeId: 'scout',
    nodes: [
      {
        id: 'scout',
        type: 'agent',
        role: 'scout',
        prompt: 'Inspect the repository.',
        capabilities: ['repository.read'],
        allowedSubagents: ['repositoryScout'],
        recoveryPolicy: 'resume_supported',
      },
      {
        id: 'planner',
        type: 'agent',
        role: 'planner',
        prompt: 'Plan the change.',
        recoveryPolicy: 'resume_supported',
      },
      {
        id: 'implement',
        type: 'agent',
        role: 'implementer',
        prompt: 'Implement the change.',
        contextSources: [
          { type: 'agent', id: 'scout' },
          { type: 'subagent', id: 'repositoryScout' },
        ],
        recoveryPolicy: 'resume_supported',
      },
      { id: 'complete', type: 'complete' },
    ],
    subagents: [
      {
        id: 'repositoryScout',
        role: 'repository-scout',
        prompt: 'Inspect delegated repository scope.',
        harness: 'child-harness',
        capabilities: ['repository.read'],
        maxInvocations: 1,
        maxConcurrent: 1,
      },
    ],
    transitions: [
      {
        id: 'scout.success.planner',
        from: { nodeId: 'scout', outcome: 'success' },
        toNodeId: 'planner',
      },
      {
        id: 'planner.success.implement',
        from: { nodeId: 'planner', outcome: 'success' },
        toNodeId: 'implement',
      },
      {
        id: 'implement.success.complete',
        from: { nodeId: 'implement', outcome: 'success' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
    permissions: ['repository.read'],
  }).unwrap();
}

function location(prefix: string): {
  readonly directory: string;
  readonly database: string;
  readonly artifacts: string;
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    directory,
    database: join(directory, 'runs.sqlite'),
    artifacts: join(directory, 'artifacts'),
  };
}

function storeAt(path: string): SqliteEventStore {
  const store = new SqliteEventStore(path);
  const initialized = store.initialize();
  if (initialized.isErr()) {
    throw new Error(JSON.stringify(initialized.error));
  }
  return store;
}

async function runAdapter(
  harness: AgentHarness,
  runId: string,
): Promise<ReturnType<SqliteEventStore['loadRun']>> {
  const paths = location(`kouro-m4-${harness.id}-`);
  const store = storeAt(paths.database);
  try {
    const executor = new AgentExecutor(
      new HarnessRegistry([harness]),
      new LocalArtifactWriter(paths.artifacts),
    );
    const coordinator = new RunCoordinator(
      store,
      new UnusedCommandRunner(),
      executor,
      paths.directory,
    );
    coordinator
      .createRun({
        runId,
        artifact: artifact(),
        startingCommit: 'abc123',
        configuration: {
          agentHarnesses: [harness.id],
          agentReasoningEffort: 'high',
        },
        idempotencyKey: 'create',
      })
      .unwrap();
    await coordinator.advance(runId);
    await coordinator.advance(runId);
    await coordinator.advance(runId);
    await coordinator.advance(runId);
    return store.loadRun(runId);
  } finally {
    store.dispose();
    rmSync(paths.directory, { recursive: true, force: true });
  }
}

describe('M4 harness-independent agent execution', () => {
  test('the Bun process runner observes stdout while preserving the full transcript', async () => {
    const chunks: string[] = [];
    const runner = new BunProcessRunner();
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 25)",
      ],
      process.cwd(),
      async (chunk) => {
        chunks.push(chunk);
      },
    );

    expect(result.unwrap().stdout).toBe('first\nsecond\n');
    expect(chunks.join('')).toBe('first\nsecond\n');
  });

  test('reuses agent context across graph invocations unless clearContext is set', async () => {
    for (const clearContext of [false, true]) {
      const paths = location(`kouro-agent-context-${clearContext}-`);
      let store = storeAt(paths.database);
      try {
        const harness = new ScriptedFakeHarness('context-fake', [
          { output: { summary: 'Initial implementation' }, transcript: '{}', resumeToken: 'ctx-1' },
          { output: { summary: 'Repair' }, transcript: '{}', resumeToken: 'ctx-1' },
        ]);
        const executor = new AgentExecutor(
          new HarnessRegistry([harness]),
          new LocalArtifactWriter(paths.artifacts),
        );
        let coordinator = new RunCoordinator(
          store,
          new UnusedCommandRunner(),
          executor,
          paths.directory,
        );
        coordinator
          .createRun({
            runId: `context-${clearContext}`,
            artifact: loopingAgentArtifact(clearContext),
            startingCommit: 'abc123',
            configuration: { agentHarnesses: [harness.id] },
            idempotencyKey: 'create',
          })
          .unwrap();

        await coordinator.advance(`context-${clearContext}`);
        await coordinator.advance(`context-${clearContext}`);
        await coordinator.advance(`context-${clearContext}`);
        store.dispose();
        store = storeAt(paths.database);
        coordinator = new RunCoordinator(
          store,
          new UnusedCommandRunner(),
          executor,
          paths.directory,
        );

        for (let step = 0; step < 8; step += 1) {
          const aggregate = store.loadRun(`context-${clearContext}`).unwrap();
          if (aggregate.state.status !== 'running') break;
          (await coordinator.advance(`context-${clearContext}`)).unwrap();
        }

        expect(harness.calls.map(({ operation }) => operation)).toEqual(
          clearContext ? ['execute', 'execute'] : ['execute', 'resume'],
        );
      } finally {
        store.dispose();
        rmSync(paths.directory, { recursive: true, force: true });
      }
    }
  });

  test('structured validation accepts every finite JSON primitive allowed by the schema', () => {
    expect(validateStructuredOutput(false, { type: 'boolean' })).toEqual({ output: false });
    expect(validateStructuredOutput(0, { type: 'number' })).toEqual({ output: 0 });
    expect(validateStructuredOutput('', { type: 'string' })).toEqual({ output: '' });
    expect(validateStructuredOutput(null, { type: 'null' })).toEqual({ output: null });
  });

  test('artifact publication is idempotent and refuses conflicting content', async () => {
    const paths = location('kouro-m4-artifact-');
    try {
      const writer = new LocalArtifactWriter(paths.artifacts);
      const request = {
        runId: 'artifact-run',
        invocationSequence: 1,
        attemptNumber: 1,
        kind: 'agent_output' as const,
        mediaType: 'application/json',
        content: '{"result":"same"}',
      };
      const first = await writer.write(request);
      const repeated = await writer.write(request);
      const conflict = await writer.write({ ...request, content: '{"result":"different"}' });
      expect(repeated.unwrap()).toEqual(first.unwrap());
      expect(conflict.isErr()).toBe(true);
    } finally {
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('SQLite initialization adds M4 attempt projection columns to an M2 database', () => {
    const paths = location('kouro-m4-migration-');
    const legacy = new Database(paths.database, { create: true });
    legacy.exec(`
      CREATE TABLE attempt_projections (
        run_id TEXT NOT NULL,
        invocation_sequence INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL,
        state TEXT NOT NULL,
        resume_token TEXT,
        PRIMARY KEY (run_id, invocation_sequence, attempt_number)
      );
    `);
    legacy.close();

    const store = storeAt(paths.database);
    try {
      const inspected = new Database(paths.database);
      const columns = inspected
        .query<{ name: string }, []>('SELECT name FROM pragma_table_info("attempt_projections")')
        .all()
        .map(({ name }) => name);
      inspected.close();
      expect(columns).toContain('harness_id');
      expect(columns).toContain('model');
      expect(columns).toContain('failure_json');
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('the same compiled ADW completes through all supported harness adapters', async () => {
    const output = { summary: 'Plan', steps: ['Inspect', 'Implement'] };
    const claudeSdk = new ScriptedClaudeSdk(output);
    const codexRunner = new ScriptedCodexAppServerFactory(output);
    const openCodeSdk = new ScriptedOpenCodeSdk(output);
    const piSdk = new ScriptedPiSdk(output);

    const claude = await runAdapter(new ClaudeCodeHarness(claudeSdk), 'claude-run');
    const codex = await runAdapter(new CodexHarness(codexRunner), 'codex-run');
    const openCode = await runAdapter(new OpenCodeHarness(openCodeSdk), 'opencode-run');
    const pi = await runAdapter(new PiHarness(piSdk), 'pi-run');

    for (const result of [claude, codex, openCode, pi]) {
      expect(result.unwrap().state.status).toBe('succeeded');
      expect(result.unwrap().state.invocations[0]?.output).toEqual(output);
      expect(result.unwrap().state.invocations[0]?.attempts[0]?.artifacts).toHaveLength(2);
    }
    expect(claude.unwrap().state.invocations[0]?.attempts[0]?.resumeToken).toBe('claude-session');
    expect(codex.unwrap().state.invocations[0]?.attempts[0]?.resumeToken).toBe('codex-session');
    expect(openCode.unwrap().state.invocations[0]?.attempts[0]?.resumeToken).toBe(
      'opencode-session',
    );
    expect(pi.unwrap().state.invocations[0]?.attempts[0]?.resumeToken).toBe(
      '/sessions/pi-session.jsonl',
    );
    expect(claudeSdk.calls[0]?.options).toMatchObject({
      model: 'claude-model',
      effort: 'high',
      outputFormat: { type: 'json_schema' },
      tools: ['Read', 'Glob', 'Grep'],
    });
    expect(codexRunner.calls.map(({ method }) => method)).toContain('turn/start');
    expect(codexRunner.calls.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
      model: 'codex-model',
      effort: 'high',
      outputSchema: expect.any(Object),
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    expect(openCodeSdk.calls[0]?.request.model).toBe('provider/opencode-model');
    expect(openCodeSdk.calls[0]?.request.reasoningEffort).toBe('high');
    expect(openCodeSdk.calls[0]?.request.outputSchema).toBeDefined();
    expect(piSdk.calls[0]?.request.capabilities).toEqual(['repository.read']);
    expect(piSdk.calls[0]?.request.model).toBe('provider/pi-model');
    expect(piSdk.calls[0]?.request.reasoningEffort).toBe('high');
  });

  test('OpenCode and Pi resume the exact recorded session', async () => {
    const output = { summary: 'Resumed', steps: ['Finish'] };
    const openCodeSdk = new ScriptedOpenCodeSdk(output);
    const piSdk = new ScriptedPiSdk(output);
    const request = {
      runId: 'resume-adapters',
      invocationSequence: 1,
      attemptNumber: 1,
      workingDirectory: '/tmp',
      role: 'implementer',
      prompt: 'Continue.',
      capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
      model: 'provider/resume-model',
    };

    expect(
      (await new OpenCodeHarness(openCodeSdk).resume(request, 'opencode-session')).unwrap().output,
    ).toEqual(output);
    expect((await new PiHarness(piSdk).resume(request, 'pi-session')).unwrap().output).toEqual(
      output,
    );
    expect(openCodeSdk.calls[0]).toMatchObject({
      resumeToken: 'opencode-session',
      request: { model: 'provider/resume-model' },
    });
    expect(piSdk.calls[0]).toMatchObject({
      resumeToken: 'pi-session',
      request: {
        capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
        model: 'provider/resume-model',
      },
    });
  });

  test('Claude Code and Codex preserve explicit models when resuming', async () => {
    const output = { summary: 'Resumed', steps: ['Finish'] };
    const claudeSdk = new ScriptedClaudeSdk(output);
    const codexRunner = new ScriptedCodexAppServerFactory(output);
    const request = {
      runId: 'resume-model-adapters',
      invocationSequence: 1,
      attemptNumber: 1,
      workingDirectory: '/tmp',
      role: 'implementer',
      prompt: 'Continue.',
      capabilities: ['repository.read'],
    };

    expect(
      (
        await new ClaudeCodeHarness(claudeSdk).resume(
          { ...request, model: 'claude-resume-model' },
          'claude-session',
        )
      ).unwrap().output,
    ).toEqual(output);
    expect(
      (
        await new CodexHarness(codexRunner).resume(
          { ...request, model: 'codex-resume-model' },
          'codex-session',
        )
      ).unwrap().output,
    ).toEqual(output);
    expect(claudeSdk.calls[0]?.options).toMatchObject({
      model: 'claude-resume-model',
      resume: 'claude-session',
    });
    expect(
      codexRunner.calls.find(({ method }) => method === 'thread/resume')?.params,
    ).toMatchObject({
      threadId: 'codex-session',
      model: 'codex-resume-model',
    });
    expect(codexRunner.calls.find(({ method }) => method === 'turn/start')?.params).toMatchObject({
      model: 'codex-resume-model',
    });
  });

  test('workflow pins override run routing and unpinned agents use node routes', async () => {
    const paths = location('kouro-agent-routing-');
    const store = storeAt(paths.database);
    try {
      const planner = new ScriptedFakeHarness('claude-code', [
        { output: { plan: 'Inspect first' }, transcript: 'planned' },
      ]);
      const implementer = new ScriptedFakeHarness('opencode', [
        { output: { change: 'Implemented' }, transcript: 'implemented' },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(
          new HarnessRegistry([planner, implementer]),
          new LocalArtifactWriter(paths.artifacts),
        ),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'routed-run',
          artifact: routedAgentArtifact(),
          startingCommit: 'abc123',
          configuration: {
            agentHarnessesByNode: {
              plan: ['opencode'],
              implement: ['opencode'],
            },
            agentReasoningEffort: 'medium',
          },
          idempotencyKey: 'create',
        })
        .unwrap();

      for (let step = 0; step < 8; step += 1) {
        const aggregate = store.loadRun('routed-run').unwrap();
        if (aggregate.state.status !== 'running') break;
        (await coordinator.advance('routed-run')).unwrap();
      }

      const completed = store.loadRun('routed-run').unwrap();
      expect(completed.state.status).toBe('succeeded');
      expect(planner.calls[0]?.request.reasoningEffort).toBe('high');
      expect(implementer.calls[0]?.request.reasoningEffort).toBe('low');
      expect(
        completed.state.invocations
          .filter(({ nodeId }) => nodeId === 'plan' || nodeId === 'implement')
          .map(({ nodeId, attempts }) => ({
            nodeId,
            harnessId: attempts[0]?.harnessId,
            model: attempts[0]?.model,
          })),
      ).toEqual([
        { nodeId: 'plan', harnessId: 'claude-code', model: 'claude-model' },
        {
          nodeId: 'implement',
          harnessId: 'opencode',
          model: 'provider/opencode-model',
        },
      ]);
      expect(planner.calls[0]?.request.model).toBe('claude-model');
      expect(implementer.calls[0]?.request.model).toBe('provider/opencode-model');
      expect(planner.calls).toHaveLength(1);
      expect(implementer.calls).toHaveLength(1);
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('injects declared structured output across agent and model boundaries', async () => {
    const paths = location('kouro-shared-agent-context-');
    const store = storeAt(paths.database);
    try {
      const scout = new ContextDelegatingHarness();
      const child = new ScriptedFakeHarness('child-harness', [
        { output: { boundary: 'domain' }, transcript: 'child scouted' },
      ]);
      const planner = new ScriptedFakeHarness('planner-harness', [
        { output: { steps: ['Implement domain change'] }, transcript: 'planned' },
      ]);
      const implementer = new ScriptedFakeHarness('implementer-harness', [
        { output: { changed: true }, transcript: 'implemented' },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(
          new HarnessRegistry([scout, child, planner, implementer]),
          new LocalArtifactWriter(paths.artifacts),
        ),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'shared-context-run',
          artifact: sharedContextArtifact(),
          startingCommit: 'abc123',
          configuration: {
            agentHarnessesByNode: {
              scout: ['scout-harness'],
              planner: ['planner-harness'],
              implement: ['implementer-harness'],
            },
          },
          idempotencyKey: 'create',
        })
        .unwrap();

      for (let step = 0; step < 12; step += 1) {
        if (store.loadRun('shared-context-run').unwrap().state.status !== 'running') break;
        (await coordinator.advance('shared-context-run')).unwrap();
      }

      const prompt = implementer.calls[0]?.request.prompt ?? '';
      expect(prompt).toContain('Declared context from prior agents:');
      expect(prompt).toContain('Agent scout (invocation 1):');
      expect(prompt).toContain('"src/domain.ts"');
      expect(prompt).toContain('Subagent repositoryScout (invocation 1, call repositoryScout:1):');
      expect(prompt).toContain('"boundary": "domain"');
      expect(prompt).toContain('Workflow feedback from planner');
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('replay rejects a model that differs from the compiled harness selection', () => {
    const paths = location('kouro-agent-model-replay-');
    const store = storeAt(paths.database);
    try {
      const coordinator = new RunCoordinator(store, new UnusedCommandRunner());
      let current = coordinator
        .createRun({
          runId: 'model-replay-run',
          artifact: artifact({ fake: 'expected-model' }),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['fake'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      current = store
        .appendEvent({
          runId: 'model-replay-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'activate',
          event: {
            type: 'invocation.activated',
            invocationSequence: 1,
            nodeId: 'plan',
          },
        })
        .unwrap();
      const mismatched = store.appendEvent({
        runId: 'model-replay-run',
        expectedSequence: current.nextEventSequence,
        idempotencyKey: 'wrong-model',
        event: {
          type: 'attempt.started',
          invocationSequence: 1,
          attemptNumber: 1,
          harnessId: 'fake',
          model: 'different-model',
        },
      });

      expect(mismatched.isErr()).toBe(true);
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('invalid structured output is persisted as a typed node failure', async () => {
    const paths = location('kouro-m4-invalid-');
    const store = storeAt(paths.database);
    try {
      const harness = new ScriptedFakeHarness('fake', [
        { output: { summary: 'Missing steps' }, transcript: '{}' },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(new HarnessRegistry([harness]), new LocalArtifactWriter(paths.artifacts)),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'invalid-run',
          artifact: artifact(),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['fake'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      await coordinator.advance('invalid-run');
      const failed = await coordinator.advance('invalid-run');
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) expect(failed.error.kind).toBe(ExecutorErrorKind.Agent);

      const persisted = store.loadRun('invalid-run').unwrap();
      expect(persisted.state.invocations[0]?.state).toBe('failed');
      expect(persisted.state.invocations[0]?.attempts[0]?.failure?.kind).toBe(
        'invalid_structured_output',
      );
      const completed = (await coordinator.advance('invalid-run')).unwrap();
      expect(completed.state.status).toBe('failed');
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('ignores malformed optional usage without failing a successful attempt', async () => {
    const paths = location('kouro-m4-malformed-usage-');
    const store = storeAt(paths.database);
    try {
      const harness = new ScriptedFakeHarness('fake', [
        {
          output: { summary: 'Complete', steps: ['Ship it'] },
          transcript: '{}',
          usage: { inputTokens: -1, outputTokens: 20 },
        },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(new HarnessRegistry([harness]), new LocalArtifactWriter(paths.artifacts)),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'malformed-usage-run',
          artifact: artifact(),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['fake'] },
          idempotencyKey: 'create',
        })
        .unwrap();

      await coordinator.advance('malformed-usage-run');
      expect((await coordinator.advance('malformed-usage-run')).isOk()).toBe(true);

      const persisted = store.loadRun('malformed-usage-run').unwrap();
      expect(persisted.state.invocations[0]?.state).toBe('succeeded');
      expect(persisted.state.invocations[0]?.attempts[0]?.usage).toBeUndefined();
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('fallback creates another attempt in the same invocation', async () => {
    const paths = location('kouro-m4-fallback-');
    const store = storeAt(paths.database);
    try {
      const primary = new ScriptedFakeHarness('primary', [
        err({ kind: HarnessErrorKind.ProcessFailure, message: 'provider unavailable' }),
      ]);
      const fallback = new ScriptedFakeHarness('fallback', [
        {
          output: { summary: 'Recovered', steps: ['Continue'] },
          transcript: '{}',
        },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(
          new HarnessRegistry([primary, fallback]),
          new LocalArtifactWriter(paths.artifacts),
        ),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'fallback-run',
          artifact: artifact({
            primary: 'primary-model',
            fallback: 'fallback-model',
          }),
          startingCommit: 'abc123',
          configuration: {
            agentHarnesses: ['primary'],
            agentHarnessesByNode: { plan: ['primary', 'fallback'] },
          },
          idempotencyKey: 'create',
        })
        .unwrap();
      await coordinator.advance('fallback-run');
      expect((await coordinator.advance('fallback-run')).isErr()).toBe(true);
      await coordinator.advance('fallback-run');

      const invocation = store.loadRun('fallback-run').unwrap().state.invocations[0];
      expect(invocation?.sequence).toBe(1);
      expect(
        invocation?.attempts.map(({ number, harnessId, model, state }) => ({
          number,
          harnessId,
          model,
          state,
        })),
      ).toEqual([
        { number: 1, harnessId: 'primary', model: 'primary-model', state: 'failed' },
        {
          number: 2,
          harnessId: 'fallback',
          model: 'fallback-model',
          state: 'succeeded',
        },
      ]);
      expect(primary.calls[0]?.request.model).toBe('primary-model');
      expect(fallback.calls[0]?.request.model).toBe('fallback-model');
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('resume continues the interrupted harness session without a new attempt', async () => {
    const paths = location('kouro-m4-resume-');
    const store = storeAt(paths.database);
    try {
      const harness = new ScriptedFakeHarness('fake', [
        {
          output: { summary: 'Resumed', steps: ['Finish'] },
          transcript: '{}',
          resumeToken: 'session-1',
        },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(new HarnessRegistry([harness]), new LocalArtifactWriter(paths.artifacts)),
        paths.directory,
      );
      const created = coordinator
        .createRun({
          runId: 'resume-run',
          artifact: artifact(),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['fake'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      let current = store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: created.nextEventSequence,
          idempotencyKey: 'activate',
          event: { type: 'invocation.activated', invocationSequence: 1, nodeId: 'plan' },
        })
        .unwrap();
      current = store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'started',
          event: {
            type: 'attempt.started',
            invocationSequence: 1,
            attemptNumber: 1,
            harnessId: 'fake',
          },
        })
        .unwrap();
      current = store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'token',
          event: {
            type: 'attempt.resume_token_recorded',
            invocationSequence: 1,
            attemptNumber: 1,
            resumeToken: 'session-1',
          },
        })
        .unwrap();
      store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'interrupted',
          event: { type: 'attempt.interrupted', invocationSequence: 1, attemptNumber: 1 },
        })
        .unwrap();

      await coordinator.advance('resume-run');
      const resumed = store.loadRun('resume-run').unwrap().state.invocations[0];
      expect(resumed?.state).toBe('succeeded');
      expect(resumed?.attempts).toHaveLength(1);
      expect(harness.calls).toEqual([
        expect.objectContaining({ operation: 'resume', token: 'session-1' }),
      ]);
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });
});
