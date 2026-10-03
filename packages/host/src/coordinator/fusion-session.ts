import type { AgentNode, AttemptState, Bundle, ExecutionState } from "@kouro/core";

/** A member's history belongs to one fusion activation, never to a peer or another scope. */
export function fusionContinuation(
  bundle: Bundle,
  state: ExecutionState,
  node: AgentNode,
  invocationId: string,
): { workspaceInvocationId: string; previousAttempt?: AttemptState } | undefined {
  const identity = node.fusion;
  if (!identity || identity.stage === "synthesis") return undefined;
  const invocation = state.invocations[invocationId]!;
  const definition = bundle.definitions[state.scopes[invocation.scopeId]!.definitionId]!;
  const memberInvocation = (stage: string, round: number) =>
    Object.values(state.invocations)
      .filter((candidate) => {
        if (
          candidate.scopeId !== invocation.scopeId ||
          candidate.activationOrdinal > invocation.activationOrdinal ||
          candidate.status !== "succeeded"
        )
          return false;
        const candidateNode = definition.nodes.find((item) => item.id === candidate.nodeId);
        const fusion = candidateNode?.kind === "agent" ? candidateNode.fusion : undefined;
        return (
          fusion?.groupId === identity.groupId &&
          fusion.memberId === identity.memberId &&
          fusion.stage === stage &&
          fusion.round === round
        );
      })
      .sort((a, b) => b.activationOrdinal - a.activationOrdinal)[0];
  const draft = identity.stage === "draft" ? invocation : memberInvocation("draft", 0);
  if (!draft) throw new Error(`Fusion member ${identity.memberId} has no completed draft`);
  const predecessor =
    identity.stage === "draft"
      ? undefined
      : identity.stage === "revision"
        ? memberInvocation("review", identity.round)
        : memberInvocation(identity.round === 1 ? "draft" : "revision", identity.round - 1);
  const previousAttempt = predecessor
    ? Object.values(state.attempts)
        .filter((item) => item.invocationId === predecessor.id && item.status === "succeeded")
        .sort((a, b) => b.ordinal - a.ordinal)[0]
    : undefined;
  if (identity.stage !== "draft" && !previousAttempt)
    throw new Error(`Fusion member ${identity.memberId} has no completed preceding stage`);
  return { workspaceInvocationId: draft.id, previousAttempt };
}
