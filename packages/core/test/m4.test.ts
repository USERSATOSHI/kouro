import { describe, expect, test } from "bun:test";
import {
  WorkflowBuilder,
  artifactType,
  compileWorkflow,
  compileWorkflowDetailed,
} from "../src/index";

describe("M4.1 hierarchical authoring", () => {
  test("retains child definitions and source mapping for calls", async () => {
    const child = new WorkflowBuilder({ id: "review" });
    const childDone = child.complete("done");
    child.startAt(childDone);
    const root = new WorkflowBuilder({ id: "root" });
    const call = root.call("review-call", child);
    const done = root.complete("done");
    root.startAt(call);
    call.on("success").to(done);
    const bundle = await compileWorkflow(root.build());
    expect(Object.keys(bundle.definitions).sort()).toEqual(["review", "root"]);
    expect(bundle.definitions.root.nodes.find((node) => node.id === "review-call")?.kind).toBe(
      "call",
    );
    expect(bundle.sourceMap["review-call"]).toEqual({ sourceId: "review-call" });
  });

  test("checks finite loop and map bounds", async () => {
    const w = new WorkflowBuilder({ id: "bounded" });
    const body = w.complete("body");
    const loop = w.loop("loop", { body, maxIterations: 2 });
    const done = w.complete("done");
    w.startAt(loop);
    loop.on("success").to(done);
    const bundle = await compileWorkflow(w.build());
    expect(bundle.boundSummary.scopes).toBeGreaterThan(1);
    expect(bundle.boundSummary.invocations).toBeGreaterThan(1);
    const invalid = new WorkflowBuilder({ id: "invalid" });
    expect(() =>
      invalid.loop("loop", { body: invalid.complete("body"), maxIterations: 0 }),
    ).toThrow(/maxIterations/);
    expect((await compileWorkflowDetailed(w.build())).bundle).toBeDefined();
  });

  test("uses declared child ports instead of synthetic call output", async () => {
    const Task = artifactType("Task", { type: "string" });
    const Plan = artifactType("Plan", { type: "object", properties: { steps: { type: "array" } } });
    const child = new WorkflowBuilder({ id: "planner" });
    const task = child.input("task", Task);
    const plan = child.agent("plan", { prompt: "plan", input: { task }, produces: Plan });
    const childDone = child.complete("done", { output: plan.output });
    child.startAt(plan);
    plan.on("success").to(childDone);
    child.output(plan.output);

    const root = new WorkflowBuilder({ id: "root" });
    const input = root.input("task", Task);
    const call = root.call("planner", child, { input: { task: input } });
    const done = root.complete("done", { output: call.output });
    root.startAt(call);
    call.on("success").to(done);
    const bundle = await compileWorkflow(root.build());
    const callNode = bundle.definitions.root.nodes.find((node) => node.id === "planner");
    expect(callNode?.kind).toBe("call");
    expect(callNode?.inputPorts.map((port) => port.name)).toEqual(["task"]);
    expect(callNode?.outputPorts.map((port) => port.name)).toEqual(["output"]);
    expect(callNode?.outputPorts[0]?.schemaDigest).not.toBe("{}");
  });

  test("validates explicit fork ownership and branch convergence", async () => {
    const valid = new WorkflowBuilder({ id: "parallel" });
    const left = valid.agent("left", { prompt: "left" });
    const right = valid.agent("right", { prompt: "right" });
    const fork = valid.parallel("reviews", { branches: [left, right] });
    const join = valid.join("reviews-join", { groupId: "reviews" });
    const done = valid.complete("done");
    valid.startAt(fork);
    fork.on("success").to(join);
    left.on("success").to(join);
    right.on("success").to(join);
    join.on("success").to(done);
    await expect(compileWorkflow(valid.build())).resolves.toBeDefined();

    const invalid = new WorkflowBuilder({ id: "invalid-parallel" });
    const branch = invalid.complete("branch");
    const badFork = invalid.parallel("fork", { branches: [branch] });
    const badJoin = invalid.join("join", { groupId: "fork" });
    invalid.startAt(badFork);
    badFork.on("success").to(badJoin);
    badJoin.on("success").to(invalid.complete("done"));
    const result = await compileWorkflowDetailed(invalid.build());
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "PARALLEL_BRANCH_NO_CONVERGENCE"),
    ).toBe(true);
  });

  test("includes nested call work in static bounds", async () => {
    const child = new WorkflowBuilder({ id: "expensive" });
    const work = child.agent("work", { prompt: "work" });
    const childDone = child.complete("done");
    child.startAt(work);
    work.on("success").to(childDone);
    const root = new WorkflowBuilder({ id: "bounded-root", limits: { maxInvocations: 3 } });
    const call = root.call("child", child);
    const done = root.complete("done");
    root.startAt(call);
    call.on("success").to(done);
    const result = await compileWorkflowDetailed(root.build());
    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "INVOCATION_BOUND")).toBe(
      true,
    );
  });
});
