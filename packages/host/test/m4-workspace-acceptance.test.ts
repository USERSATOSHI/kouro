import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowBuilder, compileWorkflow } from "@kouro/core";
import { Coordinator } from "../src/coordinator/coordinator.ts";
import { GitWorkspaceAdapter } from "../src/adapters/workspace/git.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";
import type { HarnessAdapter } from "../src/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class WorkspaceWritingHarness implements HarnessAdapter {
  readonly id = "workspace-fixture";
  readonly adapterVersion = "1";
  capabilities() {
    return {
      "structured-output": "unsupported" as const,
      cancel: "unsupported" as const,
      usage: "unsupported" as const,
      "cost-cap": "unsupported" as const,
    };
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    const file = input.prompt.includes("left") ? "left.txt" : "right.txt";
    writeFileSync(join(input.cwd!, file), `${file}\n`);
    return { status: "succeeded" as const, events: [], usage: { quality: "unavailable" } };
  }
}

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr);
}

async function fixtureRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "kouro-m4-workspace-repo-"));
  dirs.push(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  return repo;
}

async function terminal(coordinator: Coordinator, runId: string) {
  for (let i = 0; i < 300; i += 1) {
    const view = coordinator.journal.getView(runId);
    if (view && !["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(5);
  }
  throw new Error("workspace fixture did not terminate");
}

function bundle() {
  const w = new WorkflowBuilder({ id: "workspace-fork" });
  const left = w.agent("left", { prompt: "write left" });
  const right = w.agent("right", { prompt: "write right" });
  const fork = w.parallel("branches", { branches: [left, right] });
  const join = w.join("join", { groupId: "branches", mode: "all-settled" });
  const done = w.complete("done");
  w.startAt(fork);
  fork.on("success").to(join);
  left.on("success").to(join);
  right.on("success").to(join);
  join.on("success").to(done);
  return compileWorkflow(w.build());
}

describe("M4 coordinator workspace isolation", () => {
  test("gives fork branches distinct child worktrees and never auto-integrates at join", async () => {
    const repo = await fixtureRepo();
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m4-workspace-data-"));
    dirs.push(dataDir);
    const adapter = new GitWorkspaceAdapter({ worktreeRoot: join(dataDir, "worktrees") });
    const coordinator = new Coordinator({
      dataDir,
      workspaceAdapter: adapter,
      harness: new WorkspaceWritingHarness(),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const compiled = await bundle();
    const created = await coordinator.createRun({
      workflowId: compiled.rootDefinitionId,
      bundle: compiled,
      idempotencyKey: "workspace-fork",
      workspace: { repositoryPath: repo },
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    const claims = (await adapter.listClaims(created.run.runId)).filter(
      (claim) => claim.workspaceId !== "main",
    );
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.path)).size).toBe(2);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("base\n");
    expect(() => readFileSync(join(repo, "left.txt"))).toThrow();
    expect(() => readFileSync(join(repo, "right.txt"))).toThrow();
    expect(
      claims
        .map((claim) =>
          ["left.txt", "right.txt"].filter((file) => {
            try {
              readFileSync(join(claim.path, file));
              return true;
            } catch {
              return false;
            }
          }),
        )
        .every((files) => files.length === 1),
    ).toBe(true);
    await coordinator.close();
  });

  test("explicitly integrates disjoint changes, propagates deletion and binary data, and leaves conflicts atomic", async () => {
    const repo = await fixtureRepo();
    const root = mkdtempSync(join(tmpdir(), "kouro-m4-integration-"));
    dirs.push(root);
    const adapter = new GitWorkspaceAdapter({ worktreeRoot: join(root, "worktrees") });
    const target = await adapter.create({
      repositoryPath: repo,
      runId: "integration",
      workspaceId: "target",
    });
    const left = await adapter.create({
      repositoryPath: repo,
      runId: "integration",
      workspaceId: "left",
    });
    const right = await adapter.create({
      repositoryPath: repo,
      runId: "integration",
      workspaceId: "right",
    });
    writeFileSync(join(left.path, "left.txt"), "left\n");
    writeFileSync(join(right.path, "right.bin"), new Uint8Array([0, 1, 2, 255]));
    rmSync(join(right.path, "README.md"));
    const integrated = await adapter.integrate({ target, sources: [left, right] });
    expect(integrated.conflicts).toEqual([]);
    expect(readFileSync(join(target.path, "left.txt"), "utf8")).toBe("left\n");
    expect(Array.from(readFileSync(join(target.path, "right.bin")))).toEqual([0, 1, 2, 255]);
    expect(() => readFileSync(join(target.path, "README.md"))).toThrow();
    writeFileSync(join(left.path, "same.txt"), "left\n");
    writeFileSync(join(right.path, "same.txt"), "right\n");
    const before = await adapter.snapshot(target);
    const conflict = await adapter.integrate({ target, sources: [left, right] });
    expect(conflict.conflicts).toContain("same.txt");
    expect((await adapter.snapshot(target)).resultTree).toBe(before.resultTree);
    expect((await adapter.snapshot(target)).patch).toBe(before.patch);
    await adapter.cleanup(target);
    await adapter.cleanup(left);
    await adapter.cleanup(right);
  });

  test("reloads branch claims and refuses cleanup while an invocation is active", async () => {
    const repo = await fixtureRepo();
    const root = mkdtempSync(join(tmpdir(), "kouro-m4-reload-"));
    dirs.push(root);
    const adapter = new GitWorkspaceAdapter({ worktreeRoot: join(root, "worktrees") });
    const claim = await adapter.create({
      repositoryPath: repo,
      runId: "reload",
      workspaceId: "branch-1",
    });
    const reloaded = new GitWorkspaceAdapter({ worktreeRoot: join(root, "worktrees") });
    expect((await reloaded.loadByIdentity("reload", "branch-1")).claimToken).toBe(claim.claimToken);
    expect(await reloaded.listClaims("reload")).toHaveLength(1);
    await expect(reloaded.cleanup(claim, { active: true })).rejects.toThrow("active");
    await reloaded.cleanup(claim);
  });
});
