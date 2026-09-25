import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  VERSION as PI_SDK_VERSION,
} from "@earendil-works/pi-coding-agent";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  canonicalize,
  redactSecrets,
  unavailableUsage,
  validateJsonSchema,
  type JsonObject,
  type JsonValue,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessResult,
  type HarnessSelection,
  type RoleSpec,
  type StartTurnRequest,
  type TurnHandle,
} from "@kouro/core";
import type { CollaborationTools, HarnessAdapter } from "../../types.ts";

const nativeConfigSchema: JsonValue = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    timeoutMs: { type: "integer", minimum: 1 },
    checksum: { type: "string" },
  },
};

export async function inspectPi(): Promise<HarnessDescriptor> {
  return {
    id: "pi",
    adapterVersion: "sdk",
    version: PI_SDK_VERSION,
    availability: "available",
    capabilities: {
      "structured-output": { state: "supported" },
      cancel: { state: "supported" },
      resume: { state: "unsupported", constraints: ["each Kouro invocation is ephemeral"] },
      reattach: { state: "unsupported" },
      tools: { state: "conditional", constraints: ["read-only built-in tools only"] },
      usage: { state: "supported" },
      "cost-cap": {
        state: "unsupported",
        constraints: ["provider cost is not enforceable locally"],
      },
      "awaited-subagent-tool": { state: "supported" },
      "child-read-only-envelope": { state: "supported" },
    },
    nativeConfigSchema,
  };
}

export interface PiRunInput {
  readonly attemptId: string;
  readonly role: RoleSpec;
  readonly selection: HarnessSelection;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly context?: StartTurnRequest["context"];
  readonly onEvent?: (event: HarnessEvent) => void;
  readonly collaboration?: CollaborationTools;
}

export function piNativeConfig(config: JsonObject = {}): JsonObject & { checksum: string } {
  const safe = redactSecrets(config, [
    "apiKey",
    "api_key",
    "token",
    "password",
    "secret",
  ]) as JsonObject;
  return { ...safe, checksum: `sha256:${simpleHash(canonicalize(safe))}` };
}

export interface PiResolvedSelection {
  readonly provider?: string;
  readonly model?: string;
}

export function resolvePiSelection(
  selection: HarnessSelection,
  config: JsonObject = {},
  env: Record<string, string | undefined> = Bun.env,
): PiResolvedSelection {
  const configuredProvider =
    typeof config.provider === "string" && config.provider.trim() ? config.provider : undefined;
  const configuredModel =
    typeof config.model === "string" && config.model.trim() ? config.model : undefined;
  const selectedModel = configuredModel || env.KOURO_PI_MODEL?.trim() || selection.model.id;
  let provider = configuredProvider || env.KOURO_PI_PROVIDER?.trim() || selection.model.provider;
  let model = selectedModel || undefined;
  if (!provider && model && !/^https?:\/\//i.test(model)) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      provider = model.slice(0, slash);
      model = model.slice(slash + 1);
    }
  }
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

export class PiSdkHarness {
  readonly descriptor: HarnessDescriptor;
  private activeSessions = new Map<
    string,
    Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"]
  >();
  constructor(descriptor: HarnessDescriptor) {
    this.descriptor = descriptor;
  }

  async steer(attemptId: string, message: string): Promise<void> {
    const session = this.activeSessions.get(attemptId);
    if (!session) throw new Error("steer-unavailable: Pi session is not active");
    await session.steer(message);
  }

