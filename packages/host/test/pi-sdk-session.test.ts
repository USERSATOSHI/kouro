import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inspectPi, PiHarnessAdapter, PiSdkHarness } from "../src/adapters/harness/pi.ts";

test("real Pi SDK discovers a local model, activates subagent tools and consumes their output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kouro-pi-sdk-"));
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  const marker = `LOCAL_${randomUUID()}`;
  let calls = 0;
  let discoveries = 0;
  let delegated = false;
  let stall = false;
  let stallDiscovery = false;
  const requests: Array<Record<string, any>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/models") {
        discoveries++;
        if (stallDiscovery)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":['));
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        return Response.json({
          data: [
            {
              id: "loaded-local",
              status: { value: "loaded" },
              architecture: { input_modalities: ["text"] },
            },
          ],
        });
      }
      if (new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response("missing", { status: 404 });
      const body = (await request.json()) as Record<string, any>;
      requests.push(body);
      calls++;
      if (stall)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"stall","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const toolReply = body.messages.find((message: { role: string }) => message.role === "tool");
      const delta = toolReply
        ? { role: "assistant", content: JSON.stringify({ summary: marker }) }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "local-call",
                type: "function",
                function: {
                  name: "subagent",
                  arguments: JSON.stringify({
                    subagentId: "reviewer",
                    requestId: "local-review",
                    input: { task: "inspect" },
                  }),
                },
              },
            ],
          };
      const chunks = [
        {
          id: "local-response",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          id: "local-response",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: toolReply ? "stop" : "tool_calls" }],
        },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    process.env.PI_CODING_AGENT_DIR = directory;
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({
        "llama.cpp": {
          type: "api_key",
          env: { LLAMA_BASE_URL: `http://127.0.0.1:${server.port}` },
        },
      }),
    );
    writeFileSync(
      join(directory, "settings.json"),
      JSON.stringify({ defaultProvider: "llama.cpp", defaultModel: "stale-default" }),
    );
    const adapter = new PiHarnessAdapter(new PiSdkHarness(await inspectPi()));
    const result = await adapter.run({
      runId: "local-sdk",
      invocationId: "local-parent",
      role: "planner",
      modelId: "llama.cpp/loaded-local",
      prompt: "Call reviewer, then copy its summary.",
      timeoutMs: 10000,
      delayMs: 0,
      cwd: directory,
      outputSchema: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
      context: {
        version: 1,
        attemptId: "local-parent",
        segments: [],
        hiddenNativeContext: "unavailable",
        digest: "sha256:fixture",
        tools: [
          {
            name: "subagent",
            description: "Call reviewer",
            inputSchema: { type: "object" },
            enabled: true,
          },
        ],
      },
      collaboration: {
        participantId: "planner",
        send_message: () => {
          throw new Error("unused");
        },
        publish_blackboard: () => {
          throw new Error("unused");
        },
        wait: () => null,
        subagent: async (input) => {
          delegated = true;
          expect(input).toMatchObject({ subagentId: "reviewer", requestId: "local-review" });
          return {
            requestId: input.requestId,
            scoutId: input.subagentId,
            state: "succeeded",
            result: { summary: marker },
            resultArtifactId: "local-report",
            resultDigest: "sha256:report",
          };
        },
      },
    });
    expect({ status: result.status, error: result.error }).toMatchObject({ status: "succeeded" });
    expect(result.output).toEqual({ summary: marker });
    expect(delegated).toBe(true);
    expect(calls).toBe(2);
    expect(discoveries).toBe(1);
    expect(
      requests[0]!.tools.map((tool: { function: { name: string } }) => tool.function.name),
    ).toContain("subagent");
    expect(
      requests[1]!.messages.find((message: { role: string }) => message.role === "tool").content,
    ).toContain(marker);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        data: { status: "Model selected", provider: "llama.cpp", modelId: "loaded-local" },
      }),
    );
    const stale = await adapter.run({
      runId: "local-sdk",
      invocationId: "stale",
      role: "planner",
      prompt: "Never dispatch this",
      timeoutMs: 10000,
      delayMs: 0,
      cwd: directory,
    });
    expect(stale.status).toBe("failed");
    expect(stale.error).toContain("stale-default");
    expect(stale.error).toContain("Available models: llama.cpp/loaded-local");
    expect(calls).toBe(2);
    stall = true;
    const timed = await adapter.run({
      runId: "local-sdk",
      invocationId: "timed",
      role: "planner",
      prompt: "Wait",
      modelId: "llama.cpp/loaded-local",
      timeoutMs: 250,
      delayMs: 0,
      cwd: directory,
    });
    expect(timed.status).toBe("failed");
    expect(timed.error).toBe("pi timed out after 250ms");
    stallDiscovery = true;
    const discoveryStarted = performance.now();
    const discoveryTimeout = await adapter.run({
      runId: "local-sdk",
      invocationId: "discovery-timeout",
      role: "planner",
      prompt: "Never dispatch this",
      modelId: "llama.cpp/loaded-local",
      timeoutMs: 250,
      delayMs: 0,
      cwd: directory,
    });
    expect(discoveryTimeout.status).toBe("failed");
    expect(discoveryTimeout.error).toBe("pi timed out after 250ms");
    expect(performance.now() - discoveryStarted).toBeLessThan(2000);
    expect(calls).toBe(3);
  } finally {
    server.stop(true);
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
