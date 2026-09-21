import { describe, expect, test } from "bun:test";
import {
  WorkflowBuilder,
  HARNESS,
  artifactType,
  compileWorkflow,
  compileWorkflowDetailed,
  createInitialState,
  decide,
  reduceEvent,
  type LifecycleEvent,
  isHarness,
} from "../src/index";

const task = artifactType<string>("Task", { type: "string" });

function tinyWorkflow() {
  const workflow = new WorkflowBuilder({ id: "tiny", version: "1" });
  const agent = workflow.agent("agent", {
    prompt: "say hello",
    produces: task,
    scripted: { delayMs: 5, output: "hello" },
  });
  const command = workflow.command("command", { executable: "/usr/bin/printf", args: ["hello"] });
  const done = workflow.complete("done", { input: { evidence: command.output } });
  workflow.sequence(agent, command, done);
  workflow.startAt(agent);
  return workflow;
}

function event<T extends LifecycleEvent["type"]>(
  runId: string,
  sequence: number,
  type: T,
  payload: unknown,
  recordedAt = `2026-09-18T00:00:${String(sequence).padStart(2, "0")}Z`,
): LifecycleEvent {
  return {
    eventId: `${runId}-${sequence}`,
    runId,
    sequence,
    schemaVersion: 1,
    type,
    recordedAt,
    payload,
  } as LifecycleEvent;
}

