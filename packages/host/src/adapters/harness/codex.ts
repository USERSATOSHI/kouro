import type { JsonValue } from "@kouro/core";
import { mkdtempSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  unavailableUsage,
  validateJsonSchema,
  type HarnessDescriptor,
  type HarnessEvent,
  type HarnessResult,
  type HarnessSelection,
  type RoleSpec,
  type HarnessPort,
  type StartTurnRequest,
  type TurnHandle,
} from "@kouro/core";
import type { HarnessAdapter } from "../../types.ts";

export interface CodexRunInput {
  readonly attemptId: string;
  readonly role: RoleSpec;
  readonly selection: HarnessSelection;
  readonly cwd: string;
  readonly context?: StartTurnRequest["context"];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface CodexProcess {
  stdin: { write(data: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}

/** Read-only preflight: capability claims are based on the installed CLI help/version. */
export async function inspectCodex(): Promise<HarnessDescriptor> {
  const version = await capture(["codex", "--version"]);
  const help = await capture(["codex", "exec", "--help"]);
  const available =
    version.exitCode === 0 &&
    help.exitCode === 0 &&
    help.stdout.includes("--json") &&
    help.stdout.includes("--output-schema");
  const supported = { state: available ? ("supported" as const) : ("unsupported" as const) };
  return {
    id: "codex",
    adapterVersion: "1",
    version: version.stdout.trim() || "unknown",
    availability: available ? "available" : "unavailable",
    detail: available
      ? undefined
      : `codex exec structured interface unavailable (${version.stderr || help.stderr || "not installed"})`,
    capabilities: {
      "structured-output": supported,
      cancel: supported,
      resume: { state: "unsupported" },
      reattach: { state: "unsupported" },
      tools: {
        state: "conditional",
        constraints: ["only tools explicitly enabled by native profile"],
      },
      usage: { state: available ? "supported" : "unsupported" },
      "cost-cap": {
        state: "unsupported",
        constraints: ["provider cost is not enforceable locally"],
      },
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

export class CodexCliHarness implements HarnessPort {
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
    if (this.descriptor.availability !== "available")
      return {
        status: "unavailable",
        error: this.descriptor.detail,
        usage: unavailableUsage(),
        events: [],
      };
    const config = input.selection.nativeConfig ?? {};
    const tempDir = mkdtempSync(join(tmpdir(), "kouro-codex-"), { encoding: "utf8" });
    const args = [
      "codex",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--cd",
      input.cwd,
    ];
    if (typeof config.model === "string") args.push("--model", config.model);
    // The Kouro M2 Codex profile is deliberately read-only. A future native
    // profile may opt into a different sandbox through a separate adapter.
    args.push("--sandbox", typeof config.sandbox === "string" ? config.sandbox : "read-only");
    const schemaPath = join(tempDir, "output-schema.json");
    if (input.role.outputSchema) {
      await Bun.write(schemaPath, JSON.stringify(input.role.outputSchema));
      args.push("--output-schema", schemaPath);
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
    };
    if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
    let proc: CodexProcess;
    try {
      proc = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        signal: input.signal,
        env,
      }) as unknown as CodexProcess;
      const handoff = input.context
        ? `\n\n[KOURO_CONTEXT_BEGIN]\n${JSON.stringify(input.context)}\n[KOURO_CONTEXT_END]\n[KOURO_HANDOFF_BEGIN]\n${input.role.prompt}\n[KOURO_HANDOFF_END]`
        : input.role.prompt;
      proc.stdin.write(handoff);
      proc.stdin.end();
    } catch (cause) {
      cleanupCodexTemp(schemaPath, tempDir);
      return {
        status: input.signal?.aborted ? "cancelled" : "failed",
        error: input.signal?.aborted
          ? "cancelled"
          : `codex spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        usage: unavailableUsage(),
        events: [],
      };
    }

    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : 120_000;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        resolve("timeout");
      }, timeoutMs);
    });
    const aborted = new Promise<"aborted">((resolve) => {
      if (input.signal?.aborted) resolve("aborted");
      else input.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    let stdout = "";
    let stderr = "";
    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const stderrPromise = new Response(proc.stderr).text().catch(() => "");
    const output = Promise.all([stdoutPromise, stderrPromise]).then(([nextStdout, nextStderr]) => {
      stdout = nextStdout;
      stderr = nextStderr;
      return "output" as const;
    });
    const first = await Promise.race([output, timeout, aborted]);
    let code: number | undefined;
    if (first === "output") {
      const exited = proc.exited.then((value) => {
        code = value;
        return "exited" as const;
      });
      await Promise.race([exited, timeout, aborted]);
    } else {
      proc.kill("SIGTERM");
      const stopped = await Promise.race([
        proc.exited.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
      ]);
      if (!stopped) proc.kill("SIGKILL");
    }
    if (timeoutTimer) clearTimeout(timeoutTimer);
    cleanupCodexTemp(schemaPath, tempDir);
    if (timedOut)
      return {
        status: "failed",
        error: `codex timed out after ${timeoutMs}ms`,
        rawOutput: stdout,
        usage: unavailableUsage(),
        events: [{ type: "log", at: new Date().toISOString(), data: "timed out" }],
      };
    if (input.signal?.aborted)
      return {
        status: "cancelled",
        error: "cancelled",
        usage: unavailableUsage(),
        rawOutput: stdout,
        events: [{ type: "log", at: new Date().toISOString(), data: "cancelled" }],
      };
    if (code === undefined) code = await proc.exited.catch(() => -1);
    const lines = stdout.split("\n").filter(Boolean);
    const records = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const events: HarnessEvent[] = lines.map((line) => ({
      type: "log",
      at: new Date().toISOString(),
      data: line,
    }));
    const message =
      [...records]
        .reverse()
        .find(
          (item) =>
            item.type === "item.completed" &&
            (item.item as Record<string, unknown> | undefined)?.type === "agent_message",
        ) ??
      [...records]
        .reverse()
        .find((item) => item.type === "agent_message" || item.type === "message");
    const messageItem = message?.item as Record<string, unknown> | undefined;
    let parsed: JsonValue | undefined = (messageItem?.text ??
      message?.text ??
      message?.message ??
      message?.content) as JsonValue | undefined;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed) as JsonValue;
      } catch {
        /* raw evidence remains authoritative */
      }
    }
    const completion = records.find((item) => item.type === "turn.completed");
    const usageRecord = completion?.usage as Record<string, unknown> | undefined;
    const number = (key: string) =>
      typeof usageRecord?.[key] === "number" && Number.isFinite(usageRecord[key])
        ? Number(usageRecord[key])
        : null;
    const usage = usageRecord
      ? {
          inputTokens: {
            value: number("input_tokens"),
            quality:
              number("input_tokens") === null ? ("unavailable" as const) : ("observed" as const),
            source: "codex",
          },
          outputTokens: {
            value: number("output_tokens"),
            quality:
              number("output_tokens") === null ? ("unavailable" as const) : ("observed" as const),
            source: "codex",
          },
          totalTokens: {
            value: number("total_tokens"),
            quality:
              number("total_tokens") === null ? ("unavailable" as const) : ("observed" as const),
            source: "codex",
          },
          cost: { value: null, quality: "unavailable" as const },
        }
      : unavailableUsage();
    if (code !== 0)
      return {
        status: "failed",
        rawOutput: stdout,
        error: stderr || `codex exited ${code}`,
        usage,
        events,
      };
    if (input.role.outputSchema) {
      const check = validateJsonSchema(parsed, input.role.outputSchema);
      if (!check.valid)
        return {
          status: "failed",
          rawOutput: stdout,
          error: `invalid-output: ${check.error}`,
          usage,
          events,
        };
    }
    return { status: "succeeded", output: parsed, rawOutput: stdout, usage, events };
  }
}

/** Adapter for the host's small legacy boundary; the portable contract remains core-owned. */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly adapterVersion = "1";
  constructor(private readonly harness: CodexCliHarness) {}
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
        harnessId: this.id,
        model: { id: input.modelId ?? "default" },
        ...(input.nativeConfig ? { nativeConfig: input.nativeConfig } : {}),
      },
      cwd: input.cwd ?? ".",
      context: input.context,
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

function cleanupCodexTemp(schemaPath: string, tempDir: string): void {
  try {
    unlinkSync(schemaPath);
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best effort cleanup; evidence does not depend on it */
  }
}

async function capture(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { exitCode: await p.exited, stdout, stderr };
  } catch (error) {
    return { exitCode: -1, stdout: "", stderr: String(error) };
  }
}
