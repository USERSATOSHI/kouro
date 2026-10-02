import { expect, test } from "bun:test";
import { WorkflowBuilder, MilestonePlanType, compileWorkflow, validateMilestonePlan } from "../src";

const item = (id: string, dependsOn: string[] = []) => ({
  id,
  title: id,
  task: id,
  workflowId: "worker",
  dependsOn,
});
test("milestone plans reject invalid assignments and graphs before execution", () => {
  const validate = (milestones: unknown[]) => validateMilestonePlan({ milestones }, ["worker"], 4);
  expect(validate([item("b", ["a"]), item("a")]).milestones.map((m) => m.id)).toEqual(["a", "b"]);
  expect(() => validate([item("a"), item("a")])).toThrow("duplicate");
  expect(() => validate([item("a", ["missing"])])).toThrow("dependency");
  expect(() => validate([item("a", ["b"]), item("b", ["a"])])).toThrow("cycle");
  expect(() => validate([{ ...item("a"), workflowId: "invented" }])).toThrow("unavailable");
  expect(() => validate([])).toThrow("1 to 4");
});
test("milestones.use composes workflows and includes bounded child execution in admission", async () => {
  const worker = new WorkflowBuilder({ id: "worker" });
  const task = worker.input("task", { type: "string" });
  const agent = worker.agent("work", { prompt: "work", input: { task } });
  worker.startAt(agent);
  worker.sequence(agent, worker.complete("done"));
  const workflow = new WorkflowBuilder({ id: "task" });
  const plan = workflow.input("plan", MilestonePlanType);
  const execute = workflow
    .milestones("execute", { plan, maxMilestones: 3, maxConcurrent: 2 })
    .use(worker);
  workflow.startAt(execute);
  workflow.sequence(execute, workflow.complete("done", { output: execute.output }));
  const bundle = await compileWorkflow(workflow.build());
  expect(bundle.boundSummary.scopes).toBe(4);
  expect(bundle.boundSummary.attempts).toBe(3);
  expect(bundle.boundSummary.invocations).toBe(8);
  expect(() => workflow.milestones("bad", { plan, maxMilestones: 13 })).toThrow("maxMilestones");
  const unsupported = new WorkflowBuilder({ id: "unsupported" });
  unsupported.input("task", { type: "string" });
  unsupported.input("secret", { type: "string" });
  unsupported.startAt(unsupported.complete("done"));
  const invalid = new WorkflowBuilder({ id: "invalid" });
  invalid.startAt(invalid.milestones("execute", { plan: { milestones: [] } }).use(unsupported));
  await expect(compileWorkflow(invalid.build())).rejects.toThrow("other required");
});
