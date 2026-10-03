import { expect, test } from "bun:test";
import { artifactType, CAPABILITY, compileWorkflow, WorkflowBuilder } from "@kouro/core";
import { configureBundle } from "../src/application/service.ts";

test("duplicate child node IDs have independent model settings and retain read-only access", async () => {
  const report = artifactType<{ summary: string }>("settings-report", {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  });
  const builder = new WorkflowBuilder({ id: "settings-parent" });
  const first = builder.subagent("first", { prompt: "first", produces: report });
  const second = builder.subagent("second", { prompt: "second", produces: report });
  const parent = builder.agent("subagent", {
    prompt: "parent",
    effort: "medium",
    produces: report,
    uses: [first, second],
  });
  builder.startAt(parent);
  builder.sequence(parent, builder.complete("done"));
  const source = await compileWorkflow(builder.build());
  const root = source.definitions[source.rootDefinitionId]!;
  const firstId = root.scouts!.find((scout) => scout.id === "first")!.definitionId;
  const secondId = root.scouts!.find((scout) => scout.id === "second")!.definitionId;
  const bundle = await configureBundle(source, {
    [`${source.rootDefinitionId}/subagent`]: { modelId: "parent-model", effort: "high" },
    [`${firstId}/subagent`]: {
      harness: "codex",
      modelId: "first-model",
      effort: "low",
      capabilities: [CAPABILITY.REPOSITORY_READ],
    },
    [`${secondId}/subagent`]: { harness: "pi", modelId: "second-model" },
  });
  expect(
    bundle.definitions[source.rootDefinitionId]!.nodes.find((node) => node.kind === "agent")
      ?.modelId,
  ).toBe("parent-model");
  expect(bundle.definitions[firstId]!.nodes.find((node) => node.kind === "agent")?.modelId).toBe(
    "first-model",
  );
  expect(bundle.definitions[secondId]!.nodes.find((node) => node.kind === "agent")?.modelId).toBe(
    "second-model",
  );
  expect(
    source.definitions[firstId]!.nodes.find((node) => node.kind === "agent")?.modelId,
  ).toBeUndefined();
  expect(bundle.digest).not.toBe(source.digest);
  expect(
    bundle.definitions[source.rootDefinitionId]!.nodes.find((node) => node.kind === "agent")
      ?.effort,
  ).toBe("high");
  expect(bundle.definitions[firstId]!.nodes.find((node) => node.kind === "agent")?.effort).toBe(
    "low",
  );
  expect(
    bundle.definitions[secondId]!.nodes.find((node) => node.kind === "agent")?.effort,
  ).toBeUndefined();
  expect(bundle.digest).toBe(
    (
      await configureBundle(source, {
        [`${secondId}/subagent`]: { harness: "pi", modelId: "second-model" },
        [`${firstId}/subagent`]: {
          capabilities: [CAPABILITY.REPOSITORY_READ],
          modelId: "first-model",
          effort: "low",
          harness: "codex",
        },
        [`${source.rootDefinitionId}/subagent`]: { modelId: "parent-model", effort: "high" },
      })
    ).digest,
  );
  await expect(configureBundle(source, { subagent: { modelId: "ambiguous" } })).rejects.toThrow(
    /Ambiguous/,
  );
  await expect(
    configureBundle(source, {
      [`${firstId}/subagent`]: { capabilities: [CAPABILITY.REPOSITORY_WRITE] },
    }),
  ).rejects.toThrow(/read-only/);
  await expect(configureBundle(source, { missing: { modelId: "invalid" } })).rejects.toThrow(
    /Unknown/,
  );
  const legacy = await configureBundle(source, { [`${firstId}/subagent`]: { modelId: "first" } });
  expect(
    legacy.definitions[secondId]!.nodes.find((node) => node.kind === "agent")?.modelId,
  ).toBeUndefined();
  const cleared = await configureBundle(source, {
    [`${source.rootDefinitionId}/subagent`]: { effort: null },
  });
  expect(
    cleared.definitions[source.rootDefinitionId]!.nodes.find((node) => node.kind === "agent"),
  ).not.toHaveProperty("effort");
  for (const setting of [
    { effort: "invalid" },
    { harness: "pi", effort: "ultra" },
    { harness: "opencode", effort: "low" },
  ])
    await expect(
      configureBundle(source, { [`${source.rootDefinitionId}/subagent`]: setting as never }),
    ).rejects.toThrow(/reasoning effort|Reasoning effort/);
});
