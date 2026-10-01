import { CAPABILITY, WorkflowBuilder } from "@kouro/core";
import { ScoutQuestion, ScoutReport, Summary, Task } from "./schemas/schema.ts";
const planPrompt = await Bun.file(new URL("./prompts/plan.md", import.meta.url)).text();
const changePrompt = await Bun.file(new URL("./prompts/change.md", import.meta.url)).text();
const repositoryScoutPrompt = await Bun.file(
  new URL("./prompts/repository-scout.md", import.meta.url),
).text();
const testScoutPrompt = await Bun.file(new URL("./prompts/test-scout.md", import.meta.url)).text();
const validatePrompt = await Bun.file(new URL("./prompts/validate.md", import.meta.url)).text();
const workflow = new WorkflowBuilder({ id: "{{id}}", version: "2" });
const task = workflow.input("task", Task);
const repositoryScout = workflow.subagent(
  "repositoryScout",
  {
    role: "repository-scout",
    prompt: repositoryScoutPrompt,
    input: { task: Task, question: ScoutQuestion },
    produces: ScoutReport,
  },
  { maxInvocations: 2, maxConcurrent: 1, optional: false },
);
const testScout = workflow.subagent(
  "testScout",
  {
    role: "test-scout",
    prompt: testScoutPrompt,
    input: { task: Task, question: ScoutQuestion },
    produces: ScoutReport,
  },
  { maxInvocations: 2, maxConcurrent: 1, optional: true },
);
const plan = workflow.agent("plan", {
  role: "chore-planner",
  prompt: planPrompt,
  input: { task },
  produces: Summary,
  capabilities: [CAPABILITY.REPOSITORY_READ],
  uses: [repositoryScout, testScout],
  scoutPolicy: { maxRequests: 3, maxConcurrent: 2 },
});
const change = workflow.agent("change", {
  role: "chore-worker",
  prompt: changePrompt,
  produces: Summary,
  uses: [],
  input: {
    task,
    plan: plan.output,
    repositoryReports: workflow.subagentResults(plan, repositoryScout),
    testReports: workflow.subagentResults(plan, testScout),
  },
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE],
});
const validate = workflow.agent("validate", {
  role: "chore-validator",
  prompt: validatePrompt,
  produces: Summary,
  uses: [],
  input: {
    task,
    plan: plan.output,
    change: change.output,
    repositoryReports: workflow.subagentResults(plan, repositoryScout),
    testReports: workflow.subagentResults(plan, testScout),
  },
  capabilities: [CAPABILITY.REPOSITORY_READ],
});
const done = workflow.complete("done");
workflow.startAt(plan);
workflow.sequence(plan, change, validate, done);
export default workflow.build();
