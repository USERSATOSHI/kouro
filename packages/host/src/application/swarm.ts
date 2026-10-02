import {
  WorkflowBuilder,
  artifactType,
  canonicalize,
  compileWorkflow,
  isHarness,
  sha256Hex,
  CAPABILITY,
  type Harness,
} from "@kouro/core";

export interface SwarmModel {
  harness: Harness;
  modelId: string;
}

export function normalizeSwarmModels(raw: unknown): SwarmModel[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8)
    throw new Error("Choose between 1 and 8 swarm models");
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || !isHarness(value.harness))
      throw new Error(`Choose a harness for model ${index + 1}`);
    if (typeof value.modelId !== "string" || !value.modelId.trim() || value.modelId.length > 200)
      throw new Error(`Enter a model ID for model ${index + 1}`);
    return { harness: value.harness, modelId: value.modelId.trim() };
  });
}

const Report = artifactType<{ summary: string }>("kouro.swarm-report.v1", {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
  additionalProperties: false,
});

/** Each selected model receives the task; the first combines the durable reports. */
export async function compileSwarm(models: SwarmModel[]) {
  const digest = await sha256Hex(canonicalize(models));
  const workflow = new WorkflowBuilder({
    id: `agent-swarm-${digest.slice(0, 16)}`,
    version: "1",
    limits: { maxConcurrentEffects: models.length },
  });
  const task = workflow.input("task", { type: "string", minLength: 1 });
  const members = models.map((model, index) =>
    workflow.agent(`member-${index + 1}`, {
      role: `swarm-member-${index + 1}`,
      ...model,
      prompt:
        "Carry out the shared task in your input. Develop your own answer, inspect available repository context when relevant, and state any uncertainties. Return your complete contribution in the summary field.",
      input: { task },
      produces: Report,
      capabilities: [CAPABILITY.REPOSITORY_READ],
      workspaceAccess: "read-only",
    }),
  );
  if (members.length === 1) {
    const done = workflow.complete("done", { output: members[0]!.output });
    workflow.startAt(members[0]!);
    members[0]!.on("success").to(done);
  } else {
    const fork = workflow.parallel("members", { branches: members, maxConcurrent: members.length });
    const join = workflow.join("join-members", {
      groupId: "members",
      mode: "all-settled",
      failure: "wait-for-all",
    });
    const synthesis = workflow.agent("synthesis", {
      role: "swarm-synthesis",
      ...models[0]!,
      prompt:
        "Produce the final answer to the shared task. All selected models' contributions are bound to your input by member number. Combine their useful findings, resolve disagreements using evidence, preserve uncertainties, and return the complete final answer in the summary field.",
      input: {
        task,
        ...Object.fromEntries(
          members.map((member, index) => [`member${index + 1}`, member.output]),
        ),
      },
      produces: Report,
      capabilities: [CAPABILITY.REPOSITORY_READ],
      workspaceAccess: "read-only",
    });
    // Bind the public result to synthesis rather than a branch's completion order.
    const final = workflow.complete("final", { output: synthesis.output });
    workflow.startAt(fork);
    fork.on("success").to(join);
    for (const member of members) member.on("success").to(join);
    join.on("success").to(synthesis);
    synthesis.on("success").to(final);
  }
  return compileWorkflow(workflow.build());
}
