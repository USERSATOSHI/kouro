import {
  unavailableUsage,
  validateJsonSchema,
  validateReasoningEffort,
  type HarnessDescriptor,
  type HarnessEvent,
  type JsonValue,
} from "@kouro/core";
import type { HarnessAdapter } from "../../types.ts";

export type ExternalCliKind = "opencode";

interface CliProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}

function binary(): string {
  return process.env.KOURO_OPENCODE_BIN?.trim() || "opencode";
}

async function capture(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (cause) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function inspectExternalCli(kind: ExternalCliKind): Promise<HarnessDescriptor> {
  const command = binary();
  const version = await capture([command, "--version"]);
  const help = await capture([command, "run", "--help"]);
  const available = version.exitCode === 0 && help.exitCode === 0;
  const supported = { state: available ? ("supported" as const) : ("unsupported" as const) };
  return {
    id: kind,
    adapterVersion: "1",
    version: version.stdout.trim() || "unknown",
    availability: available ? "available" : "unavailable",
    detail: available
      ? undefined
      : `${kind} CLI unavailable (${version.stderr || help.stderr || "not installed"})`,
    capabilities: {
      "structured-output": supported,
      cancel: supported,
      resume: { state: "unsupported" },
      reattach: { state: "unsupported" },
      tools: {
        state: "conditional",
        constraints: ["native CLI permissions must be configured by the operator"],
      },
      usage: { state: "unsupported" },
      "cost-cap": { state: "unsupported" },
    },
    nativeConfigSchema: {
      type: "object",
      additionalProperties: true,
      properties: { model: { type: "string" } },
    },
  };
}

function parseOutput(stdout: string): JsonValue | undefined {
  const candidates = [
    stdout.trim(),
    ...stdout
      .split("\n")
      .reverse()
      .map((line) => line.trim()),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown> | JsonValue;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      const record = value as Record<string, unknown>;
      for (const key of ["output", "result", "text", "content"]) {
        if (record[key] !== undefined) {
          const selected = record[key];
          if (typeof selected === "string") {
            try {
              return JSON.parse(selected) as JsonValue;
            } catch {
              return selected;
            }
          }
          return selected as JsonValue;
        }
      }
      return value as JsonValue;
    } catch {
      // Keep looking for a JSON event or return the raw text below.
    }
  }
  return stdout.trim() || undefined;
}

function normalizeCliLine(line: string, channel: "stdout" | "stderr"): HarnessEvent | undefined {
  const value = line.trim();
  if (!value) return undefined;
  const at = new Date().toISOString();
  if (channel === "stderr")
    return { type: "log", at, data: { status: "CLI stderr", detail: value } };
  let parsed: Record<string, unknown> | undefined;
  try {
    const candidate: unknown = JSON.parse(value);
    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))
      parsed = candidate as Record<string, unknown>;
  } catch {
    return { type: "text", at, data: value };
  }
  if (!parsed) return { type: "text", at, data: value };
  const part =
    typeof parsed.part === "object" && parsed.part !== null
      ? (parsed.part as Record<string, unknown>)
      : {};
  const type = String(parsed.type ?? part.type ?? "").toLowerCase();
  const content =
    typeof part.text === "string"
      ? part.text
      : typeof parsed.text === "string"
        ? parsed.text
        : typeof parsed.content === "string"
          ? parsed.content
          : undefined;
  if (content !== undefined && /text|message|content/.test(type))
    return { type: "text", at, data: content };
  if (/tool/.test(type) || typeof part.tool === "string" || typeof parsed.tool === "string") {
    const state =
      typeof part.state === "object" && part.state !== null
        ? (part.state as Record<string, unknown>)
        : {};
    const status = String(
      state.status ??
        parsed.status ??
        (/result|complete|finish|error/.test(type) ? "completed" : "running"),
    ).toLowerCase();
    const name = String(part.tool ?? parsed.tool ?? parsed.name ?? "tool");
    const id = String(part.callID ?? part.id ?? parsed.callID ?? parsed.id ?? name);
    return { type: "tool", at, data: { id, name, status } };
  }
  return {
    type: "log",
    at,
    data: { status: type ? `CLI ${type}` : "CLI event", detail: value.slice(0, 2_000) },
  };
}

async function readActivity(
  stream: ReadableStream<Uint8Array>,
  channel: "stdout" | "stderr",
  onEvent: (event: HarnessEvent) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let captured = "";
  let pending = "";
  const emitLine = (line: string) => {
    const event = normalizeCliLine(line, channel);
    if (event) onEvent(event);
  };
  for (;;) {
    const { done, value } = await reader.read();
    const text = decoder.decode(value, { stream: !done });
    captured += text;
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      emitLine(pending.slice(0, newline).replace(/\r$/, ""));
      pending = pending.slice(newline + 1);
    }
    if (done) break;
  }
  emitLine(pending);
  return captured;
}

