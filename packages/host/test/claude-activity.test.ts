import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { eventsFrom } from "../src/adapters/harness/claude-agent-sdk";
import { ClaudeMessages } from "../src/adapters/harness/claude-messages";
import { projectSession } from "../../web/src/session";
import type { HarnessEvent } from "@kouro/core";

test("Claude live and retained activity show complete text and thinking across separate native blocks", () => {
  const messages = [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Inspect the source." },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "I found " },
      },
    },
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "thinking", thinking: "Inspect the source. Verify its exports." },
          { type: "text", text: "I found the public API." },
        ],
      },
    },
    {
      type: "assistant",
      message: { id: "m2", content: [{ type: "text", text: "The docs are ready." }] },
    },
  ];
  const live: HarnessEvent[] = [];
  const normalizer = new ClaudeMessages((event) => live.push(event));
  messages.forEach((message) => normalizer.consume(message));
  const render = (events: HarnessEvent[]) =>
    projectSession(
      events.map((event, cursor) => ({
        attemptId: "a",
        cursor,
        event: event as unknown as Record<string, unknown>,
      })),
    );
  const retained = eventsFrom(messages as unknown as SDKMessage[]);
  expect(render(live)).toEqual(render(retained));
  expect(
    render(live)
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.text),
  ).toEqual([
    "Inspect the source. Verify its exports.",
    "I found the public API.",
    "The docs are ready.",
  ]);
});

test("Claude thinking and tool results survive retained activity normalization without duplicate thinking", () => {
  const messages = [
    { type: "stream_event", event: { type: "message_start" } },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Inspecting the files" },
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Inspecting the files" },
          { type: "tool_use", id: "read", name: "Read", input: { path: "src/app.ts" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "read",
            content: [{ type: "text", text: "File contents" }],
          },
        ],
      },
    },
  ] as unknown as SDKMessage[];
  const events = eventsFrom(messages);
  expect(events.filter((event) => event.type === "log")).toHaveLength(1);
  expect(events[0].data).toMatchObject({ channel: "thinking", text: "Inspecting the files" });
  expect(events.filter((event) => event.type === "tool").map((event) => event.data)).toMatchObject([
    { id: "read", name: "Read", input: { path: "src/app.ts" } },
    { id: "read", status: "completed", output: [{ type: "text", text: "File contents" }] },
  ]);
});
