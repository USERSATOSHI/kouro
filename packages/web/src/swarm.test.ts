import { describe, expect, it } from "vitest";
import { formatBudget, normalizeCollaboration } from "./swarm";

describe("collaboration DTO", () => {
  it("preserves durable message provenance and selective context links", () => {
    const view = normalizeCollaboration(
      {
        objective: "repair",
        budgets: { messages: { used: 2, limit: 5 } },
        participants: [
          { id: "a", role: "planner", harness: "native", model: "model-x", state: "active" },
        ],
        messages: [
          {
            id: "m1",
            channelId: "direct",
            senderId: "a",
            recipientIds: ["b"],
            body: "finding",
            senderAttemptId: "attempt-1",
            recipientContextIds: ["ctx-1"],
          },
        ],
      },
      "run-1",
    );
    expect(view.runId).toBe("run-1");
    expect(view.messages[0]).toMatchObject({
      senderAttemptId: "attempt-1",
      recipientContextIds: ["ctx-1"],
    });
    expect(view.budgets.messages).toEqual({ used: 2, limit: 5 });
  });

  it("does not invent provider fields for sparse host records", () => {
    const view = normalizeCollaboration({ participants: [{ id: "a" }] }, "r");
    expect(view.participants[0].harness).toBeUndefined();
    expect(view.participants[0].model).toBeUndefined();
  });

  it("formats bounded budgets and unavailable limits", () => {
    expect(formatBudget({ used: 3, limit: 10 })).toBe("3 / 10");
    expect(formatBudget({ used: 3, limit: 0 })).toBe("—");
  });
});
