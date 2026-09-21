import { rmSync } from "node:fs";
import type { ProcessResult } from "../../types.ts";

export async function runEnforcedProcess(input: {
  command: string[];
  argv: string[];
  cwd: string;
  timeoutMs: number;
  operationKey?: string;
}): Promise<ProcessResult> {
  const operationKey = input.operationKey ?? "probe";
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn(input.command, { stdout: "pipe", stderr: "pipe" });
  } catch (cause) {
    return {
      operationKey,
      evidence: {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: cause instanceof Error ? cause.message : String(cause),
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        enforcementMode: "enforced",
      },
    };
  }
  const readPipe = async (pipe: typeof process.stdout): Promise<Uint8Array> => {
    if (pipe === undefined || typeof pipe === "number") return new Uint8Array();
    return new Uint8Array(await new Response(pipe).arrayBuffer());
  };
  const stdoutPromise = readPipe(process.stdout);
  const stderrPromise = readPipe(process.stderr);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      process.kill();
      resolve("timeout");
    }, input.timeoutMs);
  });
  try {
    const outcome = await Promise.race([process.exited, timeout]);
    const exitCode = outcome === "timeout" ? await process.exited.catch(() => null) : outcome;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return {
      operationKey,
      evidence: {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: exitCode === null ? null : Number(exitCode),
        signal: null,
        timedOut,
        spawnError: null,
        stdout,
        stderr,
        enforcementMode: "enforced",
      },
    };
  } catch (cause) {
    const [stdout, stderr] = await Promise.all([
      stdoutPromise.catch(() => new Uint8Array()),
      stderrPromise.catch(() => new Uint8Array()),
    ]);
    return {
      operationKey,
      evidence: {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: cause instanceof Error ? cause.message : String(cause),
        stdout,
        stderr,
        enforcementMode: "enforced",
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeEnforcedProcess(
  spawn: (workspace: string, argv: string[], timeoutMs: number) => Promise<ProcessResult>,
  name: string,
): Promise<{ available: boolean; detail: string }> {
  const workspace = await Bun.$`mktemp -d /tmp/kouro-${name}-probe.XXXXXX`
    .text()
    .catch(() => "")
    .then((value) => value.trim());
  if (!workspace) return { available: false, detail: "cannot allocate probe workspace" };
  try {
    const result = await spawn(workspace, ["/usr/bin/printf", "kouro-bwrap-probe\\n"], 5_000);
    const stdout = new TextDecoder().decode(result.evidence.stdout);
    const stderr = new TextDecoder().decode(result.evidence.stderr);
    return result.evidence.exitCode === 0 && stdout === "kouro-bwrap-probe\n"
      ? { available: true, detail: `${name} enforced probe passed` }
      : {
          available: false,
          detail:
            result.evidence.spawnError ??
            `probe exited ${result.evidence.exitCode ?? "unknown"}` +
              `${result.evidence.signal ? ` (${result.evidence.signal})` : ""}: ${stderr || "no stderr"}`,
        };
  } catch (cause) {
    return { available: false, detail: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
