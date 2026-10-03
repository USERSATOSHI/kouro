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

// This example targets a Bun/TypeScript project with typecheck and test scripts.
// Configure these models before running. Explicit node selections override the run profile.
const workflow = new WorkflowBuilder({ id: "feature-fusion", version: "1" });
const task = workflow.input("task", Task);
const repositoryScout = workflow.subagent(
  "repositoryScout",
  {
    prompt: scoutPrompt,
    input: { task: Task, question: Task },
    produces: Evidence,
  },
  { maxInvocations: 1, maxConcurrent: 1, optional: false },
);

const plannerA = workflow.agent("planner-a", {
  harness: "codex",
  modelId: "YOUR_CODEX_MODEL",
  prompt: `Plan the requested feature against the actual repository. ${requestScout}
    Trace the affected API and data flow, list files to change, migration concerns, and acceptance
    tests. Read project instructions. Return JSON with summary, steps, acceptance, evidence, risks.`,
  produces: Plan,
  capabilities: read,
  uses: [repositoryScout],
  scoutPolicy: { maxRequests: 2, maxConcurrent: 1 },
});
const plannerB = workflow.agent("planner-b", {
  harness: "claude",
  modelId: "YOUR_CLAUDE_MODEL",
  prompt: `Independently plan the feature. ${requestScout}
    Focus on compatibility, recovery, edge cases, and existing test conventions. Name concrete
    files and tests. Return JSON with summary, steps, acceptance, evidence, risks.`,
  produces: Plan,
  capabilities: read,
  uses: [repositoryScout],
  scoutPolicy: { maxRequests: 2, maxConcurrent: 1 },
});
const synthesis = workflow.agent("synthesis", {
  harness: "codex",
  modelId: "YOUR_CODEX_MODEL",
  prompt: `Resolve the revised plans against the repository and task. Preserve acceptance criteria
    and cited file paths; explain remaining tradeoffs in risks. Produce one implementable plan.
    Return JSON with summary, steps, acceptance, evidence, risks.`,
  produces: Plan,
  capabilities: read,
});
const planning = workflow
  .fusion("planning", {
    task,
    rounds: 2,
    reviewProduces: Evidence,
    reviewPrompt: `Review the peer plan against the task and repository. ${requestScout}
    Identify specific omissions and propose corrections. Return JSON with summary, findings, uncertainties.`,
    revisionPrompt: `Revise your plan from all reviews. ${requestScout}
    Recheck disputed claims. Return JSON with summary, steps, acceptance, evidence, risks.`,
    synthesis,
  })
  .use(plannerA, plannerB);

const approval = workflow.approval("approve-plan", { input: { task, plan: planning.output } });
const implement = workflow.agent("implement", {
  prompt: `Implement the approved plan and its acceptance tests in this worktree. Use the supplied
    evidence and project conventions. Preserve unrelated changes. If feedback is supplied on a
    repair attempt, fix its root cause. Return JSON with summary, changedFiles, remainingWork.`,
  input: { task, plan: planning.output },
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
const done = workflow.complete("done", { output: implement.output });

install.on("failure").to(failed);
workflow.startAt(planning);
workflow.sequence(planning, approval);
approval.on("approved").to(implement);
approval.on("rejected").to(failed);
// Requesting changes ends this run: revise the task and start a new fusion plan.
// This avoids implying that feedback automatically reaches agents inside a fused child workflow.
approval.on("changes-requested").to(failed);
workflow.sequence(implement, install, typecheck, tests, done);
for (const check of [typecheck, tests]) {
  check
    .on("failure")
    .repair(implement, { maxRepairs: 2, feedback: check.output, exhausted: failed });
}
export default workflow.build();
