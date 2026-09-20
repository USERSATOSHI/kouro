import type { ApprovalState, JsonValue, RunStatus } from "./contracts";
import { canonicalize, sha256Hex } from "./canonical";

/** A deliberately host-neutral description of the state at which a run is cut. */
export interface CheckpointInput {
  readonly runId: string;
  readonly revision: number;
  readonly eventCursor: number;
  readonly status: RunStatus;
  readonly admissionPaused: boolean;
  readonly bundleDigest: string;
  readonly configDependencyDigest: string;
  readonly effects?: readonly CheckpointEffect[];
  readonly outbox?: readonly CheckpointOutbox[];
  readonly writers?: readonly string[];
  readonly unsupportedNestedInvocationIds?: readonly string[];
  readonly sessionLeases?: readonly string[];
  readonly unresolvedReconciliation?: readonly string[];
  readonly artifacts: CheckpointClosure;
  readonly workspace: CheckpointWorkspace;
  readonly completedInvocationIds: readonly string[];
  /** Scope-local monotonic counters at the cut; fork replay must retain their spent values. */
  readonly counters?: Readonly<Record<string, number>>;
  /** Attempts already spent before this cut, including failed operational retries. */
  readonly attemptsSpent?: number;
  readonly pendingFrontier?: readonly CheckpointFrontierEntry[];
  readonly approvals?: readonly ApprovalState[];
}

export interface CheckpointEffect {
  readonly id: string;
  readonly state: "reserved" | "claimed" | "running" | "completed" | "failed" | "unknown";
  readonly dispatched?: boolean;
}

export interface CheckpointOutbox {
  readonly id: string;
  readonly state: "pending" | "claimed" | "sent" | "completed" | "unknown";
}

export interface CheckpointClosure {
  readonly verified: boolean;
  /** Exact retained artifact/blob roots, not an inferred transitive closure. */
  readonly roots: readonly string[];
}

export interface CheckpointWorkspace {
  readonly verified: boolean;
  readonly treeDigest: string;
  /** Exact retained tree/workspace roots owned by the checkpoint. */
  readonly roots: readonly string[];
}

export interface CheckpointFrontierEntry {
  readonly invocationId: string;
  readonly nodeId: string;
  readonly inputDigest?: string;
  readonly approvalRequired?: boolean;
}

export type CheckpointIneligibilityReason =
  | "admission-not-paused"
  | "run-not-paused"
  | "active-effect"
  | "reserved-effect"
  | "claimed-effect"
  | "unknown-effect"
  | "active-outbox"
  | "unknown-outbox"
  | "effect-writer"
  | "live-session-lease"
  | "recovery-required"
  | "unresolved-reconciliation"
  | "unverified-artifacts"
  | "unverified-workspace"
  | "missing-workspace-tree"
  | "invalid-revision"
  | "unsupported-nested-scope";

export interface CheckpointEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly CheckpointIneligibilityReason[];
  readonly pendingFrontierAllowed: boolean;
}

export interface CheckpointCut {
  readonly kind: "checkpoint.cut";
  readonly version: 1;
  readonly checkpointId: string;
  readonly sourceRunId: string;
  readonly sourceRevision: number;
  readonly sourceEventCursor: number;
  readonly bundleDigest: string;
  readonly configDependencyDigest: string;
  readonly retainedArtifactRoots: readonly string[];
  readonly retainedTreeRoots: readonly string[];
  readonly workspaceTreeDigest: string;
  readonly inheritedSourceInvocationIds: readonly string[];
  readonly counters: Readonly<Record<string, number>>;
  readonly attemptsSpent: number;
  readonly pendingFrontier: readonly CheckpointFrontierEntry[];
  /** Approvals are deliberately represented as requests to be rebound, never authority. */
  readonly freshApprovalInvocationIds: readonly string[];
  readonly certificateDigest: string;
}

export interface CheckpointCertificate extends CheckpointCut {
  readonly eligibility: CheckpointEligibility;
}

export interface CheckpointInvalidation {
  readonly valid: boolean;
  readonly reasons: readonly (
    | "revision-changed"
    | "bundle-changed"
    | "config-dependencies-changed"
    | "artifact-closure-changed"
    | "workspace-tree-changed"
    | "workspace-roots-changed"
  )[];
}

export interface InheritedInvocation {
  readonly sourceInvocationId: string;
  readonly status: "succeeded";
  readonly provenance: "inherited";
  readonly authority: "none";
}

export interface ForkProjection {
  readonly inherited: readonly InheritedInvocation[];
  readonly pending: readonly CheckpointFrontierEntry[];
  readonly approvals: readonly { invocationId: string; status: "fresh-required" }[];
  readonly sessions: readonly [];
  readonly deliveries: readonly [];
}

