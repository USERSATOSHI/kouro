import { expect, test } from "bun:test";
import {
  artifactType,
  compileWorkflow,
  ReasoningEffort,
  type ReasoningEffortValue,
  WorkflowBuilder,
} from "../src";

const report = artifactType<{ summary: string }>("effort-report", {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
});

function workflow(effort?: ReasoningEffortValue) {
  const builder = new WorkflowBuilder({ id: "effort" });
  const scout = builder.subagent("scout", {
    prompt: "inspect",
    produces: report,
    effort: ReasoningEffort.LOW,
  });
  const agent = builder.agent("agent", { prompt: "plan", effort, uses: [scout] });
  builder.startAt(agent);
  builder.sequence(agent, builder.complete("done"));
  return builder.build();
}

test("effort survives agent and subagent compilation and changes the pinned digest", async () => {
  const defaultBundle = await compileWorkflow(workflow());
  const configured = await compileWorkflow(workflow(ReasoningEffort.HIGH));
  expect(configured.digest).toBe((await compileWorkflow(workflow("high"))).digest);
  expect(configured.digest).not.toBe(defaultBundle.digest);
  const root = configured.definitions[configured.rootDefinitionId]!;
  expect(root.nodes.find((node) => node.kind === "agent")).toMatchObject({ effort: "high" });
  expect(defaultBundle.definitions[defaultBundle.rootDefinitionId]!.nodes[0]).not.toHaveProperty(
    "effort",
  );
  const child = configured.definitions[root.scouts![0]!.definitionId]!;
  expect(child.nodes.find((node) => node.kind === "agent")).toMatchObject({ effort: "low" });
  expect(JSON.parse(configured.canonicalJson).definitions[root.id].nodes).toEqual(root.nodes);
});

test("compiler rejects malformed and unsupported efforts in plain authoring sources", async () => {
  for (const [harness, effort] of [
    ["codex", "huge"],
    ["claude", "minimal"],
    ["pi", "ultra"],
    ["opencode", "high"],
  ]) {
    const source = workflow();
    const node = source.nodes.find((node) => node.kind === "agent")!;
    Object.assign(node, { harness, effort });
    await expect(compileWorkflow(source)).rejects.toThrow(/reasoning effort|Reasoning effort/);
  }
});
