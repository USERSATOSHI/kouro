import type { Bundle, ExecutionState, RunRetryPayload } from "@kouro/core";

/** Invalidate only structural consumers of a failed effect, preserving successful siblings. */
export function retryPlan(
  bundle: Bundle,
  state: ExecutionState,
  invocationId: string,
):
  | Pick<
      RunRetryPayload,
      | "reopenedInvocationIds"
      | "discardedInvocationIds"
      | "reopenedScopeIds"
      | "reopenedForkGroupIds"
    >
  | undefined {
  const invocations = Object.values(state.invocations);
  const nodeFor = (id: string) => {
    const invocation = state.invocations[id];
    return (
      invocation &&
      bundle.definitions[state.scopes[invocation.scopeId]?.definitionId ?? ""]?.nodes.find(
        (node) => node.id === invocation.nodeId,
      )
    );
  };
  const target = state.invocations[invocationId];
  if (!target || !["agent", "command"].includes(nodeFor(invocationId)?.kind ?? ""))
    return undefined;
  const affected = new Set([invocationId]);
  const reopened = new Set<string>();
  const discarded = new Set<string>();
  const scopes = new Set<string>();
  const groups = new Set<string>();
  const visit = (id: string): boolean => {
    const item = state.invocations[id]!;
    const node = nodeFor(id);
    if (id !== invocationId) {
      if (!node) return false;
      if (["call", "forEach", "loop", "milestones", "join"].includes(node.kind)) {
        // A successful structural result may already have been integrated or approved.
        if (item.status === "succeeded") return false;
        reopened.add(id);
      } else if (node.kind === "complete") discarded.add(id);
      else return false; // Never repeat a consumed agent, command, approval or counter.
    }
    scopes.add(item.scopeId);
    const dependants = invocations.filter(
      (candidate) => candidate.scopeId === item.scopeId && candidate.sourceInvocationId === id,
    );
    const scope = state.scopes[item.scopeId];
    const owner =
      scope?.ownerInvocationId ??
      invocations.find(
        (candidate) =>
          candidate.scopeId === scope?.parentScopeId &&
          (scope?.id === `${candidate.id}:scope` ||
            scope?.id.startsWith(`${candidate.id}:item:`) ||
            scope?.id.startsWith(`${candidate.id}:iteration:`)),
      )?.id;
    if (scope?.parentScopeId && !owner) return false;
    if (owner) dependants.push(state.invocations[owner]!);
    for (const join of invocations.filter(
      (candidate) => candidate.scopeId === item.scopeId && nodeFor(candidate.id)?.kind === "join",
    )) {
      const joinNode = nodeFor(join.id)!;
      const fork = bundle.definitions[scope!.definitionId]?.nodes.find(
        (candidate) =>
          candidate.kind === "fork" &&
          "groupId" in candidate &&
          "groupId" in joinNode &&
          candidate.groupId === joinNode.groupId,
      );
      if (fork?.kind === "fork" && "branchIds" in fork && fork.branchIds.includes(item.nodeId)) {
        dependants.push(join);
        groups.add(fork.groupId);
      }
    }
    for (const dependant of dependants) {
      if (!dependant || affected.has(dependant.id)) continue;
      affected.add(dependant.id);
      if (!visit(dependant.id)) return false;
    }
    return true;
  };
  if (!visit(invocationId)) return undefined;
  return {
    reopenedInvocationIds: [...reopened],
    discardedInvocationIds: [...discarded],
    reopenedScopeIds: [...scopes],
    reopenedForkGroupIds: [...groups],
  };
}
