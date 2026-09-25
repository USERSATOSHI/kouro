import { Codex, type CodexOptions, type ThreadEvent } from "@openai/codex-sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
  readonly nativeConfig?: import("@kouro/core").JsonObject;
  readonly outputSchema?: JsonValue;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly collaboration?: CollaborationTools;
  readonly onEvent?: (event: HarnessEvent) => void;
}

/** Capability discovery checks that the bundled Codex runtime is available. */
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
    adapterVersion: "app-server",
    version: "OpenAI Codex TypeScript SDK",
    availability: available ? "available" : "unavailable",
    detail: available ? undefined : `Codex SDK runtime unavailable (${detail})`,
    capabilities: {
      "structured-output": supported,
      cancel: supported,
      steer: supported,
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
    let streamedReply = "";
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
        const at = new Date().toISOString();
        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          const item = event.item;
          const activity =
            item.type === "agent_message"
              ? event.type === "item.completed"
                ? {
                    type: "text",
                    at,
                    data: item.text.startsWith(streamedReply)
                      ? item.text.slice(streamedReply.length)
                      : item.text,
                  }
                : event.type === "item.updated" && item.text.startsWith(streamedReply)
                  ? { type: "text", at, data: item.text.slice(streamedReply.length) }
                  : { type: "log", at, data: { status: "Writing reply" } }
              : item.type === "reasoning"
                ? { type: "log", at, data: { status: "Thinking" } }
                : item.type === "command_execution"
                  ? {
                      type: "tool",
                      at,
                      data: {
                        id: item.id,
                        name: "Command",
                        status: item.status,
                        input: item.command,
                        ...(item.status === "in_progress"
                          ? {}
                          : { output: item.aggregated_output }),
                      },
                    }
                  : item.type === "mcp_tool_call"
                    ? {
                        type: "tool",
                        at,
                        data: {
                          id: item.id,
                          name: `${item.server}/${item.tool}`,
                          status: item.status,
                          input: item.arguments,
                          output: item.result,
                          error: item.error?.message,
                        },
                      }
                    : item.type === "web_search"
                      ? {
                          type: "tool",
                          at,
                          data: {
                            id: item.id,
                            name: "Web search",
                            status: "started",
                            input: item.query,
                          },
                        }
                      : {
                          type: "log",
                          at,
                          data: {
                            status: item.type === "file_change" ? "Editing files" : "Working",
                          },
                        };
          if (item.type === "agent_message" && event.type !== "item.completed")
            streamedReply = item.text;
          const normalized = JSON.parse(JSON.stringify(activity)) as HarnessEvent;
          events.push(normalized);
          input.onEvent?.(normalized);
        } else if (event.type === "turn.started") {
          const activity: HarnessEvent = { type: "log", at, data: { status: "Thinking" } };
          events.push(activity);
          input.onEvent?.(activity);
        }
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

