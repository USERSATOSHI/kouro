import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  cpSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorkspaceRef {
  readonly repositoryPath: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly claimToken: string;
}

export interface ChangedPath {
  readonly path: string;
  readonly status: string;
  readonly oldPath?: string;
  readonly mode?: string;
  readonly binary: boolean;
}

export interface WorkspaceSnapshot {
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly resultTree: string;
  readonly patch: string;
  readonly patchDigest: string;
  readonly changedPaths: readonly ChangedPath[];
}

export interface PreparedCommit {
  readonly commit: string;
  readonly tree: string;
  readonly parent: string;
  readonly operationKey: string;
  readonly idempotent: boolean;
}
export interface IntegrationResult {
  readonly target: WorkspaceSnapshot;
  readonly sources: readonly WorkspaceSnapshot[];
  readonly conflicts: readonly string[];
}

export interface GitWorkspaceAdapterOptions {
  readonly worktreeRoot: string;
  readonly gitExecutable?: string;
}

export interface TreeWorkspaceInput {
  readonly repositoryPath: string;
  readonly runId: string;
  readonly workspaceId: string;
  /** A commit used only as the synthetic worktree parent. */
  readonly parentCommit?: string;
  /** An exact Git tree object retained by a checkpoint. */
  readonly tree: string;
}

interface ClaimFile extends WorkspaceRef {
  readonly createdAt: string;
}

export class GitWorkspaceAdapter {
  private readonly executable: string;
  private readonly root: string;

