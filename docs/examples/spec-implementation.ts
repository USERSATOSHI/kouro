import { MilestonePlanType, WorkflowBuilder } from "@kouro/core";
import { Task, Plan, Change, read, write, validate } from "./support.ts";

// Two complete worker workflows. Choose the one matching the target language.
// Each private milestone worktree needs its own dependencies and validation.
function worker(id: string, executable: string, checks: string[][]) {
  const workflow = new WorkflowBuilder({ id });
  const task = workflow.input("task", Task);
  const plan = workflow.agent("plan", {
    prompt: `Inspect the worktree, task, and completed prerequisite reports. Follow project
      instructions and produce a scoped implementation plan. For greenfield work, bootstrap the
      specified package/build files and lockfile. For a port, preserve public behavior, error cases,
      serialization, and compatibility. Return JSON with summary, steps, acceptance, evidence, risks.`,
    input: { task },
    produces: Plan,
    capabilities: read,
  });
  const approval = workflow.approval("approve-plan", { input: { task, plan: plan.output } });
  const implement = workflow.agent("implement", {
    prompt: `Implement every requirement of this milestone and its acceptance tests. Use completed
      prerequisites already present in the worktree. Respect the full specification and project
      conventions. Update dependencies and the lockfile when required. On repair, address the
      actual supplied command output. Return JSON with summary, changedFiles, remainingWork.`,
    input: { task, plan: plan.output },
    produces: Change,
    // Terminal access allows dependency/lockfile setup, including greenfield scaffolding.
    capabilities: [...write, "terminal.execute", "network.access"],
  });
  const commands = checks.map((args, index) =>
    workflow.command(`check-${index + 1}`, {
      executable,
      args,
      capabilities: validate,
    }),
  );
  const failed = workflow.complete("failed", { result: "failed" });
  workflow.startAt(plan);
  workflow.sequence(plan, approval);
  approval.on("approved").to(implement);
  approval.on("rejected").to(failed);
  approval.on("changes-requested").repair(plan, {
    maxRepairs: 1,
    feedback: approval.output,
    exhausted: failed,
  });
  workflow.sequence(
    implement,
    ...commands,
    workflow.complete("done", { output: implement.output }),
  );
  for (const check of commands) {
    check
      .on("failure")
      .repair(implement, { maxRepairs: 1, feedback: check.output, exhausted: failed });
  }
  return workflow;
}
const bunFeature = worker("bun-feature", "bun", [
  ["install", "--frozen-lockfile"],
  ["run", "typecheck"],
  ["test"],
]);
const rustPort = worker("rust-port", "cargo", [
  ["check", "--locked"],
  ["test", "--locked"],
]);
const workflow = new WorkflowBuilder({
  id: "spec-implementation",
  version: "1",
  limits: {
    maxInvocations: 256,
    maxAttempts: 512,
    maxTurns: 512,
    maxRunDurationMs: 2 * 60 * 60 * 1000,
  },
});
// An orchestrating AI supplies the detailed, approved spec (for example from fusion) as task.
const task = workflow.input("task", Task);
const planner = workflow.agent("decompose", {
  prompt: `Decompose the supplied detailed specification into at most 6 implementation milestones.
    Return { milestones: [{ id, title, task, workflowId, dependsOn }] }.
    workflowId must be "bun-feature" or "rust-port" and match the target project language.
    Preserve requirements, constraints, and acceptance criteria in each task; do not assume workers
    can see this planner's session. Put scaffolding and shared contracts before dependent modules;
    schedule the final integration milestone after every module it validates. Parallelize only
    independent work. For ports, specify behavioral parity tests and reference fixtures.
    Do not invent prerequisites outside the plan or add a separate planning-only milestone.`,
  input: { task },
  produces: MilestonePlanType,
});
const execute = workflow
  .milestones("execute", {
    plan: planner.output,
    maxMilestones: 6,
    maxConcurrent: 2,
  })
  .use(bunFeature, rustPort);
const failed = workflow.complete("failed", { result: "failed" });
workflow.startAt(planner);
planner.on("success").to(execute);
execute.on("success").to(workflow.complete("done", { output: execute.output }));
execute.on("failure").to(failed);
export default workflow.build();
