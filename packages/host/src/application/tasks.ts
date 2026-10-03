import {
  CAPABILITY,
  WorkflowBuilder,
  compileWorkflow,
  isHarness,
  MilestonePlanType,
  type Bundle,
  type Harness,
  type WorkflowDefinitionSource,
} from "@kouro/core";

export interface TaskWorkflow {
  id: string;
  name: string;
  version: string;
  digest: string;
  bundle: Bundle;
}
export interface TaskModel {
  harness: Harness;
  modelId: string;
}
export function taskModel(value: unknown): TaskModel {
  if (!value || typeof value !== "object")
    throw new Error("Choose a harness and model for planning and execution");
  const model = value as Record<string, unknown>;
  if (
    !isHarness(model.harness) ||
    typeof model.modelId !== "string" ||
    !model.modelId.trim() ||
    model.modelId.length > 200
  )
    throw new Error("Choose a supported harness and nonblank model ID");
  return { harness: model.harness, modelId: model.modelId.trim() };
}
export function taskWorkflowEligibility(workflow: TaskWorkflow) {
  const root = workflow.bundle.definitions[workflow.bundle.rootDefinitionId]!;
  const task = root.inputPorts.find((port) => port.name === "task");
  const schema = task && workflow.bundle.schemas[task.schemaDigest];
  const nodes = Object.values(workflow.bundle.definitions).flatMap(
    (definition) => definition.nodes,
  );
  const reason =
    !task ||
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    schema.type !== "string"
      ? "Workflow must accept a string task"
      : root.inputPorts.some(
            (port) => port.required && port.name !== "task" && port.defaultValue === undefined,
          )
        ? "Workflow requires additional inputs"
        : nodes.some((node) => node.kind === "milestones")
          ? "Workflow already schedules milestones"
          : nodes.some(
                (node) => node.kind === "command" && node.workspaceAccess === "source-repository",
              )
            ? "Workflow commands run in the source checkout"
            : undefined;
  return {
    eligible: !reason,
    reason,
    requiresWorkspace: nodes.some(
      (node) =>
        node.kind === "command" ||
        (node.kind === "agent" &&
          (node.workspaceAccess === "workspace-write" ||
            node.capabilities?.includes(CAPABILITY.REPOSITORY_WRITE))),
    ),
    approvalGates: nodes.filter((node) => node.kind === "approval").length,
  };
}

/** Re-author a pinned bundle with independent definition identities and unchanged gates. */
function workflowSource(workflow: TaskWorkflow, executor: TaskModel): WorkflowDefinitionSource {
  const bundle = workflow.bundle;
  const build = (definitionId: string, id: string): WorkflowDefinitionSource => {
    const definition = bundle.definitions[definitionId]!;
    const references = new Set<string>(
      (definition.scouts ?? []).map((scout) => scout.definitionId),
    );
    for (const node of definition.nodes) {
      if (node.kind === "call" && "definitionId" in node) references.add(node.definitionId);
      if (node.kind === "forEach" && "templateDefinitionId" in node)
        references.add(node.templateDefinitionId);
      if (node.kind === "milestones" && "workflows" in node)
        node.workflows.forEach((item) => references.add(item.definitionId));
    }
    const childId = (ref: string) => `${id}/${ref}`;
    return {
      ...definition,
      id,
      version: workflow.version,
      limits: bundle.limits,
      schemaCatalog: bundle.schemas,
      nodes: definition.nodes.map((node) => {
        if (node.kind === "agent")
          return {
            ...node,
            harness: node.harness ?? executor.harness,
            modelId: node.modelId ?? executor.modelId,
          };
        if (node.kind === "call" && "definitionId" in node)
          return { ...node, definitionId: childId(node.definitionId) };
        if (node.kind === "forEach" && "templateDefinitionId" in node)
          return { ...node, templateDefinitionId: childId(node.templateDefinitionId) };
        if (node.kind === "milestones" && "workflows" in node)
          return {
            ...node,
            workflows: node.workflows.map((item) => ({
              ...item,
              definitionId: childId(item.definitionId),
            })),
          };
        return node;
      }),
      scouts: definition.scouts?.map((scout) => ({
        ...scout,
        definitionId: childId(scout.definitionId),
      })),
      definitions: Object.fromEntries(
        [...references].map((ref) => [childId(ref), build(ref, childId(ref))]),
      ),
    };
  };
  return build(bundle.rootDefinitionId, workflow.id);
}

export async function compileTask(
  workflows: readonly TaskWorkflow[],
  planner: TaskModel,
  executor: TaskModel,
  maxMilestones = 8,
  maxConcurrent = 2,
) {
  const largest = (key: "scopes" | "invocations" | "attempts") =>
    Math.max(...workflows.map((workflow) => workflow.bundle.boundSummary[key]));
  const workflow = new WorkflowBuilder({
    id: "automatic-task",
    version: "1",
    limits: {
      maxScopes: 1 + maxMilestones * largest("scopes"),
      maxInvocations: 4 + maxMilestones * largest("invocations"),
      // Preserve each workflow's declared retry budget, beyond its initial graph effects.
      maxAttempts:
        1 + maxMilestones * Math.max(...workflows.map((item) => item.bundle.limits.maxAttempts)),
      maxConcurrentEffects: Math.min(4, maxConcurrent),
      maxRunDurationMs: 24 * 60 * 60 * 1000,
      maxTurns:
        1 + maxMilestones * Math.max(...workflows.map((item) => item.bundle.limits.maxTurns)),
      maxMessages:
        1 + maxMilestones * Math.max(...workflows.map((item) => item.bundle.limits.maxMessages)),
    },
  });
  const task = workflow.input("task", { type: "string", minLength: 1, maxLength: 20000 });
  const catalog = workflows.map((item) => ({
    id: item.id,
    name: item.name,
    version: item.version,
    digest: item.digest,
    steps: item.bundle.definitions[item.bundle.rootDefinitionId]!.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      ...(node.kind === "agent" ? { role: node.role } : {}),
    })),
    approvalGates: taskWorkflowEligibility(item).approvalGates,
  }));
  const plan = workflow.agent("decompose", {
    role: "task-decomposer",
    ...planner,
    produces: MilestonePlanType,
    prompt: `Decompose the task into 1 to ${maxMilestones} concrete milestones and assign EACH to one available workflow ID from workflows. Return the milestone plan as JSON. Each milestone must have a unique safe id, concise title, self-contained task, workflowId and dependsOn array. Use dependencies when a milestone needs earlier outputs or file changes. Independent milestones may execute in parallel (limit ${maxConcurrent}). Do not create artificial phases that duplicate the steps already in a workflow. Order milestones topologically, reject cycles, and keep approval gates in the selected workflows. Inspect repository context if supplied.`,
    input: { task, workflows: catalog },
    capabilities: [CAPABILITY.REPOSITORY_READ],
    workspaceAccess: "read-only",
  });
  const execute = workflow
    .milestones("execute-milestones", { plan: plan.output, maxMilestones, maxConcurrent })
    .use(...workflows.map((item) => workflowSource(item, executor)));
  const done = workflow.complete("done", { output: execute.output });
  const failed = workflow.complete("failed", { result: "failed" });
  workflow.startAt(plan);
  plan.on("success").to(execute);
  execute.on("success").to(done);
  execute.on("failure").to(failed);
  return compileWorkflow(workflow.build());
}
