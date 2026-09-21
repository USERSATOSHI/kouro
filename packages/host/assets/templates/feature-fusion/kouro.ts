import { WorkflowBuilder } from "@kouro/core";
import { Summary, Task } from "./schemas/schema.ts";
const plannerAPrompt = await Bun.file(new URL("./prompts/planner-a.md", import.meta.url)).text();
const plannerBPrompt = await Bun.file(new URL("./prompts/planner-b.md", import.meta.url)).text();
const fusionPrompt = await Bun.file(new URL("./prompts/fusion.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
const task = workflow.input("task", Task);
// Replace these with model IDs available in your Pi/llama.cpp configuration.
const plannerA = workflow.agent("planner-a", {
  role: "planner-a",
  modelId: "model-a",
  prompt: plannerAPrompt,
  input: { task },
  produces: Summary,
});
const plannerB = workflow.agent("planner-b", {
  role: "planner-b",
  modelId: "model-b",
  prompt: plannerBPrompt,
  input: { task },
  produces: Summary,
});
const fork = workflow.parallel("planners", { branches: [plannerA, plannerB], maxConcurrent: 2 });
const join = workflow.join("join-planners", {
  groupId: "planners",
  mode: "all-settled",
  failure: "wait-for-all",
});
const fusion = workflow.agent("fusion", {
  role: "plan-fuser",
  modelId: "model-fusion",
  prompt: fusionPrompt,
  input: { task, first: plannerA.output, second: plannerB.output },
  produces: Summary,
});
const done = workflow.complete("done");
workflow.startAt(fork);
fork.on("success").to(join);
plannerA.on("success").to(join);
plannerB.on("success").to(join);
join.on("success").to(fusion);
fusion.on("success").to(done);
export default workflow.build();
