import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationService } from "../src/application/service.ts";
import { ExperimentService } from "../src/evaluations.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(stderr);
}

describe("M5 experiment orchestration", () => {
  test("fixture creates exactly 18 ordinary runs with immutable experiment attribution", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-eval-"));
    dirs.push(dataDir);
    const service = new ApplicationService({
      dataDir,
      scriptedDelayMs: 0,
      process: new FakeProcessAdapter(),
    });
    await service.start();
    const digest = (await service.tiny()).digest;
    await service.experiments.create(ExperimentService.reproducibleFixture(digest));
    await service.experiments.resume("fixture-3x3x2", { maxConcurrent: 6 });
    const experiment = service.experiments.get("fixture-3x3x2")!;
    expect(experiment.cells).toHaveLength(18);
    expect(experiment.cells.every((cell) => cell.runId)).toBe(true);
    expect(experiment.cells.every((cell) => cell.status === "succeeded")).toBe(true);
    expect(service.experiments.summary("fixture-3x3x2")).toMatchObject({
      total: 18,
      eligible: 18,
      sampleSize: 18,
      successRate: 1,
      missing: 0,
    });
    expect(service.listRuns()).toHaveLength(18);
    for (const cell of experiment.cells) {
      expect(service.coordinator.journal.getRunInput(cell.runId!)?.__experiment).toMatchObject({
        experimentId: "fixture-3x3x2",
        cellKey: cell.key,
        variantId: cell.variantId,
        repetition: cell.repetition,
        workflowDigest: digest,
      });
      expect(
        service
          .getEvaluationEvidence(cell.runId!, { experimentId: "fixture-3x3x2", cellKey: cell.key })
          .map((item) => item.name)
          .sort(),
      ).toEqual(["run.status", "workflow.behavior", "workflow.efficiency"].sort());
    }
    await service.close();
  });

  test("reservation recovery reuses one idempotent run and does not relaunch bound cells", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-eval-recovery-"));
    dirs.push(dataDir);
    const service = new ApplicationService({
      dataDir,
      scriptedDelayMs: 0,
      process: new FakeProcessAdapter(),
    });
    await service.start();
    const fixture = ExperimentService.reproducibleFixture((await service.tiny()).digest);
    const definition = {
      ...fixture,
      repetitions: 1,
      dataset: { ...fixture.dataset, cases: [fixture.dataset.cases[0]!] },
      variants: [fixture.variants[0]!],
    };
    await service.experiments.create(definition);
    const cell = service.experiments.get(definition.id)!.cells[0]!;
    service.coordinator.journal.reserveExperimentCell(
      definition.id,
      cell.key,
      `reservation:${definition.id}:${cell.key}`,
    );
    await service.close();
    const reopened = new ApplicationService({
      dataDir,
      scriptedDelayMs: 0,
      process: new FakeProcessAdapter(),
    });
    await reopened.start();
    await reopened.experiments.resume(definition.id);
    const first = reopened.experiments.get(definition.id)!.cells[0]!.runId;
    await reopened.close();
    const resumed = new ApplicationService({
      dataDir,
      scriptedDelayMs: 0,
      process: new FakeProcessAdapter(),
    });
    await resumed.start();
    await resumed.experiments.resume(definition.id);
    expect(resumed.experiments.get(definition.id)!.cells[0]!.runId).toBe(first);
    expect(resumed.listRuns()).toHaveLength(1);
    await resumed.close();
  });

  test("cancel marks queued cells while an ordinary active run remains inspectable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-eval-cancel-"));
    dirs.push(dataDir);
    const service = new ApplicationService({
      dataDir,
      scriptedDelayMs: 100,
      process: new FakeProcessAdapter(),
    });
    await service.start();
    const fixture = ExperimentService.reproducibleFixture((await service.tiny()).digest);
    const definition = { ...fixture, repetitions: 1 };
    await service.experiments.create(definition);
    const resume = service.experiments.resume(definition.id, { maxConcurrent: 1 });
    await Bun.sleep(10);
    service.experiments.cancel(definition.id);
    await resume;
    const snapshot = service.experiments.get(definition.id)!;
    expect(snapshot.cells.some((cell) => cell.status === "cancelled")).toBe(true);
    expect(service.listRuns().length).toBeGreaterThan(0);
    await service.close();
  });

  test("runs pinned acceptance outside the candidate tree and records its evidence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-acceptance-data-"));
    dirs.push(dataDir);
    const repository = mkdtempSync(join(tmpdir(), "kouro-acceptance-repo-"));
    dirs.push(repository);
    await git(repository, ["init", "--initial-branch=main"]);
    writeFileSync(join(repository, "agent-test.sh"), "echo agent-editable\n");
    await git(repository, ["add", "."]);
    await git(repository, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "base",
    ]);
    const service = new ApplicationService({
      dataDir,
      scriptedDelayMs: 0,
      process: new FakeProcessAdapter(),
    });
    await service.start();
    const fixture = ExperimentService.reproducibleFixture((await service.tiny()).digest);
    const definition = {
      ...fixture,
      repositoryPath: repository,
      repetitions: 1,
      dataset: {
        ...fixture.dataset,
        cases: [
          {
            id: "acceptance",
            input: { task: "acceptance" },
            acceptance: {
              id: "pinned-acceptance",
              version: "1",
              source: "PINNED-ACCEPTANCE",
              executable: "sh",
              args: [
                "-c",
                'test -f "$KOURO_ACCEPTANCE_SOURCE" && test "$(cat "$KOURO_ACCEPTANCE_SOURCE")" = PINNED-ACCEPTANCE && test -f agent-test.sh',
              ],
            },
          },
        ],
      },
      variants: [fixture.variants[0]!],
    };
    await service.experiments.create(definition);
    await service.experiments.resume(definition.id);
    const cell = service.experiments.get(definition.id)!.cells[0]!;
    const evidence = service.getEvaluationEvidence(cell.runId!, {
      experimentId: definition.id,
      cellKey: cell.key,
    });
    expect(evidence.find((item) => item.evaluatorId === "pinned-acceptance")?.status).toBe(
      "passed",
    );
    expect(
      evidence.find((item) => item.evaluatorId === "pinned-acceptance")?.target.treeDigest,
    ).toBeTruthy();
    await service.close();
  });

  test("scripted judge is a linked ordinary run with separate opinion evidence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-eval-judge-"));
    dirs.push(dataDir);
    const service = new ApplicationService({
      dataDir,
      scriptedDelayMs: 0,
      process: new FakeProcessAdapter(),
    });
    await service.start();
    const fixture = ExperimentService.reproducibleFixture((await service.tiny()).digest);
    const definition = {
      ...fixture,
      repetitions: 1,
      dataset: { ...fixture.dataset, cases: [fixture.dataset.cases[0]!] },
      variants: [fixture.variants[0]!],
    };
    await service.experiments.create(definition);
    await service.experiments.resume(definition.id, { maxConcurrent: 1 });
    const candidate = service.experiments.get(definition.id)!.cells[0]!;
    const judge = await service.experiments.runScriptedJudge({
      experimentId: definition.id,
      cellKey: candidate.key,
      candidateRunId: candidate.runId!,
    });
    expect(service.listRuns()).toHaveLength(2);
    expect(service.coordinator.journal.getRunInput(judge.runId)?.__judge).toBeTruthy();
    expect(
      service.getEvaluationEvidence(judge.runId, {
        experimentId: definition.id,
        cellKey: candidate.key,
      })[0]?.evidenceClass,
    ).toBe("judge-opinion");
    await service.close();
  });
});