/** Codex App Server supplies the streamed, bidirectional control channel used by v1. */
export class CodexAppServerHarness {
  readonly descriptor: HarnessDescriptor;
  private active = new Map<
    string,
    { transport: CodexAppServerTransport; threadId: string; turnId: string }
  >();
  constructor(descriptor: HarnessDescriptor) {
    this.descriptor = descriptor;
  }
  async steer(invocationId: string, message: string): Promise<void> {
    const active = this.active.get(invocationId);
    if (!active) throw new Error("steer-unavailable: Codex turn is not active");
    const result = await active.transport.request("turn/steer", {
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      input: [{ type: "text", text: message }],
    });
    if (!result.ok) throw new Error(`Codex rejected steering message: ${result.error}`);
  }
  async run(input: CodexRunInput): Promise<HarnessResult> {
    const transport = new CodexAppServerTransport(input.cwd);
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent) => {
      events.push(event);
      input.onEvent?.(event);
    };
    try {
      const initialized = await transport.request("initialize", {
        clientInfo: { name: "kouro", title: "Kouro", version: "2" },
        capabilities: null,
      });
      if (!initialized.ok) throw new Error(initialized.error);
      transport.notify("initialized", {});
      const scout = input.context?.tools.find((item) => item.name === "subagent");
      const dynamicTools =
        scout && input.collaboration?.subagent
          ? [
              {
                type: "function",
                name: "subagent",
                description: scout.description,
                inputSchema: scout.inputSchema,
              },
            ]
          : undefined;
      const threadResult = await transport.request("thread/start", {
        cwd: input.cwd,
        ...(input.selection.model.id && input.selection.model.id !== "default"
          ? { model: input.selection.model.id }
          : {}),
        approvalPolicy: "on-request",
        ...(dynamicTools ? { dynamicTools } : {}),
      });
      if (!threadResult.ok) throw new Error(threadResult.error);
      const threadId =
        stringAt(threadResult.value, "thread", "id") ?? stringAt(threadResult.value, "id");
      if (!threadId) throw new Error("Codex App Server returned no thread ID");
      const policy =
        input.nativeConfig?.sandbox === "workspace-write"
          ? {
              type: "workspaceWrite",
              writableRoots: [input.cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            }
          : { type: "readOnly", networkAccess: false };
      const prompt = input.context
        ? `${input.role.prompt}\n\n[KOURO_CONTEXT_BEGIN]\n${JSON.stringify(input.context)}\n[KOURO_CONTEXT_END]`
        : input.role.prompt;
      let streamed = "";
      let completed:
        | ((result: { ok: boolean; value?: unknown; error?: string }) => void)
        | undefined;
      const done = new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
        completed = resolve;
      });
      const unsubscribe = transport.subscribe((message) => {
        const params = asObject(message.params);
        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
          streamed += params.delta;
          emit({ type: "text", at: new Date().toISOString(), data: params.delta });
        } else if (
          message.id !== undefined &&
          message.method === "item/commandExecution/requestApproval"
        ) {
          transport.respond(message.id, {
            decision: input.nativeConfig?.sandbox === "workspace-write" ? "accept" : "decline",
          });
        } else if (
          message.id !== undefined &&
          message.method === "item/fileChange/requestApproval"
        ) {
          transport.respond(message.id, {
            decision: input.nativeConfig?.sandbox === "workspace-write" ? "accept" : "decline",
          });
        } else if (message.method === "item/started" || message.method === "item/completed") {
          const item = asObject(params.item);
          if (item.type === "reasoning")
            emit({ type: "log", at: new Date().toISOString(), data: { status: "Thinking" } });
          else if (item.type === "agentMessage") {
            if (message.method === "item/started")
              emit({
                type: "log",
                at: new Date().toISOString(),
                data: { status: "Writing reply" },
              });
          } else if (typeof item.type === "string")
            emit({
              type: "tool",
              at: new Date().toISOString(),
              data: JSON.parse(
                JSON.stringify({
                  id: item.id,
                  name: item.type,
                  status: message.method === "item/started" ? "started" : "completed",
                  ...(item.command ? { input: item.command } : {}),
                  ...(item.query ? { input: item.query } : {}),
                }),
              ),
            });
        } else if (
          message.id !== undefined &&
          message.method === "item/tool/call" &&
          params.tool === "subagent" &&
          scout &&
          input.collaboration?.subagent
        ) {
          void input.collaboration
            .subagent({
              requestId: String(params.id ?? message.id),
              subagentId: String(asObject(params.arguments).subagentId ?? ""),
              input: asObject(asObject(params.arguments).input),
            })
            .then(
              (result) =>
                transport.respond(message.id!, {
                  contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
                  success: result.state === "succeeded",
                }),
              (cause) =>
                transport.respond(message.id!, {
                  contentItems: [{ type: "inputText", text: String(cause) }],
                  success: false,
                }),
            );
        } else if (message.id !== undefined && message.method === "item/tool/call") {
          transport.respond(message.id, {
            contentItems: [
              { type: "inputText", text: "Tool is not authorized for this invocation." },
            ],
            success: false,
          });
        } else if (
          message.id !== undefined &&
          message.method === "item/permissions/requestApproval"
        ) {
          transport.respond(message.id, { permissions: {}, scope: "turn" });
        } else if (message.id !== undefined && message.method === "item/tool/requestUserInput") {
          transport.respond(message.id, { answers: {} });
        } else if (message.method === "turn/completed") {
          const turn = asObject(params.turn);
          if (turn.status === "failed" || turn.status === "interrupted")
            completed?.({
              ok: false,
              error:
                turn.status === "interrupted"
                  ? "Codex turn was interrupted"
                  : String(asObject(turn.error).message ?? "Codex turn failed"),
            });
          else completed?.({ ok: true, value: turn });
        } else if (message.method === "turn/failed")
          completed?.({
            ok: false,
            error: String(asObject(params.error).message ?? "Codex turn failed"),
          });
      });
      const started = await transport.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: input.cwd,
        approvalPolicy: "on-request",
        sandboxPolicy: policy,
        ...(input.selection.model.id && input.selection.model.id !== "default"
          ? { model: input.selection.model.id }
          : {}),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      });
      if (!started.ok) throw new Error(started.error);
      const turnId = stringAt(started.value, "turn", "id") ?? stringAt(started.value, "id");
      if (!turnId) throw new Error("Codex App Server returned no turn ID");
      this.active.set(input.attemptId, { transport, threadId, turnId });
      const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        void transport.request("turn/interrupt", { threadId, turnId });
      };
      input.signal?.addEventListener("abort", cancel, { once: true });
      const timed =
        timeoutMs === undefined
          ? undefined
          : new Promise<{ ok: false; error: string }>((resolve) => {
              timeout = setTimeout(() => {
                cancel();
                resolve({ ok: false, error: `Codex timed out after ${timeoutMs}ms` });
              }, timeoutMs);
            });
      const result = await (timed ? Promise.race([done, timed]) : done);
      if (timeout) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", cancel);
      unsubscribe();
      if (!result.ok)
        return {
          status: input.signal?.aborted ? "cancelled" : "failed",
          error: result.error,
          usage: unavailableUsage(),
          events,
        };
      const turn = asObject(result.value);
      const final = finalCodexText(turn) ?? streamed;
      if (!final)
        return {
          status: "failed",
          error: "Codex turn has no final agent message",
          usage: unavailableUsage(),
          events,
        };
      let output: JsonValue = final;
      try {
        output = JSON.parse(final) as JsonValue;
      } catch {
        /* preserve plain text */
      }
      if (input.outputSchema) {
        const validation = validateJsonSchema(output, input.outputSchema);
        if (!validation.valid)
          return {
            status: "failed",
            error: `invalid-output: ${validation.error}`,
            rawOutput: final,
            usage: unavailableUsage(),
            events,
          };
      }
      const tokens = asObject(turn.tokens);
      const usage = (
        typeof tokens.input === "number" && typeof tokens.output === "number"
          ? {
              inputTokens: { value: tokens.input, quality: "observed", source: "codex" },
              outputTokens: { value: tokens.output, quality: "observed", source: "codex" },
              totalTokens: {
                value: tokens.input + tokens.output,
                quality: "observed",
                source: "codex",
              },
              cost: { value: null, quality: "unavailable" },
            }
          : unavailableUsage()
      ) as HarnessResult["usage"];
      if (!streamed) emit({ type: "text", at: new Date().toISOString(), data: final });
      else if (final.startsWith(streamed) && final.length > streamed.length)
        emit({ type: "text", at: new Date().toISOString(), data: final.slice(streamed.length) });
      return { status: "succeeded", output, rawOutput: final, usage, events };
    } catch (cause) {
      return {
        status: input.signal?.aborted ? "cancelled" : "failed",
        error: input.signal?.aborted
          ? "cancelled"
          : cause instanceof Error
            ? cause.message
            : String(cause),
        usage: unavailableUsage(),
        events,
      };
    } finally {
      this.active.delete(input.attemptId);
      await transport.dispose();
    }
  }
}

