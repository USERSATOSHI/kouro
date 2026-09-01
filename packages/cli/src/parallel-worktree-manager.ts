import { createHash } from 'node:crypto';
import type {
  CommandRunnerError,
  ParallelBranchResult,
  ParallelJoinResult,
  ParallelWorkspaceManager,
  ParallelWorkspacePreparation,
} from '@kouro/executors';
import { CommandRunnerErrorKind } from '@kouro/executors';
import {
  GitCommandRunner,
  type RunWorktree,
  WorktreeSandboxProvider,
} from '@kouro/sandbox-worktree';
import { err, ok, type Result } from '@usersatoshi/results';

interface ParallelWorktreeGroup {
  readonly checkpoint: string;
  readonly baseTree: string;
  readonly parent: RunWorktree;
  readonly branches: ReadonlyMap<string, RunWorktree>;
}

function commandError(operation: string, cause: unknown): CommandRunnerError {
  return {
    kind: CommandRunnerErrorKind.ProcessFailure,
    message: `${operation}: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`,
  };
}

function branchRunId(runId: string, groupId: string, branchId: string): string {
  const digest = createHash('sha256')
    .update(`${runId}\0${groupId}\0${branchId}`)
    .digest('hex')
    .slice(0, 24);
  return `${runId.slice(0, 80)}.branch.${digest}`;
}

