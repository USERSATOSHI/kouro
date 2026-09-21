import { afterEach, describe, expect, test } from "bun:test";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { Coordinator } from "../src/coordinator/coordinator.ts";
import { Journal } from "../src/storage/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function requiredTaskBundle() {
  const workflow = new WorkflowBuilder({ id: "task-required", version: "1" });
  const task = workflow.input(
    "task",
    artifactType<string>("task.v1", { type: "string", minLength: 1 }),
  );
  const agent = workflow.agent("planner", { role: "planner", prompt: "plan", input: { task } });
  const done = workflow.complete("done");
  workflow.startAt(agent);
  workflow.sequence(agent, done);
  return compileWorkflow(workflow.build());
}

describe("v1 capability recovery admission", () => {
  test("normalizes work-item task before persistence and validates it before workspace checks", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-admission-"));
    directories.push(dataDir);
    const coordinator = new Coordinator({ dataDir, scriptedDelayMs: 1 });
    const bundle = await requiredTaskBundle();

    await expect(
      coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        idempotencyKey: "missing-task",
        workspace: { repositoryPath: "/does/not/matter" },
      }),
    ).rejects.toThrow("Missing required workflow input task");
    expect(coordinator.journal.listRuns()).toHaveLength(0);

    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "task-run",
      input: {
        task: "  repair the parser  ",
        workItem: { version: 1, task: "repair the parser", source: "local" },
      },
    });
    expect(coordinator.journal.getRunInput(created.run.runId)).toMatchObject({
      task: "repair the parser",
      workItem: { version: 1, task: "repair the parser", source: "local" },
    });
    await coordinator.close();
  });

  test("rejects task conflicts, ticket-only admission, and reserved host fields", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-admission-"));
    directories.push(dataDir);
    const coordinator = new Coordinator({ dataDir, scriptedDelayMs: 1 });
    const bundle = await requiredTaskBundle();
    const request = (input: Record<string, unknown>) =>
      coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        idempotencyKey: crypto.randomUUID(),
        input,
      });

    await expect(request({ task: "one", workItem: { version: 1, task: "two" } })).rejects.toThrow(
      "task and workItem.task conflict",
    );
    await expect(
      request({ workItem: { version: 1, task: "one", ticket: { reference: "PROJ-1" } } }),
    ).rejects.toThrow("immutable snapshot");
    await expect(request({ task: "one", __kouroExecutionProfile: "pi-readonly" })).rejects.toThrow(
      "host-owned",
    );
    expect(coordinator.journal.listRuns()).toHaveLength(0);
    await coordinator.close();
  });

  test("includes the requested workspace and profile in idempotency identity", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-admission-"));
    directories.push(dataDir);
    const journal = new Journal({ dataDir });
    const bundle = await requiredTaskBundle();
    journal.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      input: { task: "one" },
      idempotencyKey: "same",
      executionProfile: "scripted",
      workspace: { repositoryPath: "/repo-a" },
    });
    expect(() =>
      journal.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        input: { task: "one" },
        idempotencyKey: "same",
        executionProfile: "scripted",
        workspace: { repositoryPath: "/repo-b" },
      }),
    ).toThrow("payload conflict");
    journal.close();
  });
});
