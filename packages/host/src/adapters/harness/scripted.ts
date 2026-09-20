import type { HarnessAdapter, ScriptedAgent } from "../../types.ts";

export class DelayedScriptedAgent implements ScriptedAgent {
  async run(input: {
    runId: string;
    invocationId: string;
    delayMs: number;
    signal?: AbortSignal;
  }): Promise<{ output: Record<string, unknown> }> {
    if (input.signal?.aborted) throw new Error("scripted agent aborted");
    await wait(input.delayMs, input.signal);
    return {
      output: {
        kind: "scripted-agent.output",
        runId: input.runId,
        invocationId: input.invocationId,
        message: "M1 scripted agent completed",
      },
    };
  }
}

export class ScriptedHarnessAdapter implements HarnessAdapter {
  readonly id = "scripted";
  readonly adapterVersion = "1";
  capabilities() {
    return {
      "structured-output": "supported" as const,
      cancel: "supported" as const,
      usage: "unsupported" as const,
      "cost-cap": "unsupported" as const,
    };
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]) {
    if (input.signal?.aborted)
      return {
        status: "cancelled" as const,
        error: "cancelled",
        events: [],
        usage: { quality: "unavailable" },
      };
    await wait(input.delayMs, input.signal);
    let collaboration: Record<string, unknown> | undefined;
    if (input.collaboration) {
      // This is intentionally a tiny fake harness: it exercises the real host
      // gateway rather than pretending that a provider tool call is durable.
      const peer = input.role.toLowerCase().includes("receiver") ? "sender" : "receiver";
      const batch = input.collaboration.wait({ maxMessages: 8 });
      if (batch?.visible.length) {
        const first = batch.visible[0];
        input.collaboration.send_message({
          to: first.senderParticipantId,
          body: { kind: "reply", received: first.body },
          replyTo: first.id,
          idempotencyKey: `${input.invocationId}:reply:${first.id}`,
        });
        collaboration = { received: batch.visible.map((message) => message.id) };
      } else if (peer !== input.collaboration.participantId) {
        try {
          const sent = input.collaboration.send_message({
            to: peer,
            body: { kind: "request", from: input.collaboration.participantId },
            idempotencyKey: `${input.invocationId}:request`,
          });
          collaboration = { sent: sent.id };
        } catch {
          // A generic scripted run may not declare sender/receiver roles. It
          // remains a valid harness turn; the host still records the attempt.
        }
      }
      input.collaboration.publish_blackboard({
        type: "finding",
        body: { participant: input.collaboration.participantId, status: "completed" },
        idempotencyKey: `${input.invocationId}:finding`,
      });
    }
    const output = {
      summary: "Scripted Kouro harness completed.",
      ...(collaboration ? { collaboration } : {}),
    };
    return {
      status: "succeeded" as const,
      output: output as import("@kouro/core").JsonValue,
      events: [{ type: "text", data: "scripted" }],
      usage: { quality: "unavailable" },
    };
  }
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("scripted agent aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
