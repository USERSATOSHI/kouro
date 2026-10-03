import type { AgentNode, ArtifactRef, Bundle, ExecutionState, JsonValue } from "@kouro/core";

/** Conservative, deterministic convergence. Missing decisions always keep research running. */
export function convergedFusionOutput(
  bundle: Bundle,
  state: ExecutionState,
  node: AgentNode,
  invocationId: string,
  inputs: Readonly<Record<string, JsonValue>>,
  read: (ref: ArtifactRef) => JsonValue,
): JsonValue | undefined {
  const identity = node.fusion;
  if (
    !identity ||
    identity.stopWhenUnanimous !== true ||
    identity.stage === "draft" ||
    identity.stage === "synthesis"
  )
    return undefined;
  const invocation = state.invocations[invocationId]!;
  const definition = bundle.definitions[state.scopes[invocation.scopeId]!.definitionId]!;
  const members = definition.nodes.filter(
    (candidate) =>
      candidate.kind === "agent" &&
      candidate.fusion?.groupId === identity.groupId &&
      candidate.fusion.stage === "draft",
  );
  const lastRound = identity.round - (identity.stage === "review" ? 1 : 0);
  for (let round = 1; round <= lastRound; round++) {
    const reviews = members.map((member) => {
      if (member.kind !== "agent") return undefined;
      const reviewNode = definition.nodes.find(
        (candidate) =>
          candidate.kind === "agent" &&
          candidate.fusion?.groupId === identity.groupId &&
          candidate.fusion.memberId === member.fusion!.memberId &&
          candidate.fusion.stage === "review" &&
          candidate.fusion.round === round,
      );
      const review = Object.values(state.invocations)
        .filter(
          (candidate) =>
            candidate.scopeId === invocation.scopeId &&
            candidate.nodeId === reviewNode?.id &&
            candidate.status === "succeeded" &&
            candidate.activationOrdinal <= invocation.activationOrdinal,
        )
        .sort((a, b) => b.activationOrdinal - a.activationOrdinal)[0];
      return review?.output[0]
        ? { memberId: member.fusion!.memberId, report: read(review.output[0]) }
        : undefined;
    });
    if (
      members.length < 2 ||
      !reviews.every(
        (review) =>
          review?.report &&
          typeof review.report === "object" &&
          !Array.isArray(review.report) &&
          review.report.needsRevision === false,
      )
    )
      continue;
    return identity.stage === "revision"
      ? inputs.previous
      : reviews.find((review) => review?.memberId === identity.memberId)?.report;
  }
  return undefined;
}
