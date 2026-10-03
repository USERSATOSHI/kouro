import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { readFileSync } from "node:fs";
import type { HarnessAdapter } from "../packages/host/src/types";

export async function fusionFixture(
  id = "fusion-fixture",
  rounds = 2,
  notesTransport?: "auto" | "inline" | "files",
) {
  const report = artifactType<{ summary: string; needsRevision?: boolean }>(
    "fusion-fixture-report",
    {
      type: "object",
      required: ["summary"],
      additionalProperties: false,
      properties: { summary: { type: "string" }, needsRevision: { type: "boolean" } },
    },
  );
  const workflow = new WorkflowBuilder({ id });
  const task = workflow.input(
    "task",
    artifactType<string>("fusion-fixture-task", { type: "string" }),
  );
  const plannerA = workflow.agent("planner-a", {
    role: "fusion-fixture-a",
    modelId: "model-a",
    prompt: "draft",
    produces: report,
  });
  const plannerB = workflow.agent("planner-b", {
    role: "fusion-fixture-b",
    modelId: "model-b",
    prompt: "draft",
    produces: report,
  });
  const synthesizer = workflow.agent("fusion", {
    role: "fusion-fixture-synthesis",
    modelId: "model-fusion",
    prompt: "synthesis",
    produces: report,
  });
  const fusion = workflow
    .fusion("planning", {
      task,
      rounds,
      notesTransport,
      reviewProduces: report,
      reviewPrompt: "review",
      revisionPrompt: "revision",
      synthesis: synthesizer,
    })
    .use(plannerA, plannerB);
  const done = workflow.complete("done", { output: fusion.output });
  workflow.startAt(fusion);
  fusion.on("success").to(done);
  return compileWorkflow(workflow.build());
}

/** Controlled model stand-in, shared by coordinator and rendered browser tests. */
export class FusionFixtureHarness implements HarnessAdapter {
  readonly id = "scripted";
  readonly adapterVersion = "fusion-fixture";
  readonly calls: Array<{
    invocationId: string;
    model?: string;
    stage: string;
    round: number;
    values: Record<string, any>;
  }> = [];
  readonly steered: Array<{ invocationId: string; message: string }> = [];
  private active = new Map<string, Parameters<HarnessAdapter["run"]>[0]>();
  private released = new Set<string>();
  constructor(readonly mode: "normal" | "fail-review" | "slow-review" = "normal") {}
  capabilities() {
    return {
      "structured-output": "supported" as const,
      cancel: "supported" as const,
      steer: "supported" as const,
    };
  }
  canSteer({ invocationId }: { invocationId: string }) {
    return this.active.has(invocationId);
  }
  async steer({ invocationId, message }: { invocationId: string; message: string }) {
    const input = this.active.get(invocationId);
    if (!input) throw new Error("Fixture turn is no longer active");
    this.steered.push({ invocationId, message });
    input.onEvent?.({
      type: "text",
      at: new Date().toISOString(),
      data: `Instruction received by ${input.modelId}: ${message}`,
    });
    if (message === "finish-round") this.released.add(invocationId);
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]): ReturnType<HarnessAdapter["run"]> {
    const values = Object.fromEntries(
      (input.context?.segments ?? [])
        .filter((segment) => ["artifact-input", "artifact-input-file"].includes(segment.source))
        .map((segment) => {
          const value = JSON.parse(segment.content ?? "null");
          return [
            segment.id.split(":").at(-1)!,
            segment.source === "artifact-input-file"
              ? JSON.parse(readFileSync(value.path, "utf8"))
              : value,
          ];
        }),
    );
    const stage = values.previous
      ? "revision"
      : values.own
        ? "review"
        : values.member1
          ? "synthesis"
          : "draft";
    const round = Number(input.prompt.match(/This is (?:review|revision) round (\d+)/)?.[1] ?? 0);
    this.calls.push({
      invocationId: input.invocationId,
      model: input.modelId,
      stage,
      round,
      values,
    });
    this.active.set(input.invocationId, input);
    input.onEvent?.({
      type: "text",
      at: new Date().toISOString(),
      data: `${input.modelId} ${stage} round ${round} started`,
    });
    try {
      if (
        stage === "review" &&
        this.mode !== "normal" &&
        !(this.mode === "fail-review" && input.modelId === "model-a")
      ) {
        while (!input.signal?.aborted && !this.released.has(input.invocationId))
          await Bun.sleep(10);
      } else await Bun.sleep(input.modelId === "model-a" ? 80 : 30);
      if (input.signal?.aborted)
        return { status: "cancelled", error: "cancelled", events: [], usage: {} };
      if (stage === "review" && this.mode === "fail-review" && input.modelId === "model-a")
        return { status: "failed", error: "review fixture failure", events: [], usage: {} };
      const summary =
        stage === "synthesis"
          ? `Combined: ${values.member1.summary}; ${values.member2.summary}`
          : `${input.modelId} ${stage} round ${round}${stage === "draft" ? `: ${values.task}` : ""}`;
      input.onEvent?.({ type: "text", at: new Date().toISOString(), data: summary });
      return { status: "succeeded", output: { summary }, events: [], usage: {} };
    } finally {
      this.active.delete(input.invocationId);
    }
  }
}
