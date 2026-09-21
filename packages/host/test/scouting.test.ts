import { expect, test } from "bun:test";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { ScoutGateway } from "../src/scouting/gateway.ts";
import { Journal } from "../src/storage/journal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("bounded scout gateway keeps request identity, typed results, delivery, and budget across restart", async () => {
  const report = artifactType<{ summary: string }>("scout-report", {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: { summary: { type: "string", minLength: 1 } },
  });
  const taskSchema = artifactType<string>("task", { type: "string", minLength: 1 });
  const questionSchema = artifactType<string>("question", { type: "string", minLength: 1 });

  const root = new WorkflowBuilder({ id: "workflow", version: "1" });
  const rootTask = root.input("task", taskSchema);
  const implementer = root.agent("implementer", {
    role: "implementer",
    prompt: "implement",
    input: { task: rootTask },
  });
  const done = root.complete("done");
  root.startAt(implementer);
  implementer.on("success").to(done);
  root.subagent("repository", {
    role: "scout",
    prompt: "inspect",
    input: { task: taskSchema, question: questionSchema },
    produces: report,
  });
  const bundle = await compileWorkflow(root.build());
  const dataDir = mkdtempSync(join(tmpdir(), "kouro-scout-"));
  const journal = new Journal({ dataDir });
  const run = journal.createRun({
    workflowId: "workflow",
    bundle,
    input: { task: "inspect parser" },
    idempotencyKey: "run",
  });
  journal.append({
    runId: run.run.runId,
    type: "run.started",
    payload: { rootScopeId: "root", rootDefinitionId: "workflow" },
  });
  journal.append({
    runId: run.run.runId,
    type: "invocation.created",
    payload: { invocationId: "implementer-inv", scopeId: "root", nodeId: "implementer" },
  });
  journal.append({
    runId: run.run.runId,
    type: "attempt.reserved",
    payload: { attemptId: "implementer-attempt", invocationId: "implementer-inv" },
  });
  journal.append({
    runId: run.run.runId,
    type: "attempt.started",
    payload: { attemptId: "implementer-attempt" },
  });

  const gateway = new ScoutGateway(journal);
  const request = gateway.request({
    runId: run.run.runId,
    parentInvocationId: "implementer-inv",
    parentAttemptId: "implementer-attempt",
    requestId: "scout-1",
    scoutId: "repository",
    question: "Find parser invariants",
    input: { task: "inspect parser", question: "Find parser invariants" },
  });
  expect(
    gateway.request({
      runId: run.run.runId,
      parentInvocationId: "implementer-inv",
      parentAttemptId: "implementer-attempt",
      requestId: "scout-1",
      scoutId: "repository",
      question: "Find parser invariants",
      input: { task: "inspect parser", question: "Find parser invariants" },
    }),
  ).toEqual(request);
  gateway.claim(run.run.runId, "scout-1");
  expect(gateway.complete(run.run.runId, "scout-1", { summary: "parser invariant" }).state).toBe(
    "succeeded",
  );
  const delivered = gateway.deliver(run.run.runId, "scout-1", "implementer-attempt");
  expect(delivered.manifest.source).toBe("scout-result");
  expect(delivered.result).toEqual({ summary: "parser invariant" });

  journal.close();
  const reopened = new Journal({ dataDir });
  const afterRestart = new ScoutGateway(reopened);
  expect(afterRestart.deliver(run.run.runId, "scout-1", "implementer-attempt")).toEqual(delivered);
  afterRestart.request({
    runId: run.run.runId,
    parentInvocationId: "implementer-inv",
    parentAttemptId: "implementer-attempt",
    requestId: "scout-2",
    scoutId: "repository",
    question: "Find test coverage",
    input: { task: "inspect parser", question: "Find test coverage" },
  });
  expect(() =>
    afterRestart.request({
      runId: run.run.runId,
      parentInvocationId: "implementer-inv",
      parentAttemptId: "implementer-attempt",
      requestId: "scout-3",
      scoutId: "repository",
      question: "Find risks",
      input: { task: "inspect parser", question: "Find risks" },
    }),
  ).toThrow("budget exceeded");
  reopened.close();
  rmSync(dataDir, { recursive: true, force: true });
});
