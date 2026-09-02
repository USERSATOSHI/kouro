import { describe, expect, test } from 'bun:test';

import {
  HarnessErrorKind,
  type AgentControlChannel,
  type AgentHarness,
  type HarnessExecutionRequest,
  type SubagentExecutionController,
} from '@kouro/executors';
import {
  type ClaudeAgentSdk,
  ClaudeCodeHarness,
  type OpenCodeAgentSdk,
  type OpenCodeSdkSession,
  OpenCodeHarness,
  type PiAgentSdk,
  type PiSdkSession,
  PiHarness,
} from '@kouro/harnesses';
import { invokePiSubagent } from '../../packages/harnesses/src/pi-sandbox-tools.ts';
import { loadPiBuiltInExtensions } from '../../packages/harnesses/src/pi-builtins.ts';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (!resolvePromise) throw new Error('Deferred was not initialized');
      resolvePromise();
    },
  };
}

function request(
  controls?: AgentControlChannel,
  capabilities: readonly string[] = ['repository.read'],
): HarnessExecutionRequest {
  return {
    runId: 'sdk-control',
    invocationSequence: 1,
    attemptNumber: 1,
    workingDirectory: '/tmp/worktree',
    role: 'implementer',
    prompt: 'Implement.',
    capabilities,
    ...(controls ? { controls } : {}),
  };
}

function steeringControls(): {
  readonly controls: AgentControlChannel;
  readonly applied: () => boolean;
} {
  let applied = false;
  return {
    controls: {
      read: () =>
        Promise.resolve({
          steering: applied ? [] : [{ requestSequence: 7, message: 'Preserve compatibility.' }],
          interruptRequested: false,
        }),
      steeringApplied: (sequence) => {
        expect(sequence).toBe(7);
        applied = true;
        return Promise.resolve();
      },
      steeringRejected: () => Promise.resolve(),
    },
    applied: () => applied,
  };
}

function interruptControls(): AgentControlChannel {
  return {
    read: () => Promise.resolve({ steering: [], interruptRequested: true }),
    steeringApplied: () => Promise.resolve(),
    steeringRejected: () => Promise.resolve(),
  };
}

class ControlledClaudeSdk implements ClaudeAgentSdk {
  readonly steering: string[] = [];
  interrupted = false;
  options: Parameters<ClaudeAgentSdk['query']>[1] | undefined;

  constructor(private readonly mode: 'steer' | 'interrupt') {}

  query(
    input: Parameters<ClaudeAgentSdk['query']>[0],
    options: Parameters<ClaudeAgentSdk['query']>[1],
  ) {
    this.options = options;
    const mode = this.mode;
    const steering = this.steering;
    const interrupted = deferred();
    return {
      async *[Symbol.asyncIterator]() {
        const iterator = input[Symbol.asyncIterator]();
        await iterator.next();
        if (mode === 'steer') {
          const steered = await iterator.next();
          if (!steered.done) {
            const content = steered.value.message.content;
            if (typeof content === 'string') steering.push(content);
          }
          void iterator.next();
          await Promise.resolve();
          yield {
            type: 'result',
            subtype: 'success',
            result: '{"summary":"steered"}',
            session_id: 'claude-sdk-session',
          };
          return;
        }
        await interrupted.promise;
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['interrupted'],
          session_id: 'claude-sdk-session',
        };
      },
      interrupt: () => {
        this.interrupted = true;
        interrupted.resolve();
        return Promise.resolve();
      },
      close: () => undefined,
    };
  }
}

class ControlledOpenCodeSdk implements OpenCodeAgentSdk {
  readonly steering: string[] = [];
  interrupted = false;

  constructor(private readonly mode: 'steer' | 'interrupt') {}

