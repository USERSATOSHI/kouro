import { expect, test } from "bun:test";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAdapter } from "../src/types";
import { GitWorkspaceAdapter } from "../src/adapters/workspace/git";
import { ApplicationService, configureBundle } from "../src/application/service";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap";
import { fusionFixture, FusionFixtureHarness } from "../../../scripts/fusion-fixture";

async function terminal(service: ApplicationService, runId: string) {
  for (let count = 0; count < 500; count++) {
    const view = service.getView(runId)!;
    if (!["pending", "running"].includes(view.state.status)) return view;
    await Bun.sleep(10);
  }
  throw new Error("fusion fixture did not finish");
}

for (const nativeHarness of ["claude", "codex"] as const) {
  test(`${nativeHarness} fusion keeps member sessions, files and workspaces across rounds and restart`, async () => {
    const dataDir = await mkdtemp("/tmp/kouro-fusion-session-");
    const repositoryPath = join(dataDir, "repository");
    const workspaceAdapter = new GitWorkspaceAdapter({ worktreeRoot: join(dataDir, "worktrees") });
    if (nativeHarness === "claude") {
      await mkdir(repositoryPath);
      await writeFile(join(repositoryPath, "base.txt"), "source repository\n");
      for (const args of [
        ["init"],
        ["add", "base.txt"],
        ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "base"],
      ]) {
        const process = Bun.spawn(["git", ...args], {
          cwd: repositoryPath,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await process.exited).toBe(0);
      }
    }
    const fixture = new FusionFixtureHarness();
    const calls: Parameters<HarnessAdapter["run"]>[0][] = [];
    const sessions = new Map<string, { id: string; cwd: string }>();
    const sessionTurns = new Map<string, number>();
    let limited = false;
    const adapter: HarnessAdapter = {
      id: nativeHarness,
      adapterVersion: "fusion-session-fixture",
      capabilities: () => ({ ...fixture.capabilities(), resume: "supported" }),
      async run(input) {
        calls.push(input);
        const previous = sessions.get(input.modelId!);
        if (previous) {
          expect(input.resumeSession?.id).toBe(previous.id);
          expect(input.cwd).toBe(previous.cwd);
          expect(await readFile(join(input.cwd!, "research-notes.txt"), "utf8")).toBe(
            input.modelId!,
          );
        } else {
          expect(input.resumeSession).toBeUndefined();
          sessions.set(input.modelId!, {
            id: `${nativeHarness}-${input.modelId}`,
            cwd: input.cwd!,
          });
          await writeFile(join(input.cwd!, "research-notes.txt"), input.modelId!);
        }
        const result = await fixture.run(input);
        const turns = (sessionTurns.get(input.modelId!) ?? 0) + 1;
        sessionTurns.set(input.modelId!, turns);
        const metric = (value: number) => ({ value, quality: "observed", source: nativeHarness });
        const usage = {
          inputTokens: metric(turns * 100),
          outputTokens: metric(turns * 20),
          totalTokens: metric(turns * 120),
          cost: { value: null, quality: "unavailable" },
        };
        if (!limited && input.modelId === "model-a" && input.prompt.startsWith("review")) {
          limited = true;
          return {
            ...result,
            usage,
            usageScope: "session",
            status: "failed",
            error: "usage limit exceeded",
            stopReason: "usage-limit",
            session: { id: sessions.get(input.modelId!)!.id },
          };
        }
        return {
          ...result,
          usage,
          usageScope: "session",
          session: { id: sessions.get(input.modelId!)!.id },
        };
      },
    };
    const options = {
      dataDir,
      workspaceAdapter,
      harness: adapter,
      harnessAdapters: { [nativeHarness]: adapter },
      process: new FakeProcessAdapter(),
    };
    let service = new ApplicationService(options);
    await service.start();
    try {
      const bundle = await fusionFixture("fusion-session", 2, "files");
      const created = await service.coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        input: { task: "Compare approaches" },
        idempotencyKey: "sessions",
        ...(nativeHarness === "claude" ? { workspace: { repositoryPath } } : {}),
      });
      const runId = created.run.runId;
      expect((await terminal(service, runId)).state.status).toBe("paused");
      const review = calls.find(
        (call) => call.modelId === "model-a" && call.prompt.startsWith("review"),
      )!;
      const peerSegment = review.context!.segments.find((segment) =>
        segment.id.endsWith(":peer2"),
      )!;
      expect(peerSegment.source).toBe("artifact-input-file");
      const peerFile = JSON.parse(peerSegment.content);
      expect(JSON.parse(await readFile(peerFile.path, "utf8")).summary).toBe(
        "model-b draft round 0: Compare approaches",
      );
      expect(review.contextDirectories).toContain(
        join(
          dataDir,
          "workspaces",
          runId,
          calls.find((call) => call.modelId === "model-a")!.invocationId,
          "context-files",
        ),
      );
      await service.close();
      service = new ApplicationService(options);
      await service.start();
      expect(await readFile(peerFile.path, "utf8")).toContain("model-b");
      service.control({
        runId,
        action: "resume",
        expectedRevision: service.getView(runId)!.revision,
        actor: "test",
        idempotencyKey: "resume",
      });
      const view = await terminal(service, runId);
      expect(view.state.status).toBe("succeeded");
      expect(sessions.size).toBe(3);
      expect(new Set([...sessions.values()].map((session) => session.cwd)).size).toBe(3);
      for (const model of ["model-a", "model-b"]) {
        const memberCalls = calls.filter((call) => call.modelId === model);
        expect(memberCalls).toHaveLength(model === "model-a" ? 6 : 5);
        expect(
          memberCalls.slice(1).every((call) => call.resumeSession?.id === sessions.get(model)!.id),
        ).toBe(true);
      }
      const successful = Object.values(view.state.attempts).filter(
        (attempt) => attempt.status === "succeeded",
      );
      const countedTokens = Object.values(view.state.attempts).reduce(
        (sum, attempt) => sum + ((attempt.usage as any)?.totalTokens?.value ?? 0),
        0,
      );
      expect(countedTokens).toBe(calls.length * 120);
      expect(
        successful.filter(
          (attempt) => (attempt.sessionReference as any)?.continuation === "native-resume",
        ),
      ).toHaveLength(8);
      expect(calls.at(-1)!.resumeSession).toBeUndefined();
      expect(fixture.calls.at(-1)!.values.member1.summary).toBe("model-a revision round 2");
      expect(fixture.calls.at(-1)!.values.member2.summary).toBe("model-b revision round 2");
      if (nativeHarness === "claude") {
        const claims = await workspaceAdapter.listClaims(runId);
        expect(claims).toHaveLength(4); // main, two members, synthesis
        for (const claim of claims) {
          const snapshot = await workspaceAdapter.snapshot(claim);
          expect(
            snapshot.changedPaths.every((change) => !change.path.includes("context-files")),
          ).toBe(true);
        }
        expect(peerFile.path.startsWith(join(dataDir, "workspaces"))).toBe(true);
        expect(peerFile.path.startsWith(join(dataDir, "worktrees"))).toBe(false);
        expect(await readFile(join(repositoryPath, "base.txt"), "utf8")).toBe(
          "source repository\n",
        );
      }
      const deletion = await service.deleteRun({
        runId,
        expectedRevision: service.getView(runId)!.revision,
        idempotencyKey: "delete",
        actor: "test",
      });
      expect(deletion.status).toBe("completed");
      await expect(readFile(peerFile.path, "utf8")).rejects.toThrow("ENOENT");
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

test("same-model fusion members and repeated child scopes have independent native sessions", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-fusion-scope-");
  const report = artifactType<{ summary: string }>("scope-report", {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  });
  const child = new WorkflowBuilder({ id: "research" });
  const task = child.input("task", { type: "string" });
  const a = child.agent("a", { prompt: "draft", modelId: "same-model", produces: report });
  const b = child.agent("b", { prompt: "draft", modelId: "same-model", produces: report });
  const synthesis = child.agent("synthesis", {
    prompt: "synthesize",
    modelId: "same-model",
    produces: report,
  });
  const fusion = child
    .fusion("research", {
      task,
      rounds: 1,
      reviewProduces: report,
      reviewPrompt: "review",
      revisionPrompt: "revise",
      synthesis,
    })
    .use(a, b);
  child.startAt(fusion);
  child.output(fusion.output);
  child.sequence(fusion, child.complete("done", { output: fusion.output }));
  const workflow = new WorkflowBuilder({ id: "repeat-research" });
  const first = workflow.call("first", child, { input: { task: "First question" } });
  const second = workflow.call("second", child, { input: { task: "Second question" } });
  workflow.startAt(first);
  workflow.sequence(first, second, workflow.complete("done", { output: second.output }));
  const sessions = new Map<string, string>();
  const calls: Parameters<HarnessAdapter["run"]>[0][] = [];
  const adapter: HarnessAdapter = {
    id: "claude",
    adapterVersion: "scope-fixture",
    capabilities: () => ({
      resume: "supported",
      "structured-output": "supported",
      cancel: "supported",
    }),
    async run(input) {
      calls.push(input);
      const existing = sessions.get(input.cwd!);
      expect(input.resumeSession?.id).toBe(existing);
      const sessionId = existing ?? `session-${sessions.size}`;
      sessions.set(input.cwd!, sessionId);
      const question = JSON.parse(
        input.context!.segments.find((segment) => segment.id.endsWith(":task"))!.content,
      );
      const peer = input.context!.segments.find((segment) => /:peer\d+$/.test(segment.id));
      if (peer) expect(JSON.parse(peer.content).summary).toContain(question);
      return {
        status: "succeeded",
        output: { summary: `${question}: ${input.role}` },
        session: { id: sessionId },
        usage: {},
        events: [],
      };
    },
  };
  const service = new ApplicationService({
    dataDir,
    harness: adapter,
    harnessAdapters: { claude: adapter },
  });
  await service.start();
  try {
    const bundle = await compileWorkflow(workflow.build());
    const run = await service.coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "scope",
    });
    expect((await terminal(service, run.run.runId)).state.status).toBe("succeeded");
    expect(calls).toHaveLength(14);
    expect(sessions.size).toBe(6);
    expect(calls.filter((call) => call.resumeSession)).toHaveLength(8);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("fusion refuses a missing native session instead of silently researching again", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-fusion-missing-session-");
  const fixture = new FusionFixtureHarness();
  const adapter: HarnessAdapter = {
    id: "claude",
    adapterVersion: "missing-session-fixture",
    capabilities: () => ({ ...fixture.capabilities(), resume: "supported" }),
    run: (input) => fixture.run(input),
  };
  const service = new ApplicationService({
    dataDir,
    harness: adapter,
    harnessAdapters: { claude: adapter },
  });
  await service.start();
  try {
    const bundle = await fusionFixture("missing-session", 1);
    const run = await service.coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      input: { task: "Research" },
      idempotencyKey: "missing",
    });
    const view = await terminal(service, run.run.runId);
    expect(view.state.status).toBe("failed");
    expect(fixture.calls).toHaveLength(2);
    expect(
      Object.values(view.state.attempts).some((attempt) =>
        attempt.error?.includes("no saved native session"),
      ),
    ).toBe(true);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("fusion runs parallel drafts, reviews and revisions with stage barriers, final inputs and reload", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-fusion-");
  const harness = new FusionFixtureHarness();
  let service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
  await service.start();
  try {
    const source = await fusionFixture();
    const configured = await configureBundle(source, {
      "fusion-fixture:planning/planner-a": { modelId: "chosen-a", harness: "pi", effort: "high" },
    });
    const configuredAgents = configured.definitions["fusion-fixture:planning"]!.nodes.filter(
      (node) => node.kind === "agent",
    );
    expect(
      configuredAgents
        .filter((node) => node.fusion?.memberId === "planner-a")
        .map((node) => [node.modelId, node.harness, node.effort]),
    ).toEqual(Array(5).fill(["chosen-a", "pi", "high"]));
    expect(
      source.definitions["fusion-fixture:planning"]!.nodes.filter(
        (node) => node.kind === "agent",
      ).find((node) => node.id === "planner-a")?.modelId,
    ).toBe("model-a");
    expect(configuredAgents.find((node) => node.id === "fusion")?.modelId).toBe("model-fusion");
    const run = await service.coordinator.createRun({
      workflowId: source.rootDefinitionId,
      bundle: source,
      input: { task: "Compare approaches" },
      idempotencyKey: "fusion",
    });
    const view = await terminal(service, run.run.runId);
    expect(view.state.status).toBe("succeeded");
    expect(harness.calls).toHaveLength(11);
    for (const call of harness.calls.filter((call) => call.stage === "review")) {
      const previous = call.round === 1 ? "draft round 0: Compare approaches" : "revision round 1";
      expect(call.values.own.summary).toBe(`${call.model} ${previous}`);
      const peer = call.model === "model-a" ? "model-b" : "model-a";
      expect(call.values[call.model === "model-a" ? "peer2" : "peer1"].summary).toBe(
        `${peer} ${previous}`,
      );
    }
    for (const call of harness.calls.filter((call) => call.stage === "revision")) {
      expect(call.values.review1.summary).toBe(`model-a review round ${call.round}`);
      expect(call.values.review2.summary).toBe(`model-b review round ${call.round}`);
    }
    expect(harness.calls.at(-1)!.values.member1.summary).toBe("model-a revision round 2");
    expect(harness.calls.at(-1)!.values.member2.summary).toBe("model-b revision round 2");
    const attempts = Object.values(view.state.attempts);
    const stages = Array.from({ length: 5 }, (_, index) =>
      harness.calls.filter(
        (call) =>
          call.stage === (index === 0 ? "draft" : index % 2 ? "review" : "revision") &&
          call.round === Math.ceil(index / 2),
      ),
    );
    let previousEnd = 0;
    for (const stage of stages) {
      const pair = stage.map((call) =>
        attempts.find((attempt) => attempt.invocationId === call.invocationId)!,
      );
      const start = Math.min(...pair.map((attempt) => Date.parse(attempt.startedAt!)));
      const end = Math.max(...pair.map((attempt) => Date.parse(attempt.finishedAt!)));
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      expect(Math.max(...pair.map((attempt) => Date.parse(attempt.startedAt!)))).toBeLessThan(
        Math.min(...pair.map((attempt) => Date.parse(attempt.finishedAt!))),
      );
      previousEnd = end;
    }
    const synthesis = Object.values(view.state.invocations).find(
      (invocation) => invocation.nodeId === "fusion",
    )!;
    expect(
      JSON.parse(new TextDecoder().decode(service.readArtifact(synthesis.output[0]!.id))).summary,
    ).toBe("Combined: model-a revision round 2; model-b revision round 2");
    const call = Object.values(view.state.invocations).find(
      (invocation) =>
        invocation.scopeId === view.state.rootScopeId && invocation.nodeId === "planning",
    )!;
    expect(call.output).toEqual(synthesis.output);
    const persisted = JSON.stringify(view.state);
    await service.close();
    service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
    await service.start();
    expect(JSON.stringify(service.getView(run.run.runId)!.state)).toBe(persisted);
    expect(harness.calls).toHaveLength(11);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("review failure drains the other model and cancellation prevents later rounds", async () => {
  for (const mode of ["fail-review", "slow-review"] as const) {
    const dataDir = await mkdtemp("/tmp/kouro-fusion-stop-");
    const harness = new FusionFixtureHarness(mode);
    const service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
    await service.start();
    try {
      const bundle = await fusionFixture();
      const run = await service.coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        input: { task: "Stop review" },
        idempotencyKey: mode,
      });
      if (mode === "slow-review") {
        for (
          let count = 0;
          count < 300 && harness.calls.filter((call) => call.stage === "review").length < 2;
          count++
        )
          await Bun.sleep(10);
        expect(harness.calls.filter((call) => call.stage === "review")).toHaveLength(2);
        service.control({
          runId: run.run.runId,
          action: "cancel",
          expectedRevision: service.getView(run.run.runId)!.revision,
          actor: "test",
          idempotencyKey: "cancel",
        });
      }
      const view = await terminal(service, run.run.runId);
      expect(view.state.status).toBe(mode === "fail-review" ? "failed" : "cancelled");
      expect(
        harness.calls.some((call) => call.stage === "revision" || call.stage === "synthesis"),
      ).toBe(false);
      expect(
        Object.values(view.state.attempts).some((attempt) => attempt.status === "cancelled"),
      ).toBe(true);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("composed agents retain producer context and the shared task across call scopes", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-fusion-context-");
  const harness = new FusionFixtureHarness();
  const service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
  await service.start();
  try {
    const report = artifactType<{ summary: string }>("fusion-context", {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    });
    const workflow = new WorkflowBuilder({ id: "fusion-context" });
    const seed = workflow.agent("seed", {
      prompt: "draft",
      modelId: "seed-model",
      produces: report,
    });
    const a = workflow.agent("a", {
      prompt: "draft",
      modelId: "model-a",
      produces: report,
      input: { context: seed.output },
    });
    const b = workflow.agent("b", {
      prompt: "draft",
      modelId: "model-b",
      produces: report,
      input: { context: seed.output },
    });
    const synthesizer = workflow.agent("synthesizer", {
      prompt: "combine",
      modelId: "model-fusion",
      produces: report,
      input: { context: seed.output },
    });
    const fusion = workflow
      .fusion("planning", {
        task: "Shared literal task",
        rounds: 1,
        reviewProduces: report,
        reviewPrompt: "review",
        revisionPrompt: "revision",
        synthesis: synthesizer,
      })
      .use(a, b);
    workflow.startAt(seed);
    workflow.sequence(seed, fusion, workflow.complete("done", { output: fusion.output }));
    const bundle = await compileWorkflow(workflow.build());
    const run = await service.coordinator.createRun({
      workflowId: bundle.rootDefinitionId,
      bundle,
      idempotencyKey: "context",
    });
    expect((await terminal(service, run.run.runId)).state.status).toBe("succeeded");
    expect(harness.calls).toHaveLength(8);
    for (const call of harness.calls.slice(1)) {
      expect(call.values.task).toBe("Shared literal task");
      expect(call.values.context.summary).toBe("seed-model draft round 0: undefined");
    }
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

for (const decision of [false, true, undefined]) {
  test(`fusion convergence requires unanimous explicit no-revision decisions (${decision})`, async () => {
    const dataDir = await mkdtemp("/tmp/kouro-convergence-");
    const fixture = new FusionFixtureHarness();
    const harness: HarnessAdapter = {
      id: "scripted",
      adapterVersion: "convergence-fixture",
      capabilities: () => fixture.capabilities(),
      async run(input) {
        const result = await fixture.run(input);
        if (
          input.prompt.startsWith("review") &&
          result.output &&
          typeof result.output === "object" &&
          !Array.isArray(result.output)
        )
          return {
            ...result,
            output: {
              ...result.output,
              ...(decision === undefined && input.modelId === "model-b"
                ? {}
                : { needsRevision: decision ?? false }),
            },
          };
        return result;
      },
    };
    const service = new ApplicationService({ dataDir, harness, process: new FakeProcessAdapter() });
    await service.start();
    try {
      const bundle = await fusionFixture("convergence", 2);
      const created = await service.coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        input: { task: "Research" },
        idempotencyKey: "converge",
      });
      const view = await terminal(service, created.run.runId);
      expect(view.state.status).toBe("succeeded");
      expect(fixture.calls).toHaveLength(decision === false ? 5 : 11);
      expect(fixture.calls.filter((call) => call.stage === "synthesis")).toHaveLength(1);
      if (decision === false) {
        const final = fixture.calls.at(-1)!;
        expect(final.values.member1.summary).toContain("draft");
        expect(final.values.member2.summary).toContain("draft");
        expect(final.values.review1.needsRevision).toBe(false);
        expect(
          Object.values(view.state.attempts).filter((attempt) =>
            attempt.diagnostics?.some((note) => note.includes("no model call")),
          ),
        ).toHaveLength(6);
      }
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

for (const changeWorkspace of [false, true]) {
  test(`fusion reuses repository scouting per member and invalidates edits (${changeWorkspace})`, async () => {
    const dataDir = await mkdtemp("/tmp/kouro-scout-cache-");
    const repositoryPath = join(dataDir, "repository");
    await mkdir(repositoryPath);
    await writeFile(join(repositoryPath, "base.md"), "repository evidence");
    for (const args of [
      ["init"],
      ["add", "base.md"],
      ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "base"],
    ])
      expect(
        await Bun.spawn(["git", ...args], { cwd: repositoryPath, stdout: "pipe", stderr: "pipe" })
          .exited,
      ).toBe(0);
    const report = artifactType<{ summary: string; needsRevision?: boolean }>("cache-report", {
      type: "object",
      properties: { summary: { type: "string" }, needsRevision: { type: "boolean" } },
      required: ["summary"],
      additionalProperties: false,
    });
    const workflow = new WorkflowBuilder({ id: "cache-research" });
    const task = workflow.input("task", { type: "string" });
    const scout = workflow.subagent("repositoryScout", {
      role: "scout",
      prompt: "Inspect",
      produces: report,
      input: { task: { type: "string" }, question: { type: "string" } },
    });
    const a = workflow.agent("a", {
      prompt: "Draft",
      modelId: "a",
      produces: report,
      uses: [scout],
    });
    const b = workflow.agent("b", {
      prompt: "Draft",
      modelId: "b",
      produces: report,
      uses: [scout],
    });
    const synthesis = workflow.agent("synthesis", { prompt: "Combine", produces: report });
    const fusion = workflow
      .fusion("research", {
        task,
        rounds: 2,
        reviewProduces: report,
        reviewPrompt: "Review",
        revisionPrompt: "Revise",
        synthesis,
      })
      .use(a, b);
    workflow.startAt(fusion);
    workflow.sequence(fusion, workflow.complete("done", { output: fusion.output }));
    let childCalls = 0;
    const sessions = new Map<string, string>();
    const harness: HarnessAdapter = {
      id: "claude",
      adapterVersion: "cache-fixture",
      capabilities: () => ({
        resume: "supported",
        "awaited-subagent-tool": "supported",
        "child-read-only-envelope": "supported",
      }),
      async run(input): ReturnType<HarnessAdapter["run"]> {
        if (input.role === "scout") {
          childCalls++;
          return {
            status: "succeeded",
            output: { summary: "scouted evidence" },
            events: [],
            usage: {},
          };
        }
        const id =
          sessions.get(input.modelId ?? "synthesis") ?? `session-${input.modelId ?? "synthesis"}`;
        sessions.set(input.modelId ?? "synthesis", id);
        if (
          changeWorkspace &&
          input.modelId === "a" &&
          input.prompt.startsWith("Review") &&
          input.prompt.includes("round 1")
        )
          await writeFile(join(input.cwd!, "new-evidence.md"), "changed evidence");
        if (input.collaboration?.subagent)
          expect(
            (
              await input.collaboration.subagent({
                subagentId: "repositoryScout",
                requestId: `scout-${input.invocationId}`,
                input: { task: "Research", question: "Inspect repository files" },
              })
            ).state,
          ).toBe("succeeded");
        return {
          status: "succeeded",
          output: { summary: "evidence", needsRevision: true },
          session: { id },
          events: [],
          usage: {},
        };
      },
    };
    const service = new ApplicationService({
      dataDir,
      harness,
      harnessAdapters: { claude: harness },
      workspaceAdapter: new GitWorkspaceAdapter({ worktreeRoot: join(dataDir, "worktrees") }),
      process: new FakeProcessAdapter(),
    });
    await service.start();
    try {
      const bundle = await compileWorkflow(workflow.build());
      const created = await service.coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        workspace: { repositoryPath },
        input: { task: "Research" },
        idempotencyKey: "cache",
      });
      const view = await terminal(service, created.run.runId);
      expect(view.state.status).toBe("succeeded");
      expect(childCalls).toBe(changeWorkspace ? 3 : 2);
      expect(
        service.coordinator.journal.db
          .query("SELECT request_id FROM scout_requests WHERE run_id=?1 AND state='succeeded'")
          .all(created.run.runId),
      ).toHaveLength(10);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
