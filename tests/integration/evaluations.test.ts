import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { compileWorkflow } from '@kouro/adw';
import { createKouroApp, LocalEvaluationDatasetSource } from '@kouro/api';
import type { RunState, WorkflowSourceBundle } from '@kouro/domain';
import {
  compileEvaluationDataset,
  createEvaluationRecord,
  EvaluationStoreErrorKind,
} from '@kouro/evaluations';
import {
  type CommandExecution,
  type CommandRunner,
  type CommandRunnerError,
  RunCoordinator,
} from '@kouro/executors';
import { SqliteEvaluationStore, SqliteEventStore } from '@kouro/persistence-sqlite';
import type { Result } from '@usersatoshi/results';
import { evaluationStoreContract } from '../contracts/evaluation-store.contract.ts';

class UnusedCommandRunner implements CommandRunner {
  execute(): Promise<Result<CommandExecution, CommandRunnerError>> {
    throw new Error('The evaluation fixture has no command nodes');
  }
}

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

function datasetDefinition(id = 'feature-regression'): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: '1',
    id,
    version: '1.0.0',
    cases: [
      {
        id: 'health-check',
        workItem: { title: 'Add a health check' },
        expectations: [
          { type: 'run_status', value: 'succeeded' },
          { type: 'max_invocations', value: 4 },
          { type: 'max_total_tokens', value: 100 },
        ],
      },
    ],
  };
}

function state(): RunState {
  return {
    workflowChecksum: 'sha256:workflow',
    startingCommit: 'abc123',
    repositoryHead: 'abc123',
    configuration: { repositoryId: 'repo-1', profile: 'test' },
    status: 'succeeded',
    nextInvocationSequence: 1,
    counters: {},
    invocations: [],
  };
}

function record(reportId: string, experimentId = 'experiment-a') {
  return createEvaluationRecord(compileEvaluationDataset(datasetDefinition()).unwrap(), {
    reportId,
    experimentId,
    runId: `run-${reportId}`,
    repositoryId: 'repo-1',
    workflowChecksum: 'sha256:workflow',
    caseId: 'health-check',
    actor: 'tester',
    createdAt: '2026-08-14T12:00:00.000Z',
    state: state(),
  }).unwrap();
}

function responseReportId(value: unknown): string {
  if (
    value !== null &&
    typeof value === 'object' &&
    'binding' in value &&
    value.binding !== null &&
    typeof value.binding === 'object' &&
    'reportId' in value.binding &&
    typeof value.binding.reportId === 'string'
  ) {
    return value.binding.reportId;
  }
  throw new Error('Evaluation response has no report ID');
}

function evaluationRequest(idempotencyKey = 'evaluate-once'): Request {
  return new Request('http://localhost/runs/evaluated-run/evaluations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      datasetId: 'feature-regression',
      caseId: 'health-check',
      experimentId: 'health-experiment',
      actor: 'tester',
      idempotencyKey,
    }),
  });
}

