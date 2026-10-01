import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { eventsFrom } from "../src/adapters/harness/claude-agent-sdk";

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
