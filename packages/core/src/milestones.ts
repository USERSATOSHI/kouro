import type { ArtifactType, ExecutionState, MilestonesNode } from "./contracts";

export interface Milestone {
  readonly id: string;
  readonly title: string;
  readonly task: string;
  readonly workflowId: string;
  readonly dependsOn: readonly string[];
}
export interface MilestonePlan {
  readonly milestones: readonly Milestone[];
}
export const MAX_MILESTONES = 12;
export const MilestonePlanType: ArtifactType<MilestonePlan> = {
  id: "kouro.milestone-plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["milestones"],
    properties: {
      milestones: {
        type: "array",
        minItems: 1,
        maxItems: MAX_MILESTONES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "task", "workflowId", "dependsOn"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
            title: { type: "string", minLength: 1, maxLength: 200 },
            task: { type: "string", minLength: 1, maxLength: 20000 },
            workflowId: { type: "string", minLength: 1 },
            dependsOn: {
              type: "array",
              uniqueItems: true,
              maxItems: MAX_MILESTONES,
              items: { type: "string" },
            },
          },
        },
      },
    },
  },
};
export const MilestoneResultType: ArtifactType = {
  id: "kouro.milestone-result",
  schema: {
    type: "object",
    required: ["milestones"],
    properties: {
      milestones: { type: "array", items: { type: "object" } },
    },
  },
};

/** Validate the whole plan before any workflow is started; return stable topological order. */
export function validateMilestonePlan(
  value: unknown,
  workflows: readonly string[],
  max: number,
): MilestonePlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Milestone plan must be an object");
  const raw = (value as { milestones?: unknown }).milestones;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max)
    throw new Error(`Plan must contain 1 to ${max} milestones`);
  const ids = new Set<string>();
  const milestones = raw.map((item): Milestone => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid milestone");
    const { id, title, task, workflowId, dependsOn } = item;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id))
      throw new Error(`Invalid or duplicate milestone ID: ${id}`);
    ids.add(id);
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 200 ||
      typeof task !== "string" ||
      !task.trim() ||
      task.length > 20000
    )
      throw new Error(`Milestone ${id} needs a title and task`);
    if (typeof workflowId !== "string" || !workflows.includes(workflowId))
      throw new Error(`Milestone ${id} selects unavailable workflow ${workflowId}`);
    if (
      !Array.isArray(dependsOn) ||
      dependsOn.some((dependency) => typeof dependency !== "string") ||
      new Set(dependsOn).size !== dependsOn.length
    )
      throw new Error(`Milestone ${id} has invalid dependencies`);
    return { id, title: title.trim(), task: task.trim(), workflowId, dependsOn };
  });
  for (const milestone of milestones)
    for (const dependency of milestone.dependsOn)
      if (dependency === milestone.id || !ids.has(dependency))
        throw new Error(`Milestone ${milestone.id} has unknown or self dependency ${dependency}`);
  const ordered: Milestone[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (milestone: Milestone) => {
    if (visited.has(milestone.id)) return;
    if (visiting.has(milestone.id)) throw new Error("Milestone dependencies contain a cycle");
    visiting.add(milestone.id);
    for (const dependency of milestone.dependsOn)
      visit(milestones.find((item) => item.id === dependency)!);
    visiting.delete(milestone.id);
    visited.add(milestone.id);
    ordered.push(milestone);
  };
  milestones.forEach(visit);
  return { milestones: ordered };
}

export function milestoneScopeId(ownerInvocationId: string, milestoneId: string): string {
  return `${ownerInvocationId}:milestone:${milestoneId}`;
}
export type MilestoneStatus =
  | "ready"
  | "waiting"
  | "running"
  | "approval"
  | "succeeded"
  | "failed"
  | "blocked";
export function milestoneProgress(
  plan: MilestonePlan,
  node: MilestonesNode,
  state: ExecutionState,
  owner: string,
) {
  const statuses = new Map<string, MilestoneStatus>();
  return plan.milestones.map((milestone) => {
    const scopeId = milestoneScopeId(owner, milestone.id);
    const invocations = Object.values(state.invocations).filter((item) => item.scopeId === scopeId);
    const active = invocations.some((item) =>
      ["pending", "reserved", "running"].includes(item.status),
    );
    const terminal = invocations.some(
      (item) =>
        item.status === "succeeded" &&
        item.outcome === "success" &&
        state.scopes[scopeId]?.milestoneExitIds?.includes(item.nodeId),
    );
    let status: MilestoneStatus;
    if (state.scopes[scopeId]) {
      const approval = Object.values(state.approvals).some((item) => {
        let scope = state.scopes[state.invocations[item.invocationId]?.scopeId ?? ""];
        while (scope && scope.id !== scopeId && scope.parentScopeId)
          scope = state.scopes[scope.parentScopeId];
        return item.status === "pending" && scope?.id === scopeId;
      });
      status = approval ? "approval" : active ? "running" : terminal ? "succeeded" : "failed";
    } else if (
      milestone.dependsOn.some((id) =>
        ["failed", "blocked"].includes(statuses.get(id) ?? "waiting"),
      )
    )
      status = "blocked";
    else
      status = milestone.dependsOn.every((id) => statuses.get(id) === "succeeded")
        ? "ready"
        : "waiting";
    statuses.set(milestone.id, status);
    return {
      ...milestone,
      scopeId,
      definitionId: node.workflows.find((item) => item.id === milestone.workflowId)!.definitionId,
      status,
      invocationIds: invocations.map((item) => item.id),
    };
  });
}
