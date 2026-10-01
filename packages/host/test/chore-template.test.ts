import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.ts";
import { ApplicationService } from "../src/application/service.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";
import { ScriptedHarnessAdapter } from "../src/adapters/harness/scripted.ts";
import type { HarnessAdapter } from "../src/types.ts";

test("scaffolded chore delivers scout reports through change and validation, and blocks a missing required scout", async () => {
  const templateRoot = mkdtempSync(resolve(".kouro", ".chore-test-"));
  const dataDir = mkdtempSync(join(tmpdir(), "kouro-chore-test-"));
  const scripted = new ScriptedHarnessAdapter();
  const turns: Array<Parameters<HarnessAdapter["run"]>[0]> = [];
  let skipScouts = false;
  const harness: HarnessAdapter = {
    id: scripted.id,
    adapterVersion: scripted.adapterVersion,
    capabilities: () => scripted.capabilities(),
    async run(input) {
      turns.push(input);
      if (skipScouts)
        return {
          status: "succeeded",
          output: { summary: "No scout requested" },
          events: [],
          usage: { quality: "unavailable" },
        };
      return scripted.run(input);
    },
  };
  const service = new ApplicationService({
    dataDir,
    templateRoot,
    harness,
    process: new FakeProcessAdapter(),
    scriptedDelayMs: 0,
  });
  try {
    expect(
      await main([
        "create",
        "template",
        "test-chore",
        "--template",
        "chore",
        "--output",
        templateRoot,
      ]),
    ).toBe(0);
    await service.start();
    const template = (await service.workflows()).find((entry) => entry.id === "test-chore")!;
    expect(template.version).toBe("2");
    const execute = async (key: string) => {
      const { run } = await service.coordinator.createRun({
        workflowId: template.id,
        bundle: template.bundle,
        input: { task: "Document current Kouro behavior" },
        idempotencyKey: key,
        actor: "test",
      });
      const deadline = Date.now() + 5000;
      while (
        ["pending", "running"].includes(service.getView(run.runId)!.state.status) &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      return service.getView(run.runId)!;
    };
    const success = await execute("with-scouts");
    expect({
      status: success.state.status,
      errors: Object.values(success.state.attempts)
        .map((attempt) => attempt.error)
        .filter(Boolean),
      turns: turns.map((turn) => turn.role),
    }).toMatchObject({ status: "succeeded" });
    expect(turns.map((turn) => turn.role)).toEqual([
      "chore-planner",
      "repository-scout",
      "test-scout",
      "chore-worker",
      "chore-validator",
    ]);
    for (const role of ["chore-worker", "chore-validator"]) {
      const turn = turns.find((candidate) => candidate.role === role)!;
      for (const port of ["repositoryReports", "testReports"]) {
        const segment = turn.context!.segments.find((item) => item.id.endsWith(`:${port}`))!;
        expect(JSON.parse(segment.content)).toHaveLength(1);
      }
    }
    expect(service.scouts(success.state.runId).map((request) => request.state)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    turns.length = 0;
    skipScouts = true;
    const blocked = await execute("without-required-scout");
    expect(blocked.state.status).toBe("failed");
    expect(turns.map((turn) => turn.role)).toEqual(["chore-planner"]);
    expect(
      Object.values(blocked.state.attempts).some((attempt) =>
        attempt.error?.includes("required scout repositoryScout was not requested"),
      ),
    ).toBe(true);
  } finally {
    await service.close();
    rmSync(templateRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
