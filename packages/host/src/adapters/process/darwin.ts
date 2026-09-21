import { mkdirSync } from "node:fs";
import type { ProcessAdapter, ProcessResult } from "../../types.ts";
import { probeEnforcedProcess, runEnforcedProcess } from "./common.ts";

export interface DarwinSandboxOptions {
  sandboxExecPath?: string;
}

/**
 * macOS counterpart to the Linux Bubblewrap adapter. sandbox-exec is deprecated
 * by Apple but remains the native profile-based containment primitive available
 * to a Bun CLI; absence or failure is always reported as unavailable.
 */
export class DarwinSandboxProcessAdapter implements ProcessAdapter {
  readonly enforcementMode = "enforced" as const;
  private probeResult?: { available: boolean; detail: string };
  private readonly sandboxExecPath: string;

  constructor(options: DarwinSandboxOptions = {}) {
    this.sandboxExecPath = options.sandboxExecPath ?? "/usr/bin/sandbox-exec";
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    if (this.probeResult) return this.probeResult;
    this.probeResult = await probeEnforcedProcess(
      (workspace, argv, timeoutMs) => this.spawn(workspace, argv, timeoutMs),
      "darwin-sandbox",
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
      ["/usr/bin/printf", "Kouro M1 command\n"],
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
      command: [this.sandboxExecPath, "-p", this.profile(workspaceDir), ...argv],
      argv,
      cwd: workspaceDir,
      timeoutMs,
      operationKey,
    });
  }

  private profile(workspaceDir: string): string {
    const path = workspaceDir.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return [
      "(version 1)",
      "(deny default)",
      '(allow process-exec (literal "/usr/bin/printf"))',
      "(allow process-fork)",
      "(allow signal (target same-sandbox))",
      "(allow file-read-metadata)",
      '(allow file-read* (subpath "/System"))',
      '(allow file-read* (subpath "/usr"))',
      '(allow file-read* (subpath "/bin"))',
      '(allow file-read* (subpath "/private/etc"))',
      '(allow file-read* (subpath "/private/var/db/timezone"))',
      '(allow file-read* file-write* (subpath "/private/tmp"))',
      '(allow file-write* (literal "/dev/null"))',
      '(allow file-read* (literal "/dev/random"))',
      '(allow file-read* (literal "/dev/urandom"))',
      `(allow file-read* (subpath "${path}"))`,
      `(allow file-write* (subpath "${path}"))`,
    ].join("\n");
  }
}
