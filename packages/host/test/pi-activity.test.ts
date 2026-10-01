import { expect, test } from "bun:test";
import type { HarnessEvent } from "@kouro/core";
import { emitPiEvent } from "../src/adapters/harness/pi.ts";

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
    { status: "Retrying model request", attempt: 1, detail: "Unavailable" },
    { status: "Context compaction finished", detail: "Compaction failed" },
  ]);
});
