import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitWorkspaceAdapter } from "../src/adapters/workspace/git.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function git(cwd: string, args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if (await p.exited) throw new Error(err);
}

describe("parallel workspace integration", () => {
  test("integrates disjoint child worktrees and reports conflicts before mutation", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kouro-parallel-repo-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".git"), { recursive: true });
    await git(repo, ["init", "--initial-branch=main"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    await git(repo, ["add", "."]);
    await git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ]);
    const adapter = new GitWorkspaceAdapter({ worktreeRoot: join(repo, ".worktrees") });
    const target = await adapter.create({
      repositoryPath: repo,
      runId: "run",
      workspaceId: "target",
    });
    const left = await adapter.create({ repositoryPath: repo, runId: "run", workspaceId: "left" });
    const right = await adapter.create({
      repositoryPath: repo,
      runId: "run",
      workspaceId: "right",
    });
    writeFileSync(join(left.path, "left.txt"), "left\n");
    writeFileSync(join(right.path, "right.txt"), "right\n");
    const integrated = await adapter.integrate({ target, sources: [left, right] });
    expect(integrated.conflicts).toEqual([]);
    expect(integrated.target.changedPaths.map((item) => item.path).sort()).toEqual([
      "left.txt",
      "right.txt",
    ]);
    writeFileSync(join(left.path, "same.txt"), "left\n");
    writeFileSync(join(right.path, "same.txt"), "right\n");
    const conflict = await adapter.integrate({ target, sources: [left, right] });
    expect(conflict.conflicts).toContain("same.txt");
    expect(existsSync(join(target.path, "same.txt"))).toBe(false);
    await adapter.cleanup(target);
    await adapter.cleanup(left);
    await adapter.cleanup(right);
  });
});
