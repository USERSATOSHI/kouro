import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SandboxErrorKind,
  GitCommandRunner,
  WorktreeSandboxProvider,
  toErr,
  type GitCommandOutput,
  type PinnedRepository,
  type RegisteredRepository,
  type SandboxError,
  type RunWorktree,
} from '@kouro/sandbox-worktree';
import { ParallelWorktreeManager } from '../../packages/cli/src/parallel-worktree-manager.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { err, type Result } from '@usersatoshi/results';

class FailAfterApplyingTreeGitRunner extends GitCommandRunner {
  private failed = false;

  override async run(
    cwd: string,
    operation: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
  ): Promise<Result<GitCommandOutput, SandboxError>> {
    const result = await super.run(cwd, operation, args, environment);
    if (!this.failed && operation === 'apply integrated tree' && result.isOk()) {
      this.failed = true;
      return err(
        toErr(SandboxErrorKind.GitFailure, {
          operation,
          exitCode: 137,
          message: 'simulated process interruption after applying tree',
        }),
      );
    }
    return result;
  }
}

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kouro Test',
      GIT_AUTHOR_EMAIL: 'kouro@example.test',
      GIT_COMMITTER_NAME: 'Kouro Test',
      GIT_COMMITTER_EMAIL: 'kouro@example.test',
      GIT_AUTHOR_DATE: '2026-07-26T00:00:00.000Z',
      GIT_COMMITTER_DATE: '2026-07-26T00:00:00.000Z',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

