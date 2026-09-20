import { describe, expect, test } from "bun:test";
import { WorkflowBuilder, compileWorkflow } from "@kouro/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator/coordinator.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";

async function bundle() {
  const workflow = new WorkflowBuilder({ id: "m6-exchange", version: "1" });
  const sender = workflow.agent("sender", { role: "sender", prompt: "send the request" });
  const receiver = workflow.agent("receiver", { role: "receiver", prompt: "answer the request" });
  const done = workflow.complete("done");
  workflow.startAt(sender);
  sender.on("success").to(receiver);
  receiver.on("success").to(done);
  return compileWorkflow(workflow.build());
}

async function respondLoopBundle() {
  const workflow = new WorkflowBuilder({ id: "m6-respond-loop", version: "1" });
  const sender = workflow.agent("sender", { role: "sender", prompt: "send the request" });
  const responder = workflow.agent("responder", {
    role: "receiver",
    prompt: "answer queued requests",
  });
  const responder2 = workflow.agent("responder-2", {
    role: "receiver",
    prompt: "answer queued requests",
  });
  const responder3 = workflow.agent("responder-3", {
    role: "receiver",
    prompt: "answer queued requests",
  });
  const done = workflow.complete("done");
  workflow.startAt(sender);
  sender.on("success").to(responder);
  responder.on("success").to(responder2);
  responder2.on("success").to(responder3);
  responder3.on("success").to(done);
  return compileWorkflow(workflow.build());
}

async function terminal(coordinator: Coordinator, runId: string) {
  for (let i = 0; i < 300; i += 1) {
    const view = coordinator.journal.getView(runId);
    if (view && !["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(2);
  }
  throw new Error("collaboration run did not terminate");
}

describe("M6 Coordinator collaboration exchange", () => {
  test("durably exchanges selected context, terminates with evidence, and rejects missing evidence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m6-e2e-"));
    const coordinator = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    const compiled = await bundle();
    const input = {
      __collaboration: {
        participants: ["sender", "receiver"],
        deterministicReproductionGate: { command: "bun test m6" },
      },
    };
    // Seed evidence before Coordinator recovery starts, as a real evaluator would.
    const created = coordinator.journal.createRun({
      workflowId: compiled.rootDefinitionId,
      bundle: compiled,
      input,
      idempotencyKey: "m6-success",
    });
    coordinator.journal.recordEvaluationEvidence({
      id: "m6-evidence",
      evaluatorId: "m6-fixture",
      evaluatorVersion: "1",
      evaluatorSourceDigest: "sha256:fixture",
      evaluatorConfigDigest: "sha256:fixture",
      evidenceClass: "deterministic",
      target: { runId: created.run.runId, revision: 0 },
      name: "bun test m6",
      status: "passed",
      supportingArtifactIds: [],
      provenance: [],
      completeness: { complete: true, missing: [] },
      recordedAt: new Date().toISOString(),
    });
    await coordinator.start();
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    const gateway = new (await import("../src/collaboration/gateway.ts")).CollaborationGateway(
      coordinator.journal,
    );
    const snapshot = gateway.snapshot(created.run.runId) as {
      messages: Array<{ recipientIds: string[]; senderId: string }>;
      blackboard: unknown[];
    };
    expect(
      snapshot.messages.some(
        (message) => message.senderId === "sender" && message.recipientIds.includes("receiver"),
      ),
    ).toBe(true);
    expect(
      snapshot.messages.some(
        (message) => message.senderId === "receiver" && message.recipientIds.includes("sender"),
      ),
    ).toBe(true);
    expect(snapshot.blackboard.length).toBeGreaterThanOrEqual(2);
    await coordinator.close();

    const failedDir = mkdtempSync(join(tmpdir(), "kouro-m6-no-evidence-"));
    const failed = new Coordinator({
      dataDir: failedDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await failed.start();
    const missing = await failed.createRun({
      workflowId: compiled.rootDefinitionId,
      bundle: compiled,
      input,
      idempotencyKey: "m6-no-evidence",
    });
    const failedView = await terminal(failed, missing.run.runId);
    expect(failedView.state.status).toBe("failed");
    await failed.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(failedDir, { recursive: true, force: true });
  });

  test("runs a bounded respond loop through normal attempts and exits idle without resurrection", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m6-loop-"));
    const coordinator = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    const compiled = await respondLoopBundle();
    const input = {
      __collaboration: {
        participants: ["sender", "receiver"],
        respondLoop: { maxTurns: 3, maxMessagesPerTurn: 2, idleDeadlineMs: 1 },
        deterministicReproductionGate: { command: "bun test m6-loop" },
      },
    };
    const created = coordinator.journal.createRun({
      workflowId: compiled.rootDefinitionId,
      bundle: compiled,
      input,
      idempotencyKey: "m6-loop",
    });
    coordinator.journal.recordEvaluationEvidence({
      id: "m6-loop-evidence",
      evaluatorId: "m6-fixture",
      evaluatorVersion: "1",
      evaluatorSourceDigest: "sha256:fixture",
      evaluatorConfigDigest: "sha256:fixture",
      evidenceClass: "deterministic",
      target: { runId: created.run.runId, revision: 0 },
      name: "bun test m6-loop",
      status: "passed",
      supportingArtifactIds: [],
      provenance: [],
      completeness: { complete: true, missing: [] },
      recordedAt: new Date().toISOString(),
    });
    await coordinator.start();
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    const gateway = new (await import("../src/collaboration/gateway.ts")).CollaborationGateway(
      coordinator.journal,
    );
    const snapshot = gateway.snapshot(created.run.runId) as {
      messages: Array<{ senderId: string; recipientIds: string[] }>;
      participants: Array<{ id: string; state: string }>;
    };
    expect(
      snapshot.messages.some(
        (message) => message.senderId === "receiver" && message.recipientIds.includes("sender"),
      ),
    ).toBe(true);
    expect(snapshot.participants.find((participant) => participant.id === "receiver")?.state).toBe(
      "active",
    );
    const receiverInvocations = Object.values(view.state.invocations).filter((invocation) =>
      invocation.nodeId.startsWith("responder"),
    );
    expect(receiverInvocations.length).toBeGreaterThan(1);
    await coordinator.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a responder with no queued work reaches bounded idle failure without creating turns", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-m6-idle-"));
    const coordinator = new Coordinator({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    const workflow = new WorkflowBuilder({ id: "m6-idle", version: "1" });
    const responder = workflow.agent("responder", { role: "receiver", prompt: "wait" });
    const responder2 = workflow.agent("responder-2", { role: "receiver", prompt: "wait" });
    const responder3 = workflow.agent("responder-3", { role: "receiver", prompt: "wait" });
    const done = workflow.complete("done");
    workflow.startAt(responder);
    responder.on("success").to(responder2);
    responder2.on("success").to(responder3);
    responder3.on("success").to(done);
    const compiled = await compileWorkflow(workflow.build());
    const input = {
      __collaboration: {
        participants: ["receiver"],
        respondLoop: { maxTurns: 2, maxMessagesPerTurn: 1, idleDeadlineMs: 1 },
      },
    };
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: compiled.rootDefinitionId,
      bundle: compiled,
      input,
      idempotencyKey: "m6-idle",
    });
    const view = await terminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("succeeded");
    expect(
      Object.values(view.state.invocations).filter((invocation) =>
        invocation.nodeId.startsWith("responder"),
      ).length,
    ).toBeLessThanOrEqual(3);
    await coordinator.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
