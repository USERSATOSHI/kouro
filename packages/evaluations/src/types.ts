import type { JsonValue, RunState, RunStatus, TokenUsage } from '@kouro/domain';

export type EvaluationExpectation =
  | {
      readonly type: 'run_status';
      readonly value: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>;
    }
  | { readonly type: 'max_invocations'; readonly value: number }
  | { readonly type: 'max_total_tokens'; readonly value: number }
  | { readonly type: 'node_outcome'; readonly nodeId: string; readonly outcome: string };

export interface EvaluationCase {
  readonly id: string;
  readonly workItem: JsonValue;
  readonly expectations: readonly EvaluationExpectation[];
}

export interface EvaluationDataset {
  readonly schemaVersion: '1';
  readonly id: string;
  readonly version: string;
  readonly cases: readonly EvaluationCase[];
}

export interface CompiledEvaluationDataset {
  readonly dataset: EvaluationDataset;
  readonly canonical: string;
  readonly checksum: `sha256:${string}`;
}

export interface EvaluationCheckResult {
  readonly expectation: EvaluationExpectation;
  readonly status: 'passed' | 'failed' | 'unavailable';
  readonly message: string;
  readonly observed?: JsonValue;
}

export interface EvaluationReport {
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetChecksum: `sha256:${string}`;
  readonly caseId: string;
  readonly status: 'passed' | 'failed' | 'incomplete';
  readonly checks: readonly EvaluationCheckResult[];
  readonly usage?: TokenUsage;
}

export interface EvaluationTarget {
  readonly state: RunState;
}

export interface EvaluationBinding {
  readonly reportId: string;
  readonly experimentId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly startingCommit: string;
  readonly workflowChecksum: string;
  readonly configurationChecksum: `sha256:${string}`;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly datasetChecksum: `sha256:${string}`;
  readonly caseId: string;
  readonly evaluatorVersion: '1';
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface EvaluationRecord {
  readonly binding: EvaluationBinding;
  readonly report: EvaluationReport;
}

export interface EvaluationAnnotation {
  readonly id: string;
  readonly reportId: string;
  readonly actor: string;
  readonly verdict: 'pass' | 'fail' | 'unsure';
  readonly note: string;
  readonly createdAt: string;
}

export interface EvaluationPreference {
  readonly id: string;
  readonly experimentId: string;
  readonly leftReportId: string;
  readonly rightReportId: string;
  readonly preferredReportId?: string;
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface EvaluationRecordView extends EvaluationRecord {
  readonly annotations: readonly EvaluationAnnotation[];
}
