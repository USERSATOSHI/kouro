import { CAPABILITY, WorkflowBuilder } from "@kouro/core";
import { ScoutQuestion, ScoutReport, Summary, Task, WorkItem } from "./schemas/schema.ts";

const planPrompt = await Bun.file(new URL("./prompts/plan.md", import.meta.url)).text();
const repositoryScoutPrompt = await Bun.file(
  new URL("./prompts/repository-scout.md", import.meta.url),
).text();
const testScoutPrompt = await Bun.file(new URL("./prompts/test-scout.md", import.meta.url)).text();
const implementPrompt = await Bun.file(new URL("./prompts/implement.md", import.meta.url)).text();

const workflow = new WorkflowBuilder({ id: "{{id}}", version: "1" });
const task = workflow.input("task", Task, { required: false });
const workItem = workflow.input("workItem", WorkItem, { required: false });
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
  role: "planner",
  prompt: planPrompt,
  input: { task, workItem },
  produces: Summary,
  uses: [repositoryScout, testScout],
  capabilities: [CAPABILITY.REPOSITORY_READ],
  scoutPolicy: { maxRequests: 4, maxConcurrent: 2 },
});
const approval = workflow.approval("approve-plan", {
  action: "accept-plan",
  input: {
    task,
    workItem,
    plan: plan.output,
  },
});
const implement = workflow.agent("implement", {
  role: "implementer",
  prompt: implementPrompt,
  input: {
    task,
    workItem,
    plan: plan.output,
    repositoryReports: workflow.subagentResults(plan, repositoryScout),
    testReports: workflow.subagentResults(plan, testScout),
  },
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE],
});
const validate = workflow.command("validate", {
  executable: "bun",
  args: ["test"],
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
});
const done = workflow.complete("done");
const failed = workflow.complete("failed", { result: "failed" });
const typecheck = workflow.command("typecheck", {
  executable: "bun",
  args: ["run", "typecheck"],
  capabilities: [CAPABILITY.REPOSITORY_READ, CAPABILITY.TERMINAL_EXECUTE],
});
workflow.startAt(plan);
plan.on("success").to(approval);
approval.on("approved").to(implement);
approval.on("rejected").to(failed);
workflow.sequence(implement, typecheck, validate, done);
export default workflow.build();