  async startTurn(request: StartTurnRequest): Promise<TurnHandle> {
    const controller = new AbortController();
    const queue: HarnessEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const result = this.run({
      attemptId: request.attemptId,
      role: request.role,
      selection: request.selection,
      cwd: request.cwd ?? ".",
      signal: controller.signal,
      context: request.context,
      onEvent: (event) => {
        queue.push(event);
        wake?.();
        wake = undefined;
      },
    });
    void result.then(() => {
      done = true;
      wake?.();
      wake = undefined;
    });
    return {
      observations: (async function* () {
        while (!done || queue.length) {
          if (!queue.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          while (queue.length) yield queue.shift()!;
        }
      })(),
      cancel: async () => {
        controller.abort();
        await result;
      },
      close: async () => {
        await result;
      },
    };
  }

  async run(input: PiRunInput): Promise<HarnessResult> {
    if (this.descriptor.availability !== "available") {
      return {
        status: "unavailable",
        error: this.descriptor.detail,
        usage: unavailableUsage(),
        events: [],
      };
    }
    const supplied = input.selection.nativeConfig ?? {};
    const config = piNativeConfig(supplied);
    const validation = validateJsonSchema(config, nativeConfigSchema);
    if (!validation.valid) {
      return {
        status: "failed",
        error: `invalid-native-config: ${validation.error}`,
        usage: unavailableUsage(),
        events: [],
      };
    }

    let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent) => {
      events.push(event);
      input.onEvent?.(event);
    };
    let timeout = false;
    const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : undefined;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timeout = true;
            void session?.abort();
          }, timeoutMs);
    const abort = () => void session?.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const resolved = resolvePiSelection(input.selection, config);
      const requestedModel =
        resolved.provider && resolved.model
          ? `${resolved.provider}/${resolved.model}`
          : resolved.model;
      const agentDir = getAgentDir();
      const services = await createAgentSessionServices({
        cwd: input.cwd,
        agentDir,
        modelRuntime: await ModelRuntime.create(),
        resourceLoaderOptions: {
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: await loadPiBuiltInExtensions(),
        },
      });
      const model = requestedModel
        ? await modelFor(services.modelRuntime, requestedModel)
        : undefined;
      if (requestedModel && !model) throw new Error(`Pi model is unavailable: ${requestedModel}`);
      const scoutTool = input.context?.tools.find((item) => item.name === "subagent");
      const subagent = input.collaboration?.subagent;
      const customTools = scoutTool && subagent ? [createSubagentTool(scoutTool, subagent)] : [];
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(input.cwd),
        ...(model ? { model } : {}),
        ...(typeof config.thinking === "string" ? { thinkingLevel: config.thinking as never } : {}),
        tools: ["read", "grep", "find", "ls"],
        customTools,
      });
      session = created.session;
      this.activeSessions.set(input.attemptId, session);
      if (input.signal?.aborted || timeout) await session.abort();
      if (input.signal?.aborted)
        return {
          status: "cancelled",
          error: "cancelled",
          usage: piUsage(session.getSessionStats()),
          events,
        };
      if (timeout)
        return {
          status: "failed",
          error: `pi timed out after ${timeoutMs}ms`,
          usage: piUsage(session.getSessionStats()),
          events,
        };
      const unsubscribe = session.subscribe((event) => emitPiEvent(event, emit));
      const handoff = input.context
        ? `${input.role.prompt}\n\n[KOURO_CONTEXT_BEGIN]\n${JSON.stringify(input.context)}\n[KOURO_CONTEXT_END]`
        : input.role.prompt;
      const prompt = input.role.outputSchema
        ? `${handoff}\n\nReturn only JSON matching this schema:\n${JSON.stringify(input.role.outputSchema)}`
        : handoff;
      await session.prompt(prompt);
      unsubscribe();
      const lastMessage = [...session.messages]
        .reverse()
        .find((candidate) => candidate.role === "assistant");
      const message = lastMessage
        ? assistantText(lastMessage as unknown as Record<string, unknown>)
        : undefined;
      let output: JsonValue | undefined = message;
      if (typeof output === "string") output = parseJsonOutput(output);
      const usage = piUsage(session.getSessionStats());
      if (input.signal?.aborted) return { status: "cancelled", error: "cancelled", usage, events };
      if (timeout)
        return { status: "failed", error: `pi timed out after ${timeoutMs}ms`, usage, events };
      if (lastMessage && (lastMessage as unknown as Record<string, unknown>).stopReason === "error")
        return {
          status: "failed",
          error: message ?? "Pi SDK turn failed",
          rawOutput: message,
          usage,
          events,
        };
      if (input.role.outputSchema) {
        const check = validateJsonSchema(output, input.role.outputSchema);
        if (!check.valid)
          return {
            status: "failed",
            error: `invalid-output: ${check.error}`,
            rawOutput: message,
            usage,
            events,
          };
      }
      return { status: "succeeded", output, rawOutput: message, usage, events };
    } catch (cause) {
      return {
        status: input.signal?.aborted ? "cancelled" : "failed",
        error: input.signal?.aborted
          ? "cancelled"
          : cause instanceof Error
            ? cause.message
            : String(cause),
        usage: session ? piUsage(session.getSessionStats()) : unavailableUsage(),
        events,
      };
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      session?.dispose();
      this.activeSessions.delete(input.attemptId);
    }
  }
}

