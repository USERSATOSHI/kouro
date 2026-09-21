import { expect, test } from "bun:test";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";

const Task = artifactType<string>("task", { type: "string", minLength: 1 });
const Question = artifactType<string>("question", { type: "string", minLength: 1 });
const Report = artifactType<{ summary: string }>("report", {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string", minLength: 1 } },
});
const Plan = artifactType<{ summary: string }>("plan", {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string", minLength: 1 } },
});

function scout(id = "repositoryScout") {
  const child = new WorkflowBuilder({ id, version: "1" });
  const task = child.input("task", Task);
  const question = child.input("question", Question);
  const inspect = child.agent("inspect", {
    role: "repository-scout",
    prompt: "inspect",
    input: { task, question },
    produces: Report,
  });
  const done = child.complete("done", { output: inspect.output });
  child.startAt(inspect);
  inspect.on("success").to(done);
  child.output(inspect.output);
  return child;
}

test("planner scout authoring preserves authorization and typed report bindings", async () => {
  const workflow = new WorkflowBuilder({ id: "feature", version: "1" });
  const task = workflow.input("task", Task);
  const repository = workflow.declareScout("repositoryScout", scout());
  const plan = workflow.agent("plan", {
    role: "planner",
    prompt: "plan",
    input: { task },
    produces: Plan,
    uses: [repository],
  });
  const implement = workflow.agent("implement", {
    role: "implementer",
    prompt: "implement",
    input: { reports: workflow.scoutResults(plan, repository) },
  });
  const done = workflow.complete("done");
  workflow.startAt(plan);
  plan.on("success").to(implement);
  implement.on("success").to(done);

  const bundle = await compileWorkflow(workflow.build());
  const definition = bundle.definitions[bundle.rootDefinitionId];
  const compiledPlan = definition.nodes.find((node) => node.id === "plan");
  const compiledImplement = definition.nodes.find((node) => node.id === "implement");
  expect(compiledPlan).toMatchObject({
    uses: ["repositoryScout"],
    scoutPolicy: { maxRequests: 4, maxConcurrent: 2 },
  });
  expect(compiledImplement?.bindings[0]?.source).toEqual({
    kind: "scout-results",
    sourceId: "plan",
    scoutId: "repositoryScout",
  });
});

test("planner scout authoring rejects impossible required budgets and foreign handles", async () => {
  const workflow = new WorkflowBuilder({ id: "feature", version: "1" });
  const task = workflow.input("task", Task);
  const first = workflow.declareScout("first", scout("first"));
  const second = workflow.declareScout("second", scout("second"));
  const plan = workflow.agent("plan", {
    role: "planner",
    prompt: "plan",
    input: { task },
    produces: Plan,
    uses: [first, second],
    scoutPolicy: { maxRequests: 1, maxConcurrent: 2 },
  });
  const done = workflow.complete("done");
  workflow.startAt(plan);
  plan.on("success").to(done);
  await expect(compileWorkflow(workflow.build())).rejects.toThrow("SCOUT_POLICY_TOO_SMALL");

  const other = new WorkflowBuilder({ id: "other", version: "1" });
  const foreign = other.declareScout("foreign", scout("foreign"));
  expect(() =>
    workflow.agent("foreign-use", {
      role: "planner",
      prompt: "plan",
      uses: [foreign],
    }),
  ).toThrow("expected feature");
});

test("compiler rejects a scout child that is not the restricted agent shape", async () => {
  const child = new WorkflowBuilder({ id: "bad-scout", version: "1" });
  const command = child.command("command", { executable: "/usr/bin/printf", args: ["x"] });
  const done = child.complete("done");
  child.startAt(command);
  command.on("success").to(done);
  const workflow = new WorkflowBuilder({ id: "feature", version: "1" });
  const handle = workflow.declareScout("bad", child);
  const plan = workflow.agent("plan", { role: "planner", prompt: "plan", uses: [handle] });
  const finish = workflow.complete("finish");
  workflow.startAt(plan);
  plan.on("success").to(finish);
  await expect(compileWorkflow(workflow.build())).rejects.toThrow("INVALID_SCOUT_SHAPE");
});
