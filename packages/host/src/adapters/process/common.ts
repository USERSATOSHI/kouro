import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessResult } from "../../types.ts";

export async function runEnforcedProcess(input: {
  command: string[];
  argv: string[];
  cwd: string;
  timeoutMs: number;
  operationKey?: string;
}): Promise<ProcessResult> {
  const operationKey = input.operationKey ?? "probe";
  const capture = capturePaths();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(input.command, {
      cwd: input.cwd,
      stdout: Bun.file(capture.stdout),
      stderr: Bun.file(capture.stderr),
      detached: true,
    });
  } catch (cause) {
    rmSync(capture.directory, { recursive: true, force: true });
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
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      terminateGroup(child, "SIGTERM");
      resolve("timeout");
    }, input.timeoutMs);
  });
  try {
    const outcome = await Promise.race([child.exited, timeout]);
    const exitCode = outcome === "timeout" ? await stopGroup(child) : outcome;
    const [stdout, stderr] = readCaptured(capture);
    return {
      operationKey,
      evidence: {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: exitCode === null ? null : Number(exitCode),
        signal: child.signalCode ?? null,
        timedOut,
        spawnError: null,
        stdout,
        stderr,
        enforcementMode: "enforced",
      },
    };
  } catch (cause) {
    const [stdout, stderr] = readCaptured(capture);
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
    rmSync(capture.directory, { recursive: true, force: true });
  }
}

export async function runTrustedCommand(input: {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  operationKey: string;
}): Promise<ProcessResult> {
  const capture = capturePaths();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(input.argv, {
      cwd: input.cwd,
      stdout: Bun.file(capture.stdout),
      stderr: Bun.file(capture.stderr),
      detached: true,
    });
  } catch (cause) {
    rmSync(capture.directory, { recursive: true, force: true });
    return {
      operationKey: input.operationKey,
      evidence: {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: cause instanceof Error ? cause.message : String(cause),
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        enforcementMode: "trusted-unrestricted",
      },
    };
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode: Number(exitCode) })),
      new Promise<{ exitCode: null }>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          terminateGroup(child, "SIGTERM");
          resolve({ exitCode: null });
        }, input.timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) await stopGroup(child);
    const [out, err] = readCaptured(capture);
    return {
      operationKey: input.operationKey,
      evidence: {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: result.exitCode,
        signal: child.signalCode ?? null,
        timedOut,
        spawnError: null,
        stdout: out,
        stderr: err,
        enforcementMode: "trusted-unrestricted",
      },
    };
  } catch (cause) {
    return {
      operationKey: input.operationKey,
      evidence: {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: null,
        signal: child.signalCode ?? null,
        timedOut,
        spawnError: cause instanceof Error ? cause.message : String(cause),
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        enforcementMode: "trusted-unrestricted",
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
    rmSync(capture.directory, { recursive: true, force: true });
  }
}

function terminateGroup(child: ReturnType<typeof Bun.spawn>, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    globalThis.process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* exited during cancellation */
    }
  }
}

async function stopGroup(child: ReturnType<typeof Bun.spawn>): Promise<number | null> {
  const exitCode = await Promise.race([
    child.exited.then(
      (code) => Number(code),
      () => null,
    ),
    Bun.sleep(250).then(() => null),
  ]);
  terminateGroup(child, "SIGKILL");
  return exitCode;
}

function capturePaths() {
  const directory = mkdtempSync(join(tmpdir(), "kouro-process-output-"));
  return { directory, stdout: join(directory, "stdout"), stderr: join(directory, "stderr") };
}

function readCaptured(capture: ReturnType<typeof capturePaths>): [Uint8Array, Uint8Array] {
  const read = (path: string) => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return new Uint8Array();
    }
  };
  return [read(capture.stdout), read(capture.stderr)];
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
