import { describe, expect, test } from 'bun:test';

import type {
  EvaluationAnnotation,
  EvaluationPreference,
  EvaluationRecord,
  EvaluationStore,
} from '@kouro/evaluations';
import { EvaluationStoreErrorKind } from '@kouro/evaluations';

export interface EvaluationStoreHarness {
  readonly store: EvaluationStore;
  dispose(): void;
}

export type EvaluationStoreHarnessFactory = () => EvaluationStoreHarness;

const fingerprint: `sha256:${string}` = `sha256:${'1'.repeat(64)}`;

function record(reportId: string): EvaluationRecord {
  return {
    binding: {
      reportId,
      experimentId: 'experiment-a',
      runId: `run-${reportId}`,
      repositoryId: 'repo-a',
      startingCommit: 'abc123',
      workflowChecksum: 'sha256:workflow',
      configurationChecksum: 'sha256:configuration',
      datasetId: 'regression',
      datasetVersion: '1.0.0',
      datasetChecksum: 'sha256:dataset',
      caseId: 'case-a',
      evaluatorVersion: '1',
      createdBy: 'operator',
      createdAt: '2026-08-14T12:00:00.000Z',
    },
    report: {
      datasetId: 'regression',
      datasetVersion: '1.0.0',
      datasetChecksum: 'sha256:dataset',
      caseId: 'case-a',
      status: 'passed',
      checks: [],
    },
  };
}

export function evaluationStoreContract(
  name: string,
  createHarness: EvaluationStoreHarnessFactory,
): void {
  describe(`${name} EvaluationStore contract`, () => {
    test('writes reports idempotently and preserves query bindings', () => {
      const harness = createHarness();
      try {
        const first = record('report-a');
        harness.store
          .saveRecord({
            record: first,
            idempotencyKey: 'save-a',
            requestFingerprint: fingerprint,
          })
          .unwrap();
        expect(
          harness.store
            .saveRecord({
              record: first,
              idempotencyKey: 'save-a',
              requestFingerprint: fingerprint,
            })
            .unwrap(),
        ).toEqual(first);
        expect(harness.store.listRecords({ runId: 'run-report-a' }).unwrap()).toEqual([first]);

        const conflict = harness.store.saveRecord({
          record: first,
          idempotencyKey: 'save-a',
          requestFingerprint: `sha256:${'2'.repeat(64)}`,
        });
        expect(conflict.isErr()).toBe(true);
        if (conflict.isErr()) {
          expect(conflict.error.kind).toBe(EvaluationStoreErrorKind.IdempotencyConflict);
        }
      } finally {
        harness.dispose();
      }
    });

    test('appends annotations and preferences without rewriting reports', () => {
      const harness = createHarness();
      try {
        for (const report of [record('report-a'), record('report-b')]) {
          harness.store
            .saveRecord({
              record: report,
              idempotencyKey: `save:${report.binding.reportId}`,
              requestFingerprint: fingerprint,
            })
            .unwrap();
        }
        const annotation: EvaluationAnnotation = {
          id: 'annotation-a',
          reportId: 'report-a',
          actor: 'reviewer',
          verdict: 'pass',
          note: 'Accepted',
          createdAt: '2026-08-14T12:01:00.000Z',
        };
        const preference: EvaluationPreference = {
          id: 'preference-a',
          experimentId: 'experiment-a',
          leftReportId: 'report-a',
          rightReportId: 'report-b',
          preferredReportId: 'report-a',
          actor: 'reviewer',
          reason: 'More robust',
          createdAt: '2026-08-14T12:02:00.000Z',
        };
        harness.store.addAnnotation(annotation, 'annotate-a', fingerprint).unwrap();
        harness.store.addPreference(preference, 'prefer-a', fingerprint).unwrap();

        expect(harness.store.listAnnotations('report-a').unwrap()).toEqual([annotation]);
        expect(harness.store.listPreferences('experiment-a').unwrap()).toEqual([preference]);
        expect(harness.store.getRecord('report-a').unwrap()).toEqual(record('report-a'));
      } finally {
        harness.dispose();
      }
    });
  });
}
