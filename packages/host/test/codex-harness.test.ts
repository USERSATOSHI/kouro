import { expect, test } from "bun:test";
import { codexAppServerUsage, inspectCodex } from "../src/adapters/harness/codex.ts";

test("App Server usage uses reported thread totals across tool continuations, preserving zero and unknown cost", () => {
  const usage = codexAppServerUsage({
    total: { inputTokens: 400, outputTokens: 60, totalTokens: 460 },
    last: { inputTokens: 40, outputTokens: 6, totalTokens: 46 },
  });
  expect(usage).toMatchObject({
    inputTokens: { value: 400, quality: "observed" },
    outputTokens: { value: 60 },
    totalTokens: { value: 460 },
    cost: { value: null, quality: "unavailable" },
  });
  expect(
    codexAppServerUsage({ total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })?.totalTokens
      .value,
  ).toBe(0);
  expect(codexAppServerUsage({})).toBeUndefined();
  expect(
    codexAppServerUsage({ total: { inputTokens: -1, outputTokens: 2, totalTokens: 1 } }),
  ).toBeUndefined();
});

test("Codex bridge discovers its bundled runtime without starting a turn", async () => {
  const descriptor = await inspectCodex();
  expect(descriptor.id).toBe("codex");
  expect(descriptor.adapterVersion).toBe("app-server");
  expect(descriptor.availability).toBe("available");
  expect(descriptor.capabilities.cancel.state).toBe("supported");
});
