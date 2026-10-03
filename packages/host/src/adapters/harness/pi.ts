import { renderHarnessPrompt } from "./prompt";
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
  reasoningEffortsForHarness,
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
import { parseStructuredOutput } from "./structured-output.ts";
import { nativeToolPolicy, piExcludedTools } from "./tool-policy.ts";

const nativeConfigSchema: JsonValue = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    effort: { type: "string", enum: [...reasoningEffortsForHarness("pi")] },
    timeoutMs: { type: "integer", minimum: 1 },
    checksum: { type: "string" },
    toolPolicy: {
      type: "object",
      additionalProperties: false,
      properties: {
        write: { type: "boolean" },
        terminal: { type: "boolean" },
        network: { type: "boolean" },
        child: { type: "boolean" },
      },
    },
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
      tools: {
        state: "conditional",
        constraints: ["native tools follow workflow grants; child agents use read-only tools"],
      },
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
  const selectedModel = configuredModel || selection.model.id || env.KOURO_PI_MODEL?.trim();
  let provider = configuredProvider || selection.model.provider || env.KOURO_PI_PROVIDER?.trim();
  let model = selectedModel || undefined;
  if (
    !configuredProvider &&
    !selection.model.provider &&
    model &&
    !/^https?:\/\//i.test(model) &&
    (!provider || Boolean(configuredModel || selection.model.id))
  ) {
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
    const discoveryController = new AbortController();
    const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : undefined;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timeout = true;
            discoveryController.abort();
            void session?.abort();
          }, timeoutMs);
    const abort = () => {
      discoveryController.abort();
      void session?.abort();
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
      const resolved = resolvePiSelection(input.selection, config);
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
      const model = await resolvePiModel(
        services.modelRuntime,
        resolved,
        services.settingsManager,
        discoveryController.signal,
      );
      const scoutTool = input.context?.tools.find((item) => item.name === "subagent");
      const subagent = input.collaboration?.subagent;
      const customTools = scoutTool && subagent ? [createSubagentTool(scoutTool, subagent)] : [];
      const policy = nativeToolPolicy(config);
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(input.cwd),
        ...(model ? { model } : {}),
        ...(typeof (config.effort ?? config.thinking) === "string"
          ? {
              thinkingLevel: (config.effort ?? config.thinking) as
                | "minimal"
                | "low"
                | "medium"
                | "high"
                | "xhigh"
                | "max"
                | "off",
            }
          : {}),
        ...(policy.child
          ? { tools: ["read", "grep", "find", "ls"] }
          : { excludeTools: piExcludedTools(policy) }),
        customTools,
      });
      session = created.session;
      if (config.effort !== undefined && session.thinkingLevel !== config.effort)
        throw new Error(
          `Reasoning effort ${String(config.effort)} is unsupported by Pi model ${session.model?.id ?? "default"}; effective level would be ${session.thinkingLevel}`,
        );
      if (!policy.child)
        session.setActiveToolsByName(session.getAllTools().map((tool) => tool.name));
      this.activeSessions.set(input.attemptId, session);
      if (session.model)
        emit({
          type: "log",
          at: new Date().toISOString(),
          data: {
            status: "Model selected",
            provider: session.model.provider,
            modelId: session.model.id,
          },
        });
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
      const activity = new PiMessages(emit);
      const unsubscribe = session.subscribe((event) => activity.consume(event));
      const handoff = renderHarnessPrompt(input.role.prompt, input.context);
      const prompt = input.role.outputSchema
        ? `${handoff}\n\nReturn only JSON matching this schema:\n${JSON.stringify(input.role.outputSchema)}`
        : handoff;
      await session.prompt(prompt);
      unsubscribe();
      const lastMessage = [...session.messages]
        .reverse()
        .find((candidate) => candidate.role === "assistant");
      if (lastMessage) activity.consume({ type: "message_end", message: lastMessage });
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
          error:
            typeof lastMessage.errorMessage === "string" && lastMessage.errorMessage
              ? lastMessage.errorMessage
              : (message ?? "Pi SDK turn failed"),
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
          : timeout
            ? `pi timed out after ${timeoutMs}ms`
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

