import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  let toolMode: "subagent" | "native" | "plain" = "subagent";
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
      const delta =
        toolReply || toolMode === "plain"
          ? { role: "assistant", content: JSON.stringify({ summary: marker }) }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "local-call",
                  type: "function",
                  function: {
                    name: toolMode === "native" ? "write" : "subagent",
                    arguments: JSON.stringify(
                      toolMode === "native"
                        ? {
                            path: "native-write.txt",
                            content: marker,
                          }
                        : {
                            subagentId: "reviewer",
                            requestId: "local-review",
                            input: { task: "inspect" },
                          },
                    ),
                  },
                },
                ...(toolMode === "native"
                  ? [
                      {
                        index: 1,
                        id: "native-shell",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: "printf native > native-execution.txt",
                          }),
                        },
                      },
                    ]
                  : []),
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
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: toolReply || toolMode === "plain" ? "stop" : "tool_calls",
            },
          ],
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
    expect(requests[0]!.stream_options).toEqual({ include_usage: true });
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
    stall = false;
    stallDiscovery = false;
    toolMode = "native";
    const nativeInput = {
      runId: "local-sdk",
      invocationId: "native",
      role: "implementer",
      prompt: "Use native tools",
      timeoutMs: 10000,
      delayMs: 0,
      cwd: directory,
      modelId: "llama.cpp/loaded-local",
      nativeConfig: { toolPolicy: { write: true, terminal: true, network: false, child: false } },
    };
    const native = await adapter.run(nativeInput);
    expect({ status: native.status, error: native.error }).toMatchObject({ status: "succeeded" });
    expect(readFileSync(join(directory, "native-write.txt"), "utf8")).toBe(marker);
    expect(readFileSync(join(directory, "native-execution.txt"), "utf8")).toBe("native");
    toolMode = "plain";
    await adapter.run({
      ...nativeInput,
      invocationId: "child",
      nativeConfig: {
        toolPolicy: { write: true, terminal: true, network: true, child: true },
      },
    });
    const childTools = requests
      .at(-1)!
      .tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(childTools).toContain("read");
    for (const name of ["bash", "edit", "write", "subagent"])
      expect(childTools).not.toContain(name);

    // The loaded llama.cpp catalog is non-reasoning in this Pi SDK. Explicit
    // effort must fail before inference instead of silently becoming "off".
    const callsBeforeRejection = calls;
    const unsupported = await adapter.run({
      ...nativeInput,
      invocationId: "unsupported-effort",
      nativeConfig: { effort: "high" },
    });
    expect(unsupported.status).toBe("failed");
    expect(unsupported.error).toContain("effective level would be off");
    expect(calls).toBe(callsBeforeRejection);

    writeFileSync(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          "effort-fixture": {
            api: "openai-completions",
            apiKey: "fixture",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            models: [
              {
                id: "reasoning-model",
                reasoning: true,
                contextWindow: 4096,
                maxTokens: 1024,
                compat: { supportsReasoningEffort: true },
              },
            ],
          },
        },
      }),
    );
    const configured = await adapter.run({
      ...nativeInput,
      invocationId: "explicit-effort",
      modelId: "effort-fixture/reasoning-model",
      nativeConfig: { effort: "high" },
    });
    expect({ status: configured.status, error: configured.error }).toMatchObject({
      status: "succeeded",
    });
    expect(requests.at(-1)!.reasoning_effort).toBe("high");
    const requestsBeforeClamp = requests.length;
    const clamped = await adapter.run({
      ...nativeInput,
      invocationId: "clamped-effort",
      modelId: "effort-fixture/reasoning-model",
      nativeConfig: { effort: "max" },
    });
    expect(clamped.status).toBe("failed");
    expect(clamped.error).toContain("effective level would be high");
    expect(requests).toHaveLength(requestsBeforeClamp);
  } finally {
    server.stop(true);
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
