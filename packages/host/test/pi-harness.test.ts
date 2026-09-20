import { describe, expect, test } from "bun:test";
import {
  PiCliHarness,
  PiHarnessAdapter,
  inspectPi,
  parsePiRpcLine,
  piNativeConfig,
  resolvePiSelection,
  type PiRpcProcess,
  type PiRpcSpawn,
} from "../src/adapters/harness/pi.ts";

const fakeProcess = (args: string[], output: string, code = 0): PiRpcProcess => ({
  stdin: { write: () => undefined, end: () => undefined },
  stdout: new Response(output).body!,
  stderr: new Response("").body!,
  exited: Promise.resolve(code),
});
const spawnFor =
  (output: string, code = 0): PiRpcSpawn =>
  (args) =>
    fakeProcess(args, output, code);
const descriptor = await inspectPi((args) => fakeProcess(args, ""));

describe("Pi native RPC adapter", () => {
  test("selects optional Kouro profile env values without splitting provider URLs", () => {
    const resolved = resolvePiSelection(
      { harnessId: "pi", model: { id: "" } },
      {},
      { KOURO_PI_PROVIDER: "llama-server=http://models:8080", KOURO_PI_MODEL: "qwen-0.8b" },
    );
    expect(resolved).toEqual({
      provider: "llama-server=http://models:8080",
      model: "qwen-0.8b",
    });
    expect(resolvePiSelection({ harnessId: "pi", model: { id: "" } }, {}, {})).toEqual({});
    expect(
      resolvePiSelection(
        { harnessId: "pi", model: { id: "" } },
        {},
        { KOURO_PI_MODEL: "qwen36-35b-a3b-256k-vision-mtp" },
      ),
    ).toEqual({ model: "qwen36-35b-a3b-256k-vision-mtp" });
  });

  test("parses strict JSONL and redacts/checksums native config", () => {
    expect(parsePiRpcLine('{"type":"response","id":"a"}\r')).toEqual({ type: "response", id: "a" });
    expect(parsePiRpcLine("not-json")).toBeUndefined();
    const config = piNativeConfig({ model: "local", token: "do-not-store" });
    expect(config.token).toBe("[REDACTED]");
    expect(config.checksum).toMatch(/^sha256:/);
  });

  test("maps streamed text and observed usage without a model call", async () => {
    const output =
      [
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"},"usage":{"input":2,"output":3}}',
        '{"type":"message_end","message":{"text":"{\\"ok\\":true}"}}',
        '{"type":"agent_settled"}',
      ].join("\n") + "\n";
    const result = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      spawnFor(output),
    ).run({
      attemptId: "a",
      role: { id: "r", prompt: "read" },
      selection: { harnessId: "pi", model: { id: "local" } },
      cwd: ".",
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ ok: true });
    expect(result.usage.inputTokens.value).toBe(2);
    expect(result.events.some((event) => event.type === "text")).toBe(true);
  });

  test("accepts a JSON object wrapped in a markdown fence", async () => {
    const output =
      [
        '{"type":"message_end","message":{"text":"```json\\n{\\"ok\\":true}\\n```"}}',
        '{"type":"agent_settled"}',
      ].join("\n") + "\n";
    const result = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      spawnFor(output),
    ).run({
      attemptId: "fenced",
      role: { id: "r", prompt: "read", outputSchema: { type: "object", required: ["ok"] } },
      selection: { harnessId: "pi", model: { id: "local" } },
      cwd: ".",
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ ok: true });
  });

  test("ends a persistent RPC process after agent_settled", async () => {
    let stopped = false;
    let finish!: (code: number) => void;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const process: PiRpcProcess = {
      stdin: {
        write: (value: string) => {
          if (value.includes('"get_session_stats"')) {
            streamController.enqueue(
              new TextEncoder().encode(
                '{"type":"response","command":"get_session_stats","data":{"tokens":{"input":7,"output":3,"total":10}}}\n',
              ),
            );
          }
        },
        end: () => undefined,
      },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            new TextEncoder().encode(
              '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"ok\\":true}"}],"usage":{"input":7,"output":3,"totalTokens":10}}}\n{"type":"agent_settled"}\n',
            ),
          );
        },
      }),
      stderr: new Response("").body!,
      exited: new Promise<number>((resolve) => {
        finish = resolve;
      }),
      kill: () => {
        stopped = true;
        finish(143);
      },
    };
    const result = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      () => process,
    ).run({
      attemptId: "persistent",
      role: { id: "r", prompt: "Return JSON", outputSchema: { type: "object", required: ["ok"] } },
      selection: { harnessId: "pi", model: { id: "local" } },
      cwd: ".",
    });
    expect(stopped).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ ok: true });
    expect(result.usage.totalTokens.value).toBe(10);
  });

  test("keeps the timeout active while waiting for missing session stats", async () => {
    let finish!: (code: number) => void;
    const process: PiRpcProcess = {
      stdin: { write: () => undefined, end: () => undefined },
      stdout: new Response(
        '{"type":"message_end","message":{"text":"{\\"ok\\":true}"}}\n{"type":"agent_settled"}\n',
      ).body!,
      stderr: new Response("").body!,
      exited: new Promise<number>((resolve) => {
        finish = resolve;
      }),
      kill: () => finish(143),
    };
    const result = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      () => process,
    ).run({
      attemptId: "stats-timeout",
      role: { id: "r", prompt: "Return JSON" },
      selection: {
        harnessId: "pi",
        model: { id: "local" },
        nativeConfig: { timeoutMs: 5 },
      },
      cwd: ".",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("timed out");
  });

  test("does not turn an all-zero stats response into observed usage", async () => {
    const output =
      [
        '{"type":"message_end","message":{"text":"{\\"ok\\":true}"}}',
        '{"type":"agent_settled"}',
        '{"type":"response","command":"get_session_stats","data":{"tokens":{"input":0,"output":0,"total":0}}}',
      ].join("\n") + "\n";
    const result = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      spawnFor(output),
    ).run({
      attemptId: "zero-stats",
      role: { id: "r", prompt: "Return JSON" },
      selection: { harnessId: "pi", model: { id: "local" } },
      cwd: ".",
    });
    expect(result.status).toBe("succeeded");
    expect(result.usage.totalTokens.value).toBeNull();
    expect(result.usage.totalTokens.quality).toBe("unavailable");
  });

  test("forwards selected model/context and uses only the read tool", async () => {
    let argv: string[] = [];
    let request = "";
    const spawn: PiRpcSpawn = (args) => {
      argv = args;
      return {
        ...fakeProcess(args, '{"type":"agent_settled"}\n'),
        stdin: {
          write: (value: string) => {
            request += value;
          },
        },
      };
    };
    await new PiCliHarness({ ...descriptor, availability: "available" }, spawn).run({
      attemptId: "ctx",
      role: { id: "r", prompt: "handoff" },
      selection: { harnessId: "pi", model: { id: "llama.cpp/qwen" } },
      cwd: ".",
      context: {
        version: 1,
        attemptId: "ctx",
        segments: [],
        tools: [],
        hiddenNativeContext: "unavailable",
        digest: "sha256:x",
      },
    });
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read");
    expect(argv).not.toContain("--no-tools");
    expect(argv[argv.indexOf("--provider") + 1]).toBe("llama.cpp");
    expect(request).toContain("[KOURO_CONTEXT_BEGIN]");
    expect(request).toContain("[KOURO_HANDOFF_BEGIN]");
  });

  test("forwards profile env provider and model exactly", async () => {
    const previousProvider = Bun.env.KOURO_PI_PROVIDER;
    const previousModel = Bun.env.KOURO_PI_MODEL;
    Bun.env.KOURO_PI_PROVIDER = "llama-server=http://models:8080";
    Bun.env.KOURO_PI_MODEL = "qwen-0.8b";
    try {
      let argv: string[] = [];
      const spawn: PiRpcSpawn = (args) => {
        argv = args;
        return fakeProcess(args, '{"type":"agent_settled"}\n');
      };
      await new PiCliHarness({ ...descriptor, availability: "available" }, spawn).run({
        attemptId: "env",
        role: { id: "r", prompt: "read" },
      selection: { harnessId: "pi", model: { id: "" } },
        cwd: ".",
      });
      expect(argv[argv.indexOf("--provider") + 1]).toBe("llama-server=http://models:8080");
      expect(argv[argv.indexOf("--model") + 1]).toBe("qwen-0.8b");
    } finally {
      if (previousProvider === undefined) delete Bun.env.KOURO_PI_PROVIDER;
      else Bun.env.KOURO_PI_PROVIDER = previousProvider;
      if (previousModel === undefined) delete Bun.env.KOURO_PI_MODEL;
      else Bun.env.KOURO_PI_MODEL = previousModel;
    }
  });

  test("reports invalid structured output and process death truthfully", async () => {
    const bad = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      spawnFor('{"type":"agent_settled"}\n'),
    ).run({
      attemptId: "a",
      role: { id: "r", prompt: "read", outputSchema: { type: "object", required: ["ok"] } },
      selection: { harnessId: "pi", model: { id: "local" } },
      cwd: ".",
    });
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("invalid-output");
    const dead = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      spawnFor("", 9),
    ).run({
      attemptId: "a",
      role: { id: "r", prompt: "read" },
      selection: { harnessId: "pi", model: { id: "local" } },
      cwd: ".",
    });
    expect(dead.status).toBe("failed");
    expect(dead.error).toContain("exited 9");
  });

  test("supports explicit abort and reports unavailable capability", async () => {
    const controller = new AbortController();
    const result = await new PiCliHarness(
      { ...descriptor, availability: "available" },
      spawnFor('{"type":"agent_settled"}\n'),
    ).run({
      attemptId: "a",
      role: { id: "r", prompt: "read" },
      selection: { harnessId: "pi", model: { id: "local" } },
      cwd: ".",
      signal: controller.signal,
    });
    expect(result.status).toBe("succeeded");
    expect((await inspectPi((args) => fakeProcess(args, "", 1))).availability).toBe("unavailable");
    expect(
      new PiHarnessAdapter(
        new PiCliHarness({ ...descriptor, availability: "unavailable" }),
      ).capabilities().resume,
    ).toBe("unsupported");
    controller.abort();
  });
});
