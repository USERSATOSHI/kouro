import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import type { Options, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { ClaudeAgentSdkHarnessAdapter } from "../src/adapters/harness/claude-agent-sdk";
import {
  CodexAppServerHarness,
  inspectCodex,
  type CodexAppServerConnection,
} from "../src/adapters/harness/codex";
import { ApplicationService } from "../src/application/service";
import { compileTask } from "../src/application/tasks";
import { parseTaskArgs, taskCommand } from "../src/cli/tasks";
import type { HarnessAdapter } from "../src/types";

test("Claude retains interrupted conversations without imposing a default turn cap", async () => {
  const received: Options[] = [];
  const provider: typeof query = (args) => {
    received.push(args.options!);
    return (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: "claude-session",
      } as unknown as SDKMessage;
      if (!args.options?.resume) {
        yield {
          type: "result",
          subtype: "error_max_turns",
          session_id: "claude-session",
          errors: [],
        } as unknown as SDKMessage;
        throw new Error("query ended");
      }
      yield {
        type: "result",
        subtype: "success",
        session_id: "claude-session",
        result: '{"summary":"continued research"}',
      } as unknown as SDKMessage;
    })() as ReturnType<typeof query>;
  };
  const adapter = new ClaudeAgentSdkHarnessAdapter(provider);
  const input = {
    runId: "run",
    invocationId: "agent",
    role: "research",
    prompt: "Research",
    delayMs: 0,
  };
  const failed = await adapter.run(input);
  expect(failed).toMatchObject({
    status: "failed",
    session: { id: "claude-session" },
    stopReason: "turn-limit",
  });
  expect(received[0]).not.toHaveProperty("maxTurns");
  expect(received[0]).not.toHaveProperty("maxBudgetUsd");
  const resumed = await adapter.run({
    ...input,
    resumeSession: failed.session,
    contextDirectories: ["/tmp/kouro-test-notes"],
  });
  expect(received[1]?.resume).toBe("claude-session");
  expect(received[1]).not.toHaveProperty("maxTurns");
  expect(received[1]?.persistSession).toBe(true);
  expect(received[1]?.additionalDirectories).toEqual(["/tmp/kouro-test-notes"]);
  expect(resumed).toMatchObject({
    status: "succeeded",
    output: { summary: "continued research" },
    session: { id: "claude-session" },
  });
});

