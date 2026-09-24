import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessDescriptor } from "@kouro/core";
import { CodexCliHarness } from "../src/adapters/harness/codex.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Codex prompt transport", () => {
  test("the adapter sends the entire handoff on stdin to its child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kouro-codex-transport-"));
    dirs.push(dir);
    const capture = join(dir, "captured-prompt.txt");
    const fakeCli = join(dir, "codex");
    writeFileSync(
      fakeCli,
      `#!/bin/sh\ncat > '${capture}'\nprintf '%s\\n' '{"type":"turn.completed"}'\n`,
    );
    chmodSync(fakeCli, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? "/usr/bin:/bin"}`;
    try {
      const descriptor = {
        id: "codex",
        adapterVersion: "test",
        version: "fake",
        availability: "available",
        capabilities: {},
        nativeConfigSchema: { type: "object" },
      } as unknown as HarnessDescriptor;
      const prompt = "A complete prompt with Unicode: नमस्ते and a second line.\nKeep both lines.";
      const result = await new CodexCliHarness(descriptor).run({
        attemptId: "attempt-1",
        role: { id: "planner", prompt },
        selection: { harness: "codex", model: { id: "fake" } },
        cwd: dir,
        timeoutMs: 5_000,
      });
      expect(result.status).toBe("succeeded");
      expect(readFileSync(capture, "utf8")).toBe(prompt);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
