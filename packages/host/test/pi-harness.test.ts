import { describe, expect, test } from "bun:test";
import {
  inspectPi,
  piNativeConfig,
  resolvePiModel,
  resolvePiSelection,
} from "../src/adapters/harness/pi.ts";

describe("Pi SDK adapter", () => {
  test("selects optional Kouro profile env values without splitting provider URLs", () => {
    const resolved = resolvePiSelection(
      { harness: "pi", model: { id: "" } },
      {},
      { KOURO_PI_PROVIDER: "llama-server=http://models:8080", KOURO_PI_MODEL: "qwen-0.8b" },
    );
    expect(resolved).toEqual({
      provider: "llama-server=http://models:8080",
      model: "qwen-0.8b",
    });
    expect(resolvePiSelection({ harness: "pi", model: { id: "" } }, {}, {})).toEqual({});
    expect(
      resolvePiSelection(
        { harness: "pi", model: { id: "" } },
        {},
        { KOURO_PI_MODEL: "qwen36-35b-a3b-256k-vision-mtp" },
      ),
    ).toEqual({ model: "qwen36-35b-a3b-256k-vision-mtp" });
  });

  test("redacts and checksums Pi native config", () => {
    const config = piNativeConfig({ model: "local", token: "do-not-store" });
    expect(config.token).toBe("[REDACTED]");
    expect(config.checksum).toMatch(/^sha256:/);
  });

  test("an explicit local model wins over profile environment defaults", () => {
    expect(
      resolvePiSelection(
        { harness: "pi", model: { id: "llama.cpp/loaded-local" } },
        {},
        { KOURO_PI_PROVIDER: "opencode", KOURO_PI_MODEL: "remote-default" },
      ),
    ).toEqual({ provider: "llama.cpp", model: "loaded-local" });
  });

  test("discovers a cold local catalog and refuses a cross-provider fallback for a stale default", async () => {
    type Runtime = Parameters<typeof resolvePiModel>[0];
    const local: NonNullable<ReturnType<Runtime["getModel"]>> = {
      id: "loaded-local",
      name: "Local",
      provider: "llama.cpp",
      api: "openai-completions",
      baseUrl: "http://models:8080/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 2048,
    };
    let discovered = false;
    let fallbackReads = 0;
    let refreshes = 0;
    const provider: NonNullable<ReturnType<Runtime["getProvider"]>> = {
      id: local.provider,
      name: "Local",
      auth: {},
      getModels: () => (discovered ? [local] : []),
      stream() {
        throw new Error("unused");
      },
      streamSimple() {
        throw new Error("unused");
      },
      async refreshModels(options) {
        expect(options.allowNetwork).toBe(true);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(
          options.credential?.type === "api_key" && options.credential.env?.LLAMA_BASE_URL,
        ).toBe("http://models:8080");
        discovered = true;
        refreshes++;
      },
    };
    const runtime: Runtime = {
      getProvider(id) {
        expect(id).toBe(local.provider);
        return provider;
      },
      getAuth: async () => ({
        auth: { apiKey: "local" },
        env: { LLAMA_BASE_URL: "http://models:8080" },
      }),
      getModels: (provider) => (discovered && provider === local.provider ? [local] : []),
      getModel: (provider, id) =>
        discovered && provider === local.provider && id === local.id ? local : undefined,
      async getAvailable() {
        fallbackReads++;
        return [{ ...local, provider: "remote" }];
      },
    };
    const defaults = {
      getDefaultProvider: () => "llama.cpp",
      getDefaultModel: () => "unloaded-default",
    };
    await expect(resolvePiModel(runtime, {}, defaults)).rejects.toThrow(
      /unloaded-default.*Available models: llama.cpp\/loaded-local/,
    );
    expect(
      await resolvePiModel(runtime, { provider: "llama.cpp", model: local.id }, defaults),
    ).toEqual(local);
    expect(refreshes).toBe(2);
    expect(fallbackReads).toBe(0);
    provider.refreshModels = async () => {
      throw new Error("router unreachable");
    };
    await expect(
      resolvePiModel(runtime, { provider: "llama.cpp", model: local.id }, defaults),
    ).rejects.toThrow(/local model discovery failed: router unreachable/);
  });

  test("discovers Pi through the SDK without requiring the Pi CLI", async () => {
    const descriptor = await inspectPi();
    expect(descriptor.id).toBe("pi");
    expect(descriptor.adapterVersion).toBe("sdk");
    expect(descriptor.availability).toBe("available");
    expect(descriptor.capabilities["awaited-subagent-tool"]?.state).toBe("supported");
  });
});
