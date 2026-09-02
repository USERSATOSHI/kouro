import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { SandboxRuntimeAgentCommandSandbox, WorktreePathGuard } from '@kouro/sandbox-worktree';
import { err, fromAsync, ok, type Result } from '@usersatoshi/results';
import type { TokenUsage } from '@kouro/domain';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
} from '@kouro/executors';
import { invalidResponse, processFailure } from './errors.ts';
import { loadPiBuiltInExtensions } from './pi-builtins.ts';
import { createPiSandboxTools } from './pi-sandbox-tools.ts';
import { parseHarnessOutput } from './structured-output.ts';

export interface PiSdkSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: readonly unknown[];
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  getSessionStats(): PiSessionStats;
  dispose(): void;
}

/** Token counts and cost reported by the Pi SDK session statistics. */
export interface PiSessionStats {
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost?: number;
}

export interface PiAgentSdk {
  create(request: HarnessExecutionRequest, resumeToken?: string): Promise<PiSdkSession>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function promptFor(request: HarnessExecutionRequest): string {
  const schemaInstruction = request.outputSchema
    ? `\n\nReturn only JSON matching this schema:\n${JSON.stringify(request.outputSchema)}`
    : '';
  return `Role: ${request.role}\n\n${request.prompt}${schemaInstruction}`;
}

function toolsFor(capabilities: readonly string[]): string[] {
  const tools = ['read', 'grep', 'find', 'ls'];
  if (capabilities.some((capability) => capability.includes('write'))) {
    tools.push('edit', 'write');
  }
  if (capabilities.some((capability) => capability.includes('execute'))) {
    tools.push('bash');
  }
  return tools;
}

async function sessionManagerFor(cwd: string, token?: string): Promise<SessionManager> {
  if (!token) return SessionManager.create(cwd);
  const matching = (await SessionManager.list(cwd)).find(
    ({ id, path }) => id === token || path === token,
  );
  return SessionManager.open(matching?.path ?? token, undefined, cwd);
}

async function modelFor(
  runtime: ModelRuntime,
  requested?: string,
): Promise<ReturnType<ModelRuntime['getModel']>> {
  if (!requested) return undefined;
  const separator = requested.indexOf('/');
  if (separator >= 1) {
    return runtime.getModel(requested.slice(0, separator), requested.slice(separator + 1));
  }
  return (await runtime.getAvailable()).find(({ id }) => id === requested);
}

const defaultSdk: PiAgentSdk = {
  async create(request, resumeToken) {
    const pathGuard = new WorktreePathGuard();
    const commandSandbox = new SandboxRuntimeAgentCommandSandbox();
    const agentDir = getAgentDir();
    const services = await createAgentSessionServices({
      cwd: request.workingDirectory,
      agentDir,
      modelRuntime: await ModelRuntime.create(),
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: await loadPiBuiltInExtensions(),
      },
    });
    const model = await modelFor(services.modelRuntime, request.model);
    if (request.model && !model) throw new Error(`Pi model is unavailable: ${request.model}`);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: await sessionManagerFor(request.workingDirectory, resumeToken),
      ...(model ? { model } : {}),
      ...(request.reasoningEffort ? { thinkingLevel: request.reasoningEffort } : {}),
      tools: toolsFor(request.capabilities),
      customTools: createPiSandboxTools(
        request.workingDirectory,
        request.capabilities,
        pathGuard,
        commandSandbox,
        request.subagents,
      ),
    });
    return session;
  },
};

function assistantOutput(value: unknown): Result<string, HarnessError> | undefined {
  if (!isRecord(value) || value.role !== 'assistant') return undefined;
  if (value.stopReason === 'error' || value.stopReason === 'aborted') {
    return err(
      processFailure(
        typeof value.errorMessage === 'string'
          ? value.errorMessage
          : `Pi request ${value.stopReason}`,
      ),
    );
  }
  if (!Array.isArray(value.content)) {
    return err(processFailure('Pi SDK assistant message has no content'));
  }
  const text = value.content
    .filter(isRecord)
    .filter((content) => content.type === 'text' && typeof content.text === 'string')
    .map((content) => String(content.text))
    .join('');
  return text ? ok(text) : err(processFailure('Pi SDK returned no assistant text'));
}

function usageFromPiStats(stats: PiSessionStats): TokenUsage | undefined {
  const tokens = stats.tokens;
  if (!tokens) return undefined;
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    ...(tokens.cacheRead > 0 ? { cacheReadTokens: tokens.cacheRead } : {}),
    ...(tokens.cacheWrite > 0 ? { cacheWriteTokens: tokens.cacheWrite } : {}),
  };
}

async function applyControls(
  request: HarnessExecutionRequest,
  session: PiSdkSession,
  stopped: () => boolean,
): Promise<boolean> {
  if (!request.controls) return false;
  const handled = new Set<number>();
  while (!stopped()) {
    const controls = await request.controls.read();
    for (const steering of controls.steering) {
      if (handled.has(steering.requestSequence)) continue;
      handled.add(steering.requestSequence);
      try {
        await session.steer(steering.message);
        await request.controls.steeringApplied(steering.requestSequence);
      } catch (cause) {
        await request.controls.steeringRejected(
          steering.requestSequence,
          cause instanceof Error ? cause.message : 'Pi SDK rejected steering',
        );
      }
    }
    if (controls.interruptRequested) {
      await session.abort();
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Runs agent requests through Pi's in-process AgentSession SDK. */
export class PiHarness implements AgentHarness {
  readonly id = 'pi';

  constructor(private readonly sdk: PiAgentSdk = defaultSdk) {}

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request);
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, token);
  }

  private async run(
    request: HarnessExecutionRequest,
    resumeToken?: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    const created = await fromAsync(
      () => this.sdk.create(request, resumeToken),
      (cause) =>
        processFailure(cause instanceof Error ? cause.message : 'Pi SDK session creation failed'),
    );
    if (created.isErr()) return created;
    const session = created.unwrap();
    const transcript: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      const line = JSON.stringify(event);
      transcript.push(line);
      if (request.onTranscriptChunk) {
        void request.onTranscriptChunk(`${line}\n`).catch(() => undefined);
      }
    });
    const token = session.sessionFile ?? session.sessionId;
    try {
      if (!resumeToken && request.onResumeToken) await request.onResumeToken(token);
      let stopped = false;
      const controls = applyControls(request, session, () => stopped);
      const prompted = await fromAsync(
        () => session.prompt(promptFor(request)),
        (cause) =>
          processFailure(cause instanceof Error ? cause.message : 'Pi SDK execution failed'),
      );
      stopped = true;
      const interrupted = await controls.catch(() => false);
      if (interrupted) return err(processFailure('Pi SDK session was interrupted'));
      if (prompted.isErr()) return prompted;
      const finalOutput = session.messages.map(assistantOutput).filter(Boolean).at(-1);
      if (!finalOutput) {
        return err(invalidResponse('Pi SDK returned no assistant text', transcript.join('\n')));
      }
      if (finalOutput.isErr()) return finalOutput;
      let usage: TokenUsage | undefined;
      try {
        usage = usageFromPiStats(session.getSessionStats());
      } catch {
        usage = undefined;
      }
      return ok({
        output: parseHarnessOutput(finalOutput.unwrap()),
        transcript: transcript.join('\n'),
        resumeToken: token,
        ...(usage ? { usage } : {}),
      });
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
}