test("Codex keeps its thread after a usage limit and resumes that exact thread", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const adapter = new CodexAppServerHarness(await inspectCodex(), () => {
    let listener: Parameters<CodexAppServerConnection["subscribe"]>[0] | undefined;
    let resumed = false;
    return {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/start" || method === "thread/resume") {
          resumed = method === "thread/resume";
          return { ok: true, value: { thread: { id: "codex-thread" } } };
        }
        if (method === "turn/start") {
          setTimeout(
            () =>
              listener?.({
                method: "turn/completed",
                params: {
                  threadId: "codex-thread",
                  turn: resumed
                    ? {
                        id: "turn",
                        status: "completed",
                        items: [
                          { id: "reply", type: "agentMessage", text: '{"summary":"continued"}' },
                        ],
                      }
                    : {
                        id: "turn",
                        status: "failed",
                        error: { message: "Try again later", codexErrorInfo: "usageLimitExceeded" },
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
      async dispose() {},
    };
  });
  const input = {
    attemptId: "agent",
    role: { id: "research", prompt: "Research" },
    selection: { harness: "codex" as const, model: { id: "fixture" } },
    cwd: "/tmp",
  };
  const failed = await adapter.run(input);
  expect(failed).toMatchObject({
    status: "failed",
    session: { id: "codex-thread" },
    stopReason: "usage-limit",
  });
  expect((await adapter.run({ ...input, resumeSession: failed.session })).status).toBe("succeeded");
  expect(calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  expect(calls.find((call) => call.method === "thread/resume")?.params.threadId).toBe(
    "codex-thread",
  );
});

test("Claude uses structured quota signals and retains the reported reset time", async () => {
  const provider: typeof query = () =>
    (async function* () {
      yield {
        type: "rate_limit_event",
        session_id: "quota-session",
        rate_limit_info: { status: "rejected", resetsAt: 1800000000 },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "error_during_execution",
        session_id: "quota-session",
        errors: ["Provider stopped"],
      } as unknown as SDKMessage;
    })() as ReturnType<typeof query>;
  expect(
    await new ClaudeAgentSdkHarnessAdapter(provider).run({
      runId: "run",
      invocationId: "agent",
      role: "research",
      prompt: "Research",
      delayMs: 0,
    }),
  ).toMatchObject({
    status: "failed",
    stopReason: "usage-limit",
    resumeAfter: new Date(1800000000 * 1000).toISOString(),
    session: { id: "quota-session" },
  });
});

async function settled(service: ApplicationService, runId: string) {
  for (let i = 0; i < 400; i++) {
    await service.coordinator.waitForCheckpointDrain(runId);
    const view = service.getView(runId)!;
    if (!["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(5);
  }
  throw new Error("research did not settle");
}

for (const harness of ["claude", "codex"] as const) {
  for (const legacy of [false, true]) {
    if (legacy && harness !== "claude") continue;
    test(`${harness} task resume preserves successful parallel research after restart${legacy ? " using legacy SDK evidence" : ""}`, async () => {
      const directory = await mkdtemp("/tmp/kouro-session-continuation-");
      const calls: Parameters<HarnessAdapter["run"]>[0][] = [];
      const adapter: HarnessAdapter = {
        id: harness,
        adapterVersion: harness === "claude" ? "agent-sdk" : "app-server",
        capabilities: () => ({
          resume: "supported",
          cancel: "supported",
          "structured-output": "supported",
        }),
        async run(input): Promise<Awaited<ReturnType<HarnessAdapter["run"]>>> {
          calls.push(input);
          if (input.role === "task-decomposer")
            return {
              status: "succeeded",
              events: [],
              usage: {},
              output: {
                milestones: [
                  {
                    id: "research",
                    title: "Research",
                    task: "Research",
                    workflowId: "research",
                    dependsOn: [],
                  },
                ],
              },
            };
          if (input.role === "good") await Bun.sleep(25);
          if (input.role === "limited" && !input.resumeSession) {
            await writeFile(pathJoin(input.cwd!, "research.txt"), "Research already gathered");
            return {
              status: "failed",
              error: legacy ? "research interrupted" : "usage limit exceeded",
              events: [],
              usage: {},
              ...(legacy
                ? {
                    rawOutput: JSON.stringify([
                      { type: "system", subtype: "init", session_id: "research-session" },
                    ]),
                  }
                : { session: { id: "research-session" } }),
            };
          }
          if (input.role === "limited") {
            expect(input.resumeSession?.id).toBe("research-session");
            expect(await readFile(pathJoin(input.cwd!, "research.txt"), "utf8")).toBe(
              "Research already gathered",
            );
          }
          return {
            status: "succeeded",
            output: { summary: input.role },
            events: [],
            usage: {},
            session: { id: `${input.role}-session` },
          };
        },
      };
      const report = artifactType<{ summary: string }>("research-report", {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      });
      const research = new WorkflowBuilder({ id: "research", limits: { maxAttempts: 16 } });
      const task = research.input("task", { type: "string" });
      const good = research.agent("good", {
        role: "good",
        prompt: "Research A",
        input: { task },
        produces: report,
      });
      const limited = research.agent("limited", {
        role: "limited",
        prompt: "Research B",
        input: { task },
        produces: report,
      });
      const fork = research.parallel("researchers", { branches: [good, limited] });
      const join = research.join("join", {
        groupId: "researchers",
        mode: legacy ? "all-settled" : "fail-fast",
      });
      const done = research.complete("done", { output: join.output });
      research.startAt(fork);
      fork.on("success").to(join);
      good.on("success").to(join);
      limited.on("success").to(join);
      join.on("success").to(done);
      const researchBundle = await compileWorkflow(research.build());
      const model = { harness, modelId: "fixture" };
      const bundle = await compileTask(
        [
          {
            id: "research",
            name: "Research",
            version: "1",
            digest: researchBundle.digest,
            bundle: researchBundle,
          },
        ],
        model,
        model,
        1,
        1,
      );
      const options = {
        dataDir: directory,
        harness: adapter,
        harnessAdapters: { [harness]: adapter },
        scriptedDelayMs: 1,
      };
      let service = new ApplicationService(options);
      try {
        await service.start();
        const created = await service.coordinator.createRun({
          workflowId: "research-task",
          bundle,
          input: { task: "Research" },
          idempotencyKey: "run",
        });
        const runId = created.run.runId;
        const before = await settled(service, runId);
        expect(before.state.status).toBe(legacy ? "failed" : "paused");
        const goodInvocation = Object.values(before.state.invocations).find(
          (item) => item.nodeId === "good",
        )!;
        expect(goodInvocation.status).toBe("succeeded");
        const savedOutput = goodInvocation.output;
        expect(savedOutput).toHaveLength(1);
        await service.close();
        service = new ApplicationService(options);
        await service.start();
        expect(service.operatorState(runId)?.capabilities.resume).toBe(true);
        const records: unknown[] = [];
        expect(
          await taskCommand(parseTaskArgs(["resume", runId]), service, (value) =>
            records.push(value),
          ),
        ).toBe(0);
        const after = await settled(service, runId);
        expect(after.state.status).toBe("succeeded");
        expect(after.state.invocations[goodInvocation.id]!.output).toEqual(savedOutput);
        expect(calls.filter((call) => call.role === "good")).toHaveLength(1);
        expect(calls.filter((call) => call.role === "task-decomposer")).toHaveLength(1);
        expect(calls.filter((call) => call.role === "limited")).toHaveLength(2);
        expect(service.coordinator.milestones(runId).milestones[0]?.status).toBe("succeeded");
      } finally {
        await service.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const scenario of ["missing-session", "changed-harness", "reset-wait", "consumed"] as const) {
  test(`continuation guard: ${scenario}`, async () => {
    const directory = await mkdtemp("/tmp/kouro-session-guard-");
    let calls = 0;
    let adapterVersion = "fixture-v1";
    const adapter: HarnessAdapter = {
      id: "claude",
      get adapterVersion() {
        return adapterVersion;
      },
      capabilities: () => ({ resume: "supported", cancel: "supported" }),
      async run(input) {
        calls++;
        if (input.resumeSession)
          return {
            status: "succeeded",
            output: "continued",
            session: input.resumeSession,
            events: [],
            usage: {},
          };
        return {
          status: "failed",
          error: scenario === "consumed" ? "research interrupted" : "usage limit exceeded",
          ...(scenario === "missing-session" ? {} : { session: { id: "saved-session" } }),
          events: [],
          usage: {},
        };
      },
    };
    const builder = new WorkflowBuilder({
      id: "continuation-guard",
      limits: { maxRunDurationMs: scenario === "reset-wait" ? 800 : 60_000 },
    });
    const agent = builder.agent("research", {
      role: "research",
      harness: "claude",
      prompt: "Research",
    });
    builder.startAt(agent);
    agent.on("success").to(builder.complete("done"));
    if (scenario === "consumed") {
      const consumer = builder.agent("consumer", {
        role: "consumer",
        harness: "claude",
        prompt: "Consume failure",
      });
      agent.on("failure").to(consumer);
      consumer.on("success").to(builder.complete("consumer-done"));
      consumer.on("failure").to(builder.complete("failed", { result: "failed" }));
    }
    const bundle = await compileWorkflow(builder.build());
    const options = { dataDir: directory, harness: adapter, harnessAdapters: { claude: adapter } };
    let service = new ApplicationService(options);
    try {
      await service.start();
      const created = await service.coordinator.createRun({
        workflowId: builder.id,
        bundle,
        idempotencyKey: "guard",
      });
      const runId = created.run.runId;
      const before = await settled(service, runId);
      const invocation = Object.values(before.state.invocations).find(
        (item) => item.nodeId === "research",
      )!;
      if (scenario === "missing-session") {
        expect(service.operatorState(runId)?.capabilities.resume).toBe(false);
        expect(() =>
          service.control({
            runId,
            action: "resume",
            expectedRevision: before.revision,
            actor: "test",
            idempotencyKey: "resume",
          }),
        ).toThrow("Native session continuation is unavailable");
        expect(calls).toBe(1);
      } else if (scenario === "consumed") {
        expect(before.state.status).toBe("failed");
        expect(service.coordinator.canRetry(runId, invocation.id)).toBe(false);
        expect(() =>
          service.retry({
            runId,
            invocationId: invocation.id,
            expectedRevision: before.revision,
            actor: "test",
            idempotencyKey: "retry",
          }),
        ).toThrow("unconsumed");
        expect(calls).toBe(2);
      } else {
        await service.close();
        if (scenario === "changed-harness") adapterVersion = "fixture-v2";
        else await Bun.sleep(900);
        service = new ApplicationService(options);
        await service.start();
        expect(service.getView(runId)!.state.status).toBe("paused");
        service.control({
          runId,
          action: "resume",
          expectedRevision: service.getView(runId)!.revision,
          actor: "test",
          idempotencyKey: "resume",
        });
        const after = await settled(service, runId);
        if (scenario === "changed-harness") {
          expect(after.state.status).toBe("failed");
          expect(after.state.invocations[invocation.id]!.error).toContain(
            "harness, model, workspace or permissions changed",
          );
          expect(calls).toBe(1);
        } else {
          expect(after.state.status).toBe("succeeded");
          expect(after.state.budgetPausedMs).toBeGreaterThanOrEqual(900);
          expect(calls).toBe(2);
        }
      }
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const { harness, missingChild } of [
  { harness: "claude", missingChild: false },
  { harness: "codex", missingChild: false },
  { harness: "claude", missingChild: true },
] as const) {
  test(`${harness} continuation ${missingChild ? "refuses a child without a saved session" : "resumes a limited subagent and reuses completed child output"}`, async () => {
    const directory = await mkdtemp("/tmp/kouro-child-continuation-");
    const calls: Parameters<HarnessAdapter["run"]>[0][] = [];
    const adapter: HarnessAdapter = {
      id: harness,
      adapterVersion: "child-session-fixture",
      capabilities: () => ({
        resume: "supported",
        cancel: "supported",
        "awaited-subagent-tool": "supported",
        "child-read-only-envelope": "supported",
      }),
      async run(input): Promise<Awaited<ReturnType<HarnessAdapter["run"]>>> {
        calls.push(input);
        if (input.role === "parent") {
          if (input.resumeSession) expect(input.resumeSession.id).toBe("parent-session");
          for (const id of ["good", "limited"])
            await input.collaboration!.subagent!({
              subagentId: id,
              requestId: id,
              input: { question: `Research ${id}` },
            });
          return {
            status: "succeeded",
            output: { summary: "Research" },
            session: { id: "parent-session" },
            usage: {},
            events: [],
          };
        }
        if (input.role === "limited" && !input.resumeSession)
          return {
            status: "failed",
            error: "Provider stopped",
            stopReason: "usage-limit",
            ...(missingChild ? {} : { session: { id: "child-session" } }),
            usage: {},
            events: [],
          };
        if (input.role === "limited") expect(input.resumeSession?.id).toBe("child-session");
        return {
          status: "succeeded",
          output: { summary: input.role },
          usage: {},
          events: [],
          session: input.resumeSession,
        };
      },
    };
    const report = artifactType<{ summary: string }>("child-report", {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    });
    const builder = new WorkflowBuilder({ id: "child-sessions" });
    const good = builder.subagent("good", {
      role: "good",
      prompt: "Research",
      input: { question: { type: "string" } },
      produces: report,
    });
    const limited = builder.subagent("limited", {
      role: "limited",
      prompt: "Research",
      input: { question: { type: "string" } },
      produces: report,
    });
    const parent = builder.agent("parent", {
      role: "parent",
      harness,
      modelId: "fixture",
      prompt: "Research",
      uses: [good, limited],
      produces: report,
    });
    builder.startAt(parent);
    builder.sequence(parent, builder.complete("done"));
    const bundle = await compileWorkflow(builder.build());
    const options = {
      dataDir: directory,
      harness: adapter,
      harnessAdapters: { [harness]: adapter },
      scriptedDelayMs: 1,
    };
    let service = new ApplicationService(options);
    try {
      await service.start();
      const created = await service.coordinator.createRun({
        workflowId: builder.id,
        bundle,
        idempotencyKey: "children",
      });
      const runId = created.run.runId;
      expect((await settled(service, runId)).state.status).toBe("paused");
      const goodDigest = service.coordinator.scouts
        .requests(runId)
        .find((request) => request.scoutId === "good")!.resultDigest;
      await service.close();
      service = new ApplicationService(options);
      await service.start();
      if (missingChild) {
        expect(service.operatorState(runId)?.capabilities.resume).toBe(false);
        expect(() =>
          service.control({
            runId,
            action: "resume",
            expectedRevision: service.getView(runId)!.revision,
            actor: "test",
            idempotencyKey: "continue",
          }),
        ).toThrow("saved session ID is missing");
        expect(calls.filter((call) => call.role === "parent")).toHaveLength(1);
        expect(calls.filter((call) => call.role === "limited")).toHaveLength(1);
        return;
      }
      service.control({
        runId,
        action: "resume",
        expectedRevision: service.getView(runId)!.revision,
        actor: "test",
        idempotencyKey: "continue",
      });
      expect((await settled(service, runId)).state.status).toBe("succeeded");
      expect(calls.filter((call) => call.role === "good")).toHaveLength(1);
      expect(calls.filter((call) => call.role === "limited")).toHaveLength(2);
      const requests = service.coordinator.scouts.requests(runId);
      expect(
        requests
          .filter((request) => request.scoutId === "good")
          .map((request) => request.resultDigest),
      ).toEqual([goodDigest, goodDigest]);
      expect(
        requests.filter((request) => request.scoutId === "limited").at(-1)?.sessionReference,
      ).toMatchObject({ id: "child-session" });
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Claude query budgets retain structured stop reasons, cache counters and configurable caps", async () => {
  const received: Options[] = [];
  const provider: typeof query = (args) => {
    received.push(args.options!);
    return (async function* () {
      yield {
        type: "result",
        subtype: "error_max_budget_usd",
        session_id: "budget-session",
        errors: ["Spending guard stopped this request"],
        modelUsage: {
          fixture: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 20,
            costUSD: 0.5,
          },
        },
      } as unknown as SDKMessage;
    })() as ReturnType<typeof query>;
  };
  const adapter = new ClaudeAgentSdkHarnessAdapter(provider);
  const result = await adapter.run({
    runId: "run",
    invocationId: "agent",
    role: "research",
    prompt: "Research",
    delayMs: 0,
    nativeConfig: { maxNativeTurns: 8, maxBudgetUsd: 0.5 },
  });
  expect(received[0]).toMatchObject({ maxTurns: 8, maxBudgetUsd: 0.5 });
  expect(result).toMatchObject({
    status: "failed",
    stopReason: "budget-limit",
    session: { id: "budget-session" },
    usage: {
      inputTokens: { value: 130 },
      uncachedInputTokens: { value: 10 },
      cacheReadInputTokens: { value: 100 },
      cacheCreationInputTokens: { value: 20 },
    },
  });
  const invalid = await adapter.run({
    runId: "run",
    invocationId: "agent",
    role: "research",
    prompt: "Research",
    delayMs: 0,
    nativeConfig: { maxNativeTurns: 0 },
  });
  expect(invalid.status).toBe("failed");
  expect(received).toHaveLength(1);
});
