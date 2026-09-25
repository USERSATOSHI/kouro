import { expect, test } from "bun:test";
import { inspectCodex } from "../src/adapters/harness/codex.ts";

test("Codex SDK discovers its bundled runtime without starting a turn", async () => {
  const descriptor = await inspectCodex();
  expect(descriptor.id).toBe("codex");
  expect(descriptor.adapterVersion).toBe("sdk");
  expect(descriptor.availability).toBe("available");
  expect(descriptor.capabilities.cancel.state).toBe("supported");
});
