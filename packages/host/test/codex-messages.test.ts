import { expect, test } from "bun:test";
import type { HarnessEvent } from "@kouro/core";
import { CodexMessages } from "../src/adapters/harness/codex-messages";
import { projectSession } from "../../web/src/session";

test("Codex retains streamed content, separate summary parts and completed assistant messages without replay duplication", () => {
  const events: HarnessEvent[] = [];
  const activity = new CodexMessages((event) => events.push(event));
  activity.consume("item/reasoning/summaryTextDelta", {
    itemId: "r",
    summaryIndex: 0,
    delta: "Identifying relevant files",
  });
  activity.consume("item/reasoning/summaryTextDelta", {
    itemId: "r",
    summaryIndex: 1,
    delta: "Planning verification checks",
  });
  activity.consume("item/reasoning/textDelta", {
    itemId: "r",
    contentIndex: 0,
    delta: "Inspect README first, ",
  });
  activity.consume("item/reasoning/textDelta", {
    itemId: "r",
    contentIndex: 0,
    delta: "then verify the commands.",
  });
  activity.consume("item/completed", {
    item: {
      type: "reasoning",
      id: "r",
      summary: ["Identifying relevant files", "Planning verification checks"],
      content: ["Inspect README first, then verify the commands."],
    },
  });
  activity.consume("item/agentMessage/delta", { itemId: "reply", delta: "I found " });
  // A tool/lifecycle event between text deltas must not fragment the message.
  events.push({ type: "log", at: new Date().toISOString(), data: { status: "Working" } });
  activity.consume("item/agentMessage/delta", { itemId: "reply", delta: "the files." });
  activity.consume("item/completed", {
    item: {
      type: "agentMessage",
      id: "reply",
      text: "I found the files. Next I will verify them.",
    },
  });
  activity.consume("item/completed", {
    item: { type: "agentMessage", id: "final", text: "Verification passed." },
  });
  activity.consume("item/completed", {
    item: { type: "agentMessage", id: "final", text: "Verification passed." },
  });
  const entries = projectSession(
    events.map((event, cursor) => ({
      attemptId: "a",
      cursor,
      event: event as unknown as Record<string, unknown>,
    })),
  );
  const messages = entries.filter((entry) => entry.kind === "message");
  expect(messages.map((entry) => entry.text)).toEqual([
    "Identifying relevant files",
    "Planning verification checks",
    "Inspect README first, then verify the commands.",
    "I found the files. Next I will verify them.",
    "Verification passed.",
  ]);
  expect(messages.map((entry) => entry.thinkingKind)).toEqual([
    "summary",
    "summary",
    "content",
    undefined,
    undefined,
  ]);
  expect(activity.lastAssistantText).toBe("Verification passed.");
});
