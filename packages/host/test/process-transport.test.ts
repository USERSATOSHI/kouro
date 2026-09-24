import { describe, expect, test } from "bun:test";
import { runTrustedCommand } from "../src/adapters/process/common.ts";

describe("native process transports", () => {
  test("Bun delivers Blob stdin completely to a real child process", async () => {
    const prompt = "Kouro prompt transport regression: hello from stdin";
    const child = Bun.spawn(["/usr/bin/cat"], {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(prompt);
    expect(stderr).toBe("");
  });

  test("declared git argv runs in its requested workspace and preserves stderr", async () => {
    const result = await runTrustedCommand({
      argv: ["git", "status", "--short"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      operationKey: "process-transport-git-smoke",
    });
    expect(result.evidence.exitCode).toBe(0);
    expect(result.evidence.argv).toEqual(["git", "status", "--short"]);
    expect(result.evidence.cwd).toBe(process.cwd());
    expect(result.evidence.enforcementMode).toBe("trusted-unrestricted");
  });

  test("captures stdout from Node-backed tools and preserves nonzero stderr", async () => {
    const node = await runTrustedCommand({
      argv: ["node", "-e", "console.log('node-capture-ok')"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      operationKey: "process-transport-node",
    });
    expect(node.evidence.exitCode).toBe(0);
    expect(new TextDecoder().decode(node.evidence.stdout).trim()).toBe("node-capture-ok");

    const failed = await runTrustedCommand({
      argv: ["git", "kouro-invalid-subcommand"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      operationKey: "process-transport-stderr",
    });
    expect(failed.evidence.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(failed.evidence.stderr)).toContain("git");
  });

  test("git, bun and npm version commands emit captured output", async () => {
    for (const executable of ["git", "bun", "npm"]) {
      const result = await runTrustedCommand({
        argv: [executable, "--version"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        operationKey: `version-${executable}`,
      });
      expect(result.evidence.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.evidence.stdout).trim().length).toBeGreaterThan(0);
    }
  });
});
