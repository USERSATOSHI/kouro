import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ContextManifest } from "@kouro/core";
import {
  CodexSdkHarness,
  CodexHarnessAdapter,
  inspectCodex,
} from "../src/adapters/harness/codex.ts";
import { ClaudeAgentSdkHarnessAdapter } from "../src/adapters/harness/claude-agent-sdk.ts";
import { inspectPi, PiSdkHarness, PiHarnessAdapter } from "../src/adapters/harness/pi.ts";
import type { CollaborationTools, HarnessAdapter } from "../src/types.ts";

const live = process.env.KOURO_LIVE_SUBAGENT_HARNESS;
if (live) {
  test(`live ${live} parent awaits a Kouro-owned subagent call`, async () => {
    let adapter: HarnessAdapter;
    if (live === "codex") {
      const descriptor = await inspectCodex();
      expect(descriptor.availability).toBe("available");
      adapter = new CodexHarnessAdapter(new CodexSdkHarness(descriptor));
    } else if (live === "pi") {
      const descriptor = await inspectPi();
      expect(descriptor.availability).toBe("available");
      adapter = new PiHarnessAdapter(new PiSdkHarness(descriptor));
    } else if (live === "claude") adapter = new ClaudeAgentSdkHarnessAdapter();
    else throw new Error(`Unknown live harness ${live}`);
    const called: string[] = [];
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
    expect(result.status).toBe("succeeded");
    expect({ called, stderr: result.stderr, output: result.output }).toEqual({
      called: ["riskReviewer"],
      stderr: result.stderr,
      output: { summary: expectedSummary },
    });
  }, 130_000);
}
