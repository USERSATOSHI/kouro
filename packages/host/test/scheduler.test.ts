import { describe, expect, test } from "bun:test";
import {
  ReadySetScheduler,
  type SchedulerRecord,
  type SchedulerTask,
} from "../src/scheduler/index.ts";

const task = (
  id: string,
  delayMs: number,
  output: string,
  started: number[],
  ended: number[],
): SchedulerTask<string> => ({
  id,
  branchId: id,
  scope: {
    scopeId: `scope-${id}`,
    parentScopeId: "root",
    definitionId: "planner",
    activationOrdinal: 0,
    controlLineage: ["root", id],
    forkGroupId: "plans",
  },
  run: async (signal) => {
    started.push(Date.now());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
    ended.push(Date.now());
    return output;
  },
});

describe("M4 ready-set scheduler", () => {
  test("overlaps three independent planners and canonicalizes completion order", async () => {
    const started: number[] = [],
      ended: number[] = [];
    const scheduler = new ReadySetScheduler({ maxConcurrency: 3 });
    const result = await scheduler.run(
      [
        task("branch-a", 35, "a", started, ended),
        task("branch-b", 5, "b", started, ended),
        task("branch-c", 20, "c", started, ended),
      ],
      [
        {
          id: "plans",
          expectedBranchIds: ["branch-a", "branch-b", "branch-c"],
          mode: "all-settled",
        },
      ],
    );
    expect(started.length).toBe(3);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(25);
    expect(result.joins.plans?.branches.map((branch) => branch.value)).toEqual(["a", "b", "c"]);
    expect(ended[0]).toBeLessThan(ended[2]!);
  });

  test("fail-fast aborts siblings while all-settled preserves them", async () => {
    const fail = (id: string): SchedulerTask => ({
      id,
      branchId: id,
      scope: {
        scopeId: `s-${id}`,
        parentScopeId: "root",
        definitionId: "x",
        activationOrdinal: 0,
        controlLineage: ["root"],
      },
      run: async () => {
        throw new Error("bad");
      },
    });
    const delayed = (id: string): SchedulerTask => ({
      ...fail(id),
      run: async (signal) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (signal.aborted) throw new Error("aborted");
        return id;
      },
    });
    const fast = await new ReadySetScheduler({ maxConcurrency: 2 }).run(
      [fail("a"), delayed("b")],
      [{ id: "g", expectedBranchIds: ["a", "b"], mode: "fail-fast" }],
    );
    expect(fast.joins.g?.status).toBe("failed");
    expect(fast.joins.g?.branches.find((branch) => branch.branchId === "b")?.status).toBe(
      "cancelled",
    );
    const settled = await new ReadySetScheduler({ maxConcurrency: 2 }).run(
      [fail("a"), delayed("b")],
      [{ id: "g", expectedBranchIds: ["a", "b"], mode: "all-settled" }],
    );
    expect(settled.joins.g?.branches.map((branch) => branch.status)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  test("enforces resource concurrency, records durable lineage, and handles empty joins", async () => {
    const records: SchedulerRecord[] = [];
    const journal = { append: (record: SchedulerRecord) => records.push(record) };
    const starts: number[] = [];
    const make = (id: string): SchedulerTask => ({
      id,
      branchId: id,
      resources: { gpu: 1 },
      scope: {
        scopeId: `s-${id}`,
        parentScopeId: "root",
        definitionId: "child",
        activationOrdinal: 1,
        controlLineage: ["root", "call-1"],
        forkGroupId: "g",
      },
      run: async () => {
        starts.push(Date.now());
        await Bun.sleep(15);
        return id;
      },
    });
    const result = await new ReadySetScheduler({
      maxConcurrency: 3,
      resourceCaps: { gpu: 1 },
      journal,
    }).run(
      [make("a"), make("b")],
      [
        { id: "g", expectedBranchIds: ["a", "b"], mode: "all-settled" },
        { id: "empty", expectedBranchIds: [], mode: "all-settled" },
      ],
    );
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(10);
    expect(result.joins.empty?.status).toBe("succeeded");
    expect(
      records.some(
        (record) => record.type === "scope.created" && record.scope.controlLineage[1] === "call-1",
      ),
    ).toBe(true);
    expect(records.filter((record) => record.type === "resource.acquired")).toHaveLength(2);
  });

  test("rejects scope and resource admission overflow", async () => {
    const make = (id: string): SchedulerTask => ({
      id,
      branchId: id,
      resources: { slot: 2 },
      scope: {
        scopeId: id,
        parentScopeId: null,
        definitionId: "x",
        activationOrdinal: 0,
        controlLineage: [],
      },
      run: async () => id,
    });
    await expect(
      new ReadySetScheduler({ maxConcurrency: 1, maxScopes: 1 }).run([make("a"), make("b")], []),
    ).rejects.toThrow("scope limit");
    await expect(
      new ReadySetScheduler({ maxConcurrency: 1, resourceCaps: { slot: 1 } }).run([make("a")], []),
    ).rejects.toThrow("resource");
  });
});
