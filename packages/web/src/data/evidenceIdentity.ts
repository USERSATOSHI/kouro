import { asArray, type UiRunView, type UiArtifact } from "../types";

export function invocationLabel(view: UiRunView, invocationId?: string, attemptId?: string) {
  const attempt = attemptId ? view.attempts[attemptId] : undefined;
  const invocation = view.invocations[invocationId ?? attempt?.invocationId ?? ""];
  if (!invocation) return "Run-level · owner not reported";
  const scope = view.scopes[invocation.scopeId];
  const node = view.bundle.definitions[
    scope?.definitionId ?? view.bundle.rootDefinitionId
  ]?.nodes.find((node) => node.id === invocation.sourceNodeId);
  const execution = attempt?.resolvedExecution as
    | { harness?: string; modelId?: string }
    | undefined;
  return [
    invocation.sourceNodeId,
    node?.kind === "agent" ? node.role : undefined,
    scope?.definitionId,
    `invocation ${invocation.ordinal + 1}`,
    attempt ? `attempt ${attempt.ordinal + 1}` : undefined,
    execution?.harness,
    execution?.modelId,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function evidenceBelongsTo(
  view: UiRunView,
  invocationId: string,
  item: { invocationId?: string; attemptId?: string },
) {
  return (
    item.invocationId === invocationId ||
    Boolean(item.attemptId && view.attempts[item.attemptId]?.invocationId === invocationId)
  );
}

export function artifactIdentity(view: UiRunView, artifactId: string) {
  const owners: Array<{ invocationId: string; attemptId?: string; label: string; role: string }> =
    [];
  for (const attempt of asArray(view.attempts)) {
    const role =
      attempt.command?.stderrArtifactId === artifactId
        ? "Command stderr"
        : attempt.outputArtifactIds?.includes(artifactId)
          ? "Typed output"
          : attempt.evidenceArtifactIds?.includes(artifactId)
            ? "Evidence"
            : view.tools.some(
                  (tool) =>
                    tool.attemptId === attempt.attemptId && tool.outputArtifactId === artifactId,
                )
              ? "Tool output"
              : attempt.artifactIds.includes(artifactId)
                ? "Attached artifact"
                : undefined;
    if (role)
      owners.push({
        invocationId: attempt.invocationId,
        attemptId: attempt.attemptId,
        label: invocationLabel(view, attempt.invocationId, attempt.attemptId),
        role,
      });
  }
  for (const invocation of asArray(view.invocations)) {
    if (owners.some((owner) => owner.invocationId === invocation.invocationId)) continue;
    const role = invocation.outputArtifactIds.includes(artifactId)
      ? "Typed output"
      : invocation.evidenceArtifactIds.includes(artifactId)
        ? "Evidence"
        : invocation.artifactIds.includes(artifactId)
          ? "Attached artifact"
          : undefined;
    if (role)
      owners.push({
        invocationId: invocation.invocationId,
        label: invocationLabel(view, invocation.invocationId),
        role,
      });
  }
  const artifact: UiArtifact | undefined = view.artifacts[artifactId];
  return {
    owners,
    name:
      artifact?.name ||
      owners
        .map(
          (owner) =>
            `${view.invocations[owner.invocationId]?.sourceNodeId ?? "Agent"} · ${owner.role}`,
        )
        .join(" / ") ||
      "Unattributed artifact",
  };
}
