import { artifactType, WorkflowBuilder } from "@kouro/core";

const Plan = artifactType<{ summary: string }>("plan", {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
});
const workflow = new WorkflowBuilder({ id: "first-workflow", version: "1" });
const task = workflow.input<string>("task", { type: "string" });

const planner = workflow.agent("plan", {
  prompt: "Write an implementation plan for the task. Return JSON with a summary field.",
  input: { task },
  produces: Plan,
});
const done = workflow.complete("done", { output: planner.output });

workflow.startAt(planner);
workflow.sequence(planner, done);

export default workflow.build();
