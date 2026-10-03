import { expect, test } from "bun:test";
import { WorkflowBuilder, artifactType, compileWorkflow, type FusionOptions } from "../src";

const report = artifactType<{ summary: string }>("fusion-report", {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
});
function setup(id = "fusion-builder") {
  const workflow = new WorkflowBuilder({ id });
  const task = workflow.input("task", artifactType<string>("fusion-task", { type: "string" }));
  const scout = workflow.subagent("repositoryScout", { prompt: "inspect", produces: report });
  const a = workflow.agent("a", {
    prompt: "plan a",
    modelId: "a-model",
    effort: "low",
    produces: report,
    uses: [scout],
    workspaceAccess: "read-only",
  });
  const b = workflow.agent("b", {
    prompt: "plan b",
    modelId: "b-model",
    effort: "medium",
    produces: report,
  });
  const synthesizer = workflow.agent("synthesizer", {
    prompt: "combine",
    modelId: "combine-model",
    effort: "high",
    produces: report,
  });
  const options: FusionOptions<{ summary: string }, { summary: string }> = {
    task,
    rounds: 2,
    reviewProduces: report,
    reviewPrompt: "review",
    revisionPrompt: "revise",
    synthesis: synthesizer,
  };
  return { workflow, a, b, options };
}

test("fusion composes agent handles and subagents with ordinary output and control edges", async () => {
  const { workflow, a, b, options } = setup();
  const fusion = workflow.fusion("planning", options).use(a, b);
  const done = workflow.complete("done", { output: fusion.output });
  workflow.startAt(fusion);
  workflow.sequence(fusion, done);
  const bundle = await compileWorkflow(workflow.build());
  const root = bundle.definitions[bundle.rootDefinitionId]!;
  expect(root.nodes.map((node) => [node.id, node.kind])).toEqual([
    ["done", "complete"],
    ["planning", "call"],
  ]);
  const child = bundle.definitions["fusion-builder:planning"]!;
  const agents = child.nodes.filter((node) => node.kind === "agent");
  expect(agents).toHaveLength(11);
  expect(agents.every((node) => node.fusion?.notesTransport === "auto")).toBe(true);
  expect(agents.filter((node) => node.fusion?.memberId === "a").map((node) => node.effort)).toEqual(
    Array(5).fill("low"),
  );
  expect(agents.find((node) => node.id === "synthesizer")?.effort).toBe("high");
  expect(
    agents
      .filter((node) => node.fusion?.memberId === "a")
      .map((node) => [node.modelId, node.uses, node.workspaceAccess]),
  ).toEqual(Array(5).fill(["a-model", ["repositoryScout"], "read-only"]));
  expect(child.scouts?.map((scout) => scout.id)).toEqual(["repositoryScout"]);
  const producers = (id: string) =>
    Object.fromEntries(
      child.nodes
        .find((node) => node.id === id)!
        .bindings.flatMap((binding) =>
          binding.source.kind === "producer" ? [[binding.targetPort, binding.source.sourceId]] : [],
        ),
    );
  expect(producers("a-review-2")).toEqual({ own: "a-revise-1", peer2: "b-revise-1" });
  expect(producers("a-revise-2")).toEqual({
    previous: "a-revise-1",
    review1: "a-review-2",
    review2: "b-review-2",
  });
  expect(producers("synthesizer")).toEqual({
    member1: "a-revise-2",
    member2: "b-revise-2",
    review1: "a-review-2",
    review2: "b-review-2",
  });
});

test("fusion validates rounds, ownership and unwired declarations before consuming agents", async () => {
  for (const rounds of [-1, 11, 1.5, NaN]) {
    const { workflow, options } = setup();
    expect(() => workflow.fusion("planning", { ...options, rounds })).toThrow(/rounds/);
  }
  for (const rounds of [0, 10]) {
    const { workflow, a, b, options } = setup();
    const fusion = workflow.fusion("planning", { ...options, rounds }).use(a, b);
    workflow.startAt(fusion);
    workflow.sequence(fusion, workflow.complete("done", { output: fusion.output }));
    const bundle = await compileWorkflow(workflow.build());
    expect(
      bundle.definitions["fusion-builder:planning"]!.nodes.filter((node) => node.kind === "agent"),
    ).toHaveLength(3 + rounds * 4);
  }
  const { workflow, a, b, options } = setup();
  const composition = workflow.fusion("planning", options);
  expect(() => composition.use(a, a)).toThrow(/distinct/);
  expect(() => composition.use(a, setup("foreign").b)).toThrow(/workflow/);
  expect(workflow.build().nodes).toHaveLength(3);
  composition.use(a, b);
  expect(() => composition.use(a, b)).toThrow(/already/);
  const wired = setup();
  wired.workflow.startAt(wired.a);
  expect(() => wired.workflow.fusion("planning", wired.options).use(wired.a, wired.b)).toThrow(
    /unwired/,
  );
});

test("native budgets survive fusion cloning and invalid or unsupported budgets fail compilation", async () => {
  const result = artifactType<{ summary: string }>("native-budget-report", { type: "object" });
  const workflow = new WorkflowBuilder({ id: "native-budget" });
  const task = workflow.input("task", { type: "string" });
  const a = workflow.agent("a", {
    prompt: "Research",
    harness: "claude",
    maxNativeTurns: 8,
    maxBudgetUsd: 0.5,
    produces: result,
  });
  const b = workflow.agent("b", { prompt: "Research", produces: result });
  const synthesis = workflow.agent("synthesis", { prompt: "Combine", produces: result });
  const fusion = workflow
    .fusion("fusion", {
      task,
      rounds: 1,
      reviewProduces: result,
      reviewPrompt: "Review",
      revisionPrompt: "Revise",
      synthesis,
      stopWhenUnanimous: false,
    })
    .use(a, b);
  workflow.startAt(fusion);
  workflow.sequence(fusion, workflow.complete("done", { output: fusion.output }));
  const bundle = await compileWorkflow(workflow.build());
  const agents = bundle.definitions["native-budget:fusion"]!.nodes.filter(
    (node) => node.kind === "agent",
  );
  expect(
    agents
      .filter((node) => node.fusion?.memberId === "a")
      .every((node) => node.maxNativeTurns === 8 && node.maxBudgetUsd === 0.5),
  ).toBe(true);
  expect(agents.every((node) => node.fusion?.stopWhenUnanimous === false)).toBe(true);
  for (const options of [
    { maxNativeTurns: 0 },
    { maxNativeTurns: 1.5 },
    { maxBudgetUsd: -1 },
    { harness: "codex" as const, maxNativeTurns: 8 },
  ]) {
    const invalid = new WorkflowBuilder({ id: "invalid-budget" });
    const agent = invalid.agent("agent", { prompt: "Research", ...options });
    invalid.startAt(agent);
    invalid.sequence(agent, invalid.complete("done"));
    await expect(compileWorkflow(invalid.build())).rejects.toThrow(/INVALID_NATIVE_BUDGET/);
  }
});