  create(): Promise<OpenCodeSdkSession> {
    const completed = deferred();
    return Promise.resolve({
      sessionId: 'opencode-sdk-session',
      prompt: () => completed.promise,
      steer: (message) => {
        this.steering.push(message);
        completed.resolve();
        return Promise.resolve();
      },
      interrupt: () => {
        this.interrupted = true;
        completed.resolve();
        return Promise.resolve();
      },
      messages: () =>
        Promise.resolve([
          {
            type: 'assistant',
            structured: { summary: 'steered' },
            content: [],
          },
        ]),
      usage: () => Promise.resolve({ inputTokens: 120, outputTokens: 40 }),
      subscribe: () => Promise.resolve(() => Promise.resolve()),
      close: () => undefined,
    });
  }
}

class ControlledPiSdk implements PiAgentSdk {
  readonly steering: string[] = [];
  interrupted = false;

  constructor(private readonly mode: 'steer' | 'interrupt') {}

  create(): Promise<PiSdkSession> {
    const completed = deferred();
    return Promise.resolve({
      sessionId: 'pi-sdk-session',
      sessionFile: '/sessions/pi-sdk-session.jsonl',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '{"summary":"steered"}' }],
        },
      ],
      prompt: () => completed.promise,
      steer: (message) => {
        this.steering.push(message);
        completed.resolve();
        return Promise.resolve();
      },
      abort: () => {
        this.interrupted = true;
        completed.resolve();
        return Promise.resolve();
      },
      getSessionStats: () => ({
        tokens: { input: 120, output: 40, cacheRead: 0, cacheWrite: 0, total: 160 },
        cost: 0.001,
      }),
      subscribe: () => () => undefined,
      dispose: () => undefined,
    });
  }
}