export function evaluateCheckpointEligibility(input: CheckpointInput): CheckpointEligibility {
  const reasons: CheckpointIneligibilityReason[] = [];
  if (!input.admissionPaused) reasons.push("admission-not-paused");
  if (input.status !== "paused") reasons.push("run-not-paused");
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) reasons.push("invalid-revision");
  if (
    Object.values(input.counters ?? {}).some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    reasons.push("invalid-revision");
  if (!Number.isSafeInteger(input.attemptsSpent ?? 0) || (input.attemptsSpent ?? 0) < 0)
    reasons.push("invalid-revision");
  for (const effect of input.effects ?? []) {
    if (effect.state === "running") reasons.push("active-effect");
    if (effect.state === "reserved") reasons.push("reserved-effect");
    if (effect.state === "claimed") reasons.push("claimed-effect");
    if (effect.state === "unknown") reasons.push("unknown-effect");
  }
  for (const outbox of input.outbox ?? []) {
    if (outbox.state === "claimed" || outbox.state === "pending") reasons.push("active-outbox");
    if (outbox.state === "unknown") reasons.push("unknown-outbox");
  }
  if ((input.writers ?? []).length) reasons.push("effect-writer");
  if ((input.unsupportedNestedInvocationIds ?? []).length) reasons.push("unsupported-nested-scope");
  if ((input.sessionLeases ?? []).length) reasons.push("live-session-lease");
  if (input.status === "recovery-required") reasons.push("recovery-required");
  if ((input.unresolvedReconciliation ?? []).length) reasons.push("unresolved-reconciliation");
  if (!input.artifacts.verified) reasons.push("unverified-artifacts");
  if (!input.workspace.verified) reasons.push("unverified-workspace");
  if (!input.workspace.treeDigest) reasons.push("missing-workspace-tree");
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    pendingFrontierAllowed: true,
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

/** Make an immutable cut. The cut contains references only; it never copies events. */
export async function createCheckpointCut(
  input: CheckpointInput,
  checkpointId: string,
): Promise<CheckpointCertificate> {
  const eligibility = evaluateCheckpointEligibility(input);
  if (!eligibility.eligible)
    throw new Error(`checkpoint is ineligible: ${eligibility.reasons.join(", ")}`);
  const frontier = [...(input.pendingFrontier ?? [])];
  const freshApprovalInvocationIds = (input.approvals ?? [])
    .filter((approval) => approval.status === "pending")
    .map((approval) => approval.invocationId);
  const base = {
    kind: "checkpoint.cut" as const,
    version: 1 as const,
    checkpointId,
    sourceRunId: input.runId,
    sourceRevision: input.revision,
    sourceEventCursor: input.eventCursor,
    bundleDigest: input.bundleDigest,
    configDependencyDigest: input.configDependencyDigest,
    retainedArtifactRoots: [...input.artifacts.roots],
    retainedTreeRoots: [...input.workspace.roots],
    workspaceTreeDigest: input.workspace.treeDigest,
    inheritedSourceInvocationIds: [...input.completedInvocationIds],
    counters: { ...input.counters },
    attemptsSpent: input.attemptsSpent ?? 0,
    pendingFrontier: frontier,
    freshApprovalInvocationIds,
  };
  const certificateDigest = `sha256:${await sha256Hex(canonicalize(base))}`;
  return freeze({ ...base, certificateDigest, eligibility });
}

/** Compare current closure/config identity to a cut; revision changes alone invalidate it. */
export function invalidateCheckpoint(
  cut: CheckpointCut,
  current: Pick<
    CheckpointInput,
    "revision" | "bundleDigest" | "configDependencyDigest" | "artifacts" | "workspace"
  >,
): CheckpointInvalidation {
  const reasons: Array<CheckpointInvalidation["reasons"][number]> = [];
  if (current.revision !== cut.sourceRevision) reasons.push("revision-changed");
  if (current.bundleDigest !== cut.bundleDigest) reasons.push("bundle-changed");
  if (current.configDependencyDigest !== cut.configDependencyDigest)
    reasons.push("config-dependencies-changed");
  if (canonicalize(current.artifacts.roots) !== canonicalize(cut.retainedArtifactRoots))
    reasons.push("artifact-closure-changed");
  if (current.workspace.treeDigest !== cut.workspaceTreeDigest)
    reasons.push("workspace-tree-changed");
  if (canonicalize(current.workspace.roots) !== canonicalize(cut.retainedTreeRoots))
    reasons.push("workspace-roots-changed");
  return { valid: reasons.length === 0, reasons };
}

/** Build child projection metadata. No parent event, approval, session, or delivery is copied. */
export function prepareForkProjection(cut: CheckpointCut): ForkProjection {
  return freeze({
    inherited: cut.inheritedSourceInvocationIds.map(
      (sourceInvocationId) =>
        ({
          sourceInvocationId,
          status: "succeeded",
          provenance: "inherited",
          authority: "none",
        }) as const,
    ),
    pending: [...cut.pendingFrontier],
    approvals: cut.freshApprovalInvocationIds.map((invocationId) => ({
      invocationId,
      status: "fresh-required" as const,
    })),
    sessions: [],
    deliveries: [],
  });
}

export type CheckpointJson = JsonValue;
