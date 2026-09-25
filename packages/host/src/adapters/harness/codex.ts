import { Codex, type CodexOptions, type ThreadEvent } from "@openai/codex-sdk";
import type { JsonValue } from "@kouro/core";
import {
  unavailableUsage,
  validateJsonSchema,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessResult,
  type HarnessSelection,
  type HarnessPort,
  type RoleSpec,
  type StartTurnRequest,
  type TurnHandle,
} from "@kouro/core";
import type { CollaborationTools, HarnessAdapter } from "../../types.ts";
import { startScoutBridge } from "./scout-bridge.ts";

export interface CodexRunInput {
  readonly attemptId: string;
  readonly role: RoleSpec;
  readonly selection: HarnessSelection;
  readonly cwd: string;
  readonly context?: StartTurnRequest["context"];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly collaboration?: CollaborationTools;
}

/** Capability discovery checks that the installed SDK can resolve its bundled runtime. */
export async function inspectCodex(): Promise<HarnessDescriptor> {
  let detail: string | undefined;
  try {
    new Codex();
  } catch (cause) {
    detail = cause instanceof Error ? cause.message : String(cause);
  }
  const available = detail === undefined;
  const supported = { state: available ? ("supported" as const) : ("unsupported" as const) };
  return {
    id: "codex",
    adapterVersion: "sdk",
    version: "OpenAI Codex TypeScript SDK",
    availability: available ? "available" : "unavailable",
    detail: available ? undefined : `Codex SDK runtime unavailable (${detail})`,
    capabilities: {
      "structured-output": supported,
      cancel: supported,
      resume: { state: "unsupported" },
      reattach: { state: "unsupported" },
      tools: {
        state: "conditional",
        constraints: ["only tools explicitly enabled by native profile"],
      },
      usage: { state: supported.state },
      "cost-cap": {
        state: "unsupported",
        constraints: ["provider cost is not enforceable locally"],
      },
      "awaited-subagent-tool": supported,
      "child-read-only-envelope": supported,
    },
    nativeConfigSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        model: { type: "string" },
        sandbox: { type: "string" },
        profile: { type: "string" },
      },
    },
  };
}

/** SDK adapter for Codex turns. The official SDK owns process invocation and JSONL parsing. */
export class CodexSdkHarness implements HarnessPort {
  readonly descriptor: HarnessDescriptor;
  constructor(descriptor: HarnessDescriptor) {
    this.descriptor = descriptor;
  }

  async startTurn(request: StartTurnRequest): Promise<TurnHandle> {
    const controller = new AbortController();
    const result = this.run({
      attemptId: request.attemptId,
      role: request.role,
      selection: request.selection,
      cwd: request.cwd ?? ".",
      context: request.context,
      signal: controller.signal,
    });
    return {
      observations: (async function* () {
        for (const event of (await result).events) yield event;
      })(),
      cancel: async (reason) => {
        void reason;
        controller.abort();
        await result;
      },
      close: async () => {
        await result;
      },
    };
  }

  async run(input: CodexRunInput): Promise<HarnessResult> {
    if (this.descriptor.availability !== "available") {
      return {
        status: "unavailable",
        error: this.descriptor.detail,
        usage: unavailableUsage(),
        events: [],
      };
    }

    const config = input.selection.nativeConfig ?? {};
    const scoutTool = input.context?.tools.find((item) => item.name === "subagent");
    const bridge =
      scoutTool && input.collaboration?.subagent
        ? await startScoutBridge(input.collaboration.subagent)
        : undefined;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
    };
    if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
    if (bridge && scoutTool) {
      env.KOURO_SCOUT_ENDPOINT = bridge.endpoint;
      env.KOURO_SCOUT_TOKEN = bridge.token;
      env.KOURO_SCOUT_SCHEMA = JSON.stringify(scoutTool.inputSchema);
    }

