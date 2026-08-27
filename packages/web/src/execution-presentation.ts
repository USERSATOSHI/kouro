import type { ArtifactView, RunDetails } from '@kouro/api-contracts';
import { estimateCostUsd, sumUsage, type TokenUsage } from '@kouro/domain';

type NodeInvocation = RunDetails['state']['invocations'][number];
type InvocationState = NodeInvocation['state'];

export interface RunFocus {
  readonly title: string;
  readonly detail: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns the operator-facing state while preserving durable runtime semantics. */
export function invocationDisplayState(invocation: NodeInvocation): InvocationState {
  return invocation.outcome === 'failure' ? 'failed' : invocation.state;
}

/** Returns the most useful durable failure detail available for an invocation. */
export function invocationFailure(
  invocation: NodeInvocation,
): { readonly kind: string; readonly message: string } | undefined {
  const attemptFailure = invocation.attempts.findLast(
    ({ failure }) => failure !== undefined,
  )?.failure;
  if (attemptFailure) return attemptFailure;
  if (invocation.outcome !== 'failure' || !isRecord(invocation.output)) return undefined;

  const stderr =
    typeof invocation.output.stderr === 'string' ? invocation.output.stderr.trim() : '';
  if (stderr) return { kind: 'command failure', message: stderr };

  const error = invocation.output.error;
  if (typeof error === 'string' && error.trim()) {
    return { kind: 'command failure', message: error.trim() };
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return { kind: 'command failure', message: error.message.trim() };
  }
  return { kind: 'command failure', message: 'The command exited unsuccessfully.' };
}

/** Summarizes the run's current operator-relevant position without changing runtime state. */
export function runFocus(run: RunDetails): RunFocus {
  const invocation =
    run.state.invocations.findLast(({ state }) =>
      ['active', 'waiting_for_approval'].includes(state),
    ) ?? run.state.invocations.at(-1);
  const node = run.nodes.find(({ id }) => id === invocation?.nodeId);
  const nodeTitle = node?.title ?? invocation?.nodeId;

  if (run.status === 'waiting_for_approval') {
    return {
      title: 'Approval required',
      detail: nodeTitle
        ? `Review ${nodeTitle} to continue.`
        : 'Review the pending decision to continue.',
    };
  }
  if (run.status === 'paused') {
    return {
      title: nodeTitle ? `Paused at ${nodeTitle}` : 'Run paused',
      detail: 'Resume when you are ready to continue.',
    };
  }
  if (run.status === 'failed') {
    return {
      title: nodeTitle ? `Stopped at ${nodeTitle}` : 'Run failed',
      detail: 'Inspect the latest invocation for the failure and recovery options.',
    };
  }
  if (run.status === 'succeeded') {
    return { title: 'Workflow complete', detail: 'The durable run finished successfully.' };
  }
  if (run.status === 'cancelled') {
    return { title: 'Run cancelled', detail: 'History and retained artifacts remain available.' };
  }
  return nodeTitle
    ? { title: nodeTitle, detail: 'The workflow is actively working on this step.' }
    : { title: 'Starting workflow', detail: 'Waiting for the first durable invocation.' };
}

/** Formats an artifact byte count with binary units suitable for compact UI metadata. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  const precision = value < 10 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

/** Formats a token count with SI units suitable for compact UI metadata. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0';
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Formats a USD estimate with a fixed dollar sign and two decimals. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Returns the summed token usage of every attempt in the run, when any was reported. */
export function runUsage(run: RunDetails): TokenUsage | undefined {
  const usage = run.state.invocations.flatMap(({ attempts }) =>
    attempts.flatMap((attempt) => [
      ...(attempt.usage ? [attempt.usage] : []),
      ...(attempt.subagents ?? []).flatMap((subagent) => (subagent.usage ? [subagent.usage] : [])),
    ]),
  );
  return usage.length > 0 ? sumUsage(usage) : undefined;
}

/**
 * Estimates the USD cost of one attempt, or undefined when the harness
 * reported no usage or the model has no price in the shared table.
 */
export function attemptCostUsd(
  run: RunDetails,
  invocationSequence: number,
  attemptNumber: number,
): number | undefined {
  const invocation = run.state.invocations.find(({ sequence }) => sequence === invocationSequence);
  const attempt = invocation?.attempts.find(({ number }) => number === attemptNumber);
  if (!attempt?.usage) return undefined;
  return estimateCostUsd(attempt.usage, attempt.model);
}

/** Estimates the USD cost of the whole run only when every reported attempt is priced. */
export function runCostUsd(run: RunDetails): number | undefined {
  const attempts = run.state.invocations.flatMap(({ attempts: invocationAttempts }) =>
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

/** Returns the Git diff published for the approval's exact invocation. */
export function approvalDiffArtifact(
  artifacts: readonly ArtifactView[],
  invocationSequence: number,
): ArtifactView | undefined {
  return artifacts.find(
    (artifact) =>
      artifact.kind === 'git_diff' &&
      (artifact.invocationSequence === invocationSequence ||
        (artifact.invocationSequence === undefined &&
          artifact.id.startsWith(`${invocationSequence}:`))),
  );
}
