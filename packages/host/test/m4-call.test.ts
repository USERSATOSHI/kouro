import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowBuilder, compileWorkflow, artifactType } from "@kouro/core";
import { Coordinator } from "../src/coordinator/coordinator.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";
import type { HarnessAdapter } from "../src/types.ts";

class MeasuredHarness implements HarnessAdapter {
  readonly id = "measured";
  readonly adapterVersion = "1";
  active = 0;
  peak = 0;
  completions: string[] = [];
  capabilities() {
    return {
      "structured-output": "supported" as const,
      cancel: "unsupported" as const,
      usage: "unsupported" as const,
      "cost-cap": "unsupported" as const,
    };
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await Bun.sleep(this.active === 1 ? 35 : 5);
    this.active -= 1;
    this.completions.push(input.invocationId);
    return {
      status: "succeeded" as const,
      output: { invocation: input.invocationId },
      events: [],
      usage: { quality: "unavailable" },
    };
  }
}

class InputHarness implements HarnessAdapter {
  readonly id = "input-test";
  readonly adapterVersion = "1";
  readonly contexts: Array<NonNullable<Parameters<HarnessAdapter["run"]>[0]["context"]>> = [];
  capabilities() {
    return {
      "structured-output": "supported" as const,
      cancel: "supported" as const,
      usage: "unsupported" as const,
      "cost-cap": "unsupported" as const,
    };
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    if (input.context) this.contexts.push(input.context);
    return {
      status: "succeeded" as const,
      output: { summary: "plan" },
      events: [],
      usage: { quality: "unavailable" },
    };
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function terminal(coordinator: Coordinator, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    const view = coordinator.journal.getView(runId);
    if (view && !["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(5);
  }
  throw new Error("call run did not terminate");
}

function workflow() {
  const child = new WorkflowBuilder({ id: "child-definition" });
  const agent = child.agent("child-agent", { prompt: "child" });
  const complete = child.complete("child-complete", { output: agent.output });
  child.startAt(agent);
  agent.on("success").to(complete);

  const root = new WorkflowBuilder({ id: "non-root-workflow" });
  const first = root.call("first-call", child);
  const second = root.call("second-call", child);
  const done = root.complete("done");
  root.startAt(first);
  first.on("success").to(second);
  second.on("success").to(done);
  return compileWorkflow(root.build());
}

describe("M4 child call execution", () => {
  test("resolves producer bindings into validated agent context before dispatch", async () => {
    const harness = new InputHarness();
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-input-binding-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 1,
    });
    const Plan = artifactType("plan", {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    });
    const workflow = new WorkflowBuilder({ id: "input-binding-root" });
    const plan = workflow.agent("plan", { prompt: "plan", produces: Plan });
    const implement = workflow.agent("implement", {
      prompt: "implement",
      input: { plan: plan.output },
      produces: Plan,
    });
    const done = workflow.complete("done");
    workflow.startAt(plan);
    workflow.sequence(plan, implement, done);
    const bundle = await compileWorkflow(workflow.build());
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "input-binding",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    const input = harness.contexts[1]?.segments.find(
      (segment) => segment.source === "artifact-input",
    );
    expect(input).toBeDefined();
    expect(JSON.parse(input!.content)).toEqual({ summary: "plan" });
    await coordinator.close();
  });

  test("rejects an unsupported command before reserving an effect", async () => {
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-command-admission-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    const workflow = new WorkflowBuilder({ id: "unsupported-command" });
    const command = workflow.command("validate", {
      executable: "/usr/bin/printf",
      args: ["unsupported\\n"],
    });
    const done = workflow.complete("done");
    workflow.startAt(command);
    command.on("success").to(done);
    const bundle = await compileWorkflow(workflow.build());
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "unsupported-command",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("failed");
    expect(Object.values(view.state.attempts)).toHaveLength(0);
    await coordinator.close();
  });

  test("executes child scope and projects child output to the parent call", async () => {
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-call-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    const bundle = await workflow();
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "call-one",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    expect(view.state.scopes[view.state.rootScopeId]?.definitionId).toBe("non-root-workflow");
    const calls = Object.values(view.state.invocations).filter((invocation) =>
      invocation.nodeId.endsWith("call"),
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((invocation) => invocation.output.length > 0)).toBe(true);
    const childScopes = Object.values(view.state.scopes).filter(
      (scope) => scope.definitionId === "child-definition",
    );
    expect(childScopes).toHaveLength(2);
    expect(childScopes[0]?.id).not.toBe(childScopes[1]?.id);
    await coordinator.close();
  });

  test("replays a pending child approval across coordinator restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-call-"));
    dirs.push(dataDir);
    const child = new WorkflowBuilder({ id: "approval-child" });
    const approval = child.approval("child-approval", { action: "approve-child" });
    const childDone = child.complete("child-done");
    child.startAt(approval);
    approval.on("approved").to(childDone);
    approval.on("rejected").to(child.complete("child-failed", { result: "failed" }));
    const root = new WorkflowBuilder({ id: "approval-root" });
    const call = root.call("child-call", child);
    const done = root.complete("done");
    root.startAt(call);
    call.on("success").to(done);
    const bundle = await compileWorkflow(root.build());

    const first = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await first.start();
    const created = await first.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "approval-call",
    });
    let pending = first.journal.getView(created.run.runId)!;
    for (let i = 0; i < 200 && Object.keys(pending.state.approvals).length === 0; i += 1) {
      await Bun.sleep(5);
      pending = first.journal.getView(created.run.runId)!;
    }
    const approvalState = Object.values(pending.state.approvals)[0]!;
    const childScopesBefore = Object.values(pending.state.scopes).filter(
      (scope) => scope.definitionId === "approval-child",
    );
    expect(childScopesBefore).toHaveLength(1);
    await first.close();

    const second = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await second.start();
    await Bun.sleep(10);
    const replayed = second.journal.getView(created.run.runId)!;
    expect(
      Object.values(replayed.state.approvals).filter((item) => item.status === "pending"),
    ).toHaveLength(1);
    expect(
      Object.values(replayed.state.scopes).filter(
        (scope) => scope.definitionId === "approval-child",
      ),
    ).toHaveLength(1);
    second.decideApproval({
      runId: created.run.runId,
      invocationId: approvalState.invocationId,
      decision: "approved",
      expectedRevision: replayed.revision,
      actor: "test-operator",
      idempotencyKey: "approve-child-after-restart",
      bindingDigest: approvalState.bindingDigest,
      subjectRevision: approvalState.subjectRevision,
    });
    const completed = await terminal(second, created.run.runId);
    expect(completed.state.status).toBe("succeeded");
    expect(
      Object.values(completed.state.scopes).filter(
        (scope) => scope.definitionId === "approval-child",
      ),
    ).toHaveLength(1);
    await second.close();
  });

  test("executes exactly the bounded number of loop iterations with isolated scopes", async () => {
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-loop-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    const workflow = new WorkflowBuilder({ id: "loop-root" });
    const body = workflow.complete("body");
    const loop = workflow.loop("bounded-loop", { body, maxIterations: 3 });
    const done = workflow.complete("done");
    workflow.startAt(loop);
    loop.on("success").to(done);
    const bundle = await compileWorkflow(workflow.build());
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "loop-three",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    const iterations = Object.values(view.state.scopes).filter((scope) =>
      scope.id.includes(":iteration:"),
    );
    expect(iterations).toHaveLength(3);
    expect(new Set(iterations.map((scope) => scope.id)).size).toBe(3);
    expect(
      Object.values(view.state.invocations).filter((invocation) => invocation.nodeId === "body"),
    ).toHaveLength(3);
    await coordinator.close();
  });

  test("resumes a fixed-count loop without duplicating an iteration", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-loop-replay-"));
    dirs.push(dataDir);
    const workflow = new WorkflowBuilder({ id: "loop-replay" });
    const body = workflow.complete("body");
    const loop = workflow.loop("bounded-loop", { body, maxIterations: 3 });
    const done = workflow.complete("done");
    workflow.startAt(loop);
    loop.on("success").to(done);
    const bundle = await compileWorkflow(workflow.build());
    const first = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await first.start();
    const created = await first.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "loop-replay",
    });
    let view = first.journal.getView(created.run.runId)!;
    for (
      let i = 0;
      i < 100 &&
      Object.values(view.state.scopes).filter((scope) => scope.id.includes(":iteration:")).length <
        1;
      i += 1
    ) {
      await Bun.sleep(2);
      view = first.journal.getView(created.run.runId)!;
    }
    await first.close();
    const second = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await second.start();
    const completed = await terminal(second, created.run.runId);
    const iterations = Object.values(completed.state.scopes).filter((scope) =>
      scope.id.includes(":iteration:"),
    );
    expect(completed.state.status).toBe("succeeded");
    expect(iterations).toHaveLength(3);
    expect(new Set(iterations.map((scope) => scope.id)).size).toBe(3);
    await second.close();
  });

  test("maps bounded collection items into isolated item scopes and handles empty input", async () => {
    const child = new WorkflowBuilder({ id: "map-item" });
    const agent = child.agent("item-agent", { prompt: "item" });
    const childDone = child.complete("item-done");
    child.startAt(agent);
    agent.on("success").to(childDone);
    const workflow = new WorkflowBuilder({ id: "map-root" });
    const items = workflow.input("items", artifactType("items", { type: "array" }));
    const map = workflow.forEach("map", {
      template: child,
      collection: items,
      maxItems: 2,
      maxConcurrent: 1,
    });
    map.on("failure").to(workflow.complete("overflow-failed", { result: "failed" }));
    const done = workflow.complete("done");
    workflow.startAt(map);
    map.on("success").to(done);
    const bundle = await compileWorkflow(workflow.build());
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-map-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      input: { items: [] },
      idempotencyKey: "map-empty",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    expect(
      Object.values(view.state.scopes).filter((scope) => scope.id.includes(":item:")).length,
    ).toBe(0);
    await coordinator.close();
  });

  test("rejects collection overflow before creating item scopes", async () => {
    const child = new WorkflowBuilder({ id: "overflow-item" });
    const agent = child.agent("item-agent", { prompt: "item" });
    const childDone = child.complete("item-done");
    child.startAt(agent);
    agent.on("success").to(childDone);
    const workflow = new WorkflowBuilder({ id: "overflow-root" });
    const items = workflow.input("items", artifactType("items", { type: "array" }));
    const map = workflow.forEach("map", {
      template: child,
      collection: items,
      maxItems: 2,
      maxConcurrent: 1,
    });
    map.on("failure").to(workflow.complete("overflow-failed", { result: "failed" }));
    map.on("success").to(workflow.complete("overflow-done"));
    workflow.startAt(map);
    const bundle = await compileWorkflow(workflow.build());
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-map-overflow-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      input: { items: [1, 2, 3] },
      idempotencyKey: "map-overflow",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("failed");
    expect(
      Object.values(view.state.scopes).filter((scope) => scope.id.includes(":item:")).length,
    ).toBe(0);
    expect(Object.values(view.state.attempts)).toHaveLength(0);
    await coordinator.close();
  });

  test("enforces maxConcurrent and preserves item order despite completion permutation", async () => {
    const child = new WorkflowBuilder({ id: "measured-item" });
    const agent = child.agent("item-agent", { prompt: "item" });
    const childDone = child.complete("item-done");
    child.startAt(agent);
    agent.on("success").to(childDone);
    const workflow = new WorkflowBuilder({ id: "measured-map" });
    const items = workflow.input("items", artifactType("items", { type: "array" }));
    const map = workflow.forEach("map", {
      template: child,
      collection: items,
      maxItems: 3,
      maxConcurrent: 2,
    });
    const done = workflow.complete("done");
    workflow.startAt(map);
    map.on("success").to(done);
    const bundle = await compileWorkflow(workflow.build());
    const harness = new MeasuredHarness();
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-map-measured-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      input: { items: [1, 2, 3] },
      idempotencyKey: "map-measured",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    expect(harness.peak).toBeLessThanOrEqual(2);
    expect(harness.completions.length).toBe(3);
    const mapInvocation = Object.values(view.state.invocations).find(
      (invocation) => invocation.nodeId === "map",
    )!;
    const itemScopes = Object.values(view.state.scopes)
      .filter((scope) => scope.id.includes(":item:"))
      .sort((a, b) => a.activationOrdinal - b.activationOrdinal);
    const expected = itemScopes.flatMap((scope) =>
      Object.values(view.state.invocations)
        .filter((invocation) => invocation.scopeId === scope.id)
        .flatMap((invocation) => invocation.output),
    );
    expect(mapInvocation.output).toEqual(expected);
    expect(new Set(harness.completions)).toHaveLength(3);
    await coordinator.close();
  });

  test("restarts mid-map without duplicating item scopes", async () => {
    const child = new WorkflowBuilder({ id: "restart-item" });
    const body = child.complete("item-done");
    child.startAt(body);
    const workflow = new WorkflowBuilder({ id: "restart-map" });
    const items = workflow.input("items", artifactType("items", { type: "array" }));
    const map = workflow.forEach("map", {
      template: child,
      collection: items,
      maxItems: 3,
      maxConcurrent: 2,
    });
    const done = workflow.complete("done");
    workflow.startAt(map);
    map.on("success").to(done);
    const bundle = await compileWorkflow(workflow.build());
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-map-restart-"));
    dirs.push(dataDir);
    const first = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await first.start();
    const created = await first.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      input: { items: [1, 2, 3] },
      idempotencyKey: "map-restart",
    });
    await Bun.sleep(5);
    await first.close();
    const second = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await second.start();
    const view = await terminal(second, created.run.runId);
    const scopes = Object.values(view.state.scopes).filter((scope) => scope.id.includes(":item:"));
    expect(view.state.status).toBe("succeeded");
    expect(scopes).toHaveLength(3);
    expect(new Set(scopes.map((scope) => scope.id))).toHaveLength(3);
    await second.close();
  });

  test("reconstructs fork groups and canonical join results after restart", async () => {
    const workflow = new WorkflowBuilder({ id: "fork-replay" });
    const left = workflow.agent("left", { prompt: "left" });
    const right = workflow.agent("right", { prompt: "right" });
    const fork = workflow.parallel("branches", { branches: [left, right] });
    const joinNode = workflow.join("join", { groupId: "branches", mode: "all-settled" });
    const done = workflow.complete("done");
    workflow.startAt(fork);
    left.on("success").to(joinNode);
    right.on("success").to(joinNode);
    fork.on("success").to(joinNode);
    joinNode.on("success").to(done);
    const bundle = await compileWorkflow(workflow.build());
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-fork-replay-"));
    dirs.push(dataDir);
    const first = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await first.start();
    const created = await first.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "fork-replay",
    });
    const initial = await terminal(first, created.run.runId);
    await first.close();
    const second = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await second.start();
    const replayed = second.journal.getView(created.run.runId)!;
    expect(replayed.state.status).toBe("succeeded");
    expect(Object.keys(replayed.state.forkGroups ?? {})).toContain("branches");
    expect(replayed.state.forkGroups?.branches.joined).toBe(true);
    expect(replayed.state.forkGroups?.branches.branchIds).toEqual(["left", "right"]);
    expect(initial.state.forkGroups?.branches.branchIds).toEqual(
      replayed.state.forkGroups?.branches.branchIds,
    );
    expect(replayed.state.invocations).toEqual(initial.state.invocations);
    await second.close();
  });
});
