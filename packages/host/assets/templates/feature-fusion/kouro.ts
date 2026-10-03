import { WorkflowBuilder } from "@kouro/core";
import { Summary, Task, Review } from "./schemas/schema.ts";
const firstPrompt = await Bun.file(new URL("./prompts/planner-a.md", import.meta.url)).text();
const secondPrompt = await Bun.file(new URL("./prompts/planner-b.md", import.meta.url)).text();
const reviewPrompt = await Bun.file(new URL("./prompts/review.md", import.meta.url)).text();
const revisionPrompt = await Bun.file(new URL("./prompts/revise.md", import.meta.url)).text();
const fusionPrompt = await Bun.file(new URL("./prompts/fusion.md", import.meta.url)).text();
// Each round cross-reviews the latest plans, then revises both plans in parallel.
// Set to 0 for initial drafts followed directly by synthesis; supported range: 0-10.
const reviewRounds = 1;
// Configure each model once; its draft, reviews and revisions use the same selection.
const models = {
  a: { modelId: "model-a" },
  b: { modelId: "model-b" },
  fusion: { modelId: "model-fusion" },
};
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "2" });
const task = workflow.input("task", Task);
const plannerA = workflow.agent("planner-a", {
  role: "planner-a",
  ...models.a,
  prompt: firstPrompt,
  produces: Summary,
});
const plannerB = workflow.agent("planner-b", {
  role: "planner-b",
  ...models.b,
  prompt: secondPrompt,
  produces: Summary,
});
const synthesizer = workflow.agent("fusion", {
  role: "plan-fuser",
  ...models.fusion,
  prompt: fusionPrompt,
  produces: Summary,
});
const fusion = workflow
  .fusion("planners", {
    task,
    rounds: reviewRounds,
    reviewProduces: Review,
    reviewPrompt,
    revisionPrompt,
    synthesis: synthesizer,
  })
  .use(plannerA, plannerB);
const done = workflow.complete("done", { output: fusion.output });
workflow.startAt(fusion);
fusion.on("success").to(done);
export default workflow.build();
