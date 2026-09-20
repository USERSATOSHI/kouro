import type { JsonObject, JsonValue } from "@kouro/core";
import {
  canonicalize,
  redactSecrets,
  unavailableUsage,
  validateJsonSchema,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessResult,
  type HarnessSelection,
  type RoleSpec,
  type StartTurnRequest,
  type TurnHandle,
} from "@kouro/core";
import type { HarnessAdapter } from "../../types.ts";
import { createHash } from "node:crypto";

export interface PiRpcProcess {
  stdin: { write(data: string): unknown; end?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill?(signal?: number | string): void;
}

export type PiRpcSpawn = (args: string[], options: Record<string, unknown>) => PiRpcProcess;

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

function piCommand(): string {
  return Bun.env.KOURO_PI_BIN?.trim() || "pi";
}

/** Read-only capability discovery from the installed Pi binary and its native help. */
export async function inspectPi(spawn: PiRpcSpawn = defaultSpawn): Promise<HarnessDescriptor> {
  const version = await capturePi(spawn, ["--version"]);
  const help = await capturePi(spawn, ["--help"]);
  const available =
    version.code === 0 &&
    help.code === 0 &&
    help.stdout.includes("--mode") &&
    help.stdout.includes("rpc");
  const state = available ? ("supported" as const) : ("unsupported" as const);
  return {
    id: "pi",
    adapterVersion: "1",
    version: version.stdout.trim() || "unknown",
    availability: available ? "available" : "unavailable",
    detail: available
      ? undefined
      : `pi RPC interface unavailable (${version.stderr || help.stderr || "not installed"})`,
    capabilities: {
      "structured-output": { state },
      cancel: { state },
      resume: {
        state: "unsupported",
        constraints: ["native session resume is not exposed by this adapter"],
      },
      reattach: { state: "unsupported" },
      tools: { state: "conditional", constraints: ["read-only native tool allowlist only"] },
      usage: { state },
      "cost-cap": {
        state: "unsupported",
        constraints: ["provider cost is not enforceable locally"],
      },
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
}

export function parsePiRpcLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function piNativeConfig(config: JsonObject = {}): JsonObject & { checksum: string } {
  const safe = redactSecrets(config, [
    "apiKey",
    "api_key",
    "token",
    "password",
    "secret",
  ]) as JsonObject;
  // The checksum is an identity/evidence field; it is not a security primitive.
  return { ...safe, checksum: `sha256:${simpleHash(canonicalize(safe))}` };
}

export interface PiResolvedSelection {
  readonly provider?: string;
  readonly model?: string;
}

/** Resolve explicit config, then Kouro's optional profile env, without parsing provider URLs. */
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
  // A model reference may use the native provider/model form. Never treat an
  // HTTP(S) URL as that form: its slashes belong to the provider value.
  if (!provider && model && !/^https?:\/\//i.test(model)) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      provider = model.slice(0, slash);
      model = model.slice(slash + 1);
    }
  }
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

export class PiCliHarness {
  readonly descriptor: HarnessDescriptor;
  private readonly spawn: PiRpcSpawn;
  constructor(descriptor: HarnessDescriptor, spawn: PiRpcSpawn = defaultSpawn) {
    this.descriptor = descriptor;
    this.spawn = spawn;
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
        done = true;
        wake?.();
      },
      close: async () => {
        await result;
        done = true;
        wake?.();
      },
    };
  }

