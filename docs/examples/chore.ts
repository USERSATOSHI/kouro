import { WorkflowBuilder } from "@kouro/core";
import {
  Task,
  Evidence,
  Plan,
  Change,
  read,
  write,
  validate,
  scoutPrompt,
  requestScout,
} from "./support.ts";

// Example task: remove a deprecated adapter and update its references and documentation.
const workflow = new WorkflowBuilder({ id: "chore", version: "1" });
const task = workflow.input("task", Task);
const repositoryScout = workflow.subagent(
  "repositoryScout",
  {
    prompt: scoutPrompt,
    input: { task: Task, question: Task },
    produces: Evidence,
  },
  { maxInvocations: 2, maxConcurrent: 1, optional: false },
);
const plan = workflow.agent("plan", {
  prompt: `Plan the maintenance task with an explicit scope. ${requestScout}
    Map references before deletion, retain unique behavior and documentation, and list the project's
    relevant checks. Return JSON with summary, steps, acceptance, evidence, risks.`,
  input: { task },
  produces: Plan,
  capabilities: read,
  uses: [repositoryScout],
  scoutPolicy: { maxRequests: 2, maxConcurrent: 1 },
});
const change = workflow.agent("change", {
  prompt: `Carry out only the planned maintenance. Use the scout evidence, update affected references,
    and preserve behavior outside the task. On repair, fix the supplied check output.
    Return JSON with summary, changedFiles, remainingWork.`,
  input: { task, plan: plan.output, reports: workflow.subagentResults(plan, repositoryScout) },
  produces: Change,
  capabilities: write,
});
const typecheck = workflow.command("typecheck", {
  executable: "bun",
  args: ["run", "typecheck"],
  capabilities: validate,
});
const tests = workflow.command("tests", {
  executable: "bun",
  args: ["test"],
  capabilities: validate,
});
const install = workflow.command("install-dependencies", {
  executable: "bun",
  args: ["install", "--frozen-lockfile"],
  capabilities: validate,
});
const failed = workflow.complete("failed", { result: "failed" });
install.on("failure").to(failed);
workflow.startAt(plan);
workflow.sequence(
  plan,
  change,
  install,
  typecheck,
  tests,
  workflow.complete("done", { output: change.output }),
);
for (const check of [typecheck, tests]) {
  check.on("failure").repair(change, { maxRepairs: 1, feedback: check.output, exhausted: failed });
}
export default workflow.build();
