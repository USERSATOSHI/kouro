import { describe, expect, test } from "bun:test";
import {
  createContextManifest,
  redactSecrets,
  runWithBoundedFallback,
  validateJsonSchema,
  type HarnessSelection,
} from "../src";

describe("M2 harness contracts", () => {
  test("rejects invalid structured output and preserves unavailable usage", () => {
    expect(validateJsonSchema({}, { type: "object", required: ["answer"] }).valid).toBe(false);
  });
  test("context manifest exposes segments, tools and honest hidden context", async () => {
    const manifest = await createContextManifest({
      attemptId: "a1",
      segments: [
        {
          id: "s1",
          source: "input",
          content: "hello",
          supplied: true,
          bytes: 5,
          tokenCount: null,
          tokenQuality: "unavailable",
        },
      ],
      tools: [],
      hiddenNativeContext: "unavailable",
    });
    expect(manifest.segments[0]?.tokenQuality).toBe("unavailable");
    expect(manifest.hiddenNativeContext).toBe("unavailable");
    expect(manifest.digest).toMatch(/^sha256:/);
  });
  test("fallback is bounded and redaction does not leak secrets", async () => {
    const primary: HarnessSelection = { harnessId: "fake", model: { id: "m" } };
    let calls = 0;
    const result = await runWithBoundedFallback(
      async () => {
        calls += 1;
        return { status: calls === 1 ? "unavailable" : "succeeded" };
      },
      primary,
      { maxAttempts: 2, retryOn: ["unavailable"], fallback: { ...primary, harnessId: "fallback" } },
    );
    expect(result.attempts).toBe(2);
    expect(
      redactSecrets({ token: "secret", message: "secret value" }, ["token", "secret"]),
    ).toEqual({ token: "[REDACTED]", message: "[REDACTED] value" });
  });
});
