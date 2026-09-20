import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "../src/storage/journal.ts";
import { createCheckpointCut, type CheckpointInput } from "@kouro/core";
import { WorkflowBuilder, compileWorkflow } from "@kouro/core";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const workflow = new WorkflowBuilder({ id: "checkpoint-journal" });
  const done = workflow.complete("done");
  workflow.startAt(done);
  const bundle = await compileWorkflow(workflow.build());
  const dir = mkdtempSync(join(tmpdir(), "kouro-m7-journal-"));
  dirs.push(dir);
  const journal = new Journal({ dataDir: dir });
  const run = journal.createRun({
    workflowId: "checkpoint-journal",
    bundle,
    idempotencyKey: "run",
  }).run;
  return { journal, run, bundle };
}

describe("M7 durable checkpoint records", () => {
  test("fork materialization carries spent root repair counters", async () => {
    const { journal, run, bundle } = await fixture();
    journal.append({
      runId: run.runId,
      type: "run.started",
      payload: { rootScopeId: `${run.runId}:root`, rootDefinitionId: bundle.rootDefinitionId },
    });
    journal.append({
      runId: run.runId,
      type: "counter.incremented",
      payload: { scopeId: `${run.runId}:root`, counterId: "repairs", value: 1 },
    });
    const child = journal.createRun({
      workflowId: "checkpoint-journal",
      bundle,
      idempotencyKey: "child",
    }).run;
    journal.materializeInheritedPrefix(child.runId, run.runId, [], [], {
      [`${run.runId}:root:repairs`]: 1,
    });
    expect(journal.getView(child.runId)?.state.counters[`${child.runId}:root:repairs`]).toBe(1);
    expect(journal.getView(child.runId)?.state.attempts).toEqual({});
    journal.close();
  });

  test("checkpoint and fork preparation records are idempotent", async () => {
    const { journal, run, bundle } = await fixture();
    const input: CheckpointInput = {
      runId: run.runId,
      revision: 0,
      eventCursor: 0,
      status: "paused",
      admissionPaused: true,
      bundleDigest: bundle.digest,
      configDependencyDigest: "sha256:config",
      artifacts: { verified: true, roots: [] },
      workspace: { verified: true, treeDigest: "tree", roots: ["tree"] },
      completedInvocationIds: [],
    };
    const certificate = await createCheckpointCut(input, "cp-1");
    expect(journal.saveCheckpoint(certificate)).toEqual(certificate);
    expect(journal.saveCheckpoint(certificate)).toEqual(certificate);
    const record = journal.recordCheckpointOperation({
      id: "op-1",
      checkpointId: "cp-1",
      kind: "fork.preparation",
      requestKey: "req-1",
      record: { childRunId: "child" },
    });
    expect(
      journal.recordCheckpointOperation({
        id: "op-2",
        checkpointId: "cp-1",
        kind: "fork.preparation",
        requestKey: "req-1",
        record: { childRunId: "child" },
      }),
    ).toEqual(record);
    expect(() =>
      journal.recordCheckpointOperation({
        id: "op-3",
        checkpointId: "cp-1",
        kind: "fork.preparation",
        requestKey: "req-1",
        record: { childRunId: "other" },
      }),
    ).toThrow(/conflict/);
    journal.close();
  });
});
