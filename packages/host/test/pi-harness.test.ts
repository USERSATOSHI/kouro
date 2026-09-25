import { describe, expect, test } from "bun:test";
import { inspectPi, piNativeConfig, resolvePiSelection } from "../src/adapters/harness/pi.ts";

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

  test("discovers Pi through the SDK without requiring the Pi CLI", async () => {
    const descriptor = await inspectPi();
    expect(descriptor.id).toBe("pi");
    expect(descriptor.adapterVersion).toBe("sdk");
    expect(descriptor.availability).toBe("available");
    expect(descriptor.capabilities["awaited-subagent-tool"]?.state).toBe("supported");
  });
});
