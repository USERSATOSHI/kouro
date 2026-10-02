import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationService } from "../src/application/service";
import { compileSwarm, normalizeSwarmModels } from "../src/application/swarm";
import { createHostServer } from "../src/http/server";
import { prepareSwarmProviderFixture } from "../../../scripts/swarm-provider-fixture";

async function terminal(service: ApplicationService, runId: string) {
  for (let index = 0; index < 300; index++) {
    const view = service.getView(runId)!;
    if (!["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(10);
  }
  throw new Error("swarm did not finish");
}

test("swarm accepts a variable model list and preserves explicit harness/model bindings", async () => {
  for (const count of [1, 3, 8]) {
    const models = Array.from({ length: count }, (_, index) => ({
      harness: "pi" as const,
      modelId: `provider/model-${index}`,
    }));
    const bundle = await compileSwarm(models);
    const root = bundle.definitions[bundle.rootDefinitionId]!;
    const members = root.nodes
      .filter((node) => node.kind === "agent")
      .filter((node) => node.id !== "synthesis");
    expect(members.map((node) => [node.harness, node.modelId])).toEqual(
      models.map((model) => [model.harness, model.modelId]),
    );
    const synthesis = root.nodes.find((node) => node.id === "synthesis");
    expect(Boolean(synthesis)).toBe(count > 1);
    if (synthesis)
      expect(
        synthesis.bindings.flatMap((binding) =>
          binding.source.kind === "producer" ? [binding.source.sourceId] : [],
        ),
      ).toEqual(members.map((node) => node.id));
  }
  for (const models of [
    [],
    Array(9).fill({ harness: "pi", modelId: "m" }),
    [{ harness: "scripted", modelId: "m" }],
    [{ harness: "pi", modelId: " " }],
  ])
    expect(() => normalizeSwarmModels(models)).toThrow();
});

test("swarm HTTP admission, parallel results, synthesis, cancellation and reload are durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kouro-swarm-test-"));
  const prior = process.env.KOURO_OPENCODE_BIN;
  process.env.KOURO_OPENCODE_BIN = await prepareSwarmProviderFixture(directory);
  let service = new ApplicationService({
    dataDir: join(directory, "data"),
    scriptedDelayMs: 0,
  });
  await service.start();
  try {
    const host = createHostServer(service, { token: "swarm-test" });
    const origin = "http://127.0.0.1:43127";
    const paired = await host.app.handle(
      new Request(`${origin}/api/session`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "swarm-test" }),
      }),
    );
    const cookie = paired.headers.get("set-cookie")!;
    const { csrfToken } = (await paired.json()) as { csrfToken: string };
    const post = (body: unknown, csrf = csrfToken) =>
      host.app.handle(
        new Request(`${origin}/api/swarms`, {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify(body),
        }),
      );
    const models = [
      { harness: "opencode", modelId: "first" },
      { harness: "opencode", modelId: "second" },
    ];
    const request = { models, task: "inspect the task", idempotencyKey: "swarm-http" };
    expect((await post(request, "wrong-token")).status).toBe(403);
    for (const invalid of [
      { ...request, models: [] },
      { ...request, task: " " },
      { ...request, workspace: {} },
    ])
      expect((await post(invalid)).status).toBe(400);
    const response = await post(request);
    expect(response.status).toBe(200);
    const { id: runId } = (await response.json()) as { id: string };
    expect((await (await post(request)).json()).id).toBe(runId);
    expect((await post({ ...request, task: "changed task" })).status).toBe(400);
    const view = await terminal(service, runId);
    expect(view.state.status).toBe("succeeded");
    const memberAttempts = Object.values(view.state.attempts).filter((attempt) =>
      attempt.resolvedExecution?.role.startsWith("swarm-member-"),
    );
    expect(memberAttempts).toHaveLength(2);
    expect(Math.max(...memberAttempts.map((item) => Date.parse(item.startedAt!)))).toBeLessThan(
      Math.min(...memberAttempts.map((item) => Date.parse(item.finishedAt!))),
    );
    const snapshot = service.collaboration(runId) as any;
    expect(snapshot.participants.map((item: any) => [item.model, item.state])).toEqual([
      ["first", "succeeded"],
      ["second", "succeeded"],
    ]);
    expect(snapshot.results.find((item: any) => item.final).body).toBe(
      "member1: first: inspect the task\nmember2: second: inspect the task",
    );
    const failed = await service.createSwarm({
      models: [{ harness: "opencode", modelId: "fail" }, models[1]!],
      task: "fail task",
      idempotencyKey: "swarm-failure",
    });
    const failedView = await terminal(service, failed.runId);
    expect(failedView.state.status).toBe("failed");
    expect(
      Object.values(failedView.state.attempts).some(
        (attempt) => attempt.resolvedExecution?.role === "swarm-synthesis",
      ),
    ).toBe(false);
    const slow = await service.createSwarm({
      models: [{ harness: "opencode", modelId: "slow" }],
      task: "cancel task",
      idempotencyKey: "swarm-cancel",
    });
    for (
      let count = 0;
      count < 100 &&
      !Object.values(service.getView(slow.runId)!.state.attempts).some(
        (attempt) => attempt.status === "running",
      );
      count++
    )
      await Bun.sleep(10);
    service.control({
      runId: slow.runId,
      action: "cancel",
      expectedRevision: service.getView(slow.runId)!.revision,
      actor: "test",
      idempotencyKey: "cancel",
    });
    expect((await terminal(service, slow.runId)).state.status).toBe("cancelled");
    await service.close();
    service = new ApplicationService({ dataDir: join(directory, "data") });
    await service.start();
    expect(service.collaboration(runId)).toEqual(snapshot);
  } finally {
    await service.close();
    if (prior === undefined) delete process.env.KOURO_OPENCODE_BIN;
    else process.env.KOURO_OPENCODE_BIN = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