type RpcResponse = { ok: true; value: unknown } | { ok: false; error: string };
class CodexAppServerTransport {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, (result: RpcResponse) => void>();
  private listeners = new Set<
    (message: { id?: number; method?: string; params?: unknown }) => void
  >();
  private sequence = 0;
  private lines;
  constructor(cwd: string) {
    const entry = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
    this.child = spawn(process.execPath, [entry, "app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (message.id !== undefined && !message.method) {
          const resolve = this.pending.get(message.id);
          if (resolve) {
            this.pending.delete(message.id);
            resolve(
              message.error
                ? { ok: false, error: JSON.stringify(message.error) }
                : { ok: true, value: message.result },
            );
          }
        } else for (const listener of this.listeners) listener(message);
      } catch {
        /* malformed protocol output is ignored; pending RPC will fail on process exit */
      }
    });
    this.child.once("exit", (code) => {
      for (const resolve of this.pending.values())
        resolve({ ok: false, error: `Codex App Server exited (${code ?? "unknown"})` });
      this.pending.clear();
    });
  }
  request(method: string, params: unknown): Promise<RpcResponse> {
    const id = ++this.sequence;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method: string, params: unknown) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }
  respond(id: number, result: unknown) {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }
  subscribe(listener: (message: { id?: number; method?: string; params?: unknown }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async dispose() {
    this.lines.close();
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    }
  }
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringAt(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) current = asObject(current)[key];
  return typeof current === "string" ? current : undefined;
}
function finalCodexText(turn: Record<string, unknown>): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return items
    .filter(
      (item) => asObject(item).type === "agentMessage" || asObject(item).type === "agent_message",
    )
    .map((item) => asObject(item).text)
    .filter((text): text is string => typeof text === "string")
    .at(-1);
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
  readonly adapterVersion = "app-server";
  constructor(private readonly harness: CodexSdkHarness | CodexAppServerHarness) {}
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
      nativeConfig: input.nativeConfig,
      outputSchema: input.outputSchema,
      selection: {
        harness: this.id,
        model: { id: input.modelId ?? "default" },
        ...(input.nativeConfig ? { nativeConfig: input.nativeConfig } : {}),
      },
      cwd: input.cwd ?? ".",
      context: input.context,
      collaboration: input.collaboration,
      onEvent: input.onEvent,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    return {
      ...result,
      events: result.events.map((event) => JSON.parse(JSON.stringify(event))),
      usage: JSON.parse(JSON.stringify(result.usage)),
    } as Awaited<ReturnType<HarnessAdapter["run"]>>;
  }
  steer(input: { invocationId: string; message: string }): Promise<void> {
    if (!(this.harness instanceof CodexAppServerHarness))
      return Promise.reject(
        new Error("steer-unavailable: Codex SDK does not expose turn steering"),
      );
    return this.harness.steer(input.invocationId, input.message);
  }
}
