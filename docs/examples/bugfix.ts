import { WorkflowBuilder } from "@kouro/core";
import { Task, Evidence, Change, read, write, validate } from "./support.ts";

// The project must have a Bun regression test suite and a typecheck script.
// Example task: repeated POST requests create duplicate records; preserve idempotency.
const workflow = new WorkflowBuilder({ id: "bugfix", version: "1" });
const task = workflow.input("task", Task);
const diagnose = workflow.agent("diagnose", {
  prompt: `Read project instructions and trace the reported behavior through implementation and tests.
    Identify the root cause, concrete inputs, expected versus observed behavior, and a regression
    test that distinguishes this bug. Cite paths. Return JSON with summary, findings, uncertainties.`,
  input: { task },
  produces: Evidence,
  capabilities: read,
});
const reproduce = workflow.agent("write-regression", {
  prompt: `Add a focused regression test from the diagnosis at tests/regression/bug.test.ts.
    Test the public behavior; do not implement the fix yet. Avoid unrelated edits.
    Return JSON with summary, changedFiles, remainingWork.`,
  input: { task, diagnosis: diagnose.output },
  produces: Change,
  capabilities: write,
});
const red = workflow.command("prove-failure", {
  executable: "bun",
  args: ["test", "tests/regression/bug.test.ts"],
  acceptedExitCodes: [1], // A failing regression test is required before fixing.
  capabilities: validate,
});
const confirm = workflow.approval("confirm-reproduction", {
  action: "confirm-test-fails-for-reported-bug",
  input: { task, diagnosis: diagnose.output, reproduction: red.output },
});
const fix = workflow.agent("fix", {
  prompt: `Fix the diagnosed root cause while keeping the regression test's intended assertion.
    Read the reproduction command output: a test syntax/setup error is not proof of the bug.
    Preserve existing API behavior. On repair, address the supplied validation feedback.
    Return JSON with summary, changedFiles, remainingWork.`,
  input: { task, diagnosis: diagnose.output, reproduction: red.output },
  produces: Change,
  capabilities: write,
});
const green = workflow.command("prove-fix", {
  executable: "bun",
  args: ["test"],
  capabilities: validate,
});
const typecheck = workflow.command("typecheck", {
  executable: "bun",
  args: ["run", "typecheck"],
  capabilities: validate,
});
const install = workflow.command("install-dependencies", {
  executable: "bun",
  args: ["install", "--frozen-lockfile"],
  capabilities: validate,
});
const failed = workflow.complete("failed", { result: "failed" });
install.on("failure").to(failed);
workflow.startAt(diagnose);
workflow.sequence(diagnose, reproduce, install, red, confirm);
confirm.on("approved").to(fix);
confirm.on("rejected").to(failed);
confirm.on("changes-requested").repair(reproduce, {
  maxRepairs: 1,
  feedback: confirm.output,
  exhausted: failed,
});
workflow.sequence(fix, green, typecheck, workflow.complete("done", { output: fix.output }));
red.on("failure").to(failed); // A passing reproduction needs investigation, not a claimed fix.
for (const check of [green, typecheck]) {
  check.on("failure").repair(fix, { maxRepairs: 2, feedback: check.output, exhausted: failed });
}
export default workflow.build();