describe('ADR-0029: provider SDK harness control', () => {
  test('loads Pi built-in providers for SDK-created runtimes', async () => {
    const extensions = await loadPiBuiltInExtensions();

    expect(extensions).toContainEqual(expect.objectContaining({ name: 'llama.cpp', hidden: true }));
  });

  test('steers every SDK-backed provider through the normalized control channel', async () => {
    const claudeSdk = new ControlledClaudeSdk('steer');
    const openCodeSdk = new ControlledOpenCodeSdk('steer');
    const piSdk = new ControlledPiSdk('steer');
    const harnesses: readonly {
      readonly harness: AgentHarness;
      readonly steering: readonly string[];
    }[] = [
      { harness: new ClaudeCodeHarness(claudeSdk), steering: claudeSdk.steering },
      { harness: new OpenCodeHarness(openCodeSdk), steering: openCodeSdk.steering },
      { harness: new PiHarness(piSdk), steering: piSdk.steering },
    ];

    for (const { harness, steering } of harnesses) {
      const control = steeringControls();
      const result = await harness.execute(request(control.controls));
      expect(result.isOk()).toBe(true);
      expect(control.applied()).toBe(true);
      expect(steering).toEqual(['Preserve compatibility.']);
    }
  });

  test('interrupts every SDK-backed provider through its native control API', async () => {
    const claudeSdk = new ControlledClaudeSdk('interrupt');
    const openCodeSdk = new ControlledOpenCodeSdk('interrupt');
    const piSdk = new ControlledPiSdk('interrupt');
    const harnesses: readonly {
      readonly harness: AgentHarness;
      readonly interrupted: () => boolean;
    }[] = [
      {
        harness: new ClaudeCodeHarness(claudeSdk),
        interrupted: () => claudeSdk.interrupted,
      },
      {
        harness: new OpenCodeHarness(openCodeSdk),
        interrupted: () => openCodeSdk.interrupted,
      },
      { harness: new PiHarness(piSdk), interrupted: () => piSdk.interrupted },
    ];

    for (const { harness, interrupted } of harnesses) {
      const result = await harness.execute(request(interruptControls()));
      expect(interrupted()).toBe(true);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.kind).toBe(HarnessErrorKind.ProcessFailure);
    }
  });

  test('preserves provider-reported failures as typed process failures', async () => {
    const openCodeSdk: OpenCodeAgentSdk = {
      create: () =>
        Promise.resolve({
          sessionId: 'failed-opencode-session',
          prompt: () => Promise.resolve(),
          steer: () => Promise.resolve(),
          interrupt: () => Promise.resolve(),
          messages: () =>
            Promise.resolve([
              {
                type: 'assistant',
                error: { message: 'OpenCode provider failed' },
                content: [],
              },
            ]),
          usage: () => Promise.resolve(undefined),
          subscribe: () => Promise.resolve(() => Promise.resolve()),
          close: () => undefined,
        }),
    };
    const piSdk: PiAgentSdk = {
      create: () =>
        Promise.resolve({
          sessionId: 'failed-pi-session',
          sessionFile: '/sessions/failed-pi-session.jsonl',
          messages: [
            {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'Pi provider failed',
              content: [],
            },
          ],
          prompt: () => Promise.resolve(),
          steer: () => Promise.resolve(),
          abort: () => Promise.resolve(),
          getSessionStats: () => ({
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
          }),
          subscribe: () => () => undefined,
          dispose: () => undefined,
        }),
    };

    for (const harness of [new OpenCodeHarness(openCodeSdk), new PiHarness(piSdk)]) {
      const result = await harness.execute(request());
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.kind).toBe(HarnessErrorKind.ProcessFailure);
    }
  });

  test('does not fail a successful Pi attempt when usage statistics are unavailable', async () => {
    const piSdk: PiAgentSdk = {
      create: () =>
        Promise.resolve({
          sessionId: 'pi-no-stats-session',
          sessionFile: '/sessions/pi-no-stats-session.jsonl',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '{"summary":"complete"}' }],
            },
          ],
          prompt: () => Promise.resolve(),
          steer: () => Promise.resolve(),
          abort: () => Promise.resolve(),
          getSessionStats: () => {
            throw new Error('statistics unavailable');
          },
          subscribe: () => () => undefined,
          dispose: () => undefined,
        }),
    };

    const result = await new PiHarness(piSdk).execute(request());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.unwrap().usage).toBeUndefined();
  });

  test('configures Claude command and file tools to fail closed', async () => {
    const sdk = new ControlledClaudeSdk('steer');
    const control = steeringControls();
    const result = await new ClaudeCodeHarness(sdk).execute(
      request(control.controls, ['repository.read', 'repository.write', 'terminal.execute']),
    );
    expect(result.isOk()).toBe(true);
    expect(sdk.options?.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: {
        deniedDomains: ['*'],
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      filesystem: {
        allowWrite: ['/tmp/worktree'],
      },
    });
    const guard = sdk.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(guard).toBeDefined();
    if (!guard) return;
    const denied = await guard(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sandbox-test',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp/worktree',
        permission_mode: 'dontAsk',
        tool_name: 'Read',
        tool_input: { file_path: '/etc/passwd' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
  });

  test('exposes declared subagents through Claude SDK MCP tools', async () => {
    const sdk = new ControlledClaudeSdk('steer');
    const control = steeringControls();
    const result = await new ClaudeCodeHarness(sdk).execute({
      ...request(control.controls),
      subagents: {
        definitions: [
          { id: 'architecture', role: 'architecture-scout' },
          { id: 'tests', role: 'test-scout' },
        ],
        invoke: () =>
          Promise.resolve({
            callId: 'architecture:1',
            success: true,
            output: { summary: 'done' },
          }),
      },
    });

    expect(result.isOk()).toBe(true);
    expect(sdk.options?.allowedTools).toContain('mcp__kouro__subagent');
    expect(sdk.options?.mcpServers).toHaveProperty('kouro');
  });

  test('maps Pi custom-tool calls to the normalized subagent controller', async () => {
    const calls: unknown[] = [];
    const controller: SubagentExecutionController = {
      definitions: [{ id: 'scout', role: 'repository-scout' }],
      invoke: (subagent, task) => {
        calls.push({ subagent, task });
        return Promise.resolve({
          callId: 'scout:1',
          success: true,
          output: { files: ['src/index.ts'] },
        });
      },
    };

    const result = await invokePiSubagent(controller, 'scout', 'Find the entrypoint');

    expect(calls).toEqual([{ subagent: 'scout', task: 'Find the entrypoint' }]);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          callId: 'scout:1',
          success: true,
          output: { files: ['src/index.ts'] },
        }),
      },
    ]);
  });
});
