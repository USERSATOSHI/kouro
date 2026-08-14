import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { compileWorkflow } from '@kouro/adw';
import type { CompiledWorkflowArtifact, JsonValue, WorkflowSourceBundle } from '@kouro/domain';
import {
  BunCommandRunner,
  type Clock,
  type CommandExecution,
  type CommandRunner,
  type CommandRunnerError,
  RunCoordinator,
} from '@kouro/executors';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { ok, type Result } from '@usersatoshi/results';
import { runStoreContract } from '../contracts/run-store.contract.ts';

class ScriptedCommandRunner implements CommandRunner {
  readonly commands: string[] = [];

  constructor(private readonly executions: CommandExecution[]) {}

  execute(command: string): Promise<Result<CommandExecution, CommandRunnerError>> {
    this.commands.push(command);
    const scripted = this.executions.shift();
    if (!scripted) {
      throw new Error(`No scripted result for command: ${command}`);
    }
    return Promise.resolve(ok(scripted));
  }
}

class ScriptedClock implements Clock {
  constructor(private readonly times: string[]) {}

  now(): string {
    const time = this.times.shift();
    if (!time) throw new Error('No scripted clock value remains');
    return time;
  }
}

function workflowArtifact(): CompiledWorkflowArtifact {
  const source: WorkflowSourceBundle = {
    manifest: {
      id: 'm2-restart',
      version: '1.0.0',
    },
    semanticVersions: {
      compiler: '0.1.0',
      ir: '1',
      expressions: '1',
    },
    entryNodeId: 'prepare',
    nodes: [
      {
        id: 'prepare',
        type: 'command',
        command: 'prepare',
        recoveryPolicy: 'replay_safe',
      },
      {
        id: 'approve',
        type: 'approval',
        title: 'Approve validation',
      },
      {
        id: 'validate',
        type: 'command',
        command: 'validate',
        recoveryPolicy: 'replay_safe',
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'prepare.success.approve',
        from: { nodeId: 'prepare', outcome: 'success' },
        toNodeId: 'approve',
      },
      {
        id: 'approve.approved.validate',
        from: { nodeId: 'approve', outcome: 'approved' },
        toNodeId: 'validate',
      },
      {
        id: 'validate.passed.complete',
        from: { nodeId: 'validate', outcome: 'passed' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
  };
  const compiled = compileWorkflow(source);
  if (compiled.isErr()) {
    throw new Error(JSON.stringify(compiled.error));
  }
  return compiled.unwrap();
}

function execution(outcome: string, output: JsonValue = {}): CommandExecution {
  return { outcome, output };
}

function databasePath(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'kouro-m2-'));
  return {
    directory,
    path: join(directory, 'runs.sqlite'),
  };
}

function initializedStore(path: string): SqliteEventStore {
  const store = new SqliteEventStore(path);
  const initialized = store.initialize();
  if (initialized.isErr()) {
    throw new Error(JSON.stringify(initialized.error));
  }
  return store;
}

runStoreContract('SqliteEventStore', () => {
  const location = databasePath();
  const store = initializedStore(location.path);
  return {
    store,
    dispose(): void {
      store.dispose();
      rmSync(location.directory, { recursive: true });
    },
  };
});

describe('M2 durable command and approval runtime', () => {
  test('coordinator records command invocation wall-clock spans', async () => {
    const location = databasePath();
    try {
      const store = initializedStore(location.path);
      const coordinator = new RunCoordinator(
        store,
        new ScriptedCommandRunner([execution('success')]),
        undefined,
        process.cwd(),
        new ScriptedClock(['2026-08-14T10:00:00.000Z', '2026-08-14T10:00:15.000Z']),
      );
      coordinator
        .createRun({
          runId: 'timed-run',
          artifact: workflowArtifact(),
          startingCommit: 'abc123',
          configuration: {},
          idempotencyKey: 'create',
        })
        .unwrap();

      await coordinator.advance('timed-run');
      const completed = (await coordinator.advance('timed-run')).unwrap();

      expect(completed.state.invocations[0]).toMatchObject({
        activatedAt: '2026-08-14T10:00:00.000Z',
        finishedAt: '2026-08-14T10:00:15.000Z',
      });
      store.dispose();
    } finally {
      rmSync(location.directory, { recursive: true, force: true });
    }
  });

  test('Bun command runner records the process exit outcome', async () => {
    const runner = new BunCommandRunner(process.cwd());
    const succeeded = await runner.execute("printf 'kouro'");
    expect(succeeded.unwrap()).toEqual({
      outcome: 'success',
      output: {
        exitCode: 0,
        stdout: 'kouro',
        stderr: '',
      },
    });

    const failed = await runner.execute('exit 7');
    expect(failed.unwrap()).toEqual({
      outcome: 'failure',
      output: {
        exitCode: 7,
        stdout: '',
        stderr: '',
      },
    });
  });

  test('command → approval → command → complete survives restart', async () => {
    const location = databasePath();
    try {
      const artifact = workflowArtifact();
      let store = initializedStore(location.path);
      const firstRunner = new ScriptedCommandRunner([execution('success')]);
      let coordinator = new RunCoordinator(store, firstRunner);

      coordinator
        .createRun({
          runId: 'restart-run',
          artifact,
          startingCommit: 'abc123',
          configuration: { profile: 'test' },
          idempotencyKey: 'create',
        })
        .unwrap();
      await coordinator.advance('restart-run');
      await coordinator.advance('restart-run');
      await coordinator.advance('restart-run');
      const waiting = (await coordinator.advance('restart-run')).unwrap();
      expect(waiting.state.status).toBe('waiting_for_approval');
      expect(firstRunner.commands).toEqual(['prepare']);
      store.dispose();

      store = initializedStore(location.path);
      const secondRunner = new ScriptedCommandRunner([execution('passed')]);
      coordinator = new RunCoordinator(store, secondRunner);
      const restored = store.loadRun('restart-run').unwrap();
      expect(restored.state.status).toBe('waiting_for_approval');
      const approval = restored.state.invocations[1]?.approval;
      if (!approval) throw new Error('Expected a durable pending approval');

      coordinator
        .decideApproval(
          'restart-run',
          approval,
          'grant',
          'user:1',
          'Validation is approved',
          'approval:grant',
        )
        .unwrap();
      await coordinator.advance('restart-run');
      await coordinator.advance('restart-run');
      await coordinator.advance('restart-run');
      const completed = (await coordinator.advance('restart-run')).unwrap();

      expect(completed.state.status).toBe('succeeded');
      expect(completed.events).toHaveLength(12);
      expect(secondRunner.commands).toEqual(['validate']);

      const unchanged = (await coordinator.advance('restart-run')).unwrap();
      expect(unchanged.events).toHaveLength(12);
      store.dispose();
    } finally {
      rmSync(location.directory, { recursive: true, force: true });
    }
  });

  test('restart records interruption before replaying a replay-safe command', async () => {
    const location = databasePath();
    try {
      const artifact = workflowArtifact();
      let store = initializedStore(location.path);
      store
        .createRun({
          runId: 'recovery-run',
          artifact,
          startingCommit: 'abc123',
          configuration: {},
          idempotencyKey: 'create',
        })
        .unwrap();
      store
        .appendEvent({
          runId: 'recovery-run',
          expectedSequence: 2,
          idempotencyKey: 'activate',
          event: {
            type: 'invocation.activated',
            invocationSequence: 1,
            nodeId: 'prepare',
          },
        })
        .unwrap();
      store
        .appendEvent({
          runId: 'recovery-run',
          expectedSequence: 3,
          idempotencyKey: 'start',
          event: {
            type: 'attempt.started',
            invocationSequence: 1,
            attemptNumber: 1,
          },
        })
        .unwrap();
      store.dispose();

      store = initializedStore(location.path);
      const runner = new ScriptedCommandRunner([execution('success')]);
      const coordinator = new RunCoordinator(store, runner);
      const recovered = coordinator.recoverRun('recovery-run').unwrap();
      expect(recovered.state.invocations[0]?.state).toBe('interrupted');

      const replayed = (await coordinator.advance('recovery-run')).unwrap();
      expect(replayed.state.invocations[0]?.attempts).toEqual([
        { number: 1, state: 'interrupted' },
        { number: 2, state: 'succeeded' },
      ]);
      expect(runner.commands).toEqual(['prepare']);
      store.dispose();
    } finally {
      rmSync(location.directory, { recursive: true, force: true });
    }
  });
});
