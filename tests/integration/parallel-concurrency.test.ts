import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileWorkflow } from '@kouro/adw';
import type { WorkflowSourceBundle } from '@kouro/domain';
import {
  type CommandExecution,
  type CommandRunner,
  type CommandRunnerError,
  type ParallelBranchResult,
  type ParallelJoinResult,
  type ParallelWorkspaceManager,
  type ParallelWorkspacePreparation,
  RunCoordinator,
} from '@kouro/executors';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { ok, type Result } from '@usersatoshi/results';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ConcurrentCommandRunner implements CommandRunner {
  active = 0;
  maxActive = 0;
  readonly workingDirectories: string[] = [];
  private started = 0;
  private release: (() => void) | undefined;
  private readonly bothStarted = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async execute(
    command: string,
    workingDirectory?: string,
  ): Promise<Result<CommandExecution, CommandRunnerError>> {
    if (workingDirectory) this.workingDirectories.push(workingDirectory);
    this.started += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.started === 2) this.release?.();
    await Promise.race([this.bothStarted, delay(250)]);
    if (command === 'a') await delay(20);
    this.active -= 1;
    return ok({ outcome: 'success', output: { command } });
  }
}

class MemoryParallelWorkspaces implements ParallelWorkspaceManager {
  recover(): Promise<Result<void, CommandRunnerError>> {
    return Promise.resolve(ok(undefined));
  }

  prepare(
    _runId: string,
    _groupId: string,
    _baseHead: string,
    branchIds: readonly string[],
  ): Promise<Result<ParallelWorkspacePreparation, CommandRunnerError>> {
    return Promise.resolve(
      ok({
        baseTree: 'base-tree',
        checkpoint: 'checkpoint',
        workspaces: branchIds.map((branchId) => ({
          branchId,
          workspaceId: `workspace-${branchId}`,
          workingDirectory: `/workspace/${branchId}`,
        })),
      }),
    );
  }

  inspectBranch(): Promise<Result<ParallelBranchResult, CommandRunnerError>> {
    return Promise.resolve(ok({ changedPaths: [] }));
  }

  join(): Promise<Result<ParallelJoinResult, CommandRunnerError>> {
    return Promise.resolve(ok({ outcome: 'succeeded', head: 'head', tree: 'joined-tree' }));
  }

  workingDirectory(_runId: string, _groupId: string, branchId: string): string {
    return `/workspace/${branchId}`;
  }

  cleanupSuccessful(): Promise<void> {
    return Promise.resolve();
  }
}

function parallelWorkflow(): WorkflowSourceBundle {
  return {
    manifest: { id: 'parallel-concurrency', version: '1.0.0' },
    semanticVersions: { compiler: '0.5.0', ir: '5', expressions: '1' },
    entryNodeId: 'parallel',
    nodes: [
      {
        id: 'parallel',
        type: 'parallel',
        branches: [
          { id: 'a', entryNodeId: 'work-a', returnNodeIds: ['return-a'] },
          { id: 'b', entryNodeId: 'work-b', returnNodeIds: ['return-b'] },
        ],
        maxConcurrent: 2,
        workspace: 'isolated',
        join: 'disjoint',
      },
      { id: 'work-a', type: 'command', command: 'a', recoveryPolicy: 'replay_safe' },
      { id: 'work-b', type: 'command', command: 'b', recoveryPolicy: 'replay_safe' },
      { id: 'return-a', type: 'branch_return', automaticOutcome: 'succeeded' },
      { id: 'return-b', type: 'branch_return', automaticOutcome: 'succeeded' },
      { id: 'done', type: 'complete' },
    ],
    transitions: [
      {
        id: 'work-a.success.return-a',
        from: { nodeId: 'work-a', outcome: 'success' },
        toNodeId: 'return-a',
      },
      {
        id: 'work-b.success.return-b',
        from: { nodeId: 'work-b', outcome: 'success' },
        toNodeId: 'return-b',
      },
      ...(['succeeded', 'failed', 'conflict'] as const).map((outcome) => ({
        id: `parallel.${outcome}.done`,
        from: { nodeId: 'parallel', outcome },
        toNodeId: 'done',
      })),
    ],
    counterLimits: {},
  };
}

describe('parallel coordinator execution', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('runs isolated branch effects concurrently and serializes completion events', async () => {
    const compiled = compileWorkflow(parallelWorkflow());
    if (compiled.isErr()) throw new Error(JSON.stringify(compiled.error));
    const directory = mkdtempSync(join(tmpdir(), 'kouro-parallel-concurrency-'));
    directories.push(directory);
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    const initialized = store.initialize();
    if (initialized.isErr()) throw new Error(JSON.stringify(initialized.error));
    const commands = new ConcurrentCommandRunner();
    const coordinator = new RunCoordinator(
      store,
      commands,
      undefined,
      process.cwd(),
      undefined,
      new MemoryParallelWorkspaces(),
    );
    coordinator
      .createRun({
        runId: 'concurrent-run',
        artifact: compiled.value,
        startingCommit: 'head',
        configuration: {},
        idempotencyKey: 'create',
      })
      .unwrap();

    for (let step = 0; step < 12; step += 1) {
      const advanced = await coordinator.advanceAvailable('concurrent-run');
      if (advanced.isErr()) throw new Error(JSON.stringify(advanced.error));
      if (advanced.value.state.status !== 'running') break;
    }

    const completed = store.loadRun('concurrent-run').unwrap();
    const effectCompletions = completed.events.flatMap((event) =>
      event.type === 'invocation.completed' &&
      (event.invocationSequence === 2 || event.invocationSequence === 3)
        ? [event.invocationSequence]
        : [],
    );
    expect(commands.maxActive).toBe(2);
    expect(commands.workingDirectories.toSorted()).toEqual(['/workspace/a', '/workspace/b']);
    expect(effectCompletions).toEqual([3, 2]);
    expect(completed.state.status).toBe('succeeded');
    store.dispose();
  });
});
