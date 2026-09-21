import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitWorkspaceAdapter } from "../src/adapters/workspace/git.ts";
import { Coordinator } from "../src/coordinator/coordinator.ts";
import { WorkflowBuilder, compileWorkflow } from "@kouro/core";

describe("GitWorkspaceAdapter", () => {
  test("creates isolated registered worktrees and captures exact changes", async () => {
    const repository = await fixtureRepo();
    const root = mkdtempSync(join(tmpdir(), "kouro-workspaces-"));
    const adapter = new GitWorkspaceAdapter({ worktreeRoot: join(root, "worktrees") });
    const one = await adapter.create({
      repositoryPath: repository,
      runId: "run-a",
      workspaceId: "main",
    });
    const two = await adapter.create({
      repositoryPath: repository,
      runId: "run-b",
      workspaceId: "main",
    });
    expect(one.path).not.toBe(two.path);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("base\n");

    writeFileSync(join(one.path, "new.txt"), "new\n");
    writeFileSync(join(one.path, "binary.bin"), new Uint8Array([0, 1, 2, 255]));
    writeFileSync(join(one.path, "README.md"), "changed\n");
    const snapshot = await adapter.snapshot(one);
    expect(snapshot.resultTree).not.toBe(snapshot.baseTree);
    expect(snapshot.changedPaths.map((item) => item.path).sort()).toEqual([
      "README.md",
      "binary.bin",
      "new.txt",
    ]);
    expect(snapshot.patch).toContain("new.txt");
    expect(snapshot.patchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.changedPaths.find((item) => item.path === "binary.bin")?.binary).toBe(true);
    expect(snapshot.changedPaths.find((item) => item.path === "new.txt")?.binary).toBe(false);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("base\n");
    await adapter.cleanup(one);
    expect(() => readFileSync(one.path)).toThrow();
    await adapter.cleanup(two);
  });

  test("rejects a changed tree and verifies an interrupted commit idempotently", async () => {
    const repository = await fixtureRepo();
    const root = mkdtempSync(join(tmpdir(), "kouro-workspaces-"));
    const adapter = new GitWorkspaceAdapter({ worktreeRoot: join(root, "worktrees") });
    const workspace = await adapter.create({
      repositoryPath: repository,
      runId: "run",
      workspaceId: "main",
    });
    writeFileSync(join(workspace.path, "feature.txt"), "feature\n");
    const tree = (await adapter.snapshot(workspace)).resultTree;
    const first = await adapter.prepareCommit({
      ref: workspace,
      expectedTree: tree,
      operationKey: "approve-1",
      message: "deliver feature",
      author: { name: "Test", email: "test@example.invalid", timestamp: "2026-01-01T00:00:00Z" },
    });
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/);
    const second = await adapter.verifyPreparedCommit({
      ref: workspace,
      expectedTree: tree,
      operationKey: "approve-1",
    });
    expect(second?.commit).toBe(first.commit);
    const third = await adapter.prepareCommit({
      ref: workspace,
      expectedTree: tree,
      operationKey: "approve-1",
      message: "deliver feature",
    });
    expect(third.commit).toBe(first.commit);

    writeFileSync(join(workspace.path, "after.txt"), "too late\n");
    await expect(
      adapter.prepareCommit({
        ref: workspace,
        expectedTree: tree,
        operationKey: "approve-2",
        message: "stale",
      }),
    ).rejects.toThrow("tree changed");
    await adapter.cleanup(workspace);
  });

  test("binds delivery approval to the prepared tree and operation identity", async () => {
    const repository = await fixtureRepo();
    const root = mkdtempSync(join(tmpdir(), "kouro-delivery-data-"));
    const adapter = new GitWorkspaceAdapter({ worktreeRoot: join(root, "worktrees") });
    const workflow = new WorkflowBuilder({ id: "delivery", version: "1" });
    const done = workflow.complete("done");
    workflow.startAt(done);
    const bundle = await compileWorkflow(workflow.build());
    const coordinator = new Coordinator({ dataDir: join(root, "data"), workspaceAdapter: adapter });
    const run = await coordinator.createRun({
      workflowId: "delivery",
      bundle,
      idempotencyKey: "delivery-run",
      workspace: { repositoryPath: repository },
    });
    const runId = run.run.runId;
    const workspacePath = coordinator.workspacePath(runId)!;
    writeFileSync(join(workspacePath, "approved.txt"), "approved\n");
    const action = await coordinator.prepareDelivery({
      runId,
      requestKey: "delivery-request",
      message: "Deliver approved change",
    });
    expect(action.status).toBe("pending");
    await expect(
      coordinator.workspaceCommit({
        runId,
        expectedTree: action.resultTree,
        operationKey: "client-key",
        message: action.message,
        deliveryActionId: action.id,
      }),
    ).rejects.toThrow("pending");
    coordinator.decideDelivery({ actionId: action.id, decision: "approved", actor: "operator" });
    writeFileSync(join(workspacePath, "stale.txt"), "stale\n");
    await expect(
      coordinator.workspaceCommit({
        runId,
        expectedTree: action.resultTree,
        operationKey: "client-key",
        message: action.message,
        deliveryActionId: action.id,
      }),
    ).rejects.toThrow("tree changed");

    const fresh = await coordinator.prepareDelivery({
      runId,
      requestKey: "delivery-request-2",
      message: "Deliver fresh change",
    });
    coordinator.decideDelivery({ actionId: fresh.id, decision: "approved", actor: "operator" });
    const committed = await coordinator.workspaceCommit({
      runId,
      expectedTree: fresh.resultTree,
      operationKey: "client-key-2",
      message: fresh.message,
      deliveryActionId: fresh.id,
    });
    expect(committed.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(coordinator.deliveryAction(fresh.id)?.status).toBe("committed");
    await coordinator.close();
  });
});

async function fixtureRepo(): Promise<string> {
  const repository = mkdtempSync(join(tmpdir(), "kouro-git-repo-"));
  mkdirSync(join(repository, ".git"), { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  writeFileSync(join(repository, "README.md"), "base\n");
  await git(repository, ["add", "--", "."]);
  await git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  return repository;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git failed: ${stderr}`);
}
