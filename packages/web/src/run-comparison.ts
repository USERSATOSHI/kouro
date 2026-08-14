import type { RunDetails } from '@kouro/api-contracts';
import { estimateCostUsd, sumUsage, type JsonValue, type TokenUsage } from '@kouro/domain';

import { runCostUsd, runUsage } from './execution-presentation.ts';

interface UsageSource {
  readonly usage?: TokenUsage;
  readonly model?: string;
}

export interface RunComparisonExecution {
  readonly key: string;
  readonly label: string;
  readonly kind: 'agent' | 'subagent';
  readonly count: number;
  readonly failedCount: number;
  readonly usage?: TokenUsage;
  readonly costUsd?: number;
}

export interface RunComparisonColumn {
  readonly runId: string;
  readonly status: RunDetails['status'];
  readonly workflowId: string;
  readonly workflowChecksum: string;
  readonly startingCommit: string;
  readonly durationMs?: number;
  readonly invocationCount: number;
  readonly attemptCount: number;
  readonly subagentCallCount: number;
  readonly usage?: TokenUsage;
  readonly costUsd?: number;
  readonly executions: readonly RunComparisonExecution[];
}

function usageFor(sources: readonly UsageSource[]): TokenUsage | undefined {
  const reported = sources.flatMap(({ usage }) => (usage ? [usage] : []));
  return reported.length > 0 ? sumUsage(reported) : undefined;
}

function costFor(sources: readonly UsageSource[]): number | undefined {
  const reported = sources.filter(
    (source): source is UsageSource & { readonly usage: TokenUsage } => source.usage !== undefined,
  );
  if (reported.length === 0) return undefined;
  const costs = reported.map(({ usage, model }) => estimateCostUsd(usage, model));
  return costs.every((cost): cost is number => cost !== undefined)
    ? costs.reduce((total, cost) => total + cost, 0)
    : undefined;
}

function runDurationMs(run: RunDetails): number | undefined {
  if (!run.state.startedAt || !run.state.observedAt) return undefined;
  const startedAt = Date.parse(run.state.startedAt);
  const observedAt = Date.parse(run.state.observedAt);
  const duration = observedAt - startedAt;
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function agentExecutions(run: RunDetails): readonly RunComparisonExecution[] {
  return run.nodes
    .filter(({ type }) => type === 'agent')
    .map((node) => {
      const invocations = run.state.invocations.filter(({ nodeId }) => nodeId === node.id);
      const attempts = invocations.flatMap(
        ({ attempts: invocationAttempts }) => invocationAttempts,
      );
      const usage = usageFor(attempts);
      const costUsd = costFor(attempts);
      return {
        key: `agent:${node.id}`,
        label: node.title,
        kind: 'agent' as const,
        count: invocations.length,
        failedCount: invocations.filter(
          ({ outcome, state }) => outcome === 'failure' || state === 'failed',
        ).length,
        ...(usage ? { usage } : {}),
        ...(costUsd === undefined ? {} : { costUsd }),
      };
    });
}

function subagentExecutions(run: RunDetails): readonly RunComparisonExecution[] {
  return (run.subagents ?? []).flatMap((definition) =>
    definition.parentNodeIds.map((parentNodeId) => {
      const calls = run.state.invocations
        .filter(({ nodeId }) => nodeId === parentNodeId)
        .flatMap(({ attempts: invocationAttempts }) => invocationAttempts)
        .flatMap(({ subagents }) => subagents ?? [])
        .filter(({ subagentId }) => subagentId === definition.id);
      const usage = usageFor(calls);
      const costUsd = costFor(calls);
      return {
        key: `subagent:${parentNodeId}:${definition.id}`,
        label: `${definition.role} · ${parentNodeId}`,
        kind: 'subagent' as const,
        count: calls.length,
        failedCount: calls.filter(({ state }) => state === 'failed').length,
        ...(usage ? { usage } : {}),
        ...(costUsd === undefined ? {} : { costUsd }),
      };
    }),
  );
}

/** Builds one deterministic comparison column from a durable run projection. */
export function runComparisonColumn(run: RunDetails): RunComparisonColumn {
  const attempts = run.state.invocations.flatMap(
    ({ attempts: invocationAttempts }) => invocationAttempts,
  );
  const durationMs = runDurationMs(run);
  const usage = runUsage(run);
  const costUsd = runCostUsd(run);
  return {
    runId: run.id,
    status: run.status,
    workflowId: run.workflowId,
    workflowChecksum: run.workflowChecksum,
    startingCommit: run.startingCommit,
    invocationCount: run.state.invocations.length,
    attemptCount: attempts.length,
    subagentCallCount: attempts.reduce(
      (total, attempt) => total + (attempt.subagents?.length ?? 0),
      0,
    ),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage ? { usage } : {}),
    ...(costUsd === undefined ? {} : { costUsd }),
    executions: [...agentExecutions(run), ...subagentExecutions(run)],
  };
}

function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

/** Explains input differences that make a comparison less experiment-like. */
export function runComparisonWarnings(runs: readonly RunDetails[]): readonly string[] {
  const warnings: string[] = [];
  if (new Set(runs.map(({ repositoryPath }) => repositoryPath)).size > 1) {
    warnings.push('Repositories differ.');
  }
  if (new Set(runs.map(({ startingCommit }) => startingCommit)).size > 1) {
    warnings.push('Starting commits differ.');
  }
  if (new Set(runs.map(({ workflowId }) => workflowId)).size > 1) {
    warnings.push('Workflow identities differ.');
  }
  if (new Set(runs.map(({ state }) => canonicalJson(state.configuration.workItem))).size > 1) {
    warnings.push('Immutable work items differ.');
  }
  return warnings;
}
