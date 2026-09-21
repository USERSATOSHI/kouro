import type { ContextManifest } from "./harness";
import { canonicalize, sha256Hex } from "./canonical";

export type HandoffClaimSource = "agent" | "host" | "artifact" | "user";

export interface HandoffClaim {
  readonly text: string;
  readonly source: HandoffClaimSource;
  readonly reference?: string;
  /** Claims are never treated as verified merely because they came from a handoff. */
  readonly verified: boolean;
}

export interface HandoffFile {
  readonly path: string;
  readonly purpose?: string;
  readonly digest?: string;
  readonly source: HandoffClaimSource;
}

export interface AgentHandoff {
  readonly version: 1;
  readonly kind: "agent-handoff";
  readonly handoffId: string;
  readonly sourceAttemptId: string;
  readonly sourceSessionId?: string;
  readonly objective: HandoffClaim;
  readonly completed: readonly HandoffClaim[];
  readonly decisions: readonly HandoffClaim[];
  readonly files: readonly HandoffFile[];
  readonly unresolved: readonly HandoffClaim[];
  readonly evidence: readonly HandoffClaim[];
  readonly nextSteps: readonly HandoffClaim[];
  readonly contextManifest: Pick<ContextManifest, "version" | "attemptId" | "digest">;
  readonly provenance: {
    readonly sourceHarness: import("./contracts").RuntimeHarness;
    readonly sourceModelId?: string;
    readonly createdBy: HandoffClaimSource;
    readonly createdAt: string;
  };
  readonly limits: {
    readonly maxBytes: number;
    readonly byteLength: number;
  };
  readonly digest: string;
}

export interface HandoffLimits {
  readonly maxBytes?: number;
  readonly maxItemsPerSection?: number;
  readonly maxClaimBytes?: number;
}

const defaultHandoffLimits: Required<HandoffLimits> = {
  maxBytes: 64 * 1024,
  maxItemsPerSection: 64,
  maxClaimBytes: 8 * 1024,
};

function claim(value: HandoffClaim, path: string, limits: Required<HandoffLimits>): void {
  if (!value.text.trim()) throw new Error(`${path}.text is required`);
  if (new TextEncoder().encode(value.text).byteLength > limits.maxClaimBytes)
    throw new Error(`${path}.text is oversized`);
  if (!["agent", "host", "artifact", "user"].includes(value.source))
    throw new Error(`${path}.source is invalid`);
  if (typeof value.verified !== "boolean") throw new Error(`${path}.verified is required`);
}

export function validateAgentHandoff(
  handoff: AgentHandoff,
  limits: HandoffLimits = {},
): { readonly valid: true; readonly byteLength: number } {
  const bound = { ...defaultHandoffLimits, ...limits };
  if (handoff.version !== 1 || handoff.kind !== "agent-handoff")
    throw new Error("unsupported handoff version");
  if (!handoff.handoffId || !handoff.sourceAttemptId)
    throw new Error("handoff identity is required");
  claim(handoff.objective, "objective", bound);
  for (const [name, values] of Object.entries(handoff).filter(([key]) =>
    ["completed", "decisions", "unresolved", "evidence", "nextSteps"].includes(key),
  )) {
    if (!Array.isArray(values) || values.length > bound.maxItemsPerSection)
      throw new Error(`${name} exceeds its item bound`);
    values.forEach((item, index) => claim(item as HandoffClaim, `${name}[${index}]`, bound));
  }
  for (const [index, file] of handoff.files.entries()) {
    if (!file.path.trim() || file.path.startsWith("/") || file.path.includes(".."))
      throw new Error(`files[${index}].path must be a relative safe path`);
    if (!["agent", "host", "artifact", "user"].includes(file.source))
      throw new Error(`files[${index}].source is invalid`);
  }
  if (handoff.contextManifest.attemptId !== handoff.sourceAttemptId)
    throw new Error("context manifest must identify the source attempt");
  const { digest: _digest, ...withoutDigest } = handoff;
  const copy = { ...withoutDigest, limits: { ...handoff.limits, byteLength: 0 } };
  const byteLength = new TextEncoder().encode(canonicalize(copy)).byteLength;
  if (byteLength > Math.min(bound.maxBytes, handoff.limits.maxBytes))
    throw new Error("handoff exceeds byte budget");
  return { valid: true, byteLength };
}

export async function createAgentHandoff(
  input: Omit<AgentHandoff, "digest" | "limits" | "version" | "kind"> & {
    readonly maxBytes?: number;
  },
  limits: HandoffLimits = {},
): Promise<AgentHandoff> {
  const maxBytes = input.maxBytes ?? limits.maxBytes ?? defaultHandoffLimits.maxBytes;
  const base = {
    ...input,
    version: 1 as const,
    kind: "agent-handoff" as const,
    limits: { maxBytes, byteLength: 0 },
  };
  const { digest: _digest, ...withoutDigest } = { ...base, digest: "" };
  const byteLength = new TextEncoder().encode(canonicalize(withoutDigest)).byteLength;
  const handoff = { ...base, limits: { maxBytes, byteLength } } as AgentHandoff;
  validateAgentHandoff(handoff, limits);
  return Object.freeze({ ...handoff, digest: `sha256:${await sha256Hex(canonicalize(handoff))}` });
}

