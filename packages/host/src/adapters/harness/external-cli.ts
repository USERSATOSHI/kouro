import {
  unavailableUsage,
  validateJsonSchema,
  type HarnessDescriptor,
  type HarnessEvent,
  type JsonValue,
} from "@kouro/core";
import type { HarnessAdapter } from "../../types.ts";

export type ExternalCliKind = "claude" | "opencode";

interface CliProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}

function binary(kind: ExternalCliKind): string {
  return process.env[kind === "claude" ? "KOURO_CLAUDE_BIN" : "KOURO_OPENCODE_BIN"]?.trim() || kind;
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
  const command = binary(kind);
  const version = await capture([command, "--version"]);
  const help = await capture(kind === "claude" ? [command, "--help"] : [command, "run", "--help"]);
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

function parseOutput(kind: ExternalCliKind, stdout: string): JsonValue | undefined {
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
      for (const key of kind === "claude"
        ? ["structured_output", "result", "text", "content"]
        : ["output", "result", "text", "content"]) {
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

export class ExternalCliHarnessAdapter implements HarnessAdapter {
  readonly id: ExternalCliKind;
  readonly adapterVersion = "1";
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
    const command = binary(this.kind);
    const args =
      this.kind === "claude"
        ? [command, "-p", "--output-format", "json", "--permission-mode", "plan"]
        : [command, "run", "--format", "json", "--dir", input.cwd ?? "."];
    if (typeof config.model === "string" && config.model) args.push("--model", config.model);
    if (input.outputSchema && this.kind === "claude")
      args.push("--json-schema", JSON.stringify(input.outputSchema));
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
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 120_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve("timeout");
      }, timeoutMs);
    });
    const completed = Promise.all([stdoutPromise, stderrPromise, proc.exited]).then(
      ([stdout, stderr, code]) => ({ stdout, stderr, code }),
    );
    const result = await Promise.race([completed, timeout]);
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
    const output = parseOutput(this.kind, result.stdout);
    const events: HarnessEvent[] = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ type: "log", at: new Date().toISOString(), data: line }));
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