describe("@kouro/core M1 kernel", () => {
  test("exposes only provider harnesses for per-agent selection", () => {
    expect(HARNESS).toEqual(["codex", "pi", "claude", "opencode"]);
    expect(isHarness("scripted")).toBe(false);
    expect(isHarness("codex")).toBe(true);
  });

  test("compiles a browser-safe scripted agent -> command -> complete bundle", async () => {
    const bundle = await compileWorkflow(tinyWorkflow().build());
    expect(bundle.formatVersion).toBe(1);
    expect(bundle.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle.definitions.tiny.nodes.map((node) => node.kind)).toEqual([
      "agent",
      "command",
      "complete",
    ]);
    const command = bundle.definitions.tiny.nodes.find((node) => node.kind === "command");
    expect(command?.outputPorts[0]?.schemaDigest).toMatch(/^sha256:/);
  });

  test("preserves per-agent harness overrides alongside model IDs", async () => {
    const workflow = new WorkflowBuilder({ id: "mixed-harness", version: "1" });
    const codex = workflow.agent("codex", {
      harness: "codex",
      modelId: "gpt-5",
      prompt: "plan",
    });
    const pi = workflow.agent("pi", {
      harness: "pi",
      modelId: "llama.cpp/local",
      prompt: "implement",
    });
    const done = workflow.complete("done");
    workflow.sequence(codex, pi, done);
    workflow.startAt(codex);

    const nodes = (await compileWorkflow(workflow.build())).definitions["mixed-harness"].nodes;
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", harness: "codex", modelId: "gpt-5" }),
        expect.objectContaining({
          id: "pi",
          harness: "pi",
          modelId: "llama.cpp/local",
        }),
      ]),
    );
  });

  test("rejects harness overrides outside the defined harness list", async () => {
    const workflow = new WorkflowBuilder({ id: "invalid-harness", version: "1" });
    workflow.agent("agent", { prompt: "test" });
    const source = workflow.build();
    (source.nodes[0] as { harness?: string }).harness = "unknown";
    const result = await compileWorkflowDetailed(source);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_HARNESS" })]),
    );
  });

  test("canonical bundle identity is stable and detached from mutable source", async () => {
    const workflow = tinyWorkflow();
    const source = workflow.build();
    const first = await compileWorkflow(source);
    (source.nodes[0] as { prompt?: string }).prompt = "mutated after compile";
    const second = await compileWorkflow(tinyWorkflow().build());
    expect(first.digest).toBe(second.digest);
    expect(first.canonicalJson).not.toContain("mutated after compile");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.definitions.tiny.nodes)).toBe(true);
  });

  test("handles from another builder are rejected even when workflow IDs match", () => {
    const left = new WorkflowBuilder({ id: "same" });
    const right = new WorkflowBuilder({ id: "same" });
    const foreign = right.agent("foreign", { prompt: "foreign", produces: task });
    expect(() => left.agent("local", { prompt: "local", input: { task: foreign.output } })).toThrow(
      /another WorkflowBuilder/,
    );
  });

  test("only exposes declared agent output while commands always expose their standard result", () => {
    const workflow = new WorkflowBuilder({ id: "handles" });
    const agent = workflow.agent("implement", { prompt: "implement" });
    const command = workflow.command("validate", { executable: "/usr/bin/true" });
    const done = workflow.complete("done");
    expect("output" in agent).toBe(false);
    expect(command.output.sourceId).toBe("validate");
    expect("output" in done).toBe(false);
  });

  test("rejects unsupported M1 graph semantics with diagnostics", async () => {
    const workflow = new WorkflowBuilder({ id: "invalid" });
    const a = workflow.agent("a", { prompt: "a", produces: task });
    const b = workflow.complete("b");
    workflow.startAt(a);
    a.on("success").to(b, { guard: { literal: true } });
    const result = await import("../src/compiler").then(({ compileWorkflowDetailed }) =>
      compileWorkflowDetailed(workflow.build()),
    );
    expect(result.bundle).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "UNSUPPORTED_EDGE_FEATURE",
    );
  });

  test("decisions and reducer advance one deterministic lifecycle fact at a time", async () => {
    const bundle = await compileWorkflow(tinyWorkflow().build());
    let state = createInitialState("run-1", "scope-1");
    state = reduceEvent(state, event("run-1", 1, "run.started", { rootScopeId: "scope-1" }));
    expect(decide(bundle, state)).toEqual([
      { kind: "activate", scopeId: "scope-1", nodeId: "agent", bindings: {} },
    ]);

    state = reduceEvent(
      state,
      event("run-1", 2, "invocation.created", {
        invocationId: "inv-agent",
        nodeId: "agent",
        scopeId: "scope-1",
      }),
    );
    expect(decide(bundle, state)[0]).toEqual({
      kind: "reserve",
      invocationId: "inv-agent",
      attemptOrdinal: 0,
    });
    state = reduceEvent(
      state,
      event("run-1", 3, "attempt.reserved", { attemptId: "att-agent", invocationId: "inv-agent" }),
    );
    expect(decide(bundle, state)[0]).toEqual({
      kind: "execute",
      invocationId: "inv-agent",
      attemptId: "att-agent",
    });
    state = reduceEvent(state, event("run-1", 4, "attempt.started", { attemptId: "att-agent" }));
    state = reduceEvent(
      state,
      event("run-1", 5, "attempt.completed", {
        attemptId: "att-agent",
        status: "succeeded",
        output: [{ id: "artifact-task", digest: "sha256:task" }],
      }),
    );
    state = reduceEvent(
      state,
      event("run-1", 6, "invocation.completed", {
        invocationId: "inv-agent",
        status: "succeeded",
        output: [{ id: "artifact-task", digest: "sha256:task" }],
      }),
    );
    expect(decide(bundle, state)).toEqual([
      {
        kind: "activate",
        scopeId: "scope-1",
        nodeId: "command",
        bindings: {},
        sourceEdgeId: "agent:success:command:0",
        sourceInvocationId: "inv-agent",
      },
    ]);

    state = reduceEvent(
      state,
      event("run-1", 7, "invocation.created", {
        invocationId: "inv-command",
        nodeId: "command",
        scopeId: "scope-1",
        sourceInvocationId: "inv-agent",
        sourceEdgeId: "agent:success:command:0",
      }),
    );
    state = reduceEvent(
      state,
      event("run-1", 8, "attempt.reserved", {
        attemptId: "att-command",
        invocationId: "inv-command",
      }),
    );
    state = reduceEvent(state, event("run-1", 9, "attempt.started", { attemptId: "att-command" }));
    state = reduceEvent(
      state,
      event("run-1", 10, "attempt.completed", {
        attemptId: "att-command",
        status: "succeeded",
        output: [{ id: "result-command", digest: "sha256:result" }],
        evidence: [{ id: "evidence-command", digest: "sha256:evidence" }],
        commandEvidence: {
          kind: "command.evidence",
          executable: "/usr/bin/printf",
          args: ["hello"],
          exitCode: 0,
          signal: null,
          timeout: false,
          spawnError: null,
        },
      }),
    );
    state = reduceEvent(
      state,
      event("run-1", 11, "invocation.completed", {
        invocationId: "inv-command",
        status: "succeeded",
        output: [{ id: "result-command", digest: "sha256:result" }],
        evidence: [{ id: "evidence-command", digest: "sha256:evidence" }],
      }),
    );
    expect(decide(bundle, state)).toEqual([
      {
        kind: "activate",
        scopeId: "scope-1",
        nodeId: "done",
        sourceInvocationId: "inv-command",
        sourceEdgeId: "command:success:done:1",
        bindings: {
          evidence: {
            source: { kind: "producer", sourceId: "command", port: "output" },
            artifactId: "result-command",
            missing: "error",
          },
        },
      },
    ]);
    state = reduceEvent(
      state,
      event("run-1", 12, "invocation.created", {
        invocationId: "inv-done",
        nodeId: "done",
        scopeId: "scope-1",
        sourceInvocationId: "inv-command",
        sourceEdgeId: "command:success:done:1",
      }),
    );
    expect(decide(bundle, state)).toEqual([
      { kind: "complete", invocationId: "inv-done", outcome: "succeeded" },
    ]);
    state = reduceEvent(
      state,
      event("run-1", 13, "invocation.completed", {
        invocationId: "inv-done",
        status: "succeeded",
        direct: true,
      }),
    );
    expect(decide(bundle, state)).toEqual([{ kind: "finish", status: "succeeded" }]);
    state = reduceEvent(state, event("run-1", 14, "run.completed", { status: "succeeded" }));
    expect(state.status).toBe("succeeded");
    expect(state.finishedAt).not.toBeNull();
  });

  test("reducer rejects sequence gaps and terminal lifecycle mutations", () => {
    let state = createInitialState("run-2", "scope-2");
    state = reduceEvent(state, event("run-2", 1, "run.started", { rootScopeId: "scope-2" }));
    expect(() =>
      reduceEvent(state, event("run-2", 3, "run.completed", { status: "succeeded" })),
    ).toThrow(/revision \+ 1/);
  });

  test("a failed invocation without a failure route deterministically fails the run", async () => {
    const bundle = await compileWorkflow(tinyWorkflow().build());
    let state = createInitialState("run-failed", "scope-failed");
    state = reduceEvent(
      state,
      event("run-failed", 1, "run.started", { rootScopeId: "scope-failed" }),
    );
    state = reduceEvent(
      state,
      event("run-failed", 2, "invocation.created", {
        invocationId: "inv-agent",
        nodeId: "agent",
        scopeId: "scope-failed",
      }),
    );
    state = reduceEvent(
      state,
      event("run-failed", 3, "attempt.reserved", {
        attemptId: "att-agent",
        invocationId: "inv-agent",
      }),
    );
    state = reduceEvent(
      state,
      event("run-failed", 4, "attempt.started", { attemptId: "att-agent" }),
    );
    state = reduceEvent(
      state,
      event("run-failed", 5, "attempt.completed", {
        attemptId: "att-agent",
        status: "failed",
        error: "fixture failure",
      }),
    );
    state = reduceEvent(
      state,
      event("run-failed", 6, "invocation.completed", {
        invocationId: "inv-agent",
        status: "failed",
        error: "fixture failure",
      }),
    );
    expect(decide(bundle, state)).toEqual([{ kind: "finish", status: "failed" }]);
  });
});
