import { expect, test } from "bun:test";
import type { HarnessEvent } from "@kouro/core";
import { emitPiEvent, PiMessages, piUsage } from "../src/adapters/harness/pi.ts";
import { projectSession } from "../../web/src/session";

test("Pi does not present default zero usage as observed telemetry or free cost", () => {
  const zero = { tokens: { input: 0, output: 0, total: 0 }, cost: 0 } as Parameters<
    typeof piUsage
  >[0];
  expect(piUsage(zero).totalTokens).toMatchObject({ value: null, quality: "unavailable" });
  const known = { ...zero, tokens: { ...zero.tokens, input: 20, output: 10, total: 30 } };
  expect(piUsage(known).totalTokens).toMatchObject({ value: 30, quality: "observed" });
  expect(piUsage(known).cost).toMatchObject({ value: null, quality: "unavailable" });
});

test("Pi retains actual text and thinking snapshots across model turns, repairing an incomplete stream", () => {
  const events: HarnessEvent[] = [];
  const activity = new PiMessages((event) => events.push(event));
  activity.consume({ type: "message_start", message: { role: "assistant" } });
  activity.consume({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Read the " },
  });
  activity.consume({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "I will inspect" },
  });
  const first = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Read the source and check exports." },
      { type: "text", text: "I will inspect the repository." },
    ],
  };
  activity.consume({ type: "message_end", message: first });
  activity.consume({ type: "message_end", message: first });
  activity.consume({ type: "message_start", message: { role: "assistant" } });
  activity.consume({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Verification passed." }] },
  });
  const entries = projectSession(
    events.map((event, cursor) => ({
      attemptId: "a",
      cursor,
      event: event as unknown as Record<string, unknown>,
    })),
  );
  expect(entries.filter((entry) => entry.kind === "message").map((entry) => entry.text)).toEqual([
    "Read the source and check exports.",
    "I will inspect the repository.",
    "Verification passed.",
  ]);
});

test("Pi streams actual thinking and tool results without inventing Thinking for SDK bookkeeping", () => {
  const events: HarnessEvent[] = [];
  const emit = (event: HarnessEvent) => events.push(event);
  emitPiEvent({ type: "agent_start" }, emit);
  for (let index = 0; index < 100; index++) {
    emitPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "x" } },
      emit,
    );
    emitPiEvent({ type: "message_start" }, emit);
    emitPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
      emit,
    );
  }
  for (const delta of ["Check", "", " the files"])
    emitPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } },
      emit,
    );
  emitPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    },
    emit,
  );
  emitPiEvent(
    {
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "README contents" }] },
    },
    emit,
  );
  emitPiEvent({ type: "message_end" }, emit);
  emitPiEvent({ type: "entry_appended" }, emit);
  emitPiEvent({ type: "agent_end" }, emit);
  expect(events).toHaveLength(5);
  expect(events.map((event) => event.data)).toMatchObject([
    { status: "Working" },
    { channel: "thinking", text: "Check" },
    { channel: "thinking", text: " the files" },
    { id: "read-1", name: "read", status: "running", input: { path: "README.md" } },
    { id: "read-1", status: "completed", output: { content: [{ text: "README contents" }] } },
  ]);
});

test("Pi retry and compaction observations retain failure details", () => {
  const events: HarnessEvent[] = [];
  emitPiEvent({ type: "auto_retry_start", attempt: 1, errorMessage: "Unavailable" }, (event) =>
    events.push(event),
  );
  emitPiEvent({ type: "compaction_end", errorMessage: "Compaction failed" }, (event) =>
    events.push(event),
  );
  expect(events.map((event) => event.data)).toEqual([
    { status: "Retrying model request", attempt: 1, detail: "Unavailable", level: "warn" },
    { status: "Context compaction finished", detail: "Compaction failed", level: "warn" },
  ]);
});