export async function resolvePiModel(
  runtime: Pick<
    ModelRuntime,
    "getProvider" | "getAuth" | "getModel" | "getAvailable" | "getModels"
  >,
  selection: PiResolvedSelection,
  settings: { getDefaultProvider(): string | undefined; getDefaultModel(): string | undefined },
  signal?: AbortSignal,
) {
  const provider = selection.provider ?? settings.getDefaultProvider();
  const requested = selection.model ?? settings.getDefaultModel();
  if (provider === "llama.cpp") {
    // SDK service construction restores caches but does not discover the live
    // router catalog. Refresh after the built-in provider is registered.
    const local = runtime.getProvider(provider);
    const auth = await runtime.getAuth(provider);
    if (!local?.refreshModels || !auth)
      throw new Error("Pi local model discovery failed: llama.cpp is not configured");
    const discoverySignal = AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]);
    try {
      // Refresh only this provider. ModelRuntime.refresh in SDK 0.82 also
      // contacts unrelated providers; their failures must not block a local run.
      await local.refreshModels({
        credential: { type: "api_key", key: auth.auth.apiKey, env: auth.env },
        store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
        allowNetwork: true,
        force: true,
        signal: discoverySignal,
      });
    } catch (cause) {
      if (signal?.aborted) throw new Error("Pi model discovery cancelled");
      if (discoverySignal.aborted) throw new Error("Pi local model discovery timed out");
      throw new Error(
        `Pi local model discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (signal?.aborted) throw new Error("Pi model discovery cancelled");
    if (discoverySignal.aborted) throw new Error("Pi local model discovery timed out");
  }
  if (!requested && !provider) return undefined;
  const available = provider ? runtime.getModels(provider) : await runtime.getAvailable();
  const model = requested
    ? provider
      ? runtime.getModel(provider, requested)
      : available.find(({ id }) => id === requested)
    : available[0];
  if (!model) {
    const choices = available
      .map((item) => `${item.provider}/${item.id}`)
      .slice(0, 10)
      .join(", ");
    throw new Error(
      `Pi model is unavailable: ${provider ? `${provider}/` : ""}${requested ?? "(none)"}.${choices ? ` Available models: ${choices}.` : " No models are available for this provider."}`,
    );
  }
  // The SDK's llama.cpp catalog disables streamed usage. Request the standard
  // usage chunk for this invocation without modifying the saved provider/catalog.
  return model.provider === "llama.cpp"
    ? { ...model, compat: { ...model.compat, supportsUsageInStreaming: true } }
    : model;
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

export class PiMessages {
  private sequence = 0;
  private messageId = "pi-0";
  private text = new Map<string, string>();
  constructor(private readonly emit: (event: HarnessEvent) => void) {}
  consume(value: unknown) {
    if (!isRecord(value)) return;
    if (
      value.type === "message_start" &&
      isRecord(value.message) &&
      value.message.role === "assistant"
    ) {
      this.messageId = `pi-${++this.sequence}`;
      return;
    }
    const update = value.assistantMessageEvent;
    if (value.type === "message_update" && isRecord(update)) {
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        const thinking = update.type === "thinking_delta";
        this.publish(
          `${this.messageId}:${String(update.contentIndex ?? 0)}:${thinking ? "thinking" : "text"}`,
          update.delta,
          false,
          thinking,
        );
      }
      return;
    }
    if (
      value.type === "message_end" &&
      isRecord(value.message) &&
      value.message.role === "assistant"
    ) {
      const message = value.message;
      if (Array.isArray(message.content))
        message.content.forEach((part, index) => {
          if (!isRecord(part)) return;
          if (part.type === "text" || part.type === "thinking") {
            const thinking = part.type === "thinking";
            this.publish(
              `${this.messageId}:${index}:${thinking ? "thinking" : "text"}`,
              thinking ? part.thinking : part.text,
              true,
              thinking,
            );
          }
        });
      if (message.stopReason === "error")
        this.emit({
          type: "log",
          at: new Date().toISOString(),
          data: {
            status: "Provider error",
            level: "error",
            detail: String(message.errorMessage ?? "Pi model request failed"),
          },
        });
      return;
    }
    emitPiEvent(value, this.emit);
  }
  private publish(id: string, value: unknown, snapshot: boolean, thinking: boolean) {
    if (typeof value !== "string" || !value) return;
    const previous = this.text.get(id) ?? "";
    const next = snapshot ? value : previous + value;
    if (snapshot && next === previous) return;
    this.text.set(id, next);
    this.emit({
      type: thinking ? "log" : "text",
      at: new Date().toISOString(),
      data: {
        id,
        text: value,
        ...(snapshot ? { mode: "snapshot" } : {}),
        ...(thinking ? { channel: "thinking", thinkingKind: "content", status: "Thinking" } : {}),
      },
    });
  }
}

export function emitPiEvent(event: unknown, emit: (event: HarnessEvent) => void): void {
  if (!isRecord(event) || typeof event.type !== "string") return;
  const at = new Date().toISOString();
  const update = event.assistantMessageEvent;
  if (event.type === "message_update" && isRecord(update) && update.type === "text_delta") {
    if (typeof update.delta === "string" && update.delta)
      emit({ type: "text", at, data: update.delta });
  } else if (
    event.type === "message_update" &&
    isRecord(update) &&
    update.type === "thinking_delta"
  ) {
    if (typeof update.delta !== "string" || !update.delta) return;
    emit({
      type: "log",
      at,
      data: {
        status: "Thinking",
        text: update.delta,
        channel: "thinking",
        thinkingKind: "content",
      },
    });
  } else if (event.type.includes("tool")) {
    const result = isRecord(event.result) ? event.result : undefined;
    const isError = event.isError === true || result?.isError === true || event.error !== undefined;
    const lifecycle = event.type.toLowerCase();
    emit({
      type: "tool",
      at,
      data: {
        id: String(
          event.toolCallId ??
            (isRecord(event.toolCall) ? event.toolCall.id : undefined) ??
            event.id ??
            `${event.type}:${at}`,
        ),
        name: String(event.toolName ?? event.name ?? "Tool"),
        status: lifecycle.endsWith("_start")
          ? "running"
          : lifecycle.endsWith("_end")
            ? isError
              ? "failed"
              : "completed"
            : lifecycle.includes("update")
              ? "running"
              : isError
                ? "failed"
                : "completed",
        ...(event.args !== undefined ? { input: event.args as JsonValue } : {}),
        ...(event.input !== undefined ? { input: event.input as JsonValue } : {}),
        ...(event.result !== undefined ? { output: event.result as JsonValue } : {}),
        ...(isError
          ? {
              error: String(
                event.error ?? result?.error ?? result?.content ?? "Tool execution failed",
              ),
            }
          : {}),
      } as unknown as JsonValue,
    });
  } else {
    // Message/tool-argument start, delta and end notifications are bookkeeping,
    // not thinking content. Only publish meaningful lifecycle observations.
    const statuses: Record<string, string> = {
      agent_start: "Working",
      compaction_start: "Compacting context",
      compaction_end: "Context compaction finished",
      auto_retry_start: "Retrying model request",
      auto_retry_end: "Model request retry finished",
    };
    const status = statuses[event.type];
    if (!status) return;
    const detail = event.errorMessage ?? event.finalError;
    emit({
      type: "log",
      at,
      data: {
        status,
        ...(typeof detail === "string" && detail ? { detail, level: "warn" } : {}),
        ...(typeof event.attempt === "number" ? { attempt: event.attempt } : {}),
      },
    });
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

export function piUsage(
  stats: ReturnType<
    NonNullable<
      Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"]["getSessionStats"]
    >
  >,
) {
  const tokens = stats.tokens;
  if (
    tokens.total <= 0 ||
    ![tokens.input, tokens.output, tokens.total].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    return unavailableUsage();
  return {
    inputTokens: { value: tokens.input, quality: "observed" as const, source: "pi" },
    outputTokens: { value: tokens.output, quality: "observed" as const, source: "pi" },
    totalTokens: { value: tokens.total, quality: "observed" as const, source: "pi" },
    cost:
      stats.cost > 0
        ? { value: stats.cost, quality: "estimated" as const, source: "pi-sdk-pricing" }
        : { value: null, quality: "unavailable" as const },
  };
}

function parseJsonOutput(value: string): JsonValue {
  return parseStructuredOutput(value);
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
        nativeConfig: {
          ...input.nativeConfig,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        },
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
