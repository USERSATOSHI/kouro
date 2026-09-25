import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { startScoutBridge } from "../src/adapters/harness/scout-bridge.ts";

test("Codex MCP awaits the host-owned subagent callback used by native tool bridges", async () => {
  const received: unknown[] = [];
  const bridge = await startScoutBridge(async (input) => {
    received.push(input);
    return {
      requestId: input.requestId,
      scoutId: input.subagentId,
      state: "succeeded",
      result: { summary: "found" },
      resultArtifactId: "artifact-1",
      resultDigest: "sha256:test",
    };
  });
  const args = {
    subagentId: "repositoryScout",
    requestId: "request-1",
    input: { task: "inspect", question: "where?" },
  };
  const client = new Client({ name: "kouro-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      process.env.KOURO_SCOUT_CLI_ENTRYPOINT ?? resolve(import.meta.dir, "../src/cli.ts"),
      "__scout_mcp",
    ],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      KOURO_SCOUT_ENDPOINT: bridge.endpoint,
      KOURO_SCOUT_TOKEN: bridge.token,
      KOURO_SCOUT_SCHEMA: JSON.stringify({
        type: "object",
        required: ["subagentId", "requestId", "input"],
        properties: {
          subagentId: { type: "string", enum: ["repositoryScout"] },
          requestId: { type: "string" },
          input: { type: "object" },
        },
      }),
    },
    stderr: "pipe",
  });
  try {
    const denied = await fetch(bridge.endpoint, { method: "POST", body: JSON.stringify(args) });
    expect(denied.status).toBe(404);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((item) => item.name)).toEqual(["subagent"]);
    const result = await client.callTool({ name: "subagent", arguments: args });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("found");
    expect(received).toEqual([args]);
    expect(
      await Bun.file(new URL("../assets/scout-pi-extension.mjs", import.meta.url)).exists(),
    ).toBe(false);
  } finally {
    await client.close();
    await bridge.close();
  }
});
