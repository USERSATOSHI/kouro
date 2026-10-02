import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { ApplicationService } from "../src/application/service";
import { compileTask } from "../src/application/tasks";
import { GitWorkspaceAdapter, type TreeWorkspaceInput } from "../src/adapters/workspace/git";
import {
  taskFixtureWorkflow,
  TaskFixtureHarness,
  installTaskFixture,
} from "../../../scripts/task-fixture";

async function waitFor(predicate: () => boolean) {
  for (let count = 0; count < 600; count++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Task fixture did not reach expected state");
}
async function terminal(service: ApplicationService, runId: string) {
  await waitFor(() => !["pending", "running"].includes(service.getView(runId)!.state.status));
  return service.getView(runId)!;
}
const model = { harness: "codex" as const, modelId: "fixture-model" };
async function bundle(gates = false, writes = false) {
  const source = await compileWorkflow(taskFixtureWorkflow("task-fixture", gates, writes).build());
  return compileTask(
    [
      {
        id: "task-fixture",
        name: "Task fixture",
        version: "1",
        digest: source.digest,
        bundle: source,
      },
    ],
    model,
    model,
    4,
    2,
  );
}

test("one task assigns pinned workflows, runs independent milestones together and forwards prerequisite results", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-tasks-");
  const harness = new TaskFixtureHarness();
  const templateRoot = join(dataDir, "templates");
  await installTaskFixture(templateRoot);
  const service = new ApplicationService({
    dataDir,
    templateRoot,
    harness,
    harnessAdapters: { codex: harness },
  });
  await service.start();
  try {
    const catalog = await service.taskWorkflows();
    expect(catalog.find((item) => item.id === "tiny")!.eligible).toBe(false);
    expect(catalog.find((item) => item.id === "task-fixture")!.eligible).toBe(true);
    const request = {
      task: "Build and combine",
      workflowIds: ["task-fixture"],
      planner: model,
      executor: model,
      maxMilestones: 4,
      maxConcurrent: 2,
      idempotencyKey: "task",
    };
    const run = await service.createTask(request);
    expect((await service.createTask(request)).runId).toBe(run.runId);
    const view = await terminal(service, run.runId);
    expect(view.state.status).toBe("succeeded");
    const work = harness.calls.filter((call) => call.role === "task-fixture-work");
    expect(work).toHaveLength(3);
    expect(work[1]!.started).toBeLessThan(work[0]!.ended);
    expect(work[2]!.started).toBeGreaterThanOrEqual(
      Math.max(
        ...harness.calls
          .filter((call) => call.role === "task-fixture-check" && !call.task.startsWith("Combine"))
          .map((call) => call.ended),
      ),
    );
    expect(work[2]!.task).toContain("Finished Build A");
    expect(work[2]!.task).toContain("Finished Build B");
    expect(harness.calls.every((call) => call.model === model.modelId)).toBe(true);
    const progress = service.coordinator.milestones(run.runId);
    expect(progress.milestones.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    const final = Object.values(view.state.invocations).find(
      (item) => item.scopeId === view.state.rootScopeId && item.nodeId === "done",
    )!;
    expect(
      JSON.parse(new TextDecoder().decode(service.readArtifact(final.output[0]!.id))).milestones,
    ).toHaveLength(3);
    await expect(
      service.createTask({ ...request, workflowIds: ["tiny"], idempotencyKey: "invalid" }),
    ).rejects.toThrow("string task");
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a failed prerequisite blocks dependents, malformed plans start no workflows and cancellation drains parallel work", async () => {
  for (const mode of ["fail", "slow", "invalid"] as const) {
    const dataDir = await mkdtemp("/tmp/kouro-task-stop-");
    const harness = new TaskFixtureHarness(
      mode === "invalid" ? "normal" : mode,
      "task-fixture",
      mode === "invalid"
        ? {
            milestones: [
              { id: "bad", title: "bad", task: "bad", workflowId: "invented", dependsOn: [] },
            ],
          }
        : undefined,
    );
    const service = new ApplicationService({
      dataDir,
      harness,
      harnessAdapters: { codex: harness },
    });
    await service.start();
    try {
      const run = (
        await service.coordinator.createRun({
          workflowId: "automatic-task",
          bundle: await bundle(),
          input: { task: "test" },
          idempotencyKey: mode,
        })
      ).run;
      if (mode === "slow") {
        await waitFor(
          () => harness.calls.filter((call) => call.role === "task-fixture-work").length === 2,
        );
        service.control({
          runId: run.runId,
          action: "cancel",
          expectedRevision: service.getView(run.runId)!.revision,
          actor: "test",
          idempotencyKey: "cancel",
        });
      }
      const view = await terminal(service, run.runId);
      expect(view.state.status).toBe(mode === "slow" ? "cancelled" : "failed");
      expect(harness.calls.some((call) => call.task.startsWith("Combine"))).toBe(false);
      if (mode === "invalid") expect(harness.calls).toHaveLength(1);
      if (mode === "fail")
        expect(service.coordinator.milestones(run.runId).milestones.at(-1)!.status).toBe("blocked");
      if (mode === "slow")
        expect(
          Object.values(view.state.attempts).filter((attempt) => attempt.status === "cancelled"),
        ).toHaveLength(2);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("workflow approval gates survive restart and prevent dependent execution until approved", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-task-approval-");
  const harness = new TaskFixtureHarness();
  let service = new ApplicationService({ dataDir, harness, harnessAdapters: { codex: harness } });
  await service.start();
  try {
    const run = (
      await service.coordinator.createRun({
        workflowId: "automatic-task",
        bundle: await bundle(true),
        input: { task: "gated" },
        idempotencyKey: "gated",
      })
    ).run;
    await waitFor(
      () =>
        Object.values(service.getView(run.runId)!.state.approvals).filter(
          (approval) => approval.status === "pending",
        ).length === 2,
    );
    expect(harness.calls).toHaveLength(1);
    expect(service.coordinator.milestones(run.runId).milestones.map((item) => item.status)).toEqual(
      ["approval", "approval", "waiting"],
    );
    await service.close();
    service = new ApplicationService({ dataDir, harness, harnessAdapters: { codex: harness } });
    await service.start();
    expect(harness.calls).toHaveLength(1);
    const approve = () => {
      const view = service.getView(run.runId)!;
      const approval = Object.values(view.state.approvals).find(
        (item) => item.status === "pending",
      )!;
      service.decideApproval({
        runId: run.runId,
        invocationId: approval.invocationId,
        decision: "approved",
        expectedRevision: view.revision,
        actor: "test",
        idempotencyKey: approval.id,
      });
    };
    approve();
    approve();
    await waitFor(
      () => service.coordinator.milestones(run.runId).milestones.at(-1)?.status === "approval",
    );
    expect(harness.calls.filter((call) => call.task.startsWith("Combine"))).toHaveLength(0);
    approve();
    expect((await terminal(service, run.runId)).state.status).toBe("succeeded");
    expect(harness.calls.filter((call) => call.role === "task-decomposer")).toHaveLength(1);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}

test("nested workflow approvals retain repair budgets, scoped task inputs and explicit models", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-task-repair-");
  const harness = new TaskFixtureHarness("normal", "wrapper", {
    milestones: [
      { id: "a", title: "Build A", task: "Build A", workflowId: "wrapper", dependsOn: [] },
    ],
  });
  const service = new ApplicationService({ dataDir, harnessAdapters: { codex: harness } });
  await service.start();
  try {
    const child = new WorkflowBuilder({ id: "child" });
    const taskType = artifactType<string>("nested-task", { type: "string" });
    const childTask = child.input("task", taskType);
    const report = artifactType<{ summary: string }>("nested-report", {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    });
    const work = child.agent("work", {
      role: "task-fixture-work",
      modelId: "pinned-model",
      prompt: "work",
      input: { description: childTask },
      produces: report,
    });
    const review = child.approval("review", {
      action: "Review changes",
      input: { result: work.output },
    });
    const done = child.complete("done", { output: work.output });
    const failed = child.complete("failed", { result: "failed" });
    child.startAt(work);
    work.on("success").to(review);
    review.on("approved").to(done);
    review.on("rejected").to(failed);
    review
      .on("changes-requested")
      .repair(work, { maxRepairs: 1, feedback: review.output, exhausted: failed });
    const wrapper = new WorkflowBuilder({ id: "wrapper" });
    const task = wrapper.input("task", taskType);
    const nested = wrapper.call("nested", child, { input: { task } });
    wrapper.startAt(nested);
    nested.on("success").to(wrapper.complete("done", { output: nested.output }));
    const source = await compileWorkflow(wrapper.build());
    const taskBundle = await compileTask(
      [{ id: "wrapper", name: "Wrapper", version: "1", digest: source.digest, bundle: source }],
      model,
      model,
      2,
      1,
    );
    const run = (
      await service.coordinator.createRun({
        workflowId: "automatic-task",
        bundle: taskBundle,
        input: { task: "nested" },
        idempotencyKey: "nested",
      })
    ).run;
    const pending = () =>
      Object.values(service.getView(run.runId)!.state.approvals).find(
        (item) => item.status === "pending",
      );
    await waitFor(() => !!pending());
    const first = pending()!;
    service.decideApproval({
      runId: run.runId,
      invocationId: first.invocationId,
      decision: "changes-requested",
      feedback: "Revise A",
      expectedRevision: service.getView(run.runId)!.revision,
      actor: "test",
      idempotencyKey: "repair",
    });
    await waitFor(() => !!pending());
    const view = service.getView(run.runId)!;
    expect(Object.values(view.state.counters)).toEqual([1]);
    expect(
      harness.calls
        .filter((call) => call.role === "task-fixture-work")
        .map((call) => [call.task, call.model]),
    ).toEqual([
      ["Build A", "pinned-model"],
      ["Build A", "pinned-model"],
    ]);
    service.decideApproval({
      runId: run.runId,
      invocationId: pending()!.invocationId,
      decision: "approved",
      expectedRevision: view.revision,
      actor: "test",
      idempotencyKey: "approve",
    });
    expect((await terminal(service, run.runId)).state.status).toBe("succeeded");
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("parallel milestone limit serializes independent workflows when set to one", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-task-serial-");
  const harness = new TaskFixtureHarness();
  const service = new ApplicationService({ dataDir, harnessAdapters: { codex: harness } });
  await service.start();
  try {
    const source = await compileWorkflow(taskFixtureWorkflow().build());
    const taskBundle = await compileTask(
      [
        {
          id: "task-fixture",
          name: "Fixture",
          version: "1",
          digest: source.digest,
          bundle: source,
        },
      ],
      model,
      model,
      4,
      1,
    );
    const run = (
      await service.coordinator.createRun({
        workflowId: "automatic-task",
        bundle: taskBundle,
        input: { task: "serial" },
        idempotencyKey: "serial",
      })
    ).run;
    expect((await terminal(service, run.runId)).state.status).toBe("succeeded");
    const a = harness.calls.filter((call) => call.task.startsWith("Build A"));
    const b = harness.calls.filter((call) => call.task.startsWith("Build B"));
    expect(Math.min(...b.map((call) => call.started))).toBeGreaterThanOrEqual(
      Math.max(...a.map((call) => call.ended)),
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cancellation during milestone worktree allocation fences late activation", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-task-admission-stop-");
  const repositoryPath = join(dataDir, "repo");
  await mkdir(repositoryPath);
  await git(repositoryPath, ["init"]);
  await writeFile(join(repositoryPath, "base.txt"), "base\n");
  await git(repositoryPath, ["add", "."]);
  await git(repositoryPath, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-m",
    "base",
  ]);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let allocating = false;
  class DelayedWorkspace extends GitWorkspaceAdapter {
    override async createAtTree(input: TreeWorkspaceInput) {
      allocating = true;
      await hold;
      return super.createAtTree(input);
    }
  }
  const workspaceAdapter = new DelayedWorkspace({ worktreeRoot: join(dataDir, "worktrees") });
  const harness = new TaskFixtureHarness();
  const service = new ApplicationService({
    dataDir: join(dataDir, "host"),
    workspaceAdapter,
    harnessAdapters: { codex: harness },
  });
  await service.start();
  try {
    const run = (
      await service.coordinator.createRun({
        workflowId: "automatic-task",
        bundle: await bundle(false, true),
        input: { task: "stop allocation" },
        workspace: { repositoryPath },
        idempotencyKey: "stop",
      })
    ).run;
    await waitFor(() => allocating);
    service.control({
      runId: run.runId,
      action: "cancel",
      expectedRevision: service.getView(run.runId)!.revision,
      actor: "test",
      idempotencyKey: "cancel",
    });
    release();
    const view = await terminal(service, run.runId);
    expect(view.state.status).toBe("cancelled");
    expect(Object.values(view.state.scopes).filter((scope) => scope.milestoneId)).toHaveLength(0);
    expect(harness.calls).toHaveLength(1);
    expect(service.coordinator.milestones(run.runId).phase).toBe("cancelled");
    expect(await git(repositoryPath, ["status", "--porcelain"])).toBe("");
  } finally {
    release();
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("milestone steps share a worktree, dependents receive changes and integration retains source checkout", async () => {
  for (const mode of ["write", "conflict"] as const) {
    const dataDir = await mkdtemp("/tmp/kouro-task-workspaces-");
    const repositoryPath = join(dataDir, "repo");
    await mkdir(repositoryPath);
    await git(repositoryPath, ["init"]);
    await writeFile(join(repositoryPath, "shared.txt"), "base\n");
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-m",
      "base",
    ]);
    const harness = new TaskFixtureHarness(mode);
    const service = new ApplicationService({
      dataDir: join(dataDir, "host"),
      harness,
      harnessAdapters: { codex: harness },
    });
    await service.start();
    try {
      const run = (
        await service.coordinator.createRun({
          workflowId: "automatic-task",
          bundle: await bundle(false, true),
          input: { task: "write" },
          workspace: { repositoryPath },
          idempotencyKey: "write",
        })
      ).run;
      const view = await terminal(service, run.runId);
      if (mode === "write")
        expect(
          Object.values(view.state.invocations).flatMap((item) => (item.error ? [item.error] : [])),
        ).toEqual([]);
      expect(view.state.status).toBe(mode === "write" ? "succeeded" : "failed");
      expect(await git(repositoryPath, ["status", "--porcelain"])).toBe("");
      expect(await readFile(join(repositoryPath, "shared.txt"), "utf8")).toBe("base\n");
      const works = harness.calls.filter((call) => call.role === "task-fixture-work");
      const checks = harness.calls.filter((call) => call.role === "task-fixture-check");
      for (let i = 0; i < works.length; i++) expect(works[i]!.cwd).toBe(checks[i]!.cwd);
      expect(works[0]!.cwd).not.toBe(works[1]!.cwd);
      if (mode === "write") {
        expect(await readFile(join(works[2]!.cwd!, "c.txt"), "utf8")).toBe("a\nb\n");
        const snapshot = await service.coordinator.workspaceSnapshot(run.runId);
        expect(snapshot?.patch).toContain("extended");
        expect(snapshot?.patch).toContain("c.txt");
      } else {
        expect(works).toHaveLength(2);
        expect(
          Object.values(view.state.invocations).find(
            (item) => item.nodeId === "execute-milestones",
          )!.error,
        ).toContain("conflict");
        expect(await readFile(join(works[0]!.cwd!, "shared.txt"), "utf8")).toBe("a\n");
      }
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}, 20000);
