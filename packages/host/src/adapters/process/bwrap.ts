import { mkdirSync, rmSync } from "node:fs";
import type { ProcessAdapter, ProcessResult } from "../../types.ts";

export interface BubblewrapOptions {
  bwrapPath?: string;
  /** Only tests may opt into a fake probe; production remains enforced. */
  probeCommand?: string[];
}

/**
 * The M1 command adapter accepts one fixed fixture command. There is no API
 * that turns model text into argv. Bubblewrap is part of the capability, not a
 * best-effort wrapper: if the actual probe fails, execution is rejected.
 */
export class BubblewrapProcessAdapter implements ProcessAdapter {
  readonly enforcementMode = "enforced" as const;
  private probeResult?: { available: boolean; detail: string };
  private readonly bwrapPath: string;

  constructor(options: BubblewrapOptions = {}) {
    this.bwrapPath = options.bwrapPath ?? "/usr/bin/bwrap";
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    if (this.probeResult) return this.probeResult;
    const workspace = await Bun.$`mktemp -d /tmp/kouro-bwrap-probe.XXXXXX`
      .text()
      .catch(() => "")
      .then((value) => value.trim());
    if (!workspace)
      return (this.probeResult = { available: false, detail: "cannot allocate probe workspace" });
    try {
      const result = await this.spawn(
        workspace,
        ["/usr/bin/printf", "kouro-bwrap-probe\\n"],
        5_000,
      );
      const stdout = new TextDecoder().decode(result.evidence.stdout);
      const stderr = new TextDecoder().decode(result.evidence.stderr);
      this.probeResult =
        result.evidence.exitCode === 0 && stdout === "kouro-bwrap-probe\n"
          ? { available: true, detail: "bubblewrap enforced probe passed" }
          : {
              available: false,
              detail:
                result.evidence.spawnError ?? `probe exited ${result.evidence.exitCode}: ${stderr}`,
            };
    } catch (cause) {
      this.probeResult = {
        available: false,
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
    return this.probeResult;
  }

  async executeFixedFixture(input: {
    runId: string;
    operationKey: string;
    workspaceDir: string;
    timeoutMs: number;
  }): Promise<ProcessResult> {
    const probe = await this.probe();
    if (!probe.available)
      throw new Error(`Enforced process execution unavailable: ${probe.detail}`);
    mkdirSync(input.workspaceDir, { recursive: true, mode: 0o700 });
    return this.spawn(
      input.workspaceDir,
      ["/usr/bin/printf", "Kouro M1 command\\n"],
      input.timeoutMs,
      input.operationKey,
    );
  }

  private async spawn(
    workspaceDir: string,
    argv: string[],
    timeoutMs: number,
    operationKey = "probe",
  ): Promise<ProcessResult> {
    const command = this.bwrapCommand(workspaceDir, argv);
    let process: ReturnType<typeof Bun.spawn>;
    try {
      process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    } catch (cause) {
      return {
        operationKey,
        evidence: {
          argv,
          cwd: workspaceDir,
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
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([process.exited, timeout]);
      const exitCode = outcome === "timeout" ? await process.exited.catch(() => null) : outcome;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      return {
        operationKey,
        evidence: {
          argv,
          cwd: workspaceDir,
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
          argv,
          cwd: workspaceDir,
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

  private bwrapCommand(workspaceDir: string, argv: string[]): string[] {
    // --unshare-all includes network, mount, IPC, PID, UTS and user namespace
    // isolation. /tmp is an empty tmpfs; /home is not present at all.
    return [
      this.bwrapPath,
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/home",
      "--bind",
      workspaceDir,
      "/workspace",
      "--chdir",
      "/workspace",
      "--clearenv",
      "--setenv",
      "HOME",
      "/home",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "KOURO_OPERATION_KEY",
      "fixture-only",
      "--",
      ...argv,
    ];
  }
}

export class FakeProcessAdapter implements ProcessAdapter {
  readonly enforcementMode = "enforced" as const;
  readonly operations: string[] = [];
  constructor(
    private readonly output = "Kouro M1 command\\n",
    private readonly delayMs = 0,
  ) {}
  async probe(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: "fake adapter" };
  }
  async executeFixedFixture(input: {
    runId: string;
    operationKey: string;
    workspaceDir: string;
    timeoutMs: number;
  }): Promise<ProcessResult> {
    this.operations.push(input.operationKey);
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return {
      operationKey: input.operationKey,
      evidence: {
        argv: ["/usr/bin/printf", "Kouro M1 command\\n"],
        cwd: input.workspaceDir,
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnError: null,
        stdout: new TextEncoder().encode(this.output),
        stderr: new Uint8Array(),
        enforcementMode: "enforced",
      },
    };
  }
}
