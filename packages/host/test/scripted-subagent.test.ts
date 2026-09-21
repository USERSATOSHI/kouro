import { expect, test } from "bun:test";
import type { ContextManifest } from "@kouro/core";
import type { CollaborationTools } from "../src/types.ts";
import { ScriptedHarnessAdapter } from "../src/adapters/harness/scripted.ts";

test("scripted harness invokes arbitrary declared subagents from their schemas", async () => {
  const calls: Array<{ requestId: string; subagentId: string; input: Record<string, unknown> }> =
    [];
  const collaboration: CollaborationTools = {
    participantId: "implementer",
    send_message: () => {
      throw new Error("message tools are not used in a subagent turn");
    },
    publish_blackboard: () => {
      throw new Error("blackboard tools are not used in a subagent turn");
    },
    wait: () => null,
    subagent: async (input) => {
      calls.push(input);
      return {
        requestId: input.requestId,
        scoutId: input.subagentId,
        state: "succeeded",
        result: { answer: "custom result" },
        resultArtifactId: "artifact-custom",
        resultDigest: "sha256:custom",
      };
    },
  };
  const context = {
    version: 1,
    attemptId: "attempt",
    segments: [],
    tools: [
      {
        name: "subagent",
        inputSchema: {
          type: "object",
          oneOf: [
            {
              type: "object",
              required: ["subagentId", "requestId", "input"],
              properties: {
                subagentId: { const: "riskReviewer" },
                requestId: { type: "string" },
                input: {
                  type: "object",
                  required: ["ticket", "question"],
                  properties: {
                    ticket: { type: "string" },
                    question: { type: "string" },
                  },
                },
              },
            },
          ],
          properties: {
            subagentId: { type: "string", enum: ["riskReviewer"] },
          },
        },
        enabled: true,
      },
    ],
    hiddenNativeContext: "unavailable",
    digest: "sha256:context",
  } satisfies ContextManifest;

  const result = await new ScriptedHarnessAdapter().run({
    runId: "run",
    invocationId: "invocation",
    role: "implementer",
    prompt: "use a subagent",
    outputSchema: {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string" } },
    },
    delayMs: 0,
    context,
    collaboration,
  });

  expect(calls).toEqual([
    {
      requestId: "invocation:riskReviewer",
      subagentId: "riskReviewer",
      input: {
        ticket: "Scripted subagent input",
        question: "Scripted subagent input",
      },
    },
  ]);
  expect(result.output).toEqual({ answer: "Scripted subagent input" });
});
