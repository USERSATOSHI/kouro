import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileWorkflow } from '@kouro/adw';
import type { WorkflowSourceBundle } from '@kouro/domain';
import {
  CommandRunnerErrorKind,
  type CommandExecution,
  type CommandRunner,
  type CommandRunnerError,
  RunCoordinator,
  type TraceExporter,
} from '@kouro/executors';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { describe, expect, test } from 'bun:test';
import { err, ok, type Result } from '@usersatoshi/results';

class UnusedCommandRunner implements CommandRunner {
  execute(): Promise<Result<CommandExecution, CommandRunnerError>> {
    return Promise.resolve(ok({ outcome: 'success', output: {} }));
  }
}

class ObservableFailingExporter implements TraceExporter {
  readonly failures: CommandRunnerError[] = [];

  export(): Promise<Result<void, CommandRunnerError>> {
    return Promise.resolve(
      err({ kind: CommandRunnerErrorKind.ProcessFailure, message: 'collector unavailable' }),
    );
  }

  observeFailure(error: CommandRunnerError): void {
    this.failures.push(error);
  }
}

function completeWorkflow(): WorkflowSourceBundle {
  return {
    manifest: { id: 'trace-export', version: '1.0.0' },
    semanticVersions: { compiler: '0.5.0', ir: '5', expressions: '1' },
    entryNodeId: 'done',
    nodes: [{ id: 'done', type: 'complete' }],
    transitions: [],
    counterLimits: {},
  };
}

describe('trace export isolation', () => {
  test('observes exporter failures without changing durable scheduling', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-trace-export-'));
    try {
      const compiled = compileWorkflow(completeWorkflow());
      if (compiled.isErr()) throw new Error(JSON.stringify(compiled.error));
      const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
      const initialized = store.initialize();
      if (initialized.isErr()) throw new Error(JSON.stringify(initialized.error));
      const exporter = new ObservableFailingExporter();
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        undefined,
        process.cwd(),
        undefined,
        undefined,
        exporter,
      );
      coordinator
        .createRun({
          runId: 'trace-export-run',
          artifact: compiled.value,
          startingCommit: 'head',
          configuration: {},
          idempotencyKey: 'create',
        })
        .unwrap();

      expect((await coordinator.advance('trace-export-run')).isOk()).toBe(true);
      expect((await coordinator.advance('trace-export-run')).isOk()).toBe(true);

      expect(exporter.failures).toHaveLength(2);
      expect(exporter.failures[0]?.message).toBe('collector unavailable');
      expect(store.loadRun('trace-export-run').unwrap().state.status).toBe('succeeded');
      store.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
