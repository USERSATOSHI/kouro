import { CAPABILITY, WorkflowBuilder } from "@kouro/core";
import { Evidence as Report, Task } from "./support.ts";

const workflow = new WorkflowBuilder({ id: "agent-swarm" });
const task = workflow.input("task", Task);

// List the models first; every declared member receives the same task.
const members = [
  workflow.agent("member-a", {
    harness: "codex",
    modelId: "YOUR_CODEX_MODEL",
    prompt:
      "Investigate the shared task independently using repository evidence. Cite paths and compare alternatives. Return JSON with summary, findings, uncertainties.",
    input: { task },
    produces: Report,
    capabilities: [CAPABILITY.REPOSITORY_READ],
  }),
  workflow.agent("member-b", {
    harness: "claude",
    modelId: "YOUR_CLAUDE_MODEL",
    prompt:
      "Investigate the same task independently; challenge assumptions and identify edge cases. Cite paths. Return JSON with summary, findings, uncertainties.",
    input: { task },
    produces: Report,
    capabilities: [CAPABILITY.REPOSITORY_READ],
  }),
];
const swarm = workflow.parallel("members", { branches: members, maxConcurrent: 2 });
const join = workflow.join("members-done", { groupId: "members", mode: "all" });
const synthesis = workflow.agent("synthesis", {
  harness: "codex",
  modelId: "YOUR_CODEX_MODEL",
  prompt:
    "Combine contributions against the shared task and evidence. Resolve disagreements and preserve uncertainties. Return JSON with summary, findings, uncertainties.",
  input: { task, memberA: members[0]!.output, memberB: members[1]!.output },
  produces: Report,
  capabilities: [CAPABILITY.REPOSITORY_READ],
});

workflow.startAt(swarm);
swarm.on("success").to(join);
for (const member of members) member.on("success").to(join);
workflow.sequence(join, synthesis, workflow.complete("done", { output: synthesis.output }));

export default workflow.build();
