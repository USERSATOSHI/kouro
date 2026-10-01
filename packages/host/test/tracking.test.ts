import { expect, test } from "bun:test";
import type { HarnessEvent } from "@kouro/core";
import type { HarnessAdapter } from "../src/types";
import { TrackingHarnessDecorator } from "../src/adapters/harness/tracking";

test("tracking preserves repeated deltas and structured subagent text without replaying returned events", async () => {
  const at = "2026-10-01T00:00:00Z";
  const events: HarnessEvent[] = [
    { type: "text", at, data: "ha" },
    { type: "text", at, data: "ha" },
    { type: "text", at, data: { text: "child", scoutId: "reviewer", requestId: "r" } },
    { type: "text", at, data: { id: "m1", text: "first " } },
    { type: "text", at, data: { id: "m1", text: "reply" } },
    { type: "text", at, data: { id: "m2", text: "second reply" } },
    { type: "text", at, data: { id: "m2", mode: "snapshot", text: "second reply completed" } },
    { type: "tool", at, data: { id: "tool", status: "started" } },
    { type: "tool", at, data: { id: "tool", status: "started" } },
  ];
  const inner: HarnessAdapter = {
    id: "scripted",
    adapterVersion: "test",
    capabilities: () => ({}),
    run: async (input) => {
      for (const event of events) input.onEvent?.(event);
      return { status: "succeeded", output: {}, usage: {}, events: events as never[] };
    },
  };
  const observed: HarnessEvent[] = [];
  const result = await new TrackingHarnessDecorator(inner, (event) => observed.push(event)).run({
    runId: "r",
    invocationId: "i",
    role: "test",
    prompt: "test",
    delayMs: 0,
  });
  expect(observed.filter((event) => event.type === "text").map((event) => event.data)).toEqual([
    "haha",
    { text: "child", scoutId: "reviewer", requestId: "r" },
    { id: "m1", text: "first reply" },
    { id: "m2", text: "second reply" },
    { id: "m2", mode: "snapshot", text: "second reply completed" },
  ]);
  expect(observed.filter((event) => event.type === "tool")).toHaveLength(2);
  expect(result.events).toEqual(observed);
});
