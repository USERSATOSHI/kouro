import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Options, query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { artifactType, compileWorkflow, WorkflowBuilder } from "@kouro/core";
import {
  CodexAppServerHarness,
  inspectCodex,
  type CodexAppServerConnection,
} from "../src/adapters/harness/codex";
import { ClaudeAgentSdkHarnessAdapter } from "../src/adapters/harness/claude-agent-sdk";
import { Coordinator } from "../src/coordinator/coordinator";
import type { HarnessAdapter } from "../src/types";

test("Codex sends per-turn effort, preserves defaults, and rejects unsupported catalog levels before a turn", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  let disposed = 0;
  const harness = new CodexAppServerHarness(await inspectCodex(), () => {
    let listener: Parameters<CodexAppServerConnection["subscribe"]>[0] | undefined;
    return {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/start")
          return { ok: true, value: { thread: { id: "thread" }, model: "fixture" } };
        if (method === "model/list")
          return {
            ok: true,
            value: {
              data: [{ id: "fixture", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
              nextCursor: null,
            },
          };
        if (method === "turn/start") {
          setTimeout(
            () =>
              listener?.({
                method: "turn/completed",
                params: {
                  threadId: "thread",
                  turn: {
                    id: "turn",
                    status: "completed",
                    items: [{ id: "reply", type: "agentMessage", text: '{"summary":"done"}' }],
                  },
                },
              }),
            0,
          );
          return { ok: true, value: { turn: { id: "turn" } } };
        }
        return { ok: true, value: {} };
      },
      subscribe(callback) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      notify() {},
      respond() {},
      async dispose() {
        disposed++;
      },
    };
  });
  const input = {
    attemptId: "attempt",
    role: { id: "role", prompt: "test" },
    selection: { harness: "codex" as const, model: { id: "fixture" } },
    cwd: tmpdir(),
  };
  expect((await harness.run({ ...input, nativeConfig: { effort: "high" } })).status).toBe(
    "succeeded",
  );
  expect(calls.find((call) => call.method === "turn/start")?.params.effort).toBe("high");
  calls.length = 0;
  expect((await harness.run(input)).status).toBe("succeeded");
  expect(calls.find((call) => call.method === "turn/start")?.params).not.toHaveProperty("effort");
  expect(calls.some((call) => call.method === "model/list")).toBe(false);
  calls.length = 0;
  const rejected = await harness.run({ ...input, nativeConfig: { effort: "max" } });
  expect(rejected).toMatchObject({
    status: "failed",
    error: "Reasoning effort max is unsupported by Codex model fixture",
  });
  expect(calls.some((call) => call.method === "turn/start")).toBe(false);
  expect(disposed).toBe(3);
});

test("Claude passes supported effort to the SDK, leaves defaults unset, and rejects incompatible values", async () => {
  const received: Options[] = [];
  const provider: typeof query = (args) => {
    received.push(args.options!);
    return (async function* () {
      yield { type: "result", subtype: "success", result: '{"summary":"done"}' } as SDKMessage;
    })() as ReturnType<typeof query>;
  };
  const harness = new ClaudeAgentSdkHarnessAdapter(provider);
  const input = { runId: "run", invocationId: "agent", role: "role", prompt: "test", delayMs: 0 };
  for (const effort of ["low", "medium", "high", "xhigh", "max"])
    expect((await harness.run({ ...input, nativeConfig: { effort } })).status).toBe("succeeded");
  expect(received.map((options) => options.effort)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect((await harness.run(input)).status).toBe("succeeded");
  expect(received.at(-1)).not.toHaveProperty("effort");
  expect((await harness.run({ ...input, nativeConfig: { effort: "minimal" } })).status).toBe(
    "failed",
  );
  expect(received).toHaveLength(6);
});

test("coordinator forwards independent parent and child efforts and persists them across reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kouro-effort-"));
  const received: Array<{ role: string; effort: unknown }> = [];
  const adapter: HarnessAdapter = {
    id: "scripted",
    adapterVersion: "effort-fixture",
    capabilities: () => ({
      "awaited-subagent-tool": "supported",
      "child-read-only-envelope": "supported",
    }),
    async run(input) {
      received.push({ role: input.role, effort: input.nativeConfig?.effort });
      if (input.role === "parent") {
        for (const subagentId of ["child", "default-child"])
          expect(
            (await input.collaboration!.subagent!({ subagentId, requestId: subagentId, input: {} }))
              .state,
          ).toBe("succeeded");
      }
      return { status: "succeeded", output: { summary: "done" }, events: [], usage: {} };
    },
  };
  const report = artifactType<{ summary: string }>("effort-result", {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  });
  const builder = new WorkflowBuilder({ id: "effort-runtime" });
  const child = builder.subagent("child", { prompt: "inspect", produces: report, effort: "low" });
  const defaultChild = builder.subagent("default-child", { prompt: "inspect", produces: report });
  const parent = builder.agent("parent", {
    prompt: "plan",
    effort: "high",
    uses: [child, defaultChild],
  });
  builder.startAt(parent);
  builder.sequence(parent, builder.complete("done"));
  const bundle = await compileWorkflow(builder.build());
  let coordinator = new Coordinator({ dataDir: directory, harness: adapter });
  try {
    await coordinator.start();
    const created = await coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "effort",
    });
    let view = coordinator.journal.getView(created.run.runId)!;
    for (
      let count = 0;
      count < 300 && ["pending", "running"].includes(view.state.status);
      count++
    ) {
      await Bun.sleep(5);
      view = coordinator.journal.getView(created.run.runId)!;
    }
    expect(view.state.status).toBe("succeeded");
    expect(received).toEqual([
      { role: "parent", effort: "high" },
      { role: "child", effort: "low" },
      { role: "default-child", effort: undefined },
    ]);
    expect(
      Object.values(view.state.attempts).some(
        (attempt) => attempt.resolvedExecution?.effort === "high",
      ),
    ).toBe(true);
    await coordinator.close();
    coordinator = new Coordinator({ dataDir: directory, harness: adapter });
    await coordinator.start();
    const reopened = coordinator.journal.getView(created.run.runId)!;
    expect(reopened.bundle.digest).toBe(bundle.digest);
    expect(
      reopened.bundle.definitions[bundle.rootDefinitionId]!.nodes.find(
        (node) => node.kind === "agent",
      )?.effort,
    ).toBe("high");
    expect(received).toHaveLength(3);
  } finally {
    await coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
