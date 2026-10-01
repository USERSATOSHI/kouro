import { describe, expect, test } from "bun:test";
import { projectSession } from "./session";

describe("agent session projection", () => {
  test("legacy nested child text preserves identity and snapshot semantics", () => {
    const events = [
      {
        type: "text",
        data: { scoutId: "reviewer", requestId: "r", text: { id: "m", text: "Inspecting " } },
      },
      {
        type: "text",
        data: { scoutId: "reviewer", requestId: "r", text: { id: "m", text: "source" } },
      },
      {
        type: "text",
        data: {
          scoutId: "reviewer",
          requestId: "r",
          text: { id: "m", text: "Inspecting source files", mode: "snapshot" },
        },
      },
    ];
    const entries = projectSession(
      events.map((event, cursor) => ({ event, cursor, attemptId: "a" })),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "message",
      text: "Inspecting source files",
      scoutId: "reviewer",
      requestId: "r",
    });
  });
  test("old empty Thinking logs do not split real child thinking, replies, or hide tool results", () => {
    const entries = projectSession([
      ...Array.from({ length: 100 }, (_, index) => ({
        attemptId: "a",
        cursor: index,
        event: {
          type: "log",
          data: { status: "Thinking", scoutId: "repositoryScout", requestId: "repo-1" },
        },
      })),
      {
        attemptId: "a",
        cursor: 101,
        event: {
          type: "log",
          data: {
            channel: "thinking",
            text: "Inspect",
            scoutId: "repositoryScout",
            requestId: "repo-1",
          },
        },
      },
      {
        attemptId: "a",
        cursor: 102,
        event: {
          type: "log",
          data: { status: "Thinking", scoutId: "repositoryScout", requestId: "repo-1" },
        },
      },
      {
        attemptId: "a",
        cursor: 103,
        event: {
          type: "log",
          data: {
            channel: "thinking",
            text: " README",
            scoutId: "repositoryScout",
            requestId: "repo-1",
          },
        },
      },
      {
        attemptId: "a",
        cursor: 104,
        event: {
          type: "tool",
          data: {
            id: "read",
            name: "read",
            scoutId: "repositoryScout",
            requestId: "repo-1",
            status: "completed",
            output: "file contents",
          },
        },
      },
      {
        attemptId: "a",
        cursor: 105,
        event: { type: "log", data: { status: "Thinking", detail: "Model is reconnecting" } },
      },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      channel: "thinking",
      text: "Inspect README",
      scoutId: "repositoryScout",
      requestId: "repo-1",
    });
    expect(entries[1]).toMatchObject({
      kind: "tool",
      output: "file contents",
      status: "completed",
    });
    expect(entries[2]).toMatchObject({ kind: "status", message: "Thinking" });
  });
  test("groups streamed text and ignores the same observation when replayed", () => {
    const entries = projectSession([
      { attemptId: "attempt-a", cursor: 4, event: { type: "text", data: "Hello " } },
      { attemptId: "attempt-a", cursor: 5, event: { type: "text", data: "world" } },
      { attemptId: "attempt-a", cursor: 4, event: { type: "text", data: "Hello " } },
    ]);

    expect(entries).toEqual([{ kind: "message", id: "attempt-a:message:4", text: "Hello world" }]);
  });

  test("updates concurrent tool calls by id and keeps their results separate", () => {
    const entries = projectSession([
      {
        attemptId: "attempt-a",
        cursor: 1,
        event: {
          type: "tool",
          data: { id: "tool-a", name: "Read", status: "started", input: "a.ts" },
        },
      },
      {
        attemptId: "attempt-a",
        cursor: 2,
        event: {
          type: "tool",
          data: { id: "tool-b", name: "Read", status: "started", input: "b.ts" },
        },
      },
      {
        attemptId: "attempt-a",
        cursor: 3,
        event: {
          type: "tool",
          data: { id: "tool-b", name: "Read", status: "completed", output: "B" },
        },
      },
      {
        attemptId: "attempt-a",
        cursor: 4,
        event: {
          type: "tool",
          data: { id: "tool-a", name: "Read", status: "failed", error: "missing" },
        },
      },
    ]);

    expect(entries).toEqual([
      {
        kind: "tool",
        id: "attempt-a:parent:tool-a",
        name: "Read",
        status: "failed",
        input: "a.ts",
        error: "missing",
      },
      {
        kind: "tool",
        id: "attempt-a:parent:tool-b",
        name: "Read",
        status: "completed",
        input: "b.ts",
        output: "B",
      },
    ]);
  });

  test("de-duplicates a cursorless persisted copy of a streamed observation", () => {
    expect(
      projectSession([
        { attemptId: "attempt-a", cursor: 9, event: { type: "text", data: "once" } },
        { attemptId: "attempt-a", event: { type: "text", data: "once" } },
      ]),
    ).toHaveLength(1);
  });

  test("scopes provider tool IDs to the parent attempt and subagent", () => {
    const entries = projectSession([
      {
        attemptId: "a",
        cursor: 1,
        event: { type: "tool", data: { id: "1", name: "Read", input: "parent" } },
      },
      {
        attemptId: "a",
        cursor: 2,
        event: {
          type: "tool",
          data: { id: "1", name: "Read", scoutId: "reviewer", input: "child" },
        },
      },
      {
        attemptId: "b",
        cursor: 3,
        event: { type: "tool", data: { id: "1", name: "Read", input: "retry" } },
      },
      {
        attemptId: "a",
        cursor: 4,
        event: {
          type: "tool",
          data: { id: "1", scoutId: "reviewer", status: "completed", output: "child result" },
        },
      },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ input: "parent", status: "running" });
    expect(entries[1]).toMatchObject({
      input: "child",
      output: "child result",
      status: "completed",
    });
    expect(entries[2]).toMatchObject({ input: "retry", status: "running" });
  });

  test("keeps repeated deltas and separates retry and reasoning messages", () => {
    const entries = projectSession([
      { attemptId: "a", cursor: 1, event: { type: "text", data: "ha" } },
      { attemptId: "a", cursor: 2, event: { type: "text", data: "ha" } },
      {
        attemptId: "a",
        cursor: 3,
        event: { type: "log", data: { channel: "thinking", text: "Checking" } },
      },
      {
        attemptId: "a",
        cursor: 4,
        event: { type: "log", data: { channel: "thinking", text: " tests" } },
      },
      { attemptId: "b", cursor: 5, event: { type: "text", data: "retry" } },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ text: "haha" });
    expect(entries[1]).toMatchObject({ channel: "thinking", text: "Checking tests" });
    expect(entries[2]).toMatchObject({ text: "retry" });
  });

  test("joins command output deltas and honors the completed result", () => {
    const entries = projectSession([
      {
        attemptId: "a",
        cursor: 1,
        event: { type: "tool", data: { id: "command", outputDelta: "A" } },
      },
      {
        attemptId: "a",
        cursor: 2,
        event: { type: "tool", data: { id: "command", outputDelta: "B" } },
      },
      {
        attemptId: "a",
        cursor: 3,
        event: { type: "tool", data: { id: "command", status: "completed", output: "AB!" } },
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "completed", output: "AB!" });
  });
  test("retains steering instructions once with their final acceptance and keeps agent replies separate", () => {
    const entries = projectSession([
      { attemptId: "a", cursor: 1, event: { type: "text", data: "Working" } },
      {
        attemptId: "a",
        cursor: 2,
        event: {
          type: "log",
          data: { idempotencyKey: "k", outcome: "requested", instruction: "Please inspect" },
        },
      },
      {
        attemptId: "a",
        cursor: 3,
        event: {
          type: "log",
          data: { idempotencyKey: "k", outcome: "accepted", instruction: "Please inspect" },
        },
      },
      { attemptId: "a", cursor: 4, event: { type: "text", data: "Acknowledged" } },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({
      channel: "operator",
      status: "accepted",
      text: "Please inspect",
    });
    expect(entries[2]).toMatchObject({ kind: "message", text: "Acknowledged" });
    expect(entries[2]).not.toHaveProperty("channel");
  });
});