export type SessionDecision =
  | { readonly kind: "native-resume"; readonly reason: "compatible" }
  | { readonly kind: "fresh-session"; readonly reason: string; readonly requiresHandoff: true };

export function resolveSessionDecision(input: {
  readonly nativeResume: "supported" | "unsupported" | "conditional";
  readonly sameHarness: boolean;
  readonly sameModel: boolean;
  readonly permissionEnvelopeUnchanged: boolean;
}): SessionDecision {
  if (
    input.nativeResume === "supported" &&
    input.sameHarness &&
    input.sameModel &&
    input.permissionEnvelopeUnchanged
  )
    return { kind: "native-resume", reason: "compatible" };
  const reason = !input.permissionEnvelopeUnchanged
    ? "permission-envelope-changed"
    : !input.sameHarness
      ? "harness-changed"
      : !input.sameModel
        ? "model-changed"
        : "native-continuation-unavailable";
  return { kind: "fresh-session", reason, requiresHandoff: true };
}

export function assertNoEscalation(input: {
  readonly sourceBudget: Readonly<Record<string, number>>;
  readonly targetBudget: Readonly<Record<string, number>>;
  readonly sourcePermissions: readonly string[];
  readonly targetPermissions: readonly string[];
}): void {
  for (const [key, value] of Object.entries(input.targetBudget))
    if (value > (input.sourceBudget[key] ?? 0)) throw new Error(`handoff escalates budget: ${key}`);
  for (const permission of input.targetPermissions)
    if (!input.sourcePermissions.includes(permission))
      throw new Error(`handoff escalates permission: ${permission}`);
}

export interface CollaborationWorkflowTemplate {
  readonly kind: "collaboration-template";
  readonly version: 1;
  readonly roles: readonly { readonly id: string; readonly objective: string }[];
  readonly directMessageTools: readonly {
    readonly name: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly parallelBranches: readonly { readonly id: string; readonly roleId: string }[];
  readonly join: {
    readonly mode: "all" | "all-settled" | "fail-fast";
    readonly branchIds: readonly string[];
  };
  readonly respondLoop: {
    readonly maxTurns: number;
    readonly idleDeadlineMs: number;
    readonly maxMessagesPerTurn: number;
  };
  readonly deterministicReproductionGate: {
    readonly required: true;
    readonly command: string;
    readonly evidenceKind: "deterministic";
  };
}

export type DeterministicEvidence = {
  readonly kind: "deterministic";
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly attemptId: string;
};

/** A model's completion claim is insufficient; only recorded deterministic evidence can pass. */
export function validateCollaborationTermination(input: {
  readonly template: CollaborationWorkflowTemplate;
  readonly evidence: readonly DeterministicEvidence[];
}): { readonly allowed: true; readonly evidence: DeterministicEvidence } {
  const evidence = input.evidence.find(
    (item) =>
      item.kind === "deterministic" &&
      item.command === input.template.deterministicReproductionGate.command &&
      item.status === "passed",
  );
  if (!evidence) throw new Error("deterministic reproduction evidence is required before success");
  return { allowed: true, evidence };
}

export function createCollaborationWorkflowTemplate(
  input: Omit<CollaborationWorkflowTemplate, "kind" | "version">,
): CollaborationWorkflowTemplate {
  if (!input.roles.length || !input.parallelBranches.length)
    throw new Error("collaboration template needs roles and branches");
  if (!Number.isSafeInteger(input.respondLoop.maxTurns) || input.respondLoop.maxTurns < 1)
    throw new Error("respond loop maxTurns must be positive and finite");
  if (
    !Number.isSafeInteger(input.respondLoop.maxMessagesPerTurn) ||
    input.respondLoop.maxMessagesPerTurn < 1
  )
    throw new Error("respond loop maxMessagesPerTurn must be positive and finite");
  if (!Number.isFinite(input.respondLoop.idleDeadlineMs) || input.respondLoop.idleDeadlineMs <= 0)
    throw new Error("respond loop idle deadline must be positive and finite");
  const roleIds = new Set(input.roles.map((role) => role.id));
  for (const branch of input.parallelBranches)
    if (!roleIds.has(branch.roleId)) throw new Error(`branch role is undeclared: ${branch.roleId}`);
  if (
    new Set(input.join.branchIds).size !== input.parallelBranches.length ||
    input.join.branchIds.some((id) => !input.parallelBranches.some((branch) => branch.id === id))
  )
    throw new Error("join must cover exactly the declared branches");
  for (const tool of input.directMessageTools)
    if (!roleIds.has(tool.from) || !roleIds.has(tool.to))
      throw new Error("message tool references undeclared role");
  return Object.freeze({ kind: "collaboration-template", version: 1, ...input });
}

export type HandoffContextInput = Pick<ContextManifest, "version" | "attemptId" | "digest">;