async function modelFor(runtime: ModelRuntime, requested?: string) {
  if (!requested) return undefined;
  const separator = requested.indexOf("/");
  if (separator >= 1)
    return runtime.getModel(requested.slice(0, separator), requested.slice(separator + 1));
  return (await runtime.getAvailable()).find(({ id }) => id === requested);
}

async function loadPiBuiltInExtensions(): Promise<InlineExtension[]> {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const loaded: unknown = await import(resolve(dirname(entry), "extensions/index.js"));
  if (!isRecord(loaded) || !Array.isArray(loaded.builtInExtensions))
    throw new Error("Pi built-in extensions are unavailable in the installed SDK");
  return loaded.builtInExtensions.filter(isInlineExtension);
}

function createSubagentTool(
  manifestTool: NonNullable<StartTurnRequest["context"]>["tools"][number],
  invoke: NonNullable<CollaborationTools["subagent"]>,
) {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description: `${manifestTool.description} Input schema: ${JSON.stringify(manifestTool.inputSchema)}`,
    promptSnippet: "Delegate a bounded task to a declared Kouro scout.",
    executionMode: "parallel",
    parameters: Type.Object({
      requestId: Type.String({ minLength: 1 }),
      subagentId: Type.String({ minLength: 1 }),
      input: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_id, args, signal) {
      if (signal?.aborted) throw new Error("Subagent request cancelled");
      const check = validateJsonSchema(args, manifestTool.inputSchema);
      if (!check.valid) throw new Error(`Invalid subagent request: ${check.error}`);
      const result = await invoke(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: undefined,
      };
    },
  });
}

function emitPiEvent(event: unknown, emit: (event: HarnessEvent) => void): void {
  if (!isRecord(event) || typeof event.type !== "string") return;
  const at = new Date().toISOString();
  const update = event.assistantMessageEvent;
  if (event.type === "message_update" && isRecord(update) && update.type === "text_delta") {
    if (typeof update.delta === "string") emit({ type: "text", at, data: update.delta });
  } else if (
    event.type === "message_update" &&
    isRecord(update) &&
    update.type === "thinking_delta"
  ) {
    emit({ type: "log", at, data: { status: "Thinking" } });
  } else if (event.type.includes("tool")) {
    const safe = Object.fromEntries(
      Object.entries(event).filter(([key]) => !/thinking|reasoning/i.test(key)),
    );
    emit({ type: "tool", at, data: safe as JsonValue });
  } else {
    emit({ type: "log", at, data: { status: "Thinking" } });
  }
}

function assistantText(message: Record<string, unknown>): string | undefined {
  if (typeof message.text === "string") return message.text;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
  return text || undefined;
}

function piUsage(
  stats: ReturnType<
    NonNullable<
      Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"]["getSessionStats"]
    >
  >,
) {
  const tokens = stats.tokens;
  return {
    inputTokens: { value: tokens.input, quality: "observed" as const, source: "pi" },
    outputTokens: { value: tokens.output, quality: "observed" as const, source: "pi" },
    totalTokens: { value: tokens.total, quality: "observed" as const, source: "pi" },
    cost: { value: stats.cost, quality: "observed" as const },
  };
}

function parseJsonOutput(value: string): JsonValue {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  try {
    return JSON.parse(fenced ?? trimmed) as JsonValue;
  } catch {
    return value;
  }
}

function simpleHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInlineExtension(value: unknown): value is InlineExtension {
  return (
    typeof value === "function" ||
    (isRecord(value) && typeof value.name === "string" && typeof value.factory === "function")
  );
}

export class PiHarnessAdapter implements HarnessAdapter {
  readonly id = "pi";
  readonly adapterVersion = "sdk";
  constructor(private readonly harness: PiSdkHarness) {}
  capabilities() {
    return Object.fromEntries(
      Object.entries(this.harness.descriptor.capabilities).map(([key, value]) => [
        key,
        value.state,
      ]),
    );
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    const result = await this.harness.run({
      attemptId: input.invocationId,
      role: { id: input.role, prompt: input.prompt, outputSchema: input.outputSchema },
      selection: {
        harness: this.id,
        model: { id: input.modelId ?? "" },
        nativeConfig: input.nativeConfig,
      },
      cwd: input.cwd ?? ".",
      signal: input.signal,
      context: input.context,
      collaboration: input.collaboration,
      onEvent: input.onEvent,
    });
    return {
      ...result,
      usage: result.usage as unknown as JsonValue,
      events: result.events as unknown as JsonValue[],
    };
  }
  steer(input: { invocationId: string; message: string }) {
    return this.harness.steer(input.invocationId, input.message);
  }
}
