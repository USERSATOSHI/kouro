import { estimateCostUsd } from '@kouro/domain';
import type { NodeDefinition, RunState } from '@kouro/domain';
import type { ObservableRunStore } from './ports.ts';
import type { TicketError, TicketRunQuery, TicketRunUsage, TicketRunView } from '@kouro/tickets';
import { TicketErrorKind, toTicketError } from '@kouro/tickets';
import { ok, type Result } from '@usersatoshi/results';

function runningColumn(
  state: RunState,
  definitions: readonly NodeDefinition[],
): TicketRunView['column'] {
  const invocation = state.invocations
    .toReversed()
    .find(({ state: value }) => ['active', 'waiting_for_approval'].includes(value));
  const definition = definitions.find(({ id }) => id === invocation?.nodeId);
  const identity = `${definition?.id ?? ''} ${definition?.title ?? ''}`.toLowerCase();
  if (state.status === 'waiting_for_approval') {
    return identity.includes('delivery')
      ? 'waiting_for_delivery_approval'
      : 'waiting_for_plan_approval';
  }
  if (identity.includes('review')) return 'reviewing';
  if (identity.includes('repair')) return 'repairing';
  if (identity.includes('validat') || identity.includes('test')) return 'validating';
  if (identity.includes('plan')) return 'planning';
  return 'implementing';
}

function runUsage(state: RunState): TicketRunUsage | undefined {
  const usage = state.invocations.flatMap(({ attempts }) =>
    attempts.flatMap((attempt) => [
      ...(attempt.usage ? [attempt.usage] : []),
      ...(attempt.subagents ?? []).flatMap((subagent) => (subagent.usage ? [subagent.usage] : [])),
    ]),
  );
  if (usage.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let reasoningTokens: number | undefined;
  for (const item of usage) {
    inputTokens += item.inputTokens;
    outputTokens += item.outputTokens;
    if (item.cacheReadTokens !== undefined) {
      cacheReadTokens = (cacheReadTokens ?? 0) + item.cacheReadTokens;
    }
    if (item.cacheWriteTokens !== undefined) {
      cacheWriteTokens = (cacheWriteTokens ?? 0) + item.cacheWriteTokens;
    }
    if (item.reasoningTokens !== undefined) {
      reasoningTokens = (reasoningTokens ?? 0) + item.reasoningTokens;
    }
  }
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function runCostUsd(state: RunState): number | undefined {
  const attempts = state.invocations.flatMap(({ attempts: invocationAttempts }) =>
    invocationAttempts.flatMap((attempt) => [
      ...(attempt.usage ? [{ usage: attempt.usage, model: attempt.model }] : []),
      ...(attempt.subagents ?? []).flatMap((subagent) =>
        subagent.usage ? [{ usage: subagent.usage, model: subagent.model }] : [],
      ),
    ]),
  );
  if (attempts.length === 0) return undefined;
  const costs = attempts.map((attempt) => estimateCostUsd(attempt.usage, attempt.model));
  return costs.every((cost): cost is number => cost !== undefined)
    ? costs.reduce((total, cost) => total + cost, 0)
    : undefined;
}

export class KouroTicketRunQuery implements TicketRunQuery {
  constructor(private readonly runs: ObservableRunStore) {}

  get(runId: string): Result<TicketRunView | undefined, TicketError> {
    const loaded = this.runs.loadRun(runId);
    if (loaded.isErr()) {
      if ('runId' in loaded.error && loaded.error.runId === runId) return ok(undefined);
      return toTicketError(TicketErrorKind.DatabaseFailure, {
        operation: 'getTicketRun',
        message: 'Kouro run state could not be read',
      });
    }
    const aggregate = loaded.unwrap();
    const status = aggregate.state.status;
    const usage = runUsage(aggregate.state);
    const costUsd = runCostUsd(aggregate.state);
    return ok({
      runId,
      active: !['succeeded', 'failed', 'cancelled'].includes(status),
      column:
        status === 'succeeded'
          ? 'done'
          : status === 'failed'
            ? 'failed'
            : status === 'cancelled'
              ? 'cancelled'
              : status === 'paused'
                ? 'blocked'
                : status === 'waiting'
                  ? 'blocked'
                  : runningColumn(aggregate.state, aggregate.artifact.bundle.nodes),
      ...(usage ? { usage } : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
    });
  }
}
