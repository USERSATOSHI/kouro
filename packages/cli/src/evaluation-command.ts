import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  annotateEvaluation,
  evaluateStoredRun,
  getEvaluationExperiment,
  listStoredRunEvaluations,
  preferEvaluation,
} from '@kouro/api';

import type { LocalKouroHost } from './local-host.ts';

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value;
}

function verdict(value: string): 'pass' | 'fail' | 'unsure' {
  if (value === 'pass' || value === 'fail' || value === 'unsure') return value;
  throw new Error('--verdict must be pass, fail, or unsure');
}

async function listDatasets(host: LocalKouroHost, args: readonly string[]): Promise<unknown> {
  const repositoryPath = resolve(option(args, '--repo') ?? process.cwd());
  const listed = await host.evaluationDatasets.list(repositoryPath);
  if (listed.isErr()) throw new Error(listed.error.message);
  return listed.value.map(({ dataset, checksum }) => ({
    id: dataset.id,
    version: dataset.version,
    checksum,
    caseIds: dataset.cases.map(({ id }) => id),
  }));
}

async function evaluate(
  host: LocalKouroHost,
  args: readonly string[],
  actor: string,
): Promise<unknown> {
  const runId = required(args[1], 'run-id');
  const repositoryPath = resolve(option(args, '--repo') ?? process.cwd());
  const result = await evaluateStoredRun(
    host.evaluationServices(),
    host.runStoreForRepository(repositoryPath),
    runId,
    {
      datasetId: required(option(args, '--dataset'), '--dataset'),
      caseId: required(option(args, '--case'), '--case'),
      experimentId: required(option(args, '--experiment'), '--experiment'),
      actor,
      idempotencyKey: `eval:${randomUUID()}`,
    },
  );
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

function reports(host: LocalKouroHost, args: readonly string[]): unknown {
  const runId = option(args, '--run');
  const experimentId = option(args, '--experiment');
  if ((runId === undefined) === (experimentId === undefined)) {
    throw new Error('Use exactly one of --run and --experiment');
  }
  const result = runId
    ? listStoredRunEvaluations(host.evaluationServices(), host.store, runId)
    : getEvaluationExperiment(host.evaluationServices(), required(experimentId, '--experiment'));
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

function annotate(host: LocalKouroHost, args: readonly string[], actor: string): unknown {
  const result = annotateEvaluation(host.evaluationServices(), required(args[1], 'report-id'), {
    verdict: verdict(required(option(args, '--verdict'), '--verdict')),
    note: required(option(args, '--note'), '--note'),
    actor,
    idempotencyKey: `evaluation-annotation:${randomUUID()}`,
  });
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

function prefer(host: LocalKouroHost, args: readonly string[], actor: string): unknown {
  const winner = required(option(args, '--winner'), '--winner');
  const leftReportId = required(args[2], 'left-report-id');
  const rightReportId = required(args[3], 'right-report-id');
  if (winner !== 'left' && winner !== 'right' && winner !== 'tie') {
    throw new Error('--winner must be left, right, or tie');
  }
  const preferredReportId =
    winner === 'left' ? leftReportId : winner === 'right' ? rightReportId : undefined;
  const result = preferEvaluation(host.evaluationServices(), required(args[1], 'experiment-id'), {
    leftReportId,
    rightReportId,
    ...(preferredReportId ? { preferredReportId } : {}),
    actor,
    reason: required(option(args, '--reason'), '--reason'),
    idempotencyKey: `evaluation-preference:${randomUUID()}`,
  });
  if (result.isErr()) throw new Error(result.error.message);
  return result.value;
}

/** Executes repository-local evaluation CLI operations. */
export async function executeEvaluationCommand(
  host: LocalKouroHost,
  args: readonly string[],
  actor: string,
): Promise<unknown> {
  const action = required(args[0], 'evaluation action');
  if (action === 'datasets') return listDatasets(host, args);
  if (action === 'run') return evaluate(host, args, actor);
  if (action === 'reports') return reports(host, args);
  if (action === 'annotate') return annotate(host, args, actor);
  if (action === 'prefer') return prefer(host, args, actor);
  throw new Error(`Unknown evaluation action: ${action}`);
}
