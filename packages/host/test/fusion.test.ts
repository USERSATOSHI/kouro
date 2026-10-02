import { expect, test } from "bun:test";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { mkdtemp, rm } from "node:fs/promises";
import { ApplicationService, configureBundle } from "../src/application/service";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap";
import { fusionFixture, FusionFixtureHarness } from "../../../scripts/fusion-fixture";

async function terminal(service: ApplicationService, runId: string) {
  for (let count = 0; count < 500; count++) {
    const view = service.getView(runId)!;
    if (!["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(10);
  }
  throw new Error("fusion fixture did not finish");
}

test("fusion runs parallel drafts, reviews and revisions with stage barriers, final inputs and reload", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-fusion-");
  const harness = new FusionFixtureHarness();
  let service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
  await service.start();
  try {
    const source = await fusionFixture();
    const configured = await configureBundle(source, {
      "fusion-fixture:planning/planner-a": { modelId: "chosen-a", harness: "pi" },
    });
    const configuredAgents = configured.definitions["fusion-fixture:planning"]!.nodes.filter(
      (node) => node.kind === "agent",
    );
    expect(
      configuredAgents
        .filter((node) => node.fusion?.memberId === "planner-a")
        .map((node) => [node.modelId, node.harness]),
    ).toEqual(Array(5).fill(["chosen-a", "pi"]));
    expect(
      source.definitions["fusion-fixture:planning"]!.nodes.filter(
        (node) => node.kind === "agent",
      ).find((node) => node.id === "planner-a")?.modelId,
    ).toBe("model-a");
    expect(configuredAgents.find((node) => node.id === "fusion")?.modelId).toBe("model-fusion");
    const run = await service.coordinator.createRun({
      workflowId: source.rootDefinitionId,
      bundle: source,
      input: { task: "Compare approaches" },
      idempotencyKey: "fusion",
    });
    const view = await terminal(service, run.run.runId);
    expect(view.state.status).toBe("succeeded");
    expect(harness.calls).toHaveLength(11);
    for (const call of harness.calls.filter((call) => call.stage === "review")) {
      const previous = call.round === 1 ? "draft round 0: Compare approaches" : "revision round 1";
      expect(call.values.own.summary).toBe(`${call.model} ${previous}`);
      const peer = call.model === "model-a" ? "model-b" : "model-a";
      expect(call.values[call.model === "model-a" ? "peer2" : "peer1"].summary).toBe(
        `${peer} ${previous}`,
      );
    }
    for (const call of harness.calls.filter((call) => call.stage === "revision")) {
      expect(call.values.review1.summary).toBe(`model-a review round ${call.round}`);
      expect(call.values.review2.summary).toBe(`model-b review round ${call.round}`);
    }
    expect(harness.calls.at(-1)!.values.member1.summary).toBe("model-a revision round 2");
    expect(harness.calls.at(-1)!.values.member2.summary).toBe("model-b revision round 2");
    const attempts = Object.values(view.state.attempts);
    const stages = Array.from({ length: 5 }, (_, index) =>
      harness.calls.filter(
        (call) =>
          call.stage === (index === 0 ? "draft" : index % 2 ? "review" : "revision") &&
          call.round === Math.ceil(index / 2),
      ),
    );
    let previousEnd = 0;
    for (const stage of stages) {
      const pair = stage.map((call) =>
        attempts.find((attempt) => attempt.invocationId === call.invocationId)!,
      );
      const start = Math.min(...pair.map((attempt) => Date.parse(attempt.startedAt!)));
      const end = Math.max(...pair.map((attempt) => Date.parse(attempt.finishedAt!)));
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      expect(Math.max(...pair.map((attempt) => Date.parse(attempt.startedAt!)))).toBeLessThan(
        Math.min(...pair.map((attempt) => Date.parse(attempt.finishedAt!))),
      );
      previousEnd = end;
    }
    const synthesis = Object.values(view.state.invocations).find(
      (invocation) => invocation.nodeId === "fusion",
    )!;
    expect(
      JSON.parse(new TextDecoder().decode(service.readArtifact(synthesis.output[0]!.id))).summary,
    ).toBe("Combined: model-a revision round 2; model-b revision round 2");
    const call = Object.values(view.state.invocations).find(
      (invocation) =>
        invocation.scopeId === view.state.rootScopeId && invocation.nodeId === "planning",
    )!;
    expect(call.output).toEqual(synthesis.output);
    const persisted = JSON.stringify(view.state);
    await service.close();
    service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
    await service.start();
    expect(JSON.stringify(service.getView(run.run.runId)!.state)).toBe(persisted);
    expect(harness.calls).toHaveLength(11);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("review failure drains the other model and cancellation prevents later rounds", async () => {
  for (const mode of ["fail-review", "slow-review"] as const) {
    const dataDir = await mkdtemp("/tmp/kouro-fusion-stop-");
    const harness = new FusionFixtureHarness(mode);
    const service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
    await service.start();
    try {
      const bundle = await fusionFixture();
      const run = await service.coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        input: { task: "Stop review" },
        idempotencyKey: mode,
      });
      if (mode === "slow-review") {
        for (
          let count = 0;
          count < 300 && harness.calls.filter((call) => call.stage === "review").length < 2;
          count++
        )
          await Bun.sleep(10);
        expect(harness.calls.filter((call) => call.stage === "review")).toHaveLength(2);
        service.control({
          runId: run.run.runId,
          action: "cancel",
          expectedRevision: service.getView(run.run.runId)!.revision,
          actor: "test",
          idempotencyKey: "cancel",
        });
      }
      const view = await terminal(service, run.run.runId);
      expect(view.state.status).toBe(mode === "fail-review" ? "failed" : "cancelled");
      expect(
        harness.calls.some((call) => call.stage === "revision" || call.stage === "synthesis"),
      ).toBe(false);
      expect(
        Object.values(view.state.attempts).some((attempt) => attempt.status === "cancelled"),
      ).toBe(true);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("composed agents retain producer context and the shared task across call scopes", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-fusion-context-");
  const harness = new FusionFixtureHarness();
  const service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
  await service.start();
  try {
    const report = artifactType<{ summary: string }>("fusion-context", {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    });
    const workflow = new WorkflowBuilder({ id: "fusion-context" });
    const seed = workflow.agent("seed", {
      prompt: "draft",
      modelId: "seed-model",
      produces: report,
    });
    const a = workflow.agent("a", {
      prompt: "draft",
      modelId: "model-a",
      produces: report,
      input: { context: seed.output },
    });
    const b = workflow.agent("b", {
      prompt: "draft",
      modelId: "model-b",
      produces: report,
      input: { context: seed.output },
    });
    const synthesizer = workflow.agent("synthesizer", {
      prompt: "combine",
      modelId: "model-fusion",
      produces: report,
      input: { context: seed.output },
    });
    const fusion = workflow
      .fusion("planning", {
        task: "Shared literal task",
        rounds: 1,
        reviewProduces: report,
        reviewPrompt: "review",
        revisionPrompt: "revision",
        synthesis: synthesizer,
      })
      .use(a, b);
    workflow.startAt(seed);
    workflow.sequence(seed, fusion, workflow.complete("done", { output: fusion.output }));
    const bundle = await compileWorkflow(workflow.build());
    const run = await service.coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "context",
    });
    expect((await terminal(service, run.run.runId)).state.status).toBe("succeeded");
    expect(harness.calls).toHaveLength(8);
    for (const call of harness.calls.slice(1)) {
      expect(call.values.task).toBe("Shared literal task");
      expect(call.values.context.summary).toBe("seed-model draft round 0: undefined");
    }
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
