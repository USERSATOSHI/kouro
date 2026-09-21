import { mkdirSync } from "node:fs";
import type { ProcessAdapter, ProcessResult } from "../../types.ts";
import { probeEnforcedProcess, runEnforcedProcess } from "./common.ts";

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
    this.probeResult = await probeEnforcedProcess(
      (workspace, argv, timeoutMs) => this.spawn(workspace, argv, timeoutMs),
      "bwrap",
    );
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
    return runEnforcedProcess({
      command: this.bwrapCommand(workspaceDir, argv),
      argv,
      cwd: workspaceDir,
      timeoutMs,
      operationKey,
    });
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