  async run(input: PiRunInput): Promise<HarnessResult> {
    if (this.descriptor.availability !== "available")
      return {
        status: "unavailable",
        error: this.descriptor.detail,
        usage: unavailableUsage(),
        events: [],
      };
    const supplied = input.selection.nativeConfig ?? {};
    const config = piNativeConfig(supplied);
    const validation = validateJsonSchema(config, nativeConfigSchema);
    if (!validation.valid)
      return {
        status: "failed",
        error: `invalid-native-config: ${validation.error}`,
        usage: unavailableUsage(),
        events: [],
      };
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--tools",
      "read",
      "--no-context-files",
      "--no-skills",
    ];
    const resolved = resolvePiSelection(input.selection, config);
    if (resolved.provider) args.push("--provider", resolved.provider);
    if (resolved.model) args.push("--model", resolved.model);
    if (typeof config.thinking === "string") args.push("--thinking", config.thinking);
    const proc = this.spawn([piCommand(), ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: input.cwd,
    });
    const events: HarnessEvent[] = [];
    const records: Record<string, unknown>[] = [];
    let stdout = "";
    let stderr = "";
    let settled = false;
    let cancelled = false;
    let stoppedAfterSettled = false;
    let statsRequested = false;
    const abort = () => {
      cancelled = true;
      try {
        proc.stdin.write(`${JSON.stringify({ type: "abort", id: `${input.attemptId}:abort` })}\n`);
      } catch {
        /* process may already be dead */
      }
      proc.kill?.("SIGTERM");
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const handoff = input.context
        ? `\n\n[KOURO_CONTEXT_BEGIN]\n${JSON.stringify(input.context)}\n[KOURO_CONTEXT_END]\n[KOURO_HANDOFF_BEGIN]\n${input.role.prompt}\n[KOURO_HANDOFF_END]`
        : input.role.prompt;
      proc.stdin.write(
        `${JSON.stringify({ id: `${input.attemptId}:prompt`, type: "prompt", message: handoff })}\n`,
      );
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consume = async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            stdout += `${line}\n`;
            this.record(line, records, events, input.onEvent);
            if (records.at(-1)?.type === "agent_settled") settled = true;
            if (settled && !statsRequested) {
              statsRequested = true;
              proc.stdin.write(
                `${JSON.stringify({ id: `${input.attemptId}:stats`, type: "get_session_stats" })}\n`,
              );
            }
            if (
              settled &&
              records.at(-1)?.type === "response" &&
              records.at(-1)?.command === "get_session_stats"
            ) {
              // RPC mode is a persistent process. Waiting for stdout EOF would
              // hang forever after a successful turn, so close this ephemeral
              // session after the durable stats response.
              stoppedAfterSettled = true;
              proc.stdin.end?.();
              proc.kill?.("SIGTERM");
              return;
            }
            index = buffer.indexOf("\n");
          }
        }
        buffer += decoder.decode();
        if (buffer) {
          stdout += buffer;
          this.record(buffer, records, events, input.onEvent);
        }
      };
      const stderrPromise = new Response(proc.stderr).text().then((value) => {
        stderr = value;
      });
      const timeoutMs = typeof config.timeoutMs === "number" ? config.timeoutMs : 120_000;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          abort();
          resolve("timeout");
        }, timeoutMs);
      });
      const consumed = consume().catch(() => undefined);
      await Promise.race([consumed, timeout]);
      let code: number | undefined;
      if (!timedOut) {
        const exited = proc.exited.then((value) => {
          code = value;
          return "exited" as const;
        });
        await Promise.race([exited, timeout]);
      }
      if (timedOut) {
        const stopped = await Promise.race([
          proc.exited.then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
        ]);
        if (!stopped) proc.kill?.("SIGKILL");
      } else await Promise.race([stderrPromise, timeout]);
      if (timer) clearTimeout(timer);
      if (timedOut)
        return {
          status: "failed",
          error: `pi timed out after ${timeoutMs}ms`,
          rawOutput: stdout,
          usage: unavailableUsage(),
          events,
        };
      if (code === undefined) code = await proc.exited.catch(() => -1);
      if (input.signal?.aborted || cancelled)
        return {
          status: "cancelled",
          error: "cancelled",
          usage: unavailableUsage(),
          rawOutput: stdout,
          events,
        };
      const message = findMessage(records);
      let output: JsonValue | undefined = message;
      if (typeof output === "string") {
        output = parseJsonOutput(output);
      }
      const usage = mergeUsage(observedUsage(records), sessionStatsUsage(records));
      const promptResponse = records.find(
        (record) => record.type === "response" && record.id === `${input.attemptId}:prompt`,
      );
      if (promptResponse && promptResponse.success === false)
        return {
          status: "failed",
          error: `pi prompt rejected: ${String(promptResponse.error ?? "unknown RPC error")}`,
          rawOutput: stdout,
          usage,
          events,
        };
      if (code !== 0 && !stoppedAfterSettled)
        return {
          status: "failed",
          error: stderr || `pi exited ${code}`,
          rawOutput: stdout,
          usage,
          events,
        };
      if (!settled)
        return {
          status: "failed",
          error: "pi process ended before agent_settled",
          rawOutput: stdout,
          usage,
          events,
        };
      if (input.role.outputSchema) {
        const check = validateJsonSchema(output, input.role.outputSchema);
        if (!check.valid)
          return {
            status: "failed",
            error: `invalid-output: ${check.error}`,
            rawOutput: stdout,
            usage,
            events,
          };
      }
      return { status: "succeeded", output, rawOutput: stdout, usage, events };
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }

  private record(
    line: string,
    records: Record<string, unknown>[],
    events: HarnessEvent[],
    onEvent?: (event: HarnessEvent) => void,
  ): void {
    const emit = (event: HarnessEvent) => {
      events.push(event);
      onEvent?.(event);
    };
    const record = parsePiRpcLine(line);
    if (!record) {
      emit({ type: "log", at: new Date().toISOString(), data: line });
      return;
    }
    records.push(record);
    const type = record.type;
    const update = record.assistantMessageEvent as Record<string, unknown> | undefined;
    if (
      type === "message_update" &&
      update?.type === "text_delta" &&
      typeof update.delta === "string"
    )
      emit({ type: "text", at: new Date().toISOString(), data: update.delta });
    else if (type === "message_update" && usageFromRecord(record))
      emit({
        type: "usage",
        at: new Date().toISOString(),
        data: usageFromRecord(record) as JsonValue,
      });
    else if (typeof type === "string" && type.includes("tool"))
      emit({
        type: "tool",
        at: new Date().toISOString(),
        data: record as unknown as JsonValue,
      });
    else
      emit({
        type: "log",
        at: new Date().toISOString(),
        data: record as unknown as JsonValue,
      });
  }
}

