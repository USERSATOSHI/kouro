import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { WorkflowBuilder, artifactType, compileWorkflow, type ContextManifest } from "@kouro/core";
import {
  CodexAppServerHarness,
  CodexHarnessAdapter,
  inspectCodex,
} from "../src/adapters/harness/codex.ts";
import { ClaudeAgentSdkHarnessAdapter } from "../src/adapters/harness/claude-agent-sdk.ts";
import { inspectPi, PiSdkHarness, PiHarnessAdapter } from "../src/adapters/harness/pi.ts";
import type { CollaborationTools, HarnessAdapter } from "../src/types.ts";

import { ApplicationService } from "../src/application/service";
import { FakeProcessAdapter } from "../src/adapters/process/bwrap";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = process.env.KOURO_LIVE_SUBAGENT_HARNESS;
if (live) {
  test(`live ${live} parent awaits a Kouro-owned subagent call`, async () => {
    let adapter: HarnessAdapter;
    if (live === "codex") {
      const descriptor = await inspectCodex();
      expect(descriptor.availability).toBe("available");
      adapter = new CodexHarnessAdapter(new CodexAppServerHarness(descriptor));
    } else if (live === "pi") {
      const descriptor = await inspectPi();
      expect(descriptor.availability).toBe("available");
      adapter = new PiHarnessAdapter(new PiSdkHarness(descriptor));
    } else if (live === "claude") adapter = new ClaudeAgentSdkHarnessAdapter();
    else throw new Error(`Unknown live harness ${live}`);
    const called: string[] = [];
    const requestIds: string[] = [];
    const expectedSummary = `SCOUT_${randomUUID()}`;
    const collaboration: CollaborationTools = {
      participantId: "planner",
      send_message: () => {
        throw new Error("not available");
      },
      publish_blackboard: () => {
        throw new Error("not available");
      },
      wait: () => null,
      subagent: async (input) => {
        called.push(input.subagentId);
        requestIds.push(input.requestId);
        return {
          requestId: input.requestId,
          scoutId: input.subagentId,
          state: "succeeded",
          result: { summary: expectedSummary },
          resultArtifactId: "artifact-live",
          resultDigest: "sha256:live",
        };
      },
    };
    const context: ContextManifest = {
      version: 1,
      attemptId: "live-parent",
      segments: [],
      tools: [
        {
          name: "subagent",
          description: "Call the declared riskReviewer subagent once and use its report.",
          inputSchema: {
            type: "object",
            required: ["subagentId", "requestId", "input"],
            properties: {
              subagentId: { type: "string", enum: ["riskReviewer"] },
              requestId: { type: "string" },
              input: {
                type: "object",
                required: ["task", "question"],
                properties: { task: { type: "string" }, question: { type: "string" } },
              },
            },
          },
          enabled: true,
        },
      ],
      hiddenNativeContext: "unavailable",
      digest: "sha256:live-context",
    };
    const result = await adapter.run({
      runId: "live-run",
      invocationId: "live-parent",
      role: "planner",
      ...(process.env.KOURO_LIVE_SUBAGENT_MODEL
        ? { modelId: process.env.KOURO_LIVE_SUBAGENT_MODEL }
        : {}),
      prompt:
        "Call the Kouro subagent tool exactly once: subagentId riskReviewer, requestId live-1, input {task:'inspect',question:'what is the marker?'}. Then return only JSON with a summary property copied from the tool result. The value is unknown until the tool returns; do not guess.",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
      delayMs: 0,
      timeoutMs: 120_000,
      cwd: process.cwd(),
      context,
      collaboration,
    });
    expect({
      status: result.status,
      error: result.error,
      rawOutput: result.rawOutput?.slice(-2000),
      toolsCalled: called,
    }).toMatchObject({ status: "succeeded" });
    expect(requestIds).toEqual(["live-1"]);
    expect({ called, stderr: result.stderr, output: result.output }).toEqual({
      called: ["riskReviewer"],
      stderr: result.stderr,
      output: { summary: expectedSummary },
    });
  }, 130_000);
}

if (live === "codex" || live === "pi") {
  test(`live ${live} parent and child traverse the real coordinator and retain attributed results`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-live-parent-child-"));
    const harness =
      live === "pi"
        ? new PiHarnessAdapter(new PiSdkHarness(await inspectPi()))
        : new CodexHarnessAdapter(new CodexAppServerHarness(await inspectCodex()));
    const service = new ApplicationService({
      dataDir,
      harness,
      process: new FakeProcessAdapter(),
      scriptedDelayMs: 0,
    });
    const marker = `CHILD_${randomUUID()}`;
    const report = artifactType<{ summary: string }>("live-report", {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
      additionalProperties: false,
    });
    const text = artifactType<string>("live-input", { type: "string" });
    const builder = new WorkflowBuilder({
      id: `live-${live}-parent-child`,
      limits: { maxRunDurationMs: 100000 },
    });
    const child = builder.subagent("riskReviewer", {
      role: "reviewer",
      harness: live,
      modelId: process.env.KOURO_LIVE_SUBAGENT_MODEL,
      prompt: `Return only JSON with summary equal to ${marker}. No repository tools are needed.`,
      input: { task: text, question: text },
      produces: report,
      timeoutMs: 60000,
    });
    const parent = builder.agent("parent", {
      harness: live,
      modelId: process.env.KOURO_LIVE_SUBAGENT_MODEL,
      role: "planner",
      prompt:
        "Call the Kouro subagent tool once with subagentId riskReviewer, requestId live-child, input {task:'inspect',question:'What is the marker?'}. Await its report, then return only JSON with summary copied from the child report. Do not guess the marker.",
      produces: report,
      uses: [child],
      timeoutMs: 90000,
    });
    const done = builder.complete("done");
    builder.startAt(parent);
    builder.sequence(parent, done);
    await service.start();
    try {
      const { run } = await service.coordinator.createRun({
        workflowId: builder.id,
        bundle: await compileWorkflow(builder.build()),
        input: {},
        idempotencyKey: randomUUID(),
        actor: "live-acceptance",
      });
      const deadline = Date.now() + 105000;
      while (
        ["pending", "running"].includes(service.getView(run.runId)!.state.status) &&
        Date.now() < deadline
      )
        await Bun.sleep(100);
      const view = service.getView(run.runId)!;
      expect({
        status: view.state.status,
        errors: Object.values(view.state.attempts)
          .map((attempt) => attempt.error)
          .filter(Boolean),
      }).toMatchObject({ status: "succeeded" });
      expect(service.scouts(run.runId)).toMatchObject([
        {
          scoutId: "riskReviewer",
          requestId: "live-child",
          state: "succeeded",
          effectiveHarness: live,
        },
      ]);
      const activity = service.getHarnessActivity(run.runId, 0, 1000);
      expect(
        activity.some((item) => {
          const event = item.event as {
            type?: string;
            data?: { scoutId?: string; requestId?: string };
          };
          return event.data?.scoutId === "riskReviewer" && event.data.requestId === "live-child";
        }),
      ).toBe(true);
      expect(JSON.stringify(activity)).toContain(marker);
      const attempt = Object.values(view.state.attempts).find(
        (item) => item.status === "succeeded",
      )!;
      const ref = attempt.output[0]!;
      expect(
        JSON.parse(new TextDecoder().decode(service.coordinator.journal.blobs.read(ref))),
      ).toEqual({ summary: marker });
    } finally {
      await service.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120000);
}
