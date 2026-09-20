import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowBuilder, compileWorkflow, artifactType } from "@kouro/core";
import { Coordinator } from "../src/coordinator/coordinator.ts";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap.ts";
import type { HarnessAdapter } from "../src/types.ts";

class ForkHarness implements HarnessAdapter {
  readonly id = "fork-test";
  readonly adapterVersion = "1";
  readonly started: string[] = [];
  readonly completed: string[] = [];
  capabilities() {
    return {
      "structured-output": "supported" as const,
      cancel: "supported" as const,
      usage: "unsupported" as const,
      "cost-cap": "unsupported" as const,
    };
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    this.started.push(input.invocationId);
    const delay = input.prompt.includes("slow") ? 80 : input.prompt.includes("fast-fail") ? 8 : 2;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      input.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    }).catch(() => undefined);
    if (input.signal?.aborted)
      return {
        status: "cancelled" as const,
        error: "cancelled",
        events: [],
        usage: { quality: "unavailable" },
      };
    if (input.prompt.includes("fast-fail"))
      return {
        status: "failed" as const,
        error: "fixture failure",
        events: [],
        usage: { quality: "unavailable" },
      };
    this.completed.push(input.invocationId);
    return {
      status: "succeeded" as const,
      output: { branch: input.prompt },
      events: [],
      usage: { quality: "unavailable" },
    };
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function untilTerminal(coordinator: Coordinator, runId: string) {
  for (let i = 0; i < 300; i += 1) {
    const view = coordinator.journal.getView(runId);
    if (view && !["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(3);
  }
  throw new Error("fork run did not terminate");
}

function makeWorkflow(
  mode: "fail-fast" | "all-settled",
  withProducer = false,
  failLeft = true,
  reverseCompletion = false,
) {
  const w = new WorkflowBuilder({ id: `fork-${mode}-${withProducer ? "data" : "plain"}` });
  const seed = withProducer
    ? w.agent("seed", { prompt: "seed", produces: artifactType("seed", { type: "object" }) })
    : undefined;
  const left = w.agent("left", {
    prompt: failLeft ? "fast-fail" : reverseCompletion ? "slow" : "left",
    ...(seed ? { input: { seed: seed.output } } : {}),
  });
  const right = w.agent("right", {
    prompt: reverseCompletion ? "right" : "slow",
    ...(seed ? { input: { seed: seed.output } } : {}),
  });
  const fork = w.parallel("branches", { branches: [left, right] });
  const joinNode = w.join("join", { groupId: "branches", mode });
  const done = w.complete("done");
  if (seed) {
    w.startAt(seed);
    seed.on("success").to(fork);
  } else w.startAt(fork);
  fork.on("success").to(joinNode);
  left.on("success").to(joinNode);
  right.on("success").to(joinNode);
  joinNode.on("success").to(done);
  joinNode.on("failure").to(w.complete("failed", { result: "failed" }));
  return compileWorkflow(w.build());
}

describe("M4 real coordinator fork/join", () => {
  test("fail-fast cancels an actively running sibling and records durable cancellation", async () => {
    const harness = new ForkHarness();
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-failfast-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const bundle = await makeWorkflow("fail-fast");
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "fail-fast",
    });
    const view = await untilTerminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("failed");
    expect(harness.started).toHaveLength(2);
    const cancelled = Object.values(view.state.invocations).filter(
      (invocation) => invocation.outcome === "cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(view.state.forkGroups?.branches?.branchStatuses.right).toBe("cancelled");
    expect(view.state.forkGroups?.branches?.joined).toBe(true);
    await coordinator.close();
  });

  test("all-settled waits for both success and failure and keeps both branch facts", async () => {
    const harness = new ForkHarness();
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-settled-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const bundle = await makeWorkflow("all-settled");
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "all-settled",
    });
    const view = await untilTerminal(coordinator, created.run.runId);
    expect(view.state.status).toBe("failed");
    expect(
      Object.values(view.state.invocations).filter((invocation) => invocation.nodeId === "right")[0]
        ?.outcome,
    ).toBe("success");
    expect(
      Object.values(view.state.invocations).filter((invocation) => invocation.nodeId === "left")[0]
        ?.outcome,
    ).toBe("failure");
    expect(view.state.forkGroups?.branches?.joined).toBe(true);
    await coordinator.close();
  });

  test("join output is in declared branch order, not completion order", async () => {
    const harness = new ForkHarness();
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-order-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      harness,
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const bundle = await makeWorkflow("all-settled", false, false, true);
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "order",
    });
    const view = await untilTerminal(coordinator, created.run.runId);
    const branches = Object.values(view.state.invocations).filter(
      (invocation) => invocation.nodeId === "left" || invocation.nodeId === "right",
    );
    const joinInvocation = Object.values(view.state.invocations).find(
      (invocation) => invocation.nodeId === "join",
    );
    expect(
      harness.completed.map((id) => branches.find((branch) => branch.id === id)?.nodeId),
    ).toEqual(["right", "left"]);
    expect(
      joinInvocation?.output.map(
        (ref) =>
          view.state.invocations[
            branches.find((branch) => branch.output.some((item) => item.id === ref.id))?.id ?? ""
          ]?.nodeId,
      ),
    ).toEqual(["left", "right"]);
    await coordinator.close();
  });

  test("resolves data produced before the fork into every branch input", async () => {
    const coordinator = new Coordinator({
      dataDir: (dirs.push(mkdtempSync(join(tmpdir(), "kouro-dataflow-"))), dirs.at(-1)!),
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 1,
    });
    await coordinator.start();
    const bundle = await makeWorkflow("all-settled", true);
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "dataflow",
    });
    const view = await untilTerminal(coordinator, created.run.runId);
    const seed = Object.values(view.state.invocations).find(
      (invocation) => invocation.nodeId === "seed",
    );
    const branches = Object.values(view.state.invocations).filter(
      (invocation) => invocation.nodeId === "left" || invocation.nodeId === "right",
    );
    expect(seed?.output[0]).toBeDefined();
    expect(branches.map((branch) => branch.inputBindings.seed?.artifactId)).toEqual([
      seed?.output[0]?.id,
      seed?.output[0]?.id,
    ]);
    await coordinator.close();
  });
});