  constructor(options: GitWorkspaceAdapterOptions) {
    this.root = resolve(options.worktreeRoot);
    this.executable = options.gitExecutable ?? "git";
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "claims"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "indexes"), { recursive: true, mode: 0o700 });
  }

  async create(input: {
    repositoryPath: string;
    runId: string;
    workspaceId: string;
    baseCommit?: string;
  }): Promise<WorkspaceRef> {
    const repositoryPath = await this.repositoryRoot(input.repositoryPath);
    const baseCommit = await this.git(repositoryPath, [
      "rev-parse",
      `${input.baseCommit ?? "HEAD"}^{commit}`,
    ]);
    const baseTree = await this.git(repositoryPath, ["rev-parse", `${baseCommit}^{tree}`]);
    const path = join(this.root, safePart(input.runId), safePart(input.workspaceId));
    if (existsSync(path)) throw new Error(`workspace path already exists: ${path}`);
    mkdirSync(join(this.root, safePart(input.runId)), { recursive: true, mode: 0o700 });
    await this.git(repositoryPath, ["worktree", "add", "--detach", path, baseCommit]);
    const claim: ClaimFile = {
      repositoryPath,
      runId: input.runId,
      workspaceId: input.workspaceId,
      path,
      baseCommit,
      baseTree,
      claimToken: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    try {
      this.writeClaim(claim);
      await this.assertRegistered(claim);
      return claim;
    } catch (cause) {
      // A claim is only valid once both the durable claim and Git's worktree
      // registry agree.  Roll back either half if the second half fails.
      try {
        await this.git(repositoryPath, ["worktree", "remove", "--force", path]);
      } catch {
        /* best effort rollback */
      }
      rmSync(path, { recursive: true, force: true });
      rmSync(this.claimPath(claim), { force: true });
      throw cause;
    }
  }

  /** Materialize an exact retained tree in a new, independently claimed worktree. */
  async createAtTree(input: TreeWorkspaceInput): Promise<WorkspaceRef> {
    const repositoryPath = await this.repositoryRoot(input.repositoryPath);
    const tree = await this.git(repositoryPath, ["rev-parse", `${input.tree}^{tree}`]);
    const parent = await this.git(repositoryPath, [
      "rev-parse",
      `${input.parentCommit ?? "HEAD"}^{commit}`,
    ]);
    // A worktree is rooted at a commit.  This synthetic commit carries the
    // retained tree exactly; it is never used as a parent of the source run.
    const synthetic = await this.git(
      repositoryPath,
      ["commit-tree", tree, "-p", parent],
      {
        GIT_AUTHOR_NAME: "Kouro checkpoint",
        GIT_AUTHOR_EMAIL: "kouro@localhost",
        GIT_COMMITTER_NAME: "Kouro checkpoint",
        GIT_COMMITTER_EMAIL: "kouro@localhost",
      },
      "checkpoint materialization\n",
    );
    const ref = await this.create({
      repositoryPath,
      runId: input.runId,
      workspaceId: input.workspaceId,
      baseCommit: synthetic,
    });
    const snapshot = await this.snapshot(ref);
    if (snapshot.resultTree !== tree) {
      await this.cleanup(ref).catch(() => undefined);
      throw new Error("materialized workspace tree does not match retained checkpoint tree");
    }
    return ref;
  }

  /** Verify that a retained tree still exists and resolves to a tree object. */
  async verifyTree(repositoryPath: string, tree: string): Promise<string> {
    const repository = await this.repositoryRoot(repositoryPath);
    return this.git(repository, ["rev-parse", `${tree}^{tree}`]);
  }

  /** Reload a branch claim after a coordinator restart without requiring the
   * caller to reconstruct fields that are deliberately owned by the adapter. */
  async loadByIdentity(runId: string, workspaceId: string): Promise<WorkspaceRef> {
    const claimPath = this.claimPath({ runId, workspaceId });
    if (!existsSync(claimPath))
      throw new Error(`workspace claim not found: ${runId}/${workspaceId}`);
    return this.load(JSON.parse(readFileSync(claimPath, "utf8")) as WorkspaceRef);
  }

  async listClaims(runId: string): Promise<WorkspaceRef[]> {
    const prefix = `${safePart(runId)}--`;
    return readdirSync(join(this.root, "claims"))
      .filter(
        (name) =>
          name.startsWith(prefix) && name.endsWith(".json") && !name.endsWith(".prepared.json"),
      )
      .map(
        (name) => JSON.parse(readFileSync(join(this.root, "claims", name), "utf8")) as WorkspaceRef,
      )
      .filter((claim) => claim.runId === runId)
      .map((claim) => claim);
  }

  async load(ref: WorkspaceRef): Promise<WorkspaceRef> {
    const claim = this.readClaim(ref);
    if (!sameIdentity(claim, ref))
      throw new Error("workspace claim does not match requested identity");
    if (!(await this.registeredPath(claim.repositoryPath, claim.path)))
      throw new Error("workspace is no longer registered with Git");
    return claim;
  }

  async snapshot(ref: WorkspaceRef): Promise<WorkspaceSnapshot> {
    const claim = await this.load(ref);
    const temp = join(this.root, "indexes", `${randomUUID()}.index`);
    try {
      await this.git(claim.path, ["read-tree", "HEAD"], { GIT_INDEX_FILE: temp });
      await this.git(claim.path, ["add", "-A", "--", "."], { GIT_INDEX_FILE: temp });
      const resultTree = await this.git(claim.path, ["write-tree"], { GIT_INDEX_FILE: temp });
      const patch = await this.git(
        claim.path,
        ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color"],
        { GIT_INDEX_FILE: temp },
      );
      const rawNames = await this.git(
        claim.path,
        ["diff", "--cached", "--name-status", "--find-renames", "--find-copies"],
        { GIT_INDEX_FILE: temp },
      );
      const summary = await this.git(claim.path, ["diff", "--cached", "--summary"], {
        GIT_INDEX_FILE: temp,
      });
      const numstat = await this.git(claim.path, ["diff", "--cached", "--numstat"], {
        GIT_INDEX_FILE: temp,
      });
      const changedPaths = parseNameStatus(rawNames, summary, numstat);
      const patchDigest = await sha256(patch);
      return {
        baseCommit: claim.baseCommit,
        baseTree: claim.baseTree,
        resultTree,
        patch,
        patchDigest,
        changedPaths,
      };
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /** Apply independent child worktree patches only when their changed paths do
   * not overlap. The target is never mutated on a detected conflict. */
  async integrate(input: {
    target: WorkspaceRef;
    sources: readonly WorkspaceRef[];
  }): Promise<IntegrationResult> {
    const target = await this.snapshot(input.target);
    const sources = await Promise.all(input.sources.map((ref) => this.snapshot(ref)));
    const paths = new Map<string, number>();
    const touch = (change: ChangedPath) => [
      change.path,
      ...(change.oldPath ? [change.oldPath] : []),
    ];
    for (const source of sources)
      for (const change of source.changedPaths)
        for (const path of touch(change)) paths.set(path, (paths.get(path) ?? 0) + 1);
    for (const change of target.changedPaths)
      for (const path of touch(change)) paths.set(path, (paths.get(path) ?? 0) + 1);
    const conflicts = [...paths.entries()]
      .filter(([, count]) => count > 1)
      .map(([path]) => path)
      .sort();
    if (conflicts.length) return { target, sources, conflicts };
    const backup = join(this.root, "integration-backups", randomUUID());
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    try {
      // Keep the worktree's .git indirection untouched, but retain every other
      // byte so a failed multi-source application can be rolled back exactly.
      for (const entry of readdirSync(input.target.path)) {
        if (entry === ".git") continue;
        cpSync(join(input.target.path, entry), join(backup, entry), {
          recursive: true,
          force: true,
        });
      }
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
        const source = sources[sourceIndex]!;
        for (const change of source.changedPaths) {
          const sourceRef = input.sources[sourceIndex]!;
          const sourcePath = join(sourceRef.path, change.path);
          const targetPath = join(input.target.path, change.path);
          if (change.oldPath && change.status.startsWith("R"))
            rmSync(join(input.target.path, change.oldPath), { recursive: true, force: true });
          if (change.status.startsWith("D")) rmSync(targetPath, { recursive: true, force: true });
          else if (existsSync(sourcePath)) {
            mkdirSync(join(targetPath, ".."), { recursive: true });
            rmSync(targetPath, { recursive: true, force: true });
            cpSync(sourcePath, targetPath, { recursive: true, force: true });
            if (change.mode && !change.mode.endsWith("000"))
              chmodSync(targetPath, Number.parseInt(change.mode, 8) & 0o777);
          }
        }
      }
      return { target: await this.snapshot(input.target), sources, conflicts: [] };
    } catch (cause) {
      try {
        for (const entry of readdirSync(input.target.path)) {
          if (entry !== ".git")
            rmSync(join(input.target.path, entry), { recursive: true, force: true });
        }
        for (const entry of readdirSync(backup))
          cpSync(join(backup, entry), join(input.target.path, entry), {
            recursive: true,
            force: true,
          });
      } catch {
        /* preserve the original integration error */
      }
      throw cause;
    } finally {
      rmSync(backup, { recursive: true, force: true });
    }
  }

  async prepareCommit(input: {
    ref: WorkspaceRef;
    expectedTree: string;
    operationKey: string;
    message: string;
    author?: { name: string; email: string; timestamp?: string };
  }): Promise<PreparedCommit> {
    const claim = await this.load(input.ref);
    const current = await this.snapshot(claim);
    if (current.resultTree !== input.expectedTree)
      throw new Error("workspace tree changed after approval");
    const head = await this.git(claim.path, ["rev-parse", "HEAD"]);
    if (head !== claim.baseCommit) {
      const existing = await this.verifyCommit(claim, input);
      if (existing) return { ...existing, idempotent: true };
      throw new Error("workspace HEAD changed after approval");
    }
    const marker = this.preparedPath(claim);
    if (existsSync(marker)) {
      const existing = await this.verifyCommit(claim, input);
      if (existing) return { ...existing, idempotent: true };
    }
    const author = input.author ?? { name: "Kouro", email: "kouro@localhost" };
    const timestamp = author.timestamp ?? new Date().toISOString();
    const env = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    };
    const commit = await this.git(
      claim.path,
      ["commit-tree", input.expectedTree, "-p", claim.baseCommit, "-m", input.message],
      env,
    );
    await this.git(claim.path, ["update-ref", "HEAD", commit, claim.baseCommit]);
    const prepared = {
      commit,
      tree: input.expectedTree,
      parent: claim.baseCommit,
      operationKey: input.operationKey,
    };
    writeFileSync(marker, JSON.stringify(prepared, null, 2), { mode: 0o600 });
    return { ...prepared, idempotent: false };
  }

  async verifyPreparedCommit(input: {
    ref: WorkspaceRef;
    expectedTree: string;
    operationKey: string;
  }): Promise<PreparedCommit | null> {
    const claim = await this.load(input.ref);
    const marker = this.preparedPath(claim);
    if (!existsSync(marker)) return null;
    const value = JSON.parse(readFileSync(marker, "utf8")) as PreparedCommit;
    if (value.operationKey !== input.operationKey || value.tree !== input.expectedTree) return null;
    const verified = await this.verifyCommit(claim, {
      expectedTree: input.expectedTree,
      operationKey: input.operationKey,
      message: "",
    });
    return verified ? { ...verified, idempotent: true } : null;
  }

  async cleanup(
    ref: WorkspaceRef,
    options: { active?: boolean; retainedTreeRoots?: readonly string[] } = {},
  ): Promise<void> {
    if (options.active) throw new Error("refusing cleanup of active workspace claim");
    const claim = await this.load(ref);
    if (options.retainedTreeRoots?.length) {
      const current = await this.snapshot(claim);
      if (options.retainedTreeRoots.includes(current.resultTree))
        throw new Error("refusing cleanup of checkpoint-retained workspace tree");
    }
    const registered = await this.registeredPath(claim.repositoryPath, claim.path);
    if (!registered) throw new Error("refusing cleanup of unregistered workspace");
    await this.git(claim.repositoryPath, ["worktree", "remove", "--force", claim.path]);
    rmSync(claim.path, { recursive: true, force: true });
    rmSync(this.claimPath(claim), { force: true });
    rmSync(this.preparedPath(claim), { force: true });
  }

  private async verifyCommit(
    claim: WorkspaceRef,
    input: { expectedTree: string; operationKey: string; message: string },
  ): Promise<PreparedCommit | null> {
    const head = await this.git(claim.path, ["rev-parse", "HEAD"]);
    const tree = await this.git(claim.path, ["rev-parse", "HEAD^{tree}"]);
    const parents = await this.git(claim.path, ["show", "-s", "--format=%P", head]);
    const subject = await this.git(claim.path, ["show", "-s", "--format=%s", head]);
    if (
      tree !== input.expectedTree ||
      parents.split(/\s+/)[0] !== claim.baseCommit ||
      (input.message && subject !== input.message)
    )
      return null;
    return {
      commit: head,
      tree,
      parent: claim.baseCommit,
      operationKey: input.operationKey,
      idempotent: true,
    };
  }

  private readClaim(ref: WorkspaceRef): ClaimFile {
    return JSON.parse(readFileSync(this.claimPath(ref), "utf8")) as ClaimFile;
  }

  private writeClaim(claim: ClaimFile): void {
    writeFileSync(this.claimPath(claim), JSON.stringify(claim, null, 2), { mode: 0o600 });
  }

  private claimPath(ref: Pick<WorkspaceRef, "runId" | "workspaceId">): string {
    return join(this.root, "claims", `${safePart(ref.runId)}--${safePart(ref.workspaceId)}.json`);
  }

  private preparedPath(ref: Pick<WorkspaceRef, "runId" | "workspaceId">): string {
    return join(
      this.root,
      "claims",
      `${safePart(ref.runId)}--${safePart(ref.workspaceId)}.prepared.json`,
    );
  }

  private async repositoryRoot(path: string): Promise<string> {
    const root = await this.git(resolve(path), ["rev-parse", "--show-toplevel"]);
    return resolve(root);
  }

  private async assertRegistered(claim: ClaimFile): Promise<void> {
    const registered = await this.registeredPath(claim.repositoryPath, claim.path);
    if (!registered) throw new Error("created workspace is not registered with Git");
    const head = await this.git(claim.path, ["rev-parse", "HEAD"]);
    if (head !== claim.baseCommit)
      throw new Error("created workspace does not point at pinned base");
  }

  private async registeredPath(repository: string, path: string): Promise<boolean> {
    const out = await this.git(repository, ["worktree", "list", "--porcelain"]);
    return out.split("\n").some((line) => line === `worktree ${resolve(path)}`);
  }

  private async git(
    cwd: string,
    args: string[],
    extraEnv?: Record<string, string>,
    stdin?: string,
  ): Promise<string> {
    const proc = Bun.spawn([this.executable, ...args], {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin === undefined ? undefined : "pipe",
    });
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args[0] ?? ""} failed (${code}): ${stderr.trim()}`);
    return stdout.trim();
  }
}

function safePart(value: string): string {
  const part = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!part || part === "." || part === "..") throw new Error("invalid workspace identity");
  return part;
}

function parseNameStatus(raw: string, summary: string, numstat: string): ChangedPath[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      const status = fields[0] ?? "?";
      const path = fields.at(-1) ?? "";
      const oldPath = fields.length > 2 ? fields[1] : undefined;
      const binary = numstat.split("\n").some((item) => {
        const columns = item.split("\t");
        return (
          columns.length >= 3 &&
          columns[0] === "-" &&
          columns[1] === "-" &&
          (columns[2] === path || columns[2]?.endsWith(` => ${path}`))
        );
      });
      const modeMatch = summary
        .split("\n")
        .find((item) => item.endsWith(` ${path}`))
        ?.match(/(?:mode|create mode|delete mode) (\d+)/);
      return {
        path,
        status,
        ...(oldPath ? { oldPath } : {}),
        ...(modeMatch?.[1] ? { mode: modeMatch[1] } : {}),
        binary,
      };
    });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameIdentity(a: WorkspaceRef, b: WorkspaceRef): boolean {
  return (
    a.repositoryPath === b.repositoryPath &&
    a.runId === b.runId &&
    a.workspaceId === b.workspaceId &&
    resolve(a.path) === resolve(b.path) &&
    a.claimToken === b.claimToken
  );
}