function completeWorkflow(): WorkflowSourceBundle {
  return {
    manifest: { id: 'evaluation-fixture', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'complete',
    nodes: [{ id: 'complete', type: 'complete' }],
    transitions: [],
    counterLimits: {},
  };
}

evaluationStoreContract('SqliteEvaluationStore', () => {
  const root = directory('kouro-evaluation-contract-');
  const store = new SqliteEvaluationStore(join(root, 'evaluations.sqlite'));
  const initialized = store.initialize();
  if (initialized.isErr()) throw new Error(initialized.error.message);
  return { store, dispose: () => store.dispose() };
});

describe('repository-local evaluation infrastructure', () => {
  test('discovers sorted regular JSON datasets and rejects duplicate IDs', async () => {
    const repository = directory('kouro-evaluation-datasets-');
    const datasets = join(repository, '.kouro', 'evaluations');
    mkdirSync(datasets, { recursive: true });
    writeFileSync(join(datasets, 'b.json'), JSON.stringify(datasetDefinition('second')));
    writeFileSync(join(datasets, 'a.json'), JSON.stringify(datasetDefinition('first')));
    const source = new LocalEvaluationDatasetSource();

    expect((await source.list(repository)).unwrap().map(({ dataset }) => dataset.id)).toEqual([
      'first',
      'second',
    ]);
    writeFileSync(join(datasets, 'duplicate.json'), JSON.stringify(datasetDefinition('first')));
    expect((await source.list(repository)).isErr()).toBe(true);
  });

  test('persists idempotent reports, annotations, and pairwise preferences', () => {
    const root = directory('kouro-evaluation-store-');
    const store = new SqliteEvaluationStore(join(root, 'evaluations.sqlite'));
    expect(store.initialize().isOk()).toBe(true);
    const first = record('report-a');
    const second = record('report-b');
    const fingerprint: `sha256:${string}` = `sha256:${'1'.repeat(64)}`;
    expect(
      store
        .saveRecord({ record: first, idempotencyKey: 'save-a', requestFingerprint: fingerprint })
        .isOk(),
    ).toBe(true);
    expect(
      store
        .saveRecord({ record: first, idempotencyKey: 'save-a', requestFingerprint: fingerprint })
        .isOk(),
    ).toBe(true);
    const conflict = store.saveRecord({
      record: first,
      idempotencyKey: 'save-a',
      requestFingerprint: `sha256:${'2'.repeat(64)}`,
    });
    expect(conflict.isErr()).toBe(true);
    if (conflict.isErr()) {
      expect(conflict.error.kind).toBe(EvaluationStoreErrorKind.IdempotencyConflict);
    }
    store
      .saveRecord({ record: second, idempotencyKey: 'save-b', requestFingerprint: fingerprint })
      .unwrap();
    store
      .addAnnotation(
        {
          id: 'annotation-a',
          reportId: 'report-a',
          actor: 'reviewer',
          verdict: 'pass',
          note: 'Meets the acceptance criteria',
          createdAt: '2026-08-14T12:01:00.000Z',
        },
        'annotate-a',
        fingerprint,
      )
      .unwrap();
    store
      .addPreference(
        {
          id: 'preference-a',
          experimentId: 'experiment-a',
          leftReportId: 'report-a',
          rightReportId: 'report-b',
          preferredReportId: 'report-a',
          actor: 'reviewer',
          reason: 'Cleaner implementation',
          createdAt: '2026-08-14T12:02:00.000Z',
        },
        'prefer-a',
        fingerprint,
      )
      .unwrap();

    expect(store.listRecords({ experimentId: 'experiment-a' }).unwrap()).toHaveLength(2);
    expect(store.listAnnotations('report-a').unwrap()[0]?.verdict).toBe('pass');
    expect(store.listPreferences('experiment-a').unwrap()[0]?.preferredReportId).toBe('report-a');
    store.dispose();
  });

  test('rejects malformed durable evaluation JSON after restart', () => {
    const root = directory('kouro-evaluation-corruption-');
    const path = join(root, 'evaluations.sqlite');
    let store = new SqliteEvaluationStore(path);
    expect(store.initialize().isOk()).toBe(true);
    store
      .saveRecord({
        record: record('report-corrupt'),
        idempotencyKey: 'save-corrupt',
        requestFingerprint: `sha256:${'1'.repeat(64)}`,
      })
      .unwrap();
    store.dispose();
    const database = new Database(path, { strict: true });
    database
      .query('UPDATE evaluation_records SET value_json = ? WHERE report_id = ?')
      .run('{"binding":{},"report":{"status":"unknown"}}', 'report-corrupt');
    database.close();

    store = new SqliteEvaluationStore(path);
    expect(store.initialize().isOk()).toBe(true);
    const loaded = store.getRecord('report-corrupt');
    expect(loaded.isErr()).toBe(true);
    if (loaded.isErr()) {
      expect(loaded.error.kind).toBe(EvaluationStoreErrorKind.InvalidRecord);
    }
    store.dispose();
  });

  test('evaluates a terminal run through HTTP and returns evidence with run details', async () => {
    const repository = directory('kouro-evaluation-api-');
    const datasets = join(repository, '.kouro', 'evaluations');
    mkdirSync(datasets, { recursive: true });
    writeFileSync(join(datasets, 'feature.json'), JSON.stringify(datasetDefinition()));
    const databasePath = join(repository, 'kouro.sqlite');
    const runs = new SqliteEventStore(databasePath);
    const evaluations = new SqliteEvaluationStore(databasePath);
    expect(runs.initialize().isOk()).toBe(true);
    expect(evaluations.initialize().isOk()).toBe(true);
    const coordinator = new RunCoordinator(runs, new UnusedCommandRunner());
    coordinator
      .createRun({
        runId: 'evaluated-run',
        artifact: compileWorkflow(completeWorkflow()).unwrap(),
        startingCommit: 'abc123',
        configuration: { repositoryId: 'repo-1', repositoryPath: repository },
        idempotencyKey: 'create-evaluated-run',
      })
      .unwrap();
    for (let step = 0; step < 3; step += 1) {
      if (runs.loadRun('evaluated-run').unwrap().state.status === 'succeeded') break;
      (await coordinator.advance('evaluated-run')).unwrap();
    }
    let clockTick = 0;
    const app = createKouroApp({
      runs,
      coordinator,
      repositories: { list: async () => [{ id: 'repo-1', path: repository }] },
      evaluations: {
        datasets: new LocalEvaluationDatasetSource(),
        store: evaluations,
        clock: {
          now: () => `2026-08-14T12:00:0${clockTick++}.000Z`,
        },
      },
    });

    const datasetResponse = await app.handle(
      new Request('http://localhost/repositories/repo-1/evaluation-datasets'),
    );
    expect(datasetResponse.status).toBe(200);
    expect(await datasetResponse.json()).toEqual([
      expect.objectContaining({ id: 'feature-regression', caseIds: ['health-check'] }),
    ]);
    const evaluated = await app.handle(evaluationRequest());
    expect(evaluated.status).toBe(200);
    const evaluatedBody: unknown = await evaluated.json();
    expect(evaluatedBody).toEqual(
      expect.objectContaining({
        binding: expect.objectContaining({
          experimentId: 'health-experiment',
          startingCommit: 'abc123',
          workflowChecksum: expect.stringMatching(/^sha256:/),
          configurationChecksum: expect.stringMatching(/^sha256:/),
          datasetChecksum: expect.stringMatching(/^sha256:/),
        }),
        report: expect.objectContaining({ status: 'passed' }),
      }),
    );
    const firstReportId = responseReportId(evaluatedBody);
    const retried = await app.handle(evaluationRequest());
    expect(retried.status).toBe(200);
    expect(responseReportId(await retried.json())).toBe(firstReportId);

    const second = await app.handle(
      new Request('http://localhost/runs/evaluated-run/evaluations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          datasetId: 'feature-regression',
          caseId: 'health-check',
          experimentId: 'health-experiment',
          actor: 'tester',
          idempotencyKey: 'evaluate-twice',
        }),
      }),
    );
    expect(second.status).toBe(200);
    const secondReportId = responseReportId(await second.json());

    const annotation = await app.handle(
      new Request(`http://localhost/evaluations/${firstReportId}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verdict: 'pass',
          note: 'Human review passed',
          actor: 'reviewer',
          idempotencyKey: 'annotate-once',
        }),
      }),
    );
    expect(annotation.status).toBe(200);
    expect(await annotation.json()).toEqual(
      expect.objectContaining({
        annotations: [expect.objectContaining({ verdict: 'pass', actor: 'reviewer' })],
      }),
    );

    const preference = await app.handle(
      new Request('http://localhost/evaluation-experiments/health-experiment/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leftReportId: firstReportId,
          rightReportId: secondReportId,
          preferredReportId: firstReportId,
          actor: 'reviewer',
          reason: 'First result is clearer',
          idempotencyKey: 'prefer-once',
        }),
      }),
    );
    expect(preference.status).toBe(200);
    expect(await preference.json()).toEqual(
      expect.objectContaining({
        id: 'health-experiment',
        reports: expect.arrayContaining([
          expect.objectContaining({
            binding: expect.objectContaining({ reportId: firstReportId }),
          }),
          expect.objectContaining({
            binding: expect.objectContaining({ reportId: secondReportId }),
          }),
        ]),
        preferences: [expect.objectContaining({ preferredReportId: firstReportId })],
      }),
    );
    const details = await app.handle(new Request('http://localhost/runs/evaluated-run'));
    expect(details.status).toBe(200);
    expect(await details.json()).toEqual(
      expect.objectContaining({
        evaluations: expect.arrayContaining([
          expect.objectContaining({
            binding: expect.objectContaining({ reportId: firstReportId }),
            annotations: [expect.objectContaining({ verdict: 'pass' })],
          }),
        ]),
      }),
    );
    evaluations.dispose();
    runs.dispose();
  });
});