export class PiHarnessAdapter implements HarnessAdapter {
  readonly id = "pi";
  readonly adapterVersion = "1";
  constructor(private readonly harness: PiCliHarness) {}
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
        harnessId: this.id,
        model: { id: input.modelId ?? "" },
        nativeConfig: input.nativeConfig,
      },
      cwd: input.cwd ?? ".",
      signal: input.signal,
      context: input.context,
      onEvent: undefined,
    });
    return {
      ...result,
      usage: result.usage as unknown as JsonValue,
      events: result.events as unknown as JsonValue[],
    };
  }
}

function parseJsonOutput(value: string): JsonValue {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  try {
    return JSON.parse(fenced ?? trimmed) as JsonValue;
  } catch {
    // Preserve raw model text; schema validation will report the contract failure.
    return value;
  }
}

function findMessage(records: readonly Record<string, unknown>[]): JsonValue | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    if (record.type !== "message_end") continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (message?.role && message.role !== "assistant") continue;
    if (typeof message?.text === "string") return message.text;
    if (Array.isArray(message?.content)) {
      const text = message.content
        .map((part) =>
          typeof part === "string"
            ? part
            : part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
              ? (part as Record<string, unknown>).text
              : undefined,
        )
        .filter((part): part is string => typeof part === "string")
        .join("");
      if (text) return text;
    }
  }
  return undefined;
}

function observedUsage(records: readonly Record<string, unknown>[]) {
  const values = records
    .map((record) => usageFromRecord(record))
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const valuesWithObservedTokens = values.filter((value) =>
    ["input", "inputTokens", "output", "outputTokens", "total", "totalTokens"].some(
      (key) => typeof value[key] === "number" && Number(value[key]) > 0,
    ),
  );
  const latest = valuesWithObservedTokens.at(-1) ?? values.at(-1);
  const n = (key: string) =>
    typeof latest?.[key] === "number" && Number.isFinite(latest[key]) ? Number(latest[key]) : null;
  const input = n("input") ?? n("inputTokens");
  const output = n("output") ?? n("outputTokens");
  const total =
    n("total") ?? n("totalTokens") ?? (input !== null && output !== null ? input + output : null);
  return {
    inputTokens: {
      value: input,
      quality: input === null ? ("unavailable" as const) : ("observed" as const),
      source: "pi",
    },
    outputTokens: {
      value: output,
      quality: output === null ? ("unavailable" as const) : ("observed" as const),
      source: "pi",
    },
    totalTokens: {
      value: total,
      quality: total === null ? ("unavailable" as const) : ("observed" as const),
      source: "pi",
    },
    cost: { value: null, quality: "unavailable" as const },
  };
}

function sessionStatsUsage(records: readonly Record<string, unknown>[]) {
  const response = records.find(
    (record) => record.type === "response" && record.command === "get_session_stats",
  );
  const data = response?.data as Record<string, unknown> | undefined;
  const tokens = data?.tokens as Record<string, unknown> | undefined;
  if (!tokens) return unavailableUsage();
  const number = (key: string) =>
    typeof tokens[key] === "number" && Number.isFinite(tokens[key]) ? Number(tokens[key]) : null;
  const input = number("input");
  const output = number("output");
  const total = number("total");
  if (![input, output, total].some((value) => value !== null && value > 0))
    return unavailableUsage();
  return {
    inputTokens: {
      value: input,
      quality: input === null ? ("unavailable" as const) : ("observed" as const),
      source: "pi-session-stats",
    },
    outputTokens: {
      value: output,
      quality: output === null ? ("unavailable" as const) : ("observed" as const),
      source: "pi-session-stats",
    },
    totalTokens: {
      value: total,
      quality: total === null ? ("unavailable" as const) : ("observed" as const),
      source: "pi-session-stats",
    },
    cost: { value: null, quality: "unavailable" as const },
  };
}

function mergeUsage(
  streamed: ReturnType<typeof observedUsage>,
  session: ReturnType<typeof unavailableUsage>,
) {
  return streamed.totalTokens.value && streamed.totalTokens.value > 0 ? streamed : session;
}

function usageFromRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = record.message as Record<string, unknown> | undefined;
  const update = record.assistantMessageEvent as Record<string, unknown> | undefined;
  const partial = update?.partial as Record<string, unknown> | undefined;
  return (record.usage ?? message?.usage ?? update?.usage ?? partial?.usage) as
    | Record<string, unknown>
    | undefined;
}

async function capturePi(spawn: PiRpcSpawn, args: string[]) {
  try {
    const proc = spawn([piCommand(), ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return {
      code: await proc.exited,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: String(error) };
  }
}
function defaultSpawn(args: string[], options: Record<string, unknown>): PiRpcProcess {
  return Bun.spawn(args, options as never) as unknown as PiRpcProcess;
}
function simpleHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
