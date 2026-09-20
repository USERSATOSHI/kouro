import type { AttemptState, Bundle, CommandEvidence, RunView } from "./contracts";
import { canonicalize, sha256Hex } from "./canonical";
import type { JsonObject } from "./contracts";

/** Evidence is deliberately not a run result. It is an immutable observation about a pinned run. */
export type EvidenceClass = "deterministic" | "behavior" | "efficiency" | "judge-opinion" | "human";
export type EvidenceStatus = "passed" | "failed" | "unavailable" | "error" | "not-applicable";

export interface EvaluationTarget {
  readonly runId: string;
  readonly revision: number;
  /** Result tree observed at the pinned revision, when the run has a workspace. */
  readonly treeDigest?: string;
}

export interface EvidenceProvenance {
  readonly kind: "run" | "attempt" | "artifact" | "evaluator" | "human";
  readonly id: string;
  readonly revision?: number;
  readonly producer?: string;
}

export interface EvidenceCompleteness {
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly notes?: readonly string[];
}

export interface EvaluationEvidence<T = unknown> {
  readonly id: string;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly evaluatorSourceDigest: string;
  readonly evaluatorConfigDigest: string;
  readonly evidenceClass: EvidenceClass;
  readonly target: EvaluationTarget;
  readonly name: string;
  readonly status: EvidenceStatus;
  readonly value?: T;
  readonly unit?: string;
  readonly explanation?: string;
  readonly supportingArtifactIds: readonly string[];
  readonly provenance: readonly EvidenceProvenance[];
  readonly completeness: EvidenceCompleteness;
  readonly recordedAt: string;
}

export interface EvaluatorIdentity {
  readonly id: string;
  readonly version: string;
  /** Digest of the evaluator implementation/source, not the candidate tree. */
  readonly sourceDigest: string;
  readonly config?: unknown;
}

export interface BehaviorMetrics {
  readonly invocations: number;
  readonly attempts: number;
  readonly repairPasses: number;
  readonly fallbackAttempts: number;
  readonly messages: number;
  readonly turns: number;
  readonly toolCalls: number;
}

export interface EfficiencyMetrics {
  readonly wallClockMs: number | null;
  readonly activeAttemptMs: number | null;
  readonly commandMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cost: number | null;
}

