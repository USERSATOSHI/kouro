import { expect, test } from "bun:test";
import { codexToolEvent } from "../src/adapters/harness/codex-activity";

const at = "2026-10-01T00:00:00Z";
test("Codex dynamic tools retain their actual name, arguments, content and failed outcome", () => {
  expect(
    codexToolEvent(
      {
        type: "dynamicToolCall",
        id: "call",
        tool: "subagent",
        arguments: { subagentId: "reviewer" },
        status: "completed",
        contentItems: [{ type: "inputText", text: "child report" }],
        success: false,
      },
      false,
      at,
    ).data,
  ).toEqual({
    id: "call",
    name: "subagent",
    status: "failed",
    input: { subagentId: "reviewer" },
    output: [{ type: "inputText", text: "child report" }],
  });
});
test("Codex commands retain completed output and nonzero exit errors", () => {
  expect(
    codexToolEvent(
      {
        type: "commandExecution",
        id: "cmd",
        command: "bun test",
        status: "completed",
        aggregatedOutput: "test failed",
        exitCode: 1,
      },
      false,
      at,
    ).data,
  ).toMatchObject({
    input: "bun test",
    output: "test failed",
    status: "failed",
    error: "Command exited with status 1",
  });
});