    const codexConfig: NonNullable<CodexOptions["config"]> = {};
    if (bridge) {
      const sourceEntrypoint = new URL("../../cli.ts", import.meta.url);
      const entrypoint = (await Bun.file(sourceEntrypoint).exists())
        ? sourceEntrypoint.pathname
        : new URL("kouro.js", import.meta.url).pathname;
      codexConfig.mcp_servers = {
        kouro_scout: {
          command: process.execPath,
          args: [entrypoint, "__scout_mcp"],
          env_vars: ["KOURO_SCOUT_ENDPOINT", "KOURO_SCOUT_TOKEN", "KOURO_SCOUT_SCHEMA"],
        },
      };
    }
    const sdkOptions: CodexOptions = {
      env,
      ...(Object.keys(codexConfig).length > 0 ? { config: codexConfig } : {}),
    };
    let thread: ReturnType<Codex["startThread"]>;
    try {
      thread = new Codex(sdkOptions).startThread({
        ...(typeof config.model === "string" ? { model: config.model } : {}),
        workingDirectory: input.cwd,
        skipGitRepoCheck: true,
        sandboxMode: config.sandbox === "workspace-write" ? "workspace-write" : "read-only",
      });
    } catch (cause) {
      await bridge?.close();
      return {
        status: "unavailable",
        error: cause instanceof Error ? cause.message : String(cause),
        usage: unavailableUsage(),
        events: [],
      };
    }
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : undefined;
    const abortController = new AbortController();
    const abort = () => abortController.abort(input.signal?.reason);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => abortController.abort(new Error(`Codex SDK timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
    const prompt = input.context
      ? `${input.role.prompt}\n\n[KOURO_CONTEXT_BEGIN]\n${JSON.stringify(input.context)}\n[KOURO_CONTEXT_END]`
      : input.role.prompt;
    const events: HarnessEvent[] = [];
    const raw: string[] = [];
    let response: string | undefined;
    let usageRecord:
      | { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
      | undefined;
    let streamError: string | undefined;
    let bridgeClosed = false;
    const closeBridge = async () => {
      if (!bridgeClosed) {
        bridgeClosed = true;
        await bridge?.close();
      }
    };
    try {
      const { events: stream } = await thread.runStreamed(prompt, {
        ...(input.role.outputSchema ? { outputSchema: input.role.outputSchema } : {}),
        signal: abortController.signal,
      });
      for await (const event of stream) {
        raw.push(JSON.stringify(event));
        events.push({ type: "log", at: new Date().toISOString(), data: JSON.stringify(event) });
        consumeCodexEvent(
          event,
          (text) => (response = text),
          (usage) => (usageRecord = usage),
        );
        if (event.type === "turn.failed" || event.type === "error") {
          streamError = event.type === "turn.failed" ? event.error.message : event.message;
        }
      }
    } catch (cause) {
      streamError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      await closeBridge();
    }

    const rawOutput = raw.join("\n");
    const timedOut =
      timeoutMs !== undefined && abortController.signal.aborted && !input.signal?.aborted;
    if (input.signal?.aborted || timedOut) {
      const message = timedOut ? `Codex timed out after ${timeoutMs}ms` : "cancelled";
      return {
        status: input.signal?.aborted ? "cancelled" : "failed",
        error: message,
        rawOutput,
        usage: codexUsage(usageRecord),
        events: [...events, { type: "log", at: new Date().toISOString(), data: message }],
      };
    }
    if (streamError) {
      return {
        status: "failed",
        error: streamError,
        rawOutput,
        usage: codexUsage(usageRecord),
        events,
      };
    }

    let parsed: JsonValue | undefined = response;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed) as JsonValue;
      } catch {
        /* preserve the raw assistant response for consumers of unstructured turns */
      }
    }
    if (input.role.outputSchema) {
      const check = validateJsonSchema(parsed, input.role.outputSchema);
      if (!check.valid) {
        return {
          status: "failed",
          rawOutput,
          error: `invalid-output: ${check.error}`,
          usage: codexUsage(usageRecord),
          events,
        };
      }
    }
    return {
      status: "succeeded",
      output: parsed,
      rawOutput,
      usage: codexUsage(usageRecord),
      events,
    };
  }
}

function consumeCodexEvent(
  event: ThreadEvent,
  onResponse: (text: string) => void,
  onUsage: (usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  }) => void,
): void {
  if (event.type === "item.completed" && event.item.type === "agent_message") {
    onResponse(event.item.text);
  } else if (event.type === "turn.completed") {
    onUsage(event.usage);
  }
}

function codexUsage(
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens?: number } | undefined,
) {
  if (!usage) return unavailableUsage();
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens = inputTokens + outputTokens;
  return {
    inputTokens: { value: inputTokens, quality: "observed" as const, source: "codex" },
    outputTokens: { value: outputTokens, quality: "observed" as const, source: "codex" },
    totalTokens: { value: totalTokens, quality: "observed" as const, source: "codex" },
    cost: { value: null, quality: "unavailable" as const },
  };
}

/** Adapter for the host's small legacy boundary; the portable contract remains core-owned. */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly adapterVersion = "sdk";
  constructor(private readonly harness: CodexSdkHarness) {}
  capabilities(): Record<string, "supported" | "unsupported" | "conditional"> {
    return Object.fromEntries(
      Object.entries(this.harness.descriptor.capabilities).map(([name, value]) => [
        name,
        value.state,
      ]),
    );
  }
  async run(
    input: Parameters<HarnessAdapter["run"]>[0],
  ): Promise<Awaited<ReturnType<HarnessAdapter["run"]>>> {
    const result = await this.harness.run({
      attemptId: input.invocationId,
      role: {
        id: input.role,
        prompt: input.prompt,
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      },
      selection: {
        harness: this.id,
        model: { id: input.modelId ?? "default" },
        ...(input.nativeConfig ? { nativeConfig: input.nativeConfig } : {}),
      },
      cwd: input.cwd ?? ".",
      context: input.context,
      collaboration: input.collaboration,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    return {
      ...result,
      events: result.events.map((event) => JSON.parse(JSON.stringify(event))),
      usage: JSON.parse(JSON.stringify(result.usage)),
    } as Awaited<ReturnType<HarnessAdapter["run"]>>;
  }
}
