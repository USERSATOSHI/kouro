import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalCliHarnessAdapter } from "../src/adapters/harness/external-cli.ts";
import type { HarnessDescriptor } from "@kouro/core";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("external CLI stdout and stderr become live normalized activity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kouro-cli-stream-"));
  directories.push(directory);
  const executable = join(directory, "fake-opencode");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' \'{"type":"text","part":{"text":"first output"}}\'',
      "sleep 0.15",
      'printf \'%s\\n\' \'{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"call-1","state":{"status":"running"}}}\'',
      "printf '%s\\n' 'provider diagnostic' >&2",
      'printf \'%s\\n\' \'{"type":"text","part":{"text":"final output"}}\'',
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  const prior = process.env.KOURO_OPENCODE_BIN;
  process.env.KOURO_OPENCODE_BIN = executable;
  const descriptor: HarnessDescriptor = {
    id: "opencode",
    adapterVersion: "1",
    version: "test",
    availability: "available",
    capabilities: {
      "structured-output": { state: "supported" },
      cancel: { state: "supported" },
      resume: { state: "unsupported" },
      reattach: { state: "unsupported" },
      tools: { state: "conditional" },
      usage: { state: "unsupported" },
      "cost-cap": { state: "unsupported" },
    },
    nativeConfigSchema: { type: "object", additionalProperties: true },
  };
  try {
    const adapter = new ExternalCliHarnessAdapter("opencode", descriptor);
    const events: import("@kouro/core").HarnessEvent[] = [];
    let settled = false;
    let firstText!: () => void;
    const observed = new Promise<void>((resolve) => {
      firstText = resolve;
    });
    const run = adapter
      .run({
        runId: "run",
        invocationId: "invocation",
        attemptId: "attempt",
        role: "implementer",
        prompt: "work",
        delayMs: 0,
        cwd: directory,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "text" && String(event.data).includes("first output")) firstText();
        },
      })
      .finally(() => {
        settled = true;
      });
    await observed;
    expect(settled).toBe(false);
    const result = await run;
    expect(result.status).toBe("succeeded");
    expect(events.some((event) => event.type === "tool")).toBe(true);
    expect(
      events.some(
        (event) => event.type === "log" && JSON.stringify(event).includes("provider diagnostic"),
      ),
    ).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.KOURO_OPENCODE_BIN;
    else process.env.KOURO_OPENCODE_BIN = prior;
  }
});
