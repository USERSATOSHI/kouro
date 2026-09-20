import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationService } from "../src/application/service.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";
import { GitWorkspaceAdapter } from "../src/adapters/workspace/git.ts";
import { canonicalize } from "@kouro/core";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const error = await new Response(proc.stderr).text();
  if (await proc.exited) throw new Error(error);
}
async function repo() {
  const path = mkdtempSync(join(tmpdir(), "kouro-m7-repo-"));
  dirs.push(path);
  await git(path, ["init", "--initial-branch=main"]);
  writeFileSync(join(path, "README.md"), "base\n");
  await git(path, ["add", "."]);
  await git(path, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  return path;
}
async function until(
  service: ApplicationService,
  runId: string,
  predicate: (view: NonNullable<ReturnType<ApplicationService["getView"]>>) => boolean,
) {
  for (let i = 0; i < 400; i += 1) {
    const view = service.getView(runId);
    if (view && predicate(view)) return view;
    await Bun.sleep(5);
  }
  const last = service.getView(runId);
  throw new Error(
    `run did not reach expected state: ${runId} ${last?.state.status} approvals=${JSON.stringify(last?.state.approvals)} invocations=${JSON.stringify(last?.state.invocations)}`,
  );
}

describe("M7 Coordinator checkpoint and fork materialization", () => {
  test("forks preserve completed prefix without effects, request fresh approval, and retain cleanup", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-data-"));
    dirs.push(dataDir);
    const repository = await repo();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "m7-parent",
      workspace: { repositoryPath: repository },
    });
    const pending = await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    const before = pending.revision;
    const captured = await service.captureCheckpoint(parent.runId, {
      idempotencyKey: "m7-capture",
    });
    expect(service.checkpoint(parent.runId)?.checkpointId).toBe(captured.certificate.checkpointId);
    const afterCapture = service.getView(parent.runId)!;
    expect(afterCapture.revision).toBeGreaterThanOrEqual(before);
    const forks = await service.forkCheckpoint({
      checkpointId: captured.certificate.checkpointId,
      requestKey: "m7-fork",
      name: "approaches",
      count: 2,
    });
    expect(forks).toHaveLength(2);
    expect(
      service
        .genealogy(parent.runId)
        .nodes.filter((node) => node.parentRunId === parent.runId)
        .map((node) => node.label)
        .sort(),
    ).toEqual(["approaches #1", "approaches #2"]);
    const childViews = await Promise.all(
      forks.map((fork) =>
        until(service, fork.runId, (view) =>
          Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
        ),
      ),
    );
    for (const view of childViews) {
      const inherited = Object.values(view.state.invocations).filter(
        (invocation) => invocation.sourceInvocationId,
      );
      expect(inherited.length).toBeGreaterThan(0);
      expect(Object.values(view.state.attempts)).toHaveLength(0);
      expect(
        Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
      ).toBe(true);
      const childApproval = Object.values(view.state.approvals).find(
        (approval) => approval.status === "pending",
      )!;
      const parentApproval = Object.values(pending.state.approvals).find(
        (approval) => approval.status === "pending",
      )!;
      expect(childApproval.id).not.toBe(parentApproval.id);
      expect(childApproval.subjectRevision).not.toBe(parentApproval.subjectRevision);
    }
    expect((await service.workspaceSnapshot(forks[0]!.runId))?.resultTree).toBe(
      (await service.workspaceSnapshot(forks[1]!.runId))?.resultTree,
    );
    expect(service.getView(parent.runId)!.revision).toBe(afterCapture.revision);
    const sameRequest = await service.forkCheckpoint({
      checkpointId: captured.certificate.checkpointId,
      requestKey: "m7-fork",
      name: "approaches",
      count: 2,
    });
    expect(sameRequest.map((item) => item.runId)).toEqual(forks.map((item) => item.runId));
    for (const fork of forks) {
      const view = service.getView(fork.runId)!;
      const approval = Object.values(view.state.approvals).find(
        (item) => item.status === "pending",
      )!;
      service.coordinator.decideApproval({
        runId: fork.runId,
        invocationId: approval.invocationId,
        decision: "approved",
        expectedRevision: view.revision,
        actor: "fixture",
        idempotencyKey: `m7-approve-${fork.runId}`,
        bindingDigest: approval.bindingDigest,
        subjectRevision: approval.subjectRevision,
      });
      const terminal = await until(service, fork.runId, (current) =>
        ["succeeded", "failed"].includes(current.state.status),
      );
      expect(terminal.state.status).toBe("succeeded");
      for (const nodeId of ["plan", "approve-plan", "implement", "validate", "done"])
        expect(
          Object.values(terminal.state.invocations).filter(
            (invocation) => invocation.nodeId === nodeId,
          ),
        ).toHaveLength(1);
      const planInvocation = Object.values(terminal.state.invocations).find(
        (invocation) => invocation.nodeId === "plan",
      )!;
      expect(
        Object.values(terminal.state.attempts).some(
          (attempt) => attempt.invocationId === planInvocation.id,
        ),
      ).toBe(false);
      const comparison = service.checkpointComparison(fork.runId);
      expect(comparison.inheritedCount).toBe(1);
      expect(comparison.newCount).toBe(4);
      expect(comparison.missingCount).toBe(0);
      expect(comparison.entries.find((entry) => entry.label === "plan")?.status).toBe("inherited");
      expect(comparison.entries.find((entry) => entry.label === "plan")?.durationKnown).toBe(true);
    }
    expect(service.getView(parent.runId)!.revision).toBe(afterCapture.revision);
    await expect(service.cleanupWorkspace(parent.runId)).rejects.toThrow(/retained/);
    await service.close();
  });

  test("rejects a fork when captured configuration dependencies change", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-invalidated-"));
    dirs.push(dataDir);
    const repository = await repo();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "parent",
      workspace: { repositoryPath: repository },
    });
    await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    const captured = await service.captureCheckpoint(parent.runId, { idempotencyKey: "capture" });
    service.coordinator.journal.updateRunInput(parent.runId, {
      ...service.coordinator.journal.getRunInput(parent.runId),
      changedProfileDigest: "sha256:different",
    });
    await expect(
      service.forkCheckpoint({
        checkpointId: captured.certificate.checkpointId,
        requestKey: "invalidated",
      }),
    ).rejects.toThrow(/config-dependencies-changed/);
    expect(
      service.coordinator.journal.listRuns().filter((run) => run.runId !== parent.runId),
    ).toHaveLength(0);
    await service.close();
  });

  test("allows an execution-profile-only fork variant and records its child config identity", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-variant-"));
    dirs.push(dataDir);
    const repository = await repo();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "variant-parent",
      workspace: { repositoryPath: repository },
    });
    await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    const captured = await service.captureCheckpoint(parent.runId, {
      idempotencyKey: "variant-capture",
    });
    const [fork] = await service.forkCheckpoint({
      checkpointId: captured.certificate.checkpointId,
      requestKey: "variant-fork",
      executionProfile: "pi-readonly",
      count: 1,
    });
    const childInput = service.coordinator.journal.getRunInput(fork!.runId)!;
    const metadata = childInput.__kouroFork as Record<string, unknown>;
    expect(childInput.__kouroExecutionProfile).toBe("pi-readonly");
    expect(metadata.executionProfile).toBe("pi-readonly");
    expect(metadata.configDependencyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(
      service.forkCheckpoint({
        checkpointId: captured.certificate.checkpointId,
        requestKey: "variant-invalid-input",
        input: { changedCompletedDependency: true },
        executionProfile: "pi-readonly",
        count: 1,
      }),
    ).rejects.toThrow("fork variant may change only execution profile");
    await service.close();
  });

  test("forks an unexecuted prompt variant without changing the graph or completed prefix", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-prompt-variant-"));
    dirs.push(dataDir);
    const repository = await repo();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "prompt-variant-parent",
      workspace: { repositoryPath: repository },
    });
    await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    const captured = await service.captureCheckpoint(parent.runId, {
      idempotencyKey: "prompt-variant-capture",
    });
    const sourceBundle = service.coordinator.journal.getBundle(parent.runId)!;
    const [fork] = await service.forkCheckpoint({
      checkpointId: captured.certificate.checkpointId,
      requestKey: "prompt-variant-fork",
      promptVariants: { implement: "Use the alternate implementation strategy." },
      count: 1,
    });
    const childBundle = service.coordinator.journal.getBundle(fork!.runId)!;
    const childDefinition = childBundle.definitions["feature"]!;
    const sourceDefinition = sourceBundle.definitions["feature"]!;
    expect(childBundle.digest).not.toBe(sourceBundle.digest);
    const childImplement = childDefinition.nodes.find((node) => node.id === "implement");
    expect(childImplement?.kind === "agent" ? childImplement.prompt : undefined).toBe(
      "Use the alternate implementation strategy.",
    );
    expect(canonicalize(childBundle.schemas)).toBe(canonicalize(sourceBundle.schemas));
    expect(canonicalize(childDefinition.controlEdges)).toBe(
      canonicalize(sourceDefinition.controlEdges),
    );
    expect(
      (service.coordinator.journal.getRunInput(fork!.runId)!.__kouroFork as Record<string, unknown>)
        .bundleDigest,
    ).toBe(childBundle.digest);
    await expect(
      service.forkCheckpoint({
        checkpointId: captured.certificate.checkpointId,
        requestKey: "prompt-variant-completed",
        promptVariants: { plan: "Do not alter the completed plan." },
        count: 1,
      }),
    ).rejects.toThrow(/completed node: plan/);
    await service.close();
  });

  test("rebuilds retention marks from SQLite after a capture/mark crash", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-retention-crash-"));
    dirs.push(dataDir);
    const repository = await repo();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "retention-parent",
      workspace: { repositoryPath: repository },
    });
    await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    await service.captureCheckpoint(parent.runId, { idempotencyKey: "retention-capture" });
    await service.close();
    rmSync(join(dataDir, "checkpoint-retention.json"));

    const restarted = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await restarted.start();
    await expect(restarted.cleanupWorkspace(parent.runId)).rejects.toThrow(/retained/);
    await restarted.close();
  });

  test("retries capture after certificate save with the same checkpoint identity", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-capture-crash-"));
    dirs.push(dataDir);
    const repository = await repo();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "capture-crash-parent",
      workspace: { repositoryPath: repository },
    });
    await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    const journal = service.coordinator.journal;
    const record = journal.recordCheckpointOperation.bind(journal);
    let failOnce = true;
    journal.recordCheckpointOperation = ((input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated crash after certificate save");
      }
      return record(input);
    }) as typeof journal.recordCheckpointOperation;
    const request = { idempotencyKey: "capture-crash-request" };
    await expect(service.captureCheckpoint(parent.runId, request)).rejects.toThrow(
      /simulated crash after certificate save/,
    );
    const firstId = (
      journal.db.query("SELECT id FROM checkpoints WHERE source_run_id = ?1").get(parent.runId) as {
        id: string;
      }
    ).id;
    const captured = await service.captureCheckpoint(parent.runId, request);
    expect(captured.certificate.checkpointId).toBe(firstId);
    expect(
      journal.db.query("SELECT id FROM checkpoints WHERE source_run_id = ?1").all(parent.runId),
    ).toHaveLength(1);
    await service.close();
  });

  test("retries a fork after worktree allocation without duplicating its child", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-fork-crash-"));
    dirs.push(dataDir);
    const repository = await repo();
    class OneFaultWorkspace extends GitWorkspaceAdapter {
      private fault = true;
      override async createAtTree(input: Parameters<GitWorkspaceAdapter["createAtTree"]>[0]) {
        const ref = await super.createAtTree(input);
        if (this.fault) {
          this.fault = false;
          throw new Error("simulated crash after worktree allocation");
        }
        return ref;
      }
    }
    const workspaceAdapter = new OneFaultWorkspace({ worktreeRoot: join(dataDir, "worktrees") });
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
      workspaceAdapter,
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "fault-parent",
      workspace: { repositoryPath: repository },
    });
    await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    const captured = await service.captureCheckpoint(parent.runId, {
      idempotencyKey: "fault-capture",
    });
    const request = {
      checkpointId: captured.certificate.checkpointId,
      requestKey: "fault-fork",
      count: 1,
    };
    await expect(service.forkCheckpoint(request)).rejects.toThrow(/simulated crash/);
    const childrenBefore = service.coordinator.journal
      .listRuns()
      .filter((run) => run.runId !== parent.runId);
    expect(childrenBefore).toHaveLength(1);
    const [child] = await service.forkCheckpoint(request);
    expect(child?.runId).toBe(childrenBefore[0]?.runId);
    expect(await workspaceAdapter.listClaims(child!.runId)).toHaveLength(1);
    expect(
      service.coordinator.journal.listRuns().filter((run) => run.runId !== parent.runId),
    ).toHaveLength(1);
    await service.close();
  });

  test("refuses to adopt a divergent unprepared fork worktree after a crash", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m7-divergent-fork-"));
    dirs.push(dataDir);
    const repository = await repo();
    class DivergentWorkspace extends GitWorkspaceAdapter {
      private failOnce = true;
      override async createAtTree(input: Parameters<GitWorkspaceAdapter["createAtTree"]>[0]) {
        const ref = await super.createAtTree(input);
        if (this.failOnce) {
          this.failOnce = false;
          writeFileSync(join(ref.path, "README.md"), "diverged after allocation\n");
          throw new Error("simulated crash with dirty child worktree");
        }
        return ref;
      }
    }
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
      workspaceAdapter: new DivergentWorkspace({ worktreeRoot: join(dataDir, "worktrees") }),
    });
    await service.start();
    const parent = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "divergent-parent",
      workspace: { repositoryPath: repository },
    });
    await until(service, parent.runId, (view) =>
      Object.values(view.state.approvals).some((approval) => approval.status === "pending"),
    );
    const captured = await service.captureCheckpoint(parent.runId, {
      idempotencyKey: "divergent-capture",
    });
    const request = {
      checkpointId: captured.certificate.checkpointId,
      requestKey: "divergent-fork",
      count: 1,
    };
    await expect(service.forkCheckpoint(request)).rejects.toThrow(/simulated crash/);
    await expect(service.forkCheckpoint(request)).rejects.toThrow(/diverged from checkpoint tree/);
    expect(
      service.coordinator.journal.listRuns().filter((run) => run.runId !== parent.runId),
    ).toHaveLength(1);
    await service.close();
  });
});
