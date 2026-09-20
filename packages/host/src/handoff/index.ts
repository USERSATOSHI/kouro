import {
  assertNoEscalation,
  createAgentHandoff,
  resolveSessionDecision,
  type AgentHandoff,
  type HandoffLimits,
  type HandoffContextInput,
  type SessionDecision,
  validateCollaborationTermination,
  type CollaborationWorkflowTemplate,
  type DeterministicEvidence,
} from "@kouro/core";

export function assertCollaborationCanSucceed(input: {
  readonly template: CollaborationWorkflowTemplate;
  readonly evidence: readonly DeterministicEvidence[];
}): void {
  validateCollaborationTermination(input);
}

/** Host-owned handoff preparation. It deliberately never claims provider session transfer. */
export async function prepareAgentHandoff(input: {
  readonly handoff: Omit<AgentHandoff, "digest" | "limits" | "version" | "kind">;
  readonly context: HandoffContextInput;
  readonly limits?: HandoffLimits;
  readonly sourceBudget: Readonly<Record<string, number>>;
  readonly targetBudget: Readonly<Record<string, number>>;
  readonly sourcePermissions: readonly string[];
  readonly targetPermissions: readonly string[];
  readonly continuation: Parameters<typeof resolveSessionDecision>[0];
}): Promise<{ readonly handoff: AgentHandoff; readonly session: SessionDecision }> {
  assertNoEscalation({
    sourceBudget: input.sourceBudget,
    targetBudget: input.targetBudget,
    sourcePermissions: input.sourcePermissions,
    targetPermissions: input.targetPermissions,
  });
  const session = resolveSessionDecision(input.continuation);
  if (session.kind !== "fresh-session")
    throw new Error("handoff is only required for a fresh session");
  if (input.handoff.contextManifest.attemptId !== input.context.attemptId)
    throw new Error("handoff context does not match source attempt");
  const handoff = await createAgentHandoff(input.handoff, input.limits);
  return { handoff, session };
}