describe('WorktreeSandboxProvider', () => {
  let temporaryRoot: string;
  let repositoryPath: string;
  let managementRoot: string;
  let provider: WorktreeSandboxProvider;
  let repository: RegisteredRepository;
  let pinned: PinnedRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'kouro-worktree-test-'));
    repositoryPath = join(temporaryRoot, 'repository');
    managementRoot = join(temporaryRoot, 'management');
    await git(temporaryRoot, 'init', '--initial-branch=main', repositoryPath);
    await writeFile(join(repositoryPath, 'tracked.txt'), 'initial\n');
    await git(repositoryPath, 'add', 'tracked.txt');
    await git(repositoryPath, 'commit', '-m', 'initial');

    provider = new WorktreeSandboxProvider(managementRoot);
    expect((await provider.initialize()).isOk()).toBe(true);
    repository = (await provider.registerRepository('fixture', repositoryPath)).unwrap();
    pinned = (await provider.pinStartingCommit(repository)).unwrap();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test('pins a repository and isolates concurrent run worktrees', async () => {
    expect(pinned.startingCommit).toMatch(/^[0-9a-f]{40}$/);
    const secondProvider = new WorktreeSandboxProvider(managementRoot);
    expect((await secondProvider.initialize()).isOk()).toBe(true);

    const [first, second] = await Promise.all([
      provider.createWorktree(pinned, 'run-one'),
      secondProvider.createWorktree(pinned, 'run-two'),
    ]);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const firstWorktree = first.unwrap();
    const secondWorktree = second.unwrap();
    expect(firstWorktree.path).not.toBe(secondWorktree.path);

    await writeFile(join(firstWorktree.path, 'tracked.txt'), 'run one\n');
    expect(await readFile(join(secondWorktree.path, 'tracked.txt'), 'utf8')).toBe('initial\n');
    expect(await git(repositoryPath, 'worktree', 'list', '--porcelain')).toContain(
      firstWorktree.path,
    );
    expect(await git(repositoryPath, 'worktree', 'list', '--porcelain')).toContain(
      secondWorktree.path,
    );
  });

  test('snapshots a matching base and requires it for detached repositories', async () => {
    expect((await provider.resolveBaseBranch(pinned)).unwrap()).toBe('main');
    await git(repositoryPath, 'checkout', '--detach', pinned.startingCommit);
    const detached = (await provider.pinStartingCommit(repository)).unwrap();
    expect((await provider.resolveBaseBranch(detached)).isErr()).toBe(true);
    expect((await provider.resolveBaseBranch(detached, 'main')).unwrap()).toBe('main');
  });

  test('reconciles creation when the worktree exists but metadata was not recorded', async () => {
    const first = (await provider.createWorktree(pinned, 'interrupted-run')).unwrap();
    await unlink(join(managementRoot, 'runs', 'fixture', 'interrupted-run.json'));

    const restarted = new WorktreeSandboxProvider(managementRoot);
    expect((await restarted.initialize()).isOk()).toBe(true);
    const recovered = await restarted.createWorktree(pinned, 'interrupted-run');

    expect(recovered.isOk()).toBe(true);
    expect(recovered.unwrap()).toEqual(first);
    const listed = await git(repositoryPath, 'worktree', 'list', '--porcelain');
    expect(listed.split(`worktree ${await realpath(first.path)}`).length - 1).toBe(1);
  });

  test('writes checksum-bearing status and binary diff artifacts atomically', async () => {
    const worktree = (await provider.createWorktree(pinned, 'artifact-run')).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'changed\n');
    await writeFile(join(worktree.path, 'untracked.txt'), 'new\n');

    const captured = await provider.captureArtifacts(worktree);

    expect(captured.isOk()).toBe(true);
    const artifacts = captured.unwrap();
    const status = await readFile(artifacts.status.path, 'utf8');
    const diff = await readFile(artifacts.diff.path, 'utf8');
    expect(status).toContain('tracked.txt');
    expect(status).toContain('untracked.txt');
    expect(diff).toContain('-initial');
    expect(diff).toContain('+changed');
    expect(diff).toContain('diff --git a/untracked.txt b/untracked.txt');
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+new');
    expect(await git(worktree.path, 'diff', '--cached', '--name-only')).toBe('');
    expect(artifacts.diff.checksum).toBe(createHash('sha256').update(diff).digest('hex'));
    expect(artifacts.diff.size).toBe(Buffer.byteLength(diff));
  });

  test('recovers an already-created controlled commit without duplicating it', async () => {
    const worktree = (await provider.createWorktree(pinned, 'commit-run')).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'committed\n');
    const prepared = (await provider.prepareCommit(worktree)).unwrap();
    const input = {
      worktree,
      expectedHead: prepared.head,
      expectedTree: prepared.tree,
      message: 'controlled change',
      identity: {
        name: 'Kouro',
        email: 'kouro@example.test',
      },
      timestamp: '2026-07-26T01:02:03.000Z',
    } as const;

    const committed = await provider.commitWorktree(input);
    const recovered = await provider.commitWorktree(input);

    expect(committed.isOk()).toBe(true);
    expect(committed.unwrap().recovered).toBe(false);
    expect(recovered.isOk()).toBe(true);
    expect(recovered.unwrap()).toEqual({
      commit: committed.unwrap().commit,
      recovered: true,
    });
    expect(await git(worktree.path, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(await git(worktree.path, 'rev-parse', 'HEAD^{tree}')).toBe(prepared.tree);
  });

  test('pushes without force and rejects a conflicting remote delivery branch', async () => {
    const remote = join(temporaryRoot, 'remote.git');
    await git(temporaryRoot, 'init', '--bare', remote);
    await git(repositoryPath, 'remote', 'add', 'origin', remote);
    const worktree = (await provider.createWorktree(pinned, 'push-run')).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'delivered\n');
    const prepared = (await provider.prepareCommit(worktree)).unwrap();
    const committed = (
      await provider.commitWorktree({
        worktree,
        expectedHead: prepared.head,
        expectedTree: prepared.tree,
        message: 'reviewed delivery',
        identity: { name: 'Kouro', email: 'kouro@example.test' },
        timestamp: '2026-07-26T01:02:03.000Z',
      })
    ).unwrap();

    expect(
      (
        await provider.pushDeliveryBranch(worktree, 'origin', 'kouro/push-run', committed.commit)
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await provider.pushDeliveryBranch(worktree, 'origin', 'kouro/push-run', committed.commit)
      ).isOk(),
    ).toBe(true);
    await git(remote, 'update-ref', 'refs/heads/kouro/push-run', pinned.startingCommit);
    const conflict = await provider.pushDeliveryBranch(
      worktree,
      'origin',
      'kouro/push-run',
      committed.commit,
    );
    expect(conflict.isErr()).toBe(true);
    if (conflict.isErr()) expect(conflict.error.kind).toBe(SandboxErrorKind.HeadConflict);
  });

  test('rejects a changed tree and refuses dirty cleanup unless forced', async () => {
    const worktree: RunWorktree = (await provider.createWorktree(pinned, 'guarded-run')).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'prepared\n');
    const prepared = (await provider.prepareCommit(worktree)).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'changed afterward\n');

    const commit = await provider.commitWorktree({
      worktree,
      expectedHead: prepared.head,
      expectedTree: prepared.tree,
      message: 'must not commit',
      identity: {
        name: 'Kouro',
        email: 'kouro@example.test',
      },
      timestamp: '2026-07-26T01:02:03.000Z',
    });
    expect(commit.isErr()).toBe(true);
    if (commit.isErr()) expect(commit.error.kind).toBe(SandboxErrorKind.TreeConflict);

    const refused = await provider.cleanupWorktree(worktree);
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) expect(refused.error.kind).toBe(SandboxErrorKind.DirtyWorktree);
    expect((await provider.cleanupWorktree(worktree, true)).isOk()).toBe(true);
    expect(await git(repositoryPath, 'worktree', 'list', '--porcelain')).not.toContain(
      worktree.path,
    );
  });

  test('joins disjoint isolated branch trees onto the verified parent checkpoint', async () => {
    const parent = (await provider.createWorktree(pinned, 'parallel-parent')).unwrap();
    await writeFile(join(parent.path, 'checkpoint.txt'), 'checkpoint\n');
    const manager = new ParallelWorktreeManager(
      provider,
      repository.repositoryId,
      repository.repositoryPath,
      parent.path,
      parent.runId,
    );
    const prepared = await manager.prepare(parent.runId, 'group-1', pinned.startingCommit, [
      'b',
      'a',
    ]);
    expect(prepared.isOk()).toBe(true);
    const workspaces = prepared.unwrap().workspaces;
    const a = workspaces.find(({ branchId }) => branchId === 'a');
    const b = workspaces.find(({ branchId }) => branchId === 'b');
    if (!a || !b) throw new Error('branch workspaces were not prepared');
    await writeFile(join(a.workingDirectory, 'a.txt'), 'a\n');
    await writeFile(join(b.workingDirectory, 'b.txt'), 'b\n');
    expect(
      (await manager.inspectBranch(parent.runId, 'group-1', 'a')).unwrap().changedPaths,
    ).toEqual(['a.txt']);
    expect(
      (await manager.inspectBranch(parent.runId, 'group-1', 'b')).unwrap().changedPaths,
    ).toEqual(['b.txt']);

    const joined = await manager.join(parent.runId, 'group-1', ['b', 'a'], pinned.startingCommit);

    expect(joined.isOk()).toBe(true);
    expect(joined.unwrap().outcome).toBe('succeeded');
    expect(await readFile(join(parent.path, 'checkpoint.txt'), 'utf8')).toBe('checkpoint\n');
    expect(await readFile(join(parent.path, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(join(parent.path, 'b.txt'), 'utf8')).toBe('b\n');
    await manager.cleanupSuccessful(parent.runId, 'group-1');
    const listed = await git(repositoryPath, 'worktree', 'list', '--porcelain');
    expect(listed).not.toContain(a.workingDirectory);
    expect(listed).not.toContain(b.workingDirectory);
  });

  test('retries a join after interruption between tree application and durable completion', async () => {
    const parent = (await provider.createWorktree(pinned, 'parallel-recovery-parent')).unwrap();
    const interrupted = new ParallelWorktreeManager(
      provider,
      repository.repositoryId,
      repository.repositoryPath,
      parent.path,
      parent.runId,
      new FailAfterApplyingTreeGitRunner(),
    );
    const prepared = (
      await interrupted.prepare(parent.runId, 'recovery-group', pinned.startingCommit, ['a', 'b'])
    ).unwrap();
    const a = prepared.workspaces.find(({ branchId }) => branchId === 'a');
    const b = prepared.workspaces.find(({ branchId }) => branchId === 'b');
    if (!a || !b) throw new Error('branch workspaces were not prepared');
    await writeFile(join(a.workingDirectory, 'a.txt'), 'a\n');
    await writeFile(join(b.workingDirectory, 'b.txt'), 'b\n');

    const firstJoin = await interrupted.join(
      parent.runId,
      'recovery-group',
      ['a', 'b'],
      pinned.startingCommit,
    );
    expect(firstJoin.isErr()).toBe(true);
    expect(await readFile(join(parent.path, 'a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(join(parent.path, 'b.txt'), 'utf8')).toBe('b\n');

    const restarted = new ParallelWorktreeManager(
      provider,
      repository.repositoryId,
      repository.repositoryPath,
      parent.path,
      parent.runId,
    );
    const recovered = await restarted.recover(
      parent.runId,
      'recovery-group',
      pinned.startingCommit,
      prepared.baseTree,
      prepared.checkpoint,
      prepared.workspaces.map(({ branchId, workspaceId }) => ({ branchId, workspaceId })),
    );
    expect(recovered.isOk()).toBe(true);
    const retry = await restarted.join(
      parent.runId,
      'recovery-group',
      ['b', 'a'],
      pinned.startingCommit,
    );
    expect(retry.isOk()).toBe(true);
    if (retry.isOk()) {
      expect(retry.value.outcome).toBe('succeeded');
      expect(retry.value.head).toBe(pinned.startingCommit);
      expect(retry.value.tree).toMatch(/^[0-9a-f]{40}$/);
    }
    await restarted.cleanupSuccessful(parent.runId, 'recovery-group');
    const listed = await git(repositoryPath, 'worktree', 'list', '--porcelain');
    expect(listed).not.toContain(a.workingDirectory);
    expect(listed).not.toContain(b.workingDirectory);
  });
});