function duration(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function usageNumber(attempts: readonly AttemptState[], key: string): number | null {
  const values = attempts
    .map((attempt) => attempt.usage)
    .filter((usage): usage is JsonObject =>
      Boolean(usage && typeof usage === "object" && !Array.isArray(usage)),
    )
    .map((usage) => usage[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function behaviorMetrics(view: RunView): BehaviorMetrics {
  const invocations = Object.values(view.state.invocations);
  const attempts = Object.values(view.state.attempts);
  return {
    invocations: invocations.length,
    attempts: attempts.length,
    repairPasses: invocations.reduce((sum, item) => sum + (item.repairPass ?? 0), 0),
    fallbackAttempts: attempts.filter((attempt) => (attempt.ordinal ?? 0) > 0).length,
    messages: 0,
    turns: attempts.reduce((sum, attempt) => {
      const usage = attempt.usage;
      return (
        sum +
        (usage &&
        typeof usage === "object" &&
        !Array.isArray(usage) &&
        typeof usage.turns === "number"
          ? usage.turns
          : 0)
      );
    }, 0),
    toolCalls: attempts.reduce(
      (sum, attempt) =>
        sum +
        (attempt.harnessEvents?.filter((event) =>
          Boolean(
            event &&
            typeof event === "object" &&
            (event as Record<string, unknown>).type === "tool.called",
          ),
        ).length ?? 0),
      0,
    ),
  };
}

export function efficiencyMetrics(view: RunView): EfficiencyMetrics {
  const attempts = Object.values(view.state.attempts);
  const active = attempts
    .map((attempt) => duration(attempt.startedAt, attempt.finishedAt))
    .filter((value): value is number => value !== null);
  const commandMs = attempts
    .map((attempt) => attempt.commandEvidence?.durationMs ?? null)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    wallClockMs: duration(view.state.startedAt, view.state.finishedAt),
    activeAttemptMs: active.length ? active.reduce((sum, value) => sum + value, 0) : null,
    commandMs: commandMs.length ? commandMs.reduce((sum, value) => sum + value, 0) : null,
    inputTokens: usageNumber(attempts, "inputTokens"),
    outputTokens: usageNumber(attempts, "outputTokens"),
    cachedTokens: usageNumber(attempts, "cachedTokens"),
    cost: usageNumber(attempts, "cost"),
  };
}

export async function evidenceDigest(
  identity: EvaluatorIdentity,
): Promise<{ sourceDigest: string; configDigest: string }> {
  return {
    sourceDigest: identity.sourceDigest,
    configDigest: await sha256Hex(canonicalize(identity.config ?? null)),
  };
}

export async function makeEvidence<T>(input: {
  id: string;
  evaluator: EvaluatorIdentity;
  evidenceClass: EvidenceClass;
  target: EvaluationTarget;
  name: string;
  status: EvidenceStatus;
  value?: T;
  unit?: string;
  explanation?: string;
  supportingArtifactIds?: readonly string[];
  provenance?: readonly EvidenceProvenance[];
  completeness?: EvidenceCompleteness;
  recordedAt?: string;
}): Promise<EvaluationEvidence<T>> {
  const digest = await evidenceDigest(input.evaluator);
  return {
    id: input.id,
    evaluatorId: input.evaluator.id,
    evaluatorVersion: input.evaluator.version,
    evaluatorSourceDigest: digest.sourceDigest,
    evaluatorConfigDigest: digest.configDigest,
    evidenceClass: input.evidenceClass,
    target: input.target,
    name: input.name,
    status: input.status,
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
    supportingArtifactIds: [...(input.supportingArtifactIds ?? [])],
    provenance: [
      ...(input.provenance ?? [
        { kind: "run", id: input.target.runId, revision: input.target.revision },
      ]),
    ],
    completeness: input.completeness ?? { complete: true, missing: [] },
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
}

/** Pure deterministic checks over the already committed terminal projection. */
export async function evaluateRunStatus(
  view: RunView,
  evaluator: EvaluatorIdentity,
): Promise<EvaluationEvidence> {
  const passed = view.state.status === "succeeded";
  return makeEvidence({
    id: `${evaluator.id}:${view.runId}:${view.revision}:status`,
    evaluator,
    evidenceClass: "deterministic",
    target: { runId: view.runId, revision: view.revision },
    name: "run.status",
    status: passed ? "passed" : "failed",
    value: view.state.status,
    explanation: passed ? "Run reached succeeded." : `Run ended ${view.state.status}.`,
  });
}

export async function evaluateBehavior(
  view: RunView,
  evaluator: EvaluatorIdentity,
): Promise<EvaluationEvidence<BehaviorMetrics>> {
  return makeEvidence({
    id: `${evaluator.id}:${view.runId}:${view.revision}:behavior`,
    evaluator,
    evidenceClass: "behavior",
    target: { runId: view.runId, revision: view.revision },
    name: "workflow.behavior",
    status: "passed",
    value: behaviorMetrics(view),
  });
}

export async function evaluateEfficiency(
  view: RunView,
  evaluator: EvaluatorIdentity,
): Promise<EvaluationEvidence<EfficiencyMetrics>> {
  const value = efficiencyMetrics(view);
  const missing = ["wallClockMs", "activeAttemptMs", "inputTokens", "outputTokens", "cost"].filter(
    (key) => value[key as keyof EfficiencyMetrics] === null,
  );
  return makeEvidence({
    id: `${evaluator.id}:${view.runId}:${view.revision}:efficiency`,
    evaluator,
    evidenceClass: "efficiency",
    target: { runId: view.runId, revision: view.revision },
    name: "workflow.efficiency",
    status: missing.length ? "unavailable" : "passed",
    value,
    completeness: { complete: missing.length === 0, missing },
  });
}

export async function commandEvidenceStatus(
  evidence: CommandEvidence,
  evaluator: EvaluatorIdentity,
  target: EvaluationTarget,
): Promise<EvaluationEvidence> {
  const passed =
    evidence.exitCode === 0 &&
    evidence.signal === null &&
    evidence.timeout !== true &&
    evidence.spawnError === null;
  return makeEvidence({
    id: `${evaluator.id}:${target.runId}:${target.revision}:command`,
    evaluator,
    evidenceClass: "deterministic",
    target,
    name: "acceptance.command",
    status: passed ? "passed" : "failed",
    value: evidence,
    explanation: passed
      ? "Command completed successfully."
      : "Command produced a failing process outcome.",
  });
}

export type { Bundle };
