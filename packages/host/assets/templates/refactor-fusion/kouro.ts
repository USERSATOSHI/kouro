import { WorkflowBuilder } from "@kouro/core";
import { Summary } from "./schemas/schema.ts";
const analystPrompt = await Bun.file(new URL("./prompts/analyst.md", import.meta.url)).text();
const testReviewerPrompt = await Bun.file(
  new URL("./prompts/test-reviewer.md", import.meta.url),
).text();
const fusionPrompt = await Bun.file(new URL("./prompts/fusion.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
// Replace these with model IDs available in your Pi/llama.cpp configuration.
const analyst = workflow.agent("analyst", {
  role: "refactor-analyst",
  modelId: "model-a",
  prompt: analystPrompt,
  produces: Summary,
});
const testReviewer = workflow.agent("test-reviewer", {
  role: "refactor-test-reviewer",
  modelId: "model-b",
  prompt: testReviewerPrompt,
  produces: Summary,
});
const fork = workflow.parallel("reviewers", {
  branches: [analyst, testReviewer],
  maxConcurrent: 2,
});
const join = workflow.join("join-reviewers", {
  groupId: "reviewers",
  mode: "all-settled",
  failure: "wait-for-all",
});
const fusion = workflow.agent("fusion", {
  role: "refactor-plan-fuser",
  modelId: "model-fusion",
  prompt: fusionPrompt,
  input: { analysis: analyst.output, tests: testReviewer.output },
  produces: Summary,
});
const done = workflow.complete("done");
workflow.startAt(fork);
fork.on("success").to(join);
analyst.on("success").to(join);
testReviewer.on("success").to(join);
join.on("success").to(fusion);
fusion.on("success").to(done);
export default workflow.build();
