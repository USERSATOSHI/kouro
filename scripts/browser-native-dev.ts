import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { WorkflowBuilder, artifactType, compileWorkflow } from "@kouro/core";
import { ApplicationService } from "../packages/host/src/application/service";
import { createHostServer } from "../packages/host/src/http/server";

const modelId = process.env.KOURO_LIVE_BROWSER_MODEL;
const harness = process.env.KOURO_LIVE_BROWSER_HARNESS ?? "codex";
if (harness !== "codex" && harness !== "pi")
  throw new Error("KOURO_LIVE_BROWSER_HARNESS must be codex or pi");
if (!modelId)
  throw new Error("Set KOURO_LIVE_BROWSER_MODEL to an explicitly selected, working model");
const service = new ApplicationService({
  dataDir: process.env.KOURO_DATA_DIR!,
  scriptedDelayMs: 0,
});
await service.start();
const host = createHostServer(service, {
  staticRoot: resolve("packages/web/dist"),
  token: process.env.KOURO_TOKEN,
  port: Number(process.env.KOURO_PORT),
});
const report = artifactType<{ summary: string }>("native-browser-report", {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: { summary: { type: "string" } },
});
host.app.post("/__native/run", async ({ request, body, set }) => {
  if (request.headers.get("authorization") !== `Bearer ${host.token}`) {
    set.status = 401;
    return { error: "unauthorized" };
  }
  const mode = (body as { mode?: string })?.mode;
  if (!["split", "control"].includes(mode ?? "")) {
    set.status = 400;
    return { error: "unknown fixture" };
  }
  const marker = `NATIVE_${randomUUID()}`;
  const builder = new WorkflowBuilder({
    id: `native-${mode}-${randomUUID()}`,
    limits: { maxRunDurationMs: 180000 },
  });
  const text = artifactType<string>("native-browser-input", { type: "string" });
  const child = builder.subagent("reviewer", {
    harness,
    modelId,
    role: "native-reviewer",
    prompt: `Return JSON with summary equal to ${marker}. Do not use repository tools.`,
    input: { question: text },
    produces: report,
    timeoutMs: 90000,
  });
  const parent = builder.agent("parent", {
    harness,
    modelId,
    role: "native-parent",
    produces: report,
    timeoutMs: 120000,
    prompt:
      mode === "split"
        ? "Call the Kouro subagent tool with subagentId reviewer, requestId native-review, input {question:'What is the marker?'}. Await the report. Return JSON with summary copied from the report, do not guess it."
        : "Carefully plan and reason through 2000 distinct implementation steps for an imaginary compiler, covering syntax, types, optimization and testing in detail. Spend time on each step before moving to the next. After completing all steps return JSON with summary 'unsteered'. Do not use any tools. A later operator instruction may change this objective.",
    uses: mode === "split" ? [child] : [],
  });
  const done = builder.complete("done");
  builder.startAt(parent);
  builder.sequence(parent, done);
  const { run } = await service.coordinator.createRun({
    workflowId: builder.id,
    bundle: await compileWorkflow(builder.build()),
    input: {},
    idempotencyKey: randomUUID(),
    actor: "native-browser-test",
  });
  return { runId: run.runId, marker };
});
host.start();
process.stdout.write(`Native browser acceptance listening on ${host.port}\n`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await host.stop();
  await service.close();
};
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
