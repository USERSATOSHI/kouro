import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../src/application/service.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";
import { createHostServer } from "../src/http/server.ts";
import type { ProcessAdapter } from "../src/types.ts";
import type { HarnessAdapter } from "../src/types.ts";
import { CAPABILITY, WorkflowBuilder, compileWorkflow } from "@kouro/core";

const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "kouro-host-test-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function waitForTerminal(service: ApplicationService, runId: string) {
  for (let count = 0; count < 200; count += 1) {
    const view = service.getView(runId);
    if (view && !["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(5);
  }
  throw new Error("run did not reach a terminal state");
}

async function fixtureRepository(): Promise<string> {
  const repository = mkdtempSync(join(tmpdir(), "kouro-repo-e2e-"));
  mkdirSync(join(repository, ".git"), { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  writeFileSync(join(repository, "README.md"), "base\n");
  await git(repository, ["add", "--", "."]);
  await git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  return repository;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git failed: ${stderr}`);
}

describe("Kouro M1 host", () => {
  test("a selected agent interrupt is idempotent and a drained cancelled attempt can retry", async () => {
    let calls = 0;
    const harness: HarnessAdapter = {
      id: "scripted",
      adapterVersion: "interrupt-test",
      capabilities: () => ({ cancel: "supported" }),
      async run(input) {
        calls++;
        if (calls === 1) {
          while (!input.signal?.aborted) await Bun.sleep(5);
          return { status: "cancelled", error: "operator interrupted", events: [], usage: {} };
        }
        return {
          status: "succeeded",
          output: { summary: "recovered after interrupt" },
          events: [],
          usage: {},
        };
      },
    };
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      harness,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 0,
    });
    await service.start();
    try {
      const run = await service.createRun({
        workflowId: "tiny",
        idempotencyKey: "interrupt-agent",
      });
      let view = service.getView(run.runId)!;
      for (
        let tries = 0;
        tries < 100 && !service.operatorState(run.runId)?.interruptibleInvocationIds.length;
        tries++
      ) {
        await Bun.sleep(5);
        view = service.getView(run.runId)!;
      }
      const attempt = Object.values(view.state.attempts).find((item) => item.status === "running")!;
      const command = {
        runId: run.runId,
        invocationId: attempt.invocationId,
        attemptId: attempt.id,
        expectedRevision: view.revision,
        actor: "operator",
        idempotencyKey: "interrupt-one",
      };
      expect(() =>
        service.interruptAttempt({
          ...command,
          attemptId: "old-attempt",
          idempotencyKey: "interrupt-stale",
        }),
      ).toThrow(/no longer live/);
      const result = service.interruptAttempt(command);
      expect(service.interruptAttempt(command)).toEqual(result);
      const interrupted = await waitForTerminal(service, run.runId);
      expect(interrupted.state.status).toBe("failed");
      expect(interrupted.state.control).toBe("none");
      expect(interrupted.state.attempts[attempt.id]?.status).toBe("cancelled");
      expect(service.operatorState(run.runId)?.retryableInvocationIds).toEqual([
        attempt.invocationId,
      ]);
      service.retry({
        runId: run.runId,
        invocationId: attempt.invocationId,
        expectedRevision: interrupted.revision,
        actor: "operator",
        idempotencyKey: "retry-interrupted",
      });
      const recovered = await waitForTerminal(service, run.runId);
      expect(recovered.state.status).toBe("succeeded");
      expect(recovered.state.attempts[attempt.id]?.status).toBe("cancelled");
      expect(calls).toBe(2);
    } finally {
      await service.close();
    }
  });
  test("requested changes deliver durable feedback and enforce the repair limit across restart", async () => {
    const dataDir = temporaryDirectory();
    let service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const run = await service.createRun({
      workflowId: "feature",
      idempotencyKey: "review-repairs",
    });
    const pending = async (runId = run.runId) => {
      for (let count = 0; count < 200; count++) {
        const view = service.getView(runId)!;
        const approval = Object.values(view.state.approvals).find(
          (item) => item.status === "pending",
        );
        if (approval) return { view, approval };
        await Bun.sleep(5);
      }
      const state = service.getView(runId)!.state;
      throw new Error(
        `approval did not become pending: ${JSON.stringify({ status: state.status, recovery: state.recovery, invocations: Object.values(state.invocations).map((item) => ({ node: item.nodeId, status: item.status, error: item.error, bindings: item.inputBindings })) })}`,
      );
    };
    try {
      for (let repair = 0; repair < 3; repair++) {
        const { view, approval } = await pending();
        const command = {
          runId: run.runId,
          invocationId: approval.invocationId,
          decision: "changes-requested" as const,
          feedback: `Revise requirement ${repair}`,
          expectedRevision: view.revision,
          actor: "reviewer",
          idempotencyKey: `repair-${repair}`,
        };
        const result = service.decideApproval(command);
        expect(service.decideApproval(command)).toEqual(result);
        expect(() =>
          service.decideApproval({ ...command, feedback: "different feedback" }),
        ).toThrow(/payload conflict/);
        await pending();
        const next = service.getView(run.runId)!;
        const replanned = Object.values(next.state.invocations)
          .filter((item) => item.nodeId === "plan")
          .at(-1)!;
        const attempt = Object.values(next.state.attempts).find(
          (item) => item.invocationId === replanned.id,
        )!;
        expect(JSON.stringify(attempt.contextManifest)).toContain(`Revise requirement ${repair}`);
        expect(next.state.approvals[approval.id]?.feedback).toBe(command.feedback);
        if (repair === 0) {
          await service.close();
          service = new ApplicationService({
            dataDir,
            process: new FakeProcessAdapter(),
            scriptedDelayMs: 1,
          });
          await service.start();
        }
      }
      const { view, approval } = await pending();
      expect(() =>
        service.decideApproval({
          runId: run.runId,
          invocationId: approval.invocationId,
          decision: "changes-requested",
          feedback: "one more",
          expectedRevision: view.revision,
          actor: "reviewer",
          idempotencyKey: "repair-over-budget",
        }),
      ).toThrow(/repair budget/);
      service.decideApproval({
        runId: run.runId,
        invocationId: approval.invocationId,
        decision: "rejected",
        expectedRevision: view.revision,
        actor: "reviewer",
        idempotencyKey: "reject-revised-plan",
      });
      const terminal = await waitForTerminal(service, run.runId);
      expect(terminal.state.status).toBe("failed");
      expect(
        Object.values(terminal.state.invocations).some((item) => item.nodeId === "failed"),
      ).toBe(true);
      const acceptedRun = await service.createRun({
        workflowId: "feature",
        idempotencyKey: "review-repairs-accepted",
      });
      const first = await pending(acceptedRun.runId);
      service.decideApproval({
        runId: acceptedRun.runId,
        invocationId: first.approval.invocationId,
        decision: "changes-requested",
        feedback: "Include the acceptance checks",
        expectedRevision: first.view.revision,
        actor: "reviewer",
        idempotencyKey: "repair-before-acceptance",
      });
      const revised = await pending(acceptedRun.runId);
      service.decideApproval({
        runId: acceptedRun.runId,
        invocationId: revised.approval.invocationId,
        decision: "approved",
        expectedRevision: revised.view.revision,
        actor: "reviewer",
        idempotencyKey: "accept-revised-plan",
      });
      const accepted = await waitForTerminal(service, acceptedRun.runId);
      expect(accepted.state.status).toBe("succeeded");
      expect(accepted.state.approvals[first.approval.id]?.status).toBe("changes-requested");
      expect(accepted.state.approvals[revised.approval.id]?.status).toBe("approved");
    } finally {
      await service.close();
    }
  });
  test("operator retries a terminal failed effect once and retains recovery history across restart", async () => {
    let calls = 0;
    const harness: HarnessAdapter = {
      id: "scripted-fail-twice",
      adapterVersion: "test",
      capabilities: () => ({
        "structured-output": "supported",
        cancel: "supported",
        retry: "supported",
        reattach: "unsupported",
      }),
      async run(input) {
        calls++;
        input.onEvent?.({ type: "text", at: new Date().toISOString(), data: `turn-${calls}` });
        return {
          status: "succeeded",
          output: (calls <= 2
            ? { wrong: true }
            : { summary: "recovered" }) as import("@kouro/core").JsonValue,
          events: [],
          usage: { quality: "unavailable" },
        };
      },
    };
    const dataDir = temporaryDirectory();
    const service = new ApplicationService({
      dataDir,
      harness,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 0,
    });
    await service.start();
    try {
      const run = await service.createRun({ workflowId: "tiny", idempotencyKey: "operator-retry" });
      const failed = await waitForTerminal(service, run.runId);
      expect(failed.state.status).toBe("failed");
      const invocation = Object.values(failed.state.invocations).find(
        (item) => item.status === "failed",
      )!;
      expect(service.operatorState(run.runId)?.retryableInvocationIds).toEqual([invocation.id]);
      const command = {
        runId: run.runId,
        invocationId: invocation.id,
        expectedRevision: failed.revision,
        actor: "operator",
        idempotencyKey: "retry-once",
      };
      const retried = service.retry(command);
      expect(retried.status).toBe("running");
      expect(
        service.coordinator.journal.db
          .query("SELECT ended_at, error, output_artifact_ids_json FROM invocations WHERE id = ?1")
          .get(invocation.id),
      ).toEqual({
        ended_at: null,
        error: null,
        output_artifact_ids_json: "[]",
      });
      expect(service.retry(command)).toEqual(retried);
      const recovered = await waitForTerminal(service, run.runId);
      expect(recovered.state.status).toBe("succeeded");
      expect(calls).toBe(3);
      expect(
        Object.values(recovered.state.attempts)
          .filter((item) => item.invocationId === invocation.id)
          .map((item) => item.status),
      ).toEqual(["failed", "failed", "succeeded"]);
      expect(
        service.getEvents(run.runId).filter((event) => event.type === "run.retried"),
      ).toHaveLength(1);
      expect(service.getHarnessActivity(run.runId, 0, 2, undefined, true)).toHaveLength(2);
      expect(service.operatorState(run.runId)?.retryableInvocationIds).toEqual([]);
    } finally {
      await service.close();
    }
    const reopened = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 0,
    });
    await reopened.start();
    try {
      const run = reopened.listRuns()[0]!;
      expect(reopened.getView(run.runId)?.state.status).toBe("succeeded");
      expect(
        reopened.getEvents(run.runId).filter((event) => event.type === "run.retried"),
      ).toHaveLength(1);
      const activity = reopened.getHarnessActivity(run.runId, 0, 500);
      expect(activity.some((item) => (item.event as { data?: unknown }).data === "turn-3")).toBe(
        true,
      );
      const tail = reopened.getHarnessActivity(run.runId, 0, 2, undefined, true);
      expect(tail).toEqual(activity.slice(-2));
    } finally {
      await reopened.close();
    }
  });
  test("runs commands only when the node declares terminal.execute", async () => {
    const dataDir = temporaryDirectory();
    const repository = await fixtureRepository();
    const builder = new WorkflowBuilder({ id: "git-command-e2e", version: "1" });
    const command = builder.command("git-status", {
      executable: "git",
      args: ["status", "--short"],
      executionMode: "trusted-unrestricted",
    });
    const done = builder.complete("done");
    builder.startAt(command);
    builder.sequence(command, done);
    const bundle = await compileWorkflow(builder.build());
    const service = new ApplicationService({ dataDir, scriptedDelayMs: 1 });
    await service.start();
    const denied = await service.coordinator.createRun({
      workflowId: "git-command-e2e",
      bundle,
      idempotencyKey: "git-command-denied",
      workspace: { repositoryPath: repository },
    });
    const deniedView = await waitForTerminal(service, denied.run.runId);
    expect(deniedView.state.status).toBe("failed");
    expect(
      Object.values(deniedView.state.attempts).some((attempt) => attempt.commandEvidence),
    ).toBe(false);

    const configured = new WorkflowBuilder({ id: "git-command-e2e", version: "1" });
    const authorizedCommand = configured.command("git-status", {
      executable: "git",
      args: ["status", "--short"],
      capabilities: [CAPABILITY.TERMINAL_EXECUTE],
    });
    const authorizedDone = configured.complete("done");
    configured.startAt(authorizedCommand);
    configured.sequence(authorizedCommand, authorizedDone);
    const accepted = await service.coordinator.createRun({
      workflowId: "git-command-e2e",
      bundle: await compileWorkflow(configured.build()),
      idempotencyKey: "git-command-accepted",
      workspace: { repositoryPath: repository },
    });
    const acceptedView = await waitForTerminal(service, accepted.run.runId);
    expect(acceptedView.state.status).toBe("succeeded");
    const evidence = Object.values(acceptedView.state.attempts).find(
      (attempt) => attempt.commandEvidence,
    )?.commandEvidence;
    expect(evidence?.args).toEqual(["status", "--short"]);
    expect(evidence?.executable).toBe("git");
    expect(evidence?.executionMode).toBe("trusted-unrestricted");
    await service.close();
  });

  test("repository runs use isolated worktrees, exact API diff, and guarded delivery", async () => {
    const dataDir = temporaryDirectory();
    const repository = await fixtureRepository();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const one = await service.createRun({
      workflowId: "tiny",
      idempotencyKey: "repo-one",
      workspace: { repositoryPath: repository },
    });
    const two = await service.createRun({
      workflowId: "tiny",
      idempotencyKey: "repo-two",
      workspace: { repositoryPath: repository },
    });
    const refs = (service.coordinator as unknown as { workspaces: Map<string, { path: string }> })
      .workspaces;
    const first = refs.get(one.runId)!;
    const second = refs.get(two.runId)!;
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("base\n");

    writeFileSync(join(first.path, "new.txt"), "new\n");
    rmSync(join(first.path, "README.md"));
    writeFileSync(join(first.path, "binary.bin"), new Uint8Array([0, 1, 2, 255]));
    const snapshot = await service.workspaceSnapshot(one.runId);
    expect(snapshot?.changedPaths.map((item) => item.path).sort()).toEqual([
      "README.md",
      "binary.bin",
      "new.txt",
    ]);
    expect(snapshot?.changedPaths.find((item) => item.path === "binary.bin")?.binary).toBe(true);
    expect(snapshot?.patch).toContain("new.txt");

    const host = createHostServer(service, { token: "workspace-token" });
    const origin = "http://127.0.0.1:43127";
    const paired = await host.app.handle(
      new Request(`${origin}/api/session`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "workspace-token" }),
      }),
    );
    const cookie = paired.headers.get("set-cookie") ?? "";
    const csrfToken = ((await paired.clone().json()) as { csrfToken: string }).csrfToken;
    const diff = await host.app.handle(
      new Request(`${origin}/api/runs/${one.runId}/diff`, { headers: { origin, cookie } }),
    );
    expect(diff.status).toBe(200);
    expect((await diff.json()) as { resultTree: string }).toMatchObject({
      resultTree: snapshot?.resultTree,
    });

    const bypass = await host.app.handle(
      new Request(`${origin}/api/runs/${one.runId}/actions`, {
        method: "POST",
        headers: {
          origin,
          cookie,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          action: "deliver",
          expectedRevision: 0,
          idempotencyKey: "unreviewed-delivery",
          message: "deliver without review",
        }),
      }),
    );
    expect(bypass.status).toBeGreaterThanOrEqual(400);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("base\n");

    await expect(
      service.workspaceCommit({
        runId: one.runId,
        expectedTree: snapshot!.resultTree,
        operationKey: "deliver-1",
        message: "deliver",
      }),
    ).resolves.toMatchObject({ tree: snapshot!.resultTree });
    await expect(
      service.workspaceCommit({
        runId: one.runId,
        expectedTree: snapshot!.resultTree,
        operationKey: "deliver-1",
        message: "deliver",
      }),
    ).resolves.toMatchObject({ idempotent: true });
    writeFileSync(join(first.path, "stale.txt"), "stale\n");
    await expect(
      service.workspaceCommit({
        runId: one.runId,
        expectedTree: snapshot!.resultTree,
        operationKey: "deliver-2",
        message: "stale",
      }),
    ).rejects.toThrow(/tree changed/);
    expect(readFileSync(join(second.path, "README.md"), "utf8")).toBe("base\n");
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("base\n");
    await host.stop();
  });
  test("feature catalog waits for approval, rejects stale decisions, then reaches terminal", async () => {
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const catalog = await service.workflows();
    const feature = catalog.find((entry) => entry.id === "feature");
    expect(feature?.graph.nodes.map((node) => node.kind)).toContain("approval");
    const run = await service.createRun({ workflowId: "feature", idempotencyKey: "feature-e2e" });
    let view = service.getView(run.runId);
    for (let count = 0; count < 200; count += 1) {
      view = service.getView(run.runId);
      if (view && Object.keys(view.state.approvals).length > 0) break;
      await Bun.sleep(5);
    }
    expect(view?.state.status).toBe("running");
    const approval = Object.values(view?.state.approvals ?? {})[0];
    expect(approval?.status).toBe("pending");
    service.coordinator.journal.append({
      runId: run.runId,
      type: "harness.activity",
      actor: "fixture",
      payload: {
        attemptId: "steer-attempt-fixture",
        event: {
          type: "log",
          at: "2026-09-25T00:00:00.000Z",
          data: {
            status: "Steering fixture",
            outcome: "requested",
            idempotencyKey: "steer-fixture-key",
            requestDigest: "steer-fixture-digest",
          },
        },
      },
    });
    expect(
      service.coordinator.journal.getSteeringCommand(run.runId, "steer-fixture-key"),
    ).toMatchObject({
      status: "requested",
      requestDigest: "steer-fixture-digest",
    });
    view = service.getView(run.runId);
    expect(() =>
      service.decideApproval({
        runId: run.runId,
        invocationId: approval!.invocationId,
        decision: "approved",
        expectedRevision: view!.revision - 1,
        actor: "local-operator",
        idempotencyKey: "approval-stale",
      }),
    ).toThrow(/stale-action/);
    const decided = service.decideApproval({
      runId: run.runId,
      invocationId: approval!.invocationId,
      decision: "approved",
      expectedRevision: view!.revision,
      actor: "local-operator",
      idempotencyKey: "approval-once",
      bindingDigest: approval!.bindingDigest,
      subjectRevision: approval!.subjectRevision,
    });
    expect(decided.status).toBe("running");
    view = await waitForTerminal(service, run.runId);
    expect(view.state.status).toBe("succeeded");
    expect(view.state.approvals[approval!.id]?.actor).toBe("local-operator");
    expect(
      service.decideApproval({
        runId: run.runId,
        invocationId: approval!.invocationId,
        decision: "approved",
        expectedRevision: decided.revision,
        actor: "local-operator",
        idempotencyKey: "approval-once",
        bindingDigest: approval!.bindingDigest,
        subjectRevision: approval!.subjectRevision,
      }),
    ).toEqual(decided);
    expect(() =>
      service.decideApproval({
        runId: run.runId,
        invocationId: approval!.invocationId,
        decision: "rejected",
        expectedRevision: decided.revision,
        actor: "local-operator",
        idempotencyKey: "approval-once",
        bindingDigest: approval!.bindingDigest,
        subjectRevision: approval!.subjectRevision,
      }),
    ).toThrow(/payload conflict/);
    await service.close();
  });

  test("executes and durably reloads the scripted agent -> command -> complete run", async () => {
    const dataDir = temporaryDirectory();
    const process = new FakeProcessAdapter();
    const service = new ApplicationService({ dataDir, process, scriptedDelayMs: 1 });
    await service.start();
    const created = await service.createRun({ workflowId: "tiny", idempotencyKey: "one" });
    const view = await waitForTerminal(service, created.runId);
    expect(view.state.status).toBe("succeeded");
    expect(view.revision).toBeGreaterThanOrEqual(14);
    expect(Object.values(view.state.invocations).map((item) => item.nodeId)).toEqual([
      "scripted-agent",
      "safe-command",
      "complete",
    ]);
    expect(process.operations).toHaveLength(1);
    expect(
      service
        .getEvents(created.runId)
        .filter((event) => event.type !== "harness.activity")
        .map((event) => event.type),
    ).toEqual([
      "run.started",
      "invocation.created",
      "attempt.reserved",
      "attempt.started",
      "attempt.completed",
      "invocation.completed",
      "invocation.created",
      "attempt.reserved",
      "attempt.started",
      "attempt.completed",
      "invocation.completed",
      "invocation.created",
      "invocation.completed",
      "run.completed",
    ]);
    await service.close();

    const reopened = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await reopened.start();
    const restored = reopened.getView(created.runId);
    expect(restored?.state.status).toBe("succeeded");
    expect(restored?.revision).toBe(view.revision);
    const duplicate = await reopened.createRun({ workflowId: "tiny", idempotencyKey: "one" });
    expect(duplicate.runId).toBe(created.runId);
    await reopened.close();
  });

  test("returns JSON for missing API routes while retaining browser navigation fallback", async () => {
    const staticRoot = temporaryDirectory();
    writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Kouro</title>");
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
    });
    await service.start();
    const host = createHostServer(service, { staticRoot });
    const origin = "http://127.0.0.1:43127";
    try {
      for (const method of ["GET", "POST"]) {
        const missing = await host.app.handle(
          new Request(`${origin}/api/missing-route`, { method }),
        );
        expect(missing.status).toBe(404);
        expect(missing.headers.get("content-type")).toContain("application/json");
        expect(await missing.json()).toMatchObject({ error: "api-route-not-found" });
      }
      const navigation = await host.app.handle(new Request(`${origin}/runs/example`));
      expect(navigation.status).toBe(200);
      expect(await navigation.text()).toContain("<!doctype html>");
      const session = await host.app.handle(new Request(`${origin}/api/session`));
      expect(session.status).toBe(401);
      const rejected = await host.app.handle(
        new Request(`${origin}/api/missing-route`, { headers: { origin: "https://example.com" } }),
      );
      expect(rejected.status).toBe(403);
    } finally {
      await host.stop();
    }
  });

  test("requires pairing and CSRF while keeping the token out of later API calls", async () => {
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await service.start();
    const host = createHostServer(service, { token: "test-pairing-token" });
    const origin = "http://127.0.0.1:43127";
    const anonymous = await host.app.handle(new Request(`${origin}/api/workflows`));
    expect(anonymous.status).toBe(401);

    const paired = await host.app.handle(
      new Request(`${origin}/api/session`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token: "test-pairing-token" }),
      }),
    );
    expect(paired.status).toBe(200);
    const cookie = paired.headers.get("set-cookie");
    const { csrfToken } = (await paired.json()) as { csrfToken: string };
    expect(cookie).toContain("HttpOnly");

    const profiles = await host.app.handle(
      new Request(`${origin}/api/execution-profiles`, {
        headers: { origin, cookie: cookie ?? "" },
      }),
    );
    expect(profiles.status).toBe(200);
    expect((await profiles.json()) as unknown[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "scripted", available: true })]),
    );

    const rejected = await host.app.handle(
      new Request(`${origin}/api/runs`, {
        method: "POST",
        headers: { origin, cookie: cookie ?? "", "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "tiny",
          executionProfile: "scripted",
          idempotencyKey: "api-run",
        }),
      }),
    );
    expect(rejected.status).toBe(403);
    const accepted = await host.app.handle(
      new Request(`${origin}/api/runs`, {
        method: "POST",
        headers: {
          origin,
          cookie: cookie ?? "",
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ workflowId: "tiny", idempotencyKey: "api-run" }),
      }),
    );
    expect(accepted.status).toBe(200);
    const run = (await accepted.json()) as { id: string };
    const completed = await waitForTerminal(service, run.id);
    const attemptId = Object.values(completed.state.attempts).find(
      (attempt) => attempt.harnessEvents?.length,
    )?.id;
    expect(attemptId).toBeDefined();
    const history = await host.app.handle(
      new Request(`${origin}/api/runs/${run.id}/activity?attemptId=${attemptId!}`, {
        headers: { origin, cookie: cookie ?? "" },
      }),
    );
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      items: Array<{ attemptId: string; event: { data?: string } }>;
    };
    expect(historyBody.items.length).toBeGreaterThan(0);
    expect(historyBody.items.every((item) => item.attemptId === attemptId)).toBe(true);
    await host.stop();
  });

  test("fails closed when a second writable owner opens the same data directory", async () => {
    const dataDir = temporaryDirectory();
    const first = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await first.start();
    expect(
      () =>
        new ApplicationService({ dataDir, process: new FakeProcessAdapter(), scriptedDelayMs: 1 }),
    ).toThrow(/already owned/);
    await first.close();
  });

  test("marks a previously claimed effect as recovery-required instead of replaying it", async () => {
    const dataDir = temporaryDirectory();
    const first = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    const bundle = await first.tiny();
    const journal = first.coordinator.journal;
    const { run } = journal.createRun({ workflowId: "tiny", bundle, idempotencyKey: "claimed" });
    journal.append({ runId: run.runId, type: "run.started", payload: {}, actor: "test" });
    journal.append({
      runId: run.runId,
      type: "invocation.created",
      payload: { invocationId: "inv-claimed", nodeId: "scripted-agent" },
      actor: "test",
    });
    journal.reserveEffect({
      runId: run.runId,
      invocationId: "inv-claimed",
      attemptId: "attempt-claimed",
      operationKey: "claimed-operation",
      recoveryClass: "verify-then-replay",
      payload: { invocationId: "inv-claimed" },
    });
    expect(
      journal.claimEffect(journal.unresolvedEffects()[0].id, first.coordinator.ownerEpoch),
    ).toBe(true);
    await first.close();

    const restarted = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await restarted.start();
    const restored = restarted.getView(run.runId);
    expect(restored?.state.status).toBe("recovery-required");
    expect(restored?.state.recovery?.code).toBe("effect-ambiguous");
    await restarted.close();
  });

  test("uses observed command failure to fail the run instead of hanging", async () => {
    const failingProcess: ProcessAdapter = {
      enforcementMode: "enforced",
      async probe() {
        return { available: true, detail: "test" };
      },
      async executeFixedFixture(input) {
        return {
          operationKey: input.operationKey,
          evidence: {
            argv: ["/usr/bin/printf"],
            cwd: input.workspaceDir,
            exitCode: 2,
            signal: null,
            timedOut: false,
            spawnError: null,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("failed"),
            enforcementMode: "enforced",
          },
        };
      },
      async executeCommand(input) {
        return {
          operationKey: input.operationKey,
          evidence: {
            argv: [input.executable, ...input.args],
            cwd: input.workspaceDir,
            exitCode: 2,
            signal: null,
            timedOut: false,
            spawnError: null,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("failed"),
            enforcementMode: "enforced",
          },
        };
      },
    };
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: failingProcess,
      scriptedDelayMs: 1,
    });
    await service.start();
    const run = await service.createRun({ workflowId: "tiny", idempotencyKey: "failure" });
    const view = await waitForTerminal(service, run.runId);
    expect(view.state.status).toBe("failed");
    const command = Object.values(view.state.attempts).find((attempt) => attempt.commandEvidence);
    expect(command?.commandEvidence?.exitCode).toBe(2);
    expect(command?.commandEvidence?.stderrArtifactId).toBeDefined();
    await service.close();
  });

  test("retries invalid structured output as a second attempt of one invocation", async () => {
    let calls = 0;
    const harness: HarnessAdapter = {
      id: "scripted-invalid-once",
      adapterVersion: "test",
      capabilities: () => ({
        "structured-output": "supported",
        cancel: "supported",
        retry: "supported",
        reattach: "unsupported",
      }),
      async run() {
        calls += 1;
        if (calls === 1)
          return {
            status: "succeeded" as const,
            output: { wrong: true } as import("@kouro/core").JsonValue,
            rawOutput: "secret-value-that-must-not-survive",
            events: [{ type: "log", data: "secret-value-that-must-not-survive" }],
            usage: { quality: "unavailable" },
          };
        return {
          status: "succeeded" as const,
          output: { summary: "valid second attempt" } as import("@kouro/core").JsonValue,
          events: [],
          usage: { quality: "unavailable" },
        };
      },
    };
    const priorSecret = process.env.KOURO_TEST_SECRET;
    process.env.KOURO_TEST_SECRET = "secret-value-that-must-not-survive";
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 0,
    });
    try {
      await service.start();
      const run = await service.createRun({
        workflowId: "tiny",
        idempotencyKey: "invalid-once",
        executionProfile: "scripted",
      });
      const view = await waitForTerminal(service, run.runId);
      expect(view.state.status).toBe("succeeded");
      const agent = Object.values(view.state.invocations).find(
        (invocation) => invocation.nodeId === "scripted-agent",
      );
      const attempts = Object.values(view.state.attempts)
        .filter((attempt) => attempt.invocationId === agent?.id)
        .sort((left, right) => left.ordinal - right.ordinal);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
      expect(attempts[0]?.error).toContain("invalid-output");
      expect(attempts[0]?.contextManifest).toMatchObject({
        version: 1,
        hiddenNativeContext: "unavailable",
      });
      expect(
        String((attempts[0]?.contextManifest as { digest?: string } | undefined)?.digest),
      ).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(attempts)).not.toContain("secret-value-that-must-not-survive");
      expect(attempts[1]?.output).toHaveLength(1);
      expect(attempts.some((attempt) => attempt.commandEvidence !== undefined)).toBe(false);
    } finally {
      await service.close();
      if (priorSecret === undefined) delete process.env.KOURO_TEST_SECRET;
      else process.env.KOURO_TEST_SECRET = priorSecret;
    }
  });

  test("persists execution profile attribution across restart", async () => {
    const dataDir = temporaryDirectory();
    const service = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 0,
    });
    await service.start();
    const run = await service.createRun({
      workflowId: "tiny",
      idempotencyKey: "profile-attribution",
      executionProfile: "scripted",
    });
    await waitForTerminal(service, run.runId);
    expect(service.listRuns()[0]?.executionProfile).toBe("scripted");
    await service.close();

    const reopened = new ApplicationService({
      dataDir,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 0,
    });
    await reopened.start();
    expect(reopened.listRuns()[0]?.executionProfile).toBe("scripted");
    await reopened.close();
  });

  test("operator controls are idempotent and detach does not mutate runtime state", async () => {
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 40,
    });
    await service.start();
    const run = await service.createRun({ workflowId: "tiny", idempotencyKey: "control-run" });
    let view = service.getView(run.runId)!;
    for (
      let count = 0;
      count < 100 && !Object.values(view.state.attempts).some((a) => a.status === "running");
      count += 1
    ) {
      await Bun.sleep(2);
      view = service.getView(run.runId)!;
    }
    const paused = service.control({
      runId: run.runId,
      action: "pause",
      expectedRevision: view.revision,
      actor: "test",
      idempotencyKey: "pause-once",
    });
    const duplicate = service.control({
      runId: run.runId,
      action: "pause",
      expectedRevision: view.revision,
      actor: "test",
      idempotencyKey: "pause-once",
    });
    expect(duplicate).toEqual(paused);
    const pausedView = service.getView(run.runId)!;
    const detached = service.control({
      runId: run.runId,
      action: "detach",
      expectedRevision: pausedView.revision,
      actor: "test",
      idempotencyKey: "detach-once",
    });
    expect(service.getView(run.runId)?.state.status).toBe("paused");
    expect(detached.status).toBe("paused");
    await service.close();
  });

  test("cancelling an aborted scripted harness does not reserve a transport retry", async () => {
    const harness: HarnessAdapter = {
      id: "abort-rejecting-scripted",
      adapterVersion: "test",
      capabilities: () => ({
        "structured-output": "supported",
        cancel: "unsupported",
        retry: "supported",
        reattach: "unsupported",
      }),
      run(input) {
        return new Promise((_, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(new Error("scripted transport aborted")),
            { once: true },
          );
        });
      },
    };
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 0,
    });
    await service.start();
    const run = await service.createRun({ workflowId: "tiny", idempotencyKey: "cancel-no-retry" });
    let view = service.getView(run.runId)!;
    for (
      let count = 0;
      count < 200 &&
      !Object.values(view.state.attempts).some((attempt) => attempt.status === "running");
      count += 1
    ) {
      await Bun.sleep(5);
      view = service.getView(run.runId)!;
    }
    expect(Object.values(view.state.attempts).some((attempt) => attempt.status === "running")).toBe(
      true,
    );
    const receipt = service.control({
      runId: run.runId,
      action: "cancel",
      expectedRevision: view.revision,
      actor: "test",
      idempotencyKey: "cancel-action",
    });
    expect(receipt.status).toBe("running");
    expect(service.getView(run.runId)?.state.control).toBe("cancel-requested");
    const cancelled = await waitForTerminal(service, run.runId);
    expect(cancelled.state.status).toBe("cancelled");
    expect(Object.values(cancelled.state.attempts)).toHaveLength(1);
    expect(Object.values(cancelled.state.attempts).map((attempt) => attempt.status)).toEqual([
      "cancelled",
    ]);
    await service.close();
  });

  test("unconfirmed harness shutdown durably blocks deletion until late settlement", async () => {
    let release!: (result: Awaited<ReturnType<HarnessAdapter["run"]>>) => void;
    const harness: HarnessAdapter = {
      id: "ignores-cancel",
      adapterVersion: "test",
      capabilities: () => ({
        "structured-output": "supported",
        cancel: "unsupported",
        retry: "unsupported",
        reattach: "unsupported",
      }),
      run() {
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 0,
      agentIdleTimeoutMs: 10,
      agentObservationGraceMs: 10,
      cancelGraceMs: 10,
    });
    await service.start();
    const run = await service.createRun({ workflowId: "tiny", idempotencyKey: "stuck-shutdown" });
    const view = await waitForTerminal(service, run.runId);
    expect(view.state.status).toBe("recovery-required");
    await Bun.sleep(20);
    const blocked = await service.previewRunDeletion(run.runId);
    expect(blocked.canDelete).toBe(false);
    expect(blocked.blockers?.some((blocker) => blocker.message.includes("Harness shutdown"))).toBe(
      true,
    );

    const effect = service.coordinator.journal.db
      .query("SELECT id FROM effects WHERE attempt_id = ?1")
      .get(Object.keys(view.state.attempts)[0]!) as { id: string };
    service.coordinator.journal.markRecoveryRequired(
      effect.id,
      "sibling child did not confirm termination",
      "child-b-supervision",
    );

    release({
      status: "cancelled",
      error: "cancelled",
      events: [],
      usage: { quality: "unavailable" },
    });
    let recovered = await service.previewRunDeletion(run.runId);
    for (
      let count = 0;
      count < 100 &&
      !recovered.blockers?.some((blocker) => blocker.message.includes("child-b-supervision"));
      count += 1
    ) {
      await Bun.sleep(5);
      recovered = await service.previewRunDeletion(run.runId);
    }
    expect(recovered.canDelete).toBe(false);
    expect(
      recovered.blockers?.some((blocker) => blocker.message.includes("child-b-supervision")),
    ).toBe(true);
    service.coordinator.journal.confirmHarnessShutdown("child-b-supervision");
    recovered = await service.previewRunDeletion(run.runId);
    expect(recovered.canDelete).toBe(true);
    await service.close();
  });

  test("new text starts a fresh observation grace after a stall warning", async () => {
    let service!: ApplicationService;
    const warningPrecededProgress: boolean[] = [];
    const harness: HarnessAdapter = {
      id: "progress-after-stall",
      adapterVersion: "test",
      capabilities: () => ({
        "structured-output": "supported",
        cancel: "supported",
        retry: "unsupported",
        reattach: "unsupported",
      }),
      run(input) {
        return new Promise((resolve) => {
          const warningPoll = setInterval(() => {
            const warningSeen = service
              .getEvents(input.runId)
              .some(
                (event) =>
                  event.type === "harness.activity" &&
                  JSON.stringify(event.payload).includes("Possibly stalled"),
              );
            if (!warningSeen) return;
            clearInterval(warningPoll);
            warningPrecededProgress.push(true);
            setTimeout(
              () =>
                input.onEvent?.({
                  type: "text",
                  at: new Date().toISOString(),
                  data: "provider is still working",
                }),
              20,
            );
          }, 5);
          const finish = setTimeout(
            () =>
              resolve({
                status: "succeeded",
                output: { summary: "finished" },
                events: [],
                usage: { quality: "unavailable" },
              }),
            650,
          );
          input.signal?.addEventListener(
            "abort",
            () => {
              clearInterval(warningPoll);
              clearTimeout(finish);
              resolve({
                status: "cancelled",
                error: "cancelled",
                events: [],
                usage: { quality: "unavailable" },
              });
            },
            { once: true },
          );
        });
      },
    };
    const builder = new WorkflowBuilder({ id: "watchdog-progress" });
    const agent = builder.agent("agent", { prompt: "work" });
    const done = builder.complete("done");
    builder.startAt(agent);
    builder.sequence(agent, done);
    service = new ApplicationService({
      dataDir: temporaryDirectory(),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 0,
      agentIdleTimeoutMs: 40,
      agentObservationGraceMs: 120,
    });
    await service.start();
    const run = await service.coordinator.createRun({
      workflowId: "watchdog-progress",
      bundle: await compileWorkflow(builder.build()),
      idempotencyKey: "watchdog-progress",
    });
    const view = await waitForTerminal(service, run.run.runId);
    expect(view.state.status).toBe("succeeded");
    const events = view.state.attempts[Object.keys(view.state.attempts)[0]!]?.harnessEvents ?? [];
    const warningIndex = events.findIndex((event) =>
      JSON.stringify(event).includes("Possibly stalled"),
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningPrecededProgress).toEqual([true]);
    await service.close();
  });
});
