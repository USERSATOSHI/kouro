import { expect, test } from "bun:test";
import type { Options, query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkHarnessAdapter } from "../src/adapters/harness/claude-agent-sdk";

test("Claude exposes the native preset, allows granted search and terminal tools, and rejects native delegation", async () => {
  let options: Options | undefined;
  const provider: typeof query = (args) => {
    options = args.options;
    return (async function* () {
      yield { type: "result", subtype: "success", result: '{"summary":"done"}' } as SDKMessage;
    })() as ReturnType<typeof query>;
  };
  const adapter = new ClaudeAgentSdkHarnessAdapter(provider);
  const input = {
    runId: "fixture",
    invocationId: "parent",
    role: "researcher",
    prompt: "Research",
    delayMs: 0,
  };
  const granted = await adapter.run({
    ...input,
    nativeConfig: {
      toolPolicy: { write: true, terminal: true, network: true, child: false },
    },
  });
  expect(granted.status).toBe("succeeded");
  expect(options!.tools).toEqual({ type: "preset", preset: "claude_code" });
  const check = async (name: string) => {
    const decision = await options!.canUseTool!(
      name,
      {},
      {
        signal: new AbortController().signal,
        toolUseID: "tool",
        requestId: "fixture-request",
      },
    );
    if (!decision) throw new Error("The workflow tool policy must return a permission decision.");
    return decision;
  };
  for (const name of ["WebSearch", "WebFetch", "Bash", "Write", "NotebookEdit"])
    expect((await check(name)).behavior).toBe("allow");
  for (const name of ["Agent", "Task"]) expect((await check(name)).behavior).toBe("deny");

  await adapter.run({
    ...input,
    nativeConfig: {
      permissionMode: "acceptEdits",
      toolPolicy: { write: true, terminal: true, network: true, child: true },
    },
  });
  for (const name of [
    "WebSearch",
    "WebFetch",
    "Bash",
    "Write",
    "Edit",
    "NotebookEdit",
    "Agent",
    "Task",
  ])
    expect((await check(name)).behavior).toBe("deny");
  expect((await check("Read")).behavior).toBe("allow");
});
