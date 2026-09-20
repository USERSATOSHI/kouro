import { describe, expect, test } from "bun:test";
import { ReadySetScheduler } from "../src/scheduler/scheduler.ts";

const task = (
  id: string,
  resources: Record<string, number>,
  delay = 10,
  tracker?: { active: number; peak: number },
) => ({
  id,
  branchId: id,
  resources,
  scope: {
    scopeId: `${id}:scope`,
    parentScopeId: null,
    definitionId: "resource",
    activationOrdinal: 0,
    controlLineage: [],
  },
  run: async () => {
    if (tracker) {
      tracker.active += 1;
      tracker.peak = Math.max(tracker.peak, tracker.active);
    }
    await Bun.sleep(delay);
    if (tracker) tracker.active -= 1;
  },
});

describe("M4 resource admission", () => {
  test("global and local claims serialize same writer while disjoint resources overlap", async () => {
    const tracker = { active: 0, peak: 0 };
    const scheduler = new ReadySetScheduler({
      maxConcurrency: 3,
      resourceCaps: { workspace: 1, session: 1 },
    });
    await scheduler.run(
      [
        task("workspace-a", { workspace: 1 }, 20, tracker),
        task("workspace-b", { workspace: 1 }, 5, tracker),
        task("session-c", { session: 1 }, 20, tracker),
      ],
      [],
    );
    expect(tracker.peak).toBe(2);
  });

  test("nested parent scopes do not consume effect slots", async () => {
    const tracker = { active: 0, peak: 0 };
    const scheduler = new ReadySetScheduler({ maxConcurrency: 2, resourceCaps: { workspace: 1 } });
    await scheduler.run(
      [
        task("child-a", { workspace: 1 }, 15, tracker),
        task("child-b", { workspace: 1 }, 15, tracker),
      ],
      [],
    );
    expect(tracker.peak).toBe(1);
  });

  test("resource admission is deterministic after restart-style replay", async () => {
    const records: string[] = [];
    const scheduler = new ReadySetScheduler({
      maxConcurrency: 2,
      resourceCaps: { session: 1 },
      journal: { append: (record) => records.push(record.type) },
    });
    await scheduler.run([task("first", { session: 1 }, 1), task("second", { session: 1 }, 1)], []);
    expect(records.filter((record) => record === "resource.acquired")).toHaveLength(2);
    expect(records.filter((record) => record === "resource.released")).toHaveLength(2);
  });
});
