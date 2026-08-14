import { canonicalJson, sha256 } from '@kouro/adw';
import type { JsonValue, RunState } from '@kouro/domain';
import { ok, type Result } from '@usersatoshi/results';

import type { EvaluationError } from './errors.ts';
import { evaluateRun } from './evaluate.ts';
import type { CompiledEvaluationDataset, EvaluationBinding, EvaluationRecord } from './types.ts';

export interface CreateEvaluationRecordInput {
  readonly reportId: string;
  readonly experimentId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly workflowChecksum: string;
  readonly caseId: string;
  readonly actor: string;
  readonly createdAt: string;
  readonly state: RunState;
}

function configurationJson(configuration: RunState['configuration']): JsonValue {
  return Object.fromEntries(Object.entries(configuration));
}

/** Binds a pure evaluation report to every decision-affecting run input. */
export function createEvaluationRecord(
  dataset: CompiledEvaluationDataset,
  input: CreateEvaluationRecordInput,
): Result<EvaluationRecord, EvaluationError> {
  const evaluated = evaluateRun(dataset, input.caseId, { state: input.state });
  if (evaluated.isErr()) return evaluated;
  const binding: EvaluationBinding = {
    reportId: input.reportId,
    experimentId: input.experimentId,
    runId: input.runId,
    repositoryId: input.repositoryId,
    startingCommit: input.state.startingCommit,
    workflowChecksum: input.workflowChecksum,
    configurationChecksum: sha256(canonicalJson(configurationJson(input.state.configuration))),
    datasetId: dataset.dataset.id,
    datasetVersion: dataset.dataset.version,
    datasetChecksum: dataset.checksum,
    caseId: input.caseId,
    evaluatorVersion: '1',
    createdBy: input.actor,
    createdAt: input.createdAt,
  };
  return ok({ binding, report: evaluated.value });
}