const commitEnvironment = {
  GIT_AUTHOR_NAME: 'Kouro',
  GIT_AUTHOR_EMAIL: 'kouro@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Kouro',
  GIT_COMMITTER_EMAIL: 'kouro@localhost',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

/** Isolates structured branches and integrates only verified disjoint trees. */
export class ParallelWorktreeManager implements ParallelWorkspaceManager {
  private readonly groups = new Map<string, ParallelWorktreeGroup>();

  constructor(
    private readonly sandbox: WorktreeSandboxProvider,
    private readonly repositoryId: string,
    private readonly repositoryPath: string,
    private readonly parentPath: string,
    private readonly parentRunId: string,
    private readonly git = new GitCommandRunner(),
  ) {}

  async recover(
    _runId: string,
    groupId: string,
    baseHead: string,
    baseTree: string,
    checkpoint: string,
    workspaces: readonly { readonly branchId: string; readonly workspaceId: string }[],
  ): Promise<Result<void, CommandRunnerError>> {
    if (this.groups.has(groupId)) return ok(undefined);
    const registered = await this.sandbox.registerRepository(
      this.repositoryId,
      this.repositoryPath,
    );
    if (registered.isErr()) return err(commandError('recover repository', registered.error));
    const branches = new Map<string, RunWorktree>();
    for (const workspace of workspaces) {
      const recovered = await this.sandbox.createWorktree(
        { ...registered.value, startingCommit: checkpoint },
        workspace.workspaceId,
      );
      if (recovered.isErr()) {
        return err(commandError(`recover branch ${workspace.branchId}`, recovered.error));
      }
      branches.set(workspace.branchId, recovered.value);
    }
    if (!checkpoint && workspaces.length > 0) {
      return err(commandError('recover parallel group', 'checkpoint is unavailable'));
    }
    this.groups.set(groupId, {
      checkpoint,
      baseTree,
      parent: {
        ...registered.value,
        runId: this.parentRunId,
        path: this.parentPath,
        startingCommit: baseHead,
      },
      branches,
    });
    return ok(undefined);
  }

  async prepare(
    runId: string,
    groupId: string,
    baseHead: string,
    branchIds: readonly string[],
  ): Promise<Result<ParallelWorkspacePreparation, CommandRunnerError>> {
    const existing = this.groups.get(groupId);
    if (existing) return ok(this.preparation(existing));
    const registered = await this.sandbox.registerRepository(
      this.repositoryId,
      this.repositoryPath,
    );
    if (registered.isErr()) return err(commandError('register repository', registered.error));
    const parent: RunWorktree = {
      ...registered.value,
      runId: this.parentRunId,
      path: this.parentPath,
      startingCommit: baseHead,
    };
    const prepared = await this.sandbox.prepareCommit(parent);
    if (prepared.isErr()) return err(commandError('prepare parent checkpoint', prepared.error));
    if (prepared.value.head !== baseHead) {
      return err(commandError('prepare parent checkpoint', 'parent HEAD changed'));
    }
    const checkpoint = await this.git.run(
      this.parentPath,
      'parallel checkpoint',
      ['commit-tree', prepared.value.tree, '-p', baseHead, '-m', `kouro parallel ${groupId}`],
      commitEnvironment,
    );
    if (checkpoint.isErr())
      return err(commandError('create parallel checkpoint', checkpoint.error));
    const checkpointId = checkpoint.value.stdout.trim();
    const branches = new Map<string, RunWorktree>();
    for (const branchId of branchIds.toSorted()) {
      const worktree = await this.sandbox.createWorktree(
        { ...registered.value, startingCommit: checkpointId },
        branchRunId(runId, groupId, branchId),
      );
      if (worktree.isErr()) return err(commandError(`create branch ${branchId}`, worktree.error));
      branches.set(branchId, worktree.value);
    }
    const group = { checkpoint: checkpointId, baseTree: prepared.value.tree, parent, branches };
    this.groups.set(groupId, group);
    return ok(this.preparation(group));
  }

  async inspectBranch(
    _runId: string,
    groupId: string,
    branchId: string,
  ): Promise<Result<ParallelBranchResult, CommandRunnerError>> {
    const group = this.groups.get(groupId);
    const branch = group?.branches.get(branchId);
    if (!group || !branch) return err(commandError('inspect branch', 'unknown branch workspace'));
    const prepared = await this.sandbox.prepareCommit(branch);
    if (prepared.isErr()) return err(commandError('prepare branch tree', prepared.error));
    const changed = await this.git.run(branch.path, 'list branch paths', [
      'diff',
      '--name-only',
      group.checkpoint,
      prepared.value.tree,
    ]);
    return changed.isErr()
      ? err(commandError('list branch paths', changed.error))
      : ok({
          changedPaths: changed.value.stdout
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean)
            .toSorted(),
        });
  }

  async join(
    _runId: string,
    groupId: string,
    branchIds: readonly string[],
    expectedHead: string,
  ): Promise<Result<ParallelJoinResult, CommandRunnerError>> {
    const group = this.groups.get(groupId);
    if (!group) return err(commandError('join branches', 'unknown parallel group'));
    let currentCommit = group.checkpoint;
    let currentTree = group.baseTree;
    for (const branchId of branchIds.toSorted()) {
      const branch = group.branches.get(branchId);
      if (!branch) return err(commandError('join branches', `missing branch ${branchId}`));
      const prepared = await this.sandbox.prepareCommit(branch);
      if (prepared.isErr()) return err(commandError(`prepare branch ${branchId}`, prepared.error));
      const branchCommit = await this.git.run(
        branch.path,
        'create branch tree commit',
        [
          'commit-tree',
          prepared.value.tree,
          '-p',
          group.checkpoint,
          '-m',
          `kouro branch ${branchId}`,
        ],
        commitEnvironment,
      );
      if (branchCommit.isErr())
        return err(commandError('create branch tree commit', branchCommit.error));
      const merged = await this.git.run(group.parent.path, 'merge branch tree', [
        'merge-tree',
        '--write-tree',
        `--merge-base=${group.checkpoint}`,
        currentCommit,
        branchCommit.value.stdout.trim(),
      ]);
      if (merged.isErr()) return ok({ outcome: 'conflict' });
      currentTree = merged.value.stdout.trim().split('\n')[0] ?? '';
      const mergedCommit = await this.git.run(
        group.parent.path,
        'create integrated tree commit',
        ['commit-tree', currentTree, '-p', currentCommit, '-m', `kouro joined ${branchId}`],
        commitEnvironment,
      );
      if (mergedCommit.isErr())
        return err(commandError('create integrated tree commit', mergedCommit.error));
      currentCommit = mergedCommit.value.stdout.trim();
    }
    const parent = await this.sandbox.prepareCommit(group.parent);
    if (parent.isErr()) return err(commandError('verify parent tree', parent.error));
    if (parent.value.head !== expectedHead) return ok({ outcome: 'conflict' });
    // Applying a tree and recording parallel.joined are separate durable
    // operations. If the process stops between them, the recovered manager
    // reaches this point with the joined tree already in the parent worktree.
    // Treat that exact tree as an idempotent retry; any other non-base tree is
    // an unverified parent edit and must remain a conflict.
    if (parent.value.tree === currentTree) {
      return ok({ outcome: 'succeeded', head: expectedHead, tree: currentTree });
    }
    if (parent.value.tree !== group.baseTree) return ok({ outcome: 'conflict' });
    const applied = await this.git.run(group.parent.path, 'apply integrated tree', [
      'read-tree',
      '--reset',
      '-u',
      currentTree,
    ]);
    return applied.isErr()
      ? err(commandError('apply integrated tree', applied.error))
      : ok({ outcome: 'succeeded', head: expectedHead, tree: currentTree });
  }

  workingDirectory(_runId: string, groupId: string, branchId: string): string | undefined {
    return this.groups.get(groupId)?.branches.get(branchId)?.path;
  }

  async cleanupSuccessful(_runId: string, groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const branch of group.branches.values()) {
      await this.sandbox.cleanupWorktree(branch, true);
    }
    this.groups.delete(groupId);
  }

  private preparation(group: ParallelWorktreeGroup): ParallelWorkspacePreparation {
    return {
      baseTree: group.baseTree,
      checkpoint: group.checkpoint,
      workspaces: [...group.branches.entries()].map(([branchId, worktree]) => ({
        branchId,
        workspaceId: worktree.runId,
        workingDirectory: worktree.path,
      })),
    };
  }
}