export class ExternalCliHarnessAdapter implements HarnessAdapter {
  readonly id: ExternalCliKind;
  readonly adapterVersion = "1";
  private readonly activeProcesses = new Map<string, CliProcess>();
  constructor(
    private readonly kind: ExternalCliKind,
    private readonly descriptor: HarnessDescriptor,
  ) {
    this.id = kind;
  }
  capabilities(): Record<string, "supported" | "unsupported" | "conditional"> {
    return Object.fromEntries(
      Object.entries(this.descriptor.capabilities).map(([key, value]) => [key, value.state]),
    );
  }
  async terminate(input: { attemptId: string }): Promise<boolean> {
    const proc = this.activeProcesses.get(input.attemptId);
    if (!proc) return true;
    try {
      proc.kill("SIGKILL");
    } catch {
      return false;
    }
    return Promise.race([
      proc.exited.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
  }
  async run(
    input: Parameters<HarnessAdapter["run"]>[0],
  ): Promise<Awaited<ReturnType<HarnessAdapter["run"]>>> {
    const unavailable = () => JSON.parse(JSON.stringify(unavailableUsage())) as JsonValue;
    if (this.descriptor.availability !== "available")
      return {
        status: "unavailable" as const,
        error: this.descriptor.detail,
        usage: unavailable(),
        events: [],
      };
    const config = input.nativeConfig ?? {};
    const effortError = validateReasoningEffort(config.effort, "opencode");
    if (effortError)
      return { status: "failed", error: effortError, usage: unavailable(), events: [] };
    const command = binary();
    const args = [command, "run", "--format", "json", "--dir", input.cwd ?? "."];
    if (typeof config.model === "string" && config.model) args.push("--model", config.model);
    const prompt = input.context
      ? `[KOURO_CONTEXT_BEGIN]\n${JSON.stringify(input.context)}\n[KOURO_CONTEXT_END]\n${input.prompt}`
      : input.prompt;
    args.push(prompt);
    let proc: CliProcess;
    try {
      proc = Bun.spawn(args, {
        cwd: input.cwd ?? ".",
        stdout: "pipe",
        stderr: "pipe",
        signal: input.signal,
      }) as unknown as CliProcess;
    } catch (cause) {
      return {
        status: "failed" as const,
        error: `${this.kind} spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        usage: unavailable(),
        events: [],
      };
    }
    const attemptId = input.attemptId ?? input.invocationId;
    this.activeProcesses.set(attemptId, proc);
    const cleanup = () => {
      if (this.activeProcesses.get(attemptId) === proc) this.activeProcesses.delete(attemptId);
    };
    void proc.exited.then(cleanup, cleanup);
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent) => {
      events.push(event);
      input.onEvent?.(event);
    };
    const stdoutPromise = readActivity(proc.stdout, "stdout", emit).catch(() => "");
    const stderrPromise = readActivity(proc.stderr, "stderr", emit).catch(() => "");
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => {
              proc.kill("SIGTERM");
              resolve("timeout");
            }, timeoutMs);
          });
    const completed = Promise.all([stdoutPromise, stderrPromise, proc.exited]).then(
      ([stdout, stderr, code]) => ({ stdout, stderr, code }),
    );
    const result = timeout ? await Promise.race([completed, timeout]) : await completed;
    if (timer) clearTimeout(timer);
    if (result === "timeout")
      return {
        status: "failed" as const,
        error: `${this.kind} timed out after ${timeoutMs}ms`,
        usage: unavailable(),
        events: [],
      };
    if (input.signal?.aborted)
      return { status: "cancelled" as const, error: "cancelled", usage: unavailable(), events: [] };
    const output = parseOutput(result.stdout);
    if (result.code !== 0)
      return {
        status: "failed" as const,
        rawOutput: result.stdout,
        error: result.stderr || `${this.kind} exited ${result.code}`,
        usage: unavailable(),
        events,
      };
    if (input.outputSchema) {
      const check = validateJsonSchema(output, input.outputSchema);
      if (!check.valid)
        return {
          status: "failed" as const,
          rawOutput: result.stdout,
          error: `invalid-output: ${check.error}`,
          usage: unavailable(),
          events,
        };
    }
    return {
      status: "succeeded" as const,
      output,
      rawOutput: result.stdout,
      usage: unavailable(),
      events,
    };
  }
}
