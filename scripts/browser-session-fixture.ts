import {
  WorkflowBuilder,
  artifactType,
  compileWorkflow,
  type HarnessEvent,
  type JsonValue,
} from "@kouro/core";
import { ScriptedHarnessAdapter } from "../packages/host/src/adapters/harness/scripted";
import type { HarnessAdapter } from "../packages/host/src/types";
import type { ApplicationService } from "../packages/host/src/application/service";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Controlled provider for browser acceptance, using the real coordinator and scout gateway. */
export class BrowserSessionHarness implements HarnessAdapter {
  readonly id = "scripted";
  readonly adapterVersion = "browser-fixture";
  private scripted = new ScriptedHarnessAdapter();
  capabilities() {
    return this.scripted.capabilities();
  }
  private active = new Map<
    string,
    { input: Parameters<HarnessAdapter["run"]>[0]; finished: boolean }
  >();
  private failedTurns = 0;
  private interruptedTurns = 0;

  async steer({ invocationId, message }: { invocationId: string; message: string }) {
    const turn = this.active.get(invocationId);
    if (!turn) throw new Error("fixture turn is not active");
    turn.input.onEvent?.({
      type: "text",
      at: new Date().toISOString(),
      data: `Instruction received: ${message}\n`,
    });
    if (message === "finish-session") turn.finished = true;
    if (message === "spawn-live-subagent") {
      // Independent of steering acknowledgement, like a provider's next tool call.
      void turn.input.collaboration
        ?.subagent?.({
          subagentId: "reviewer",
          requestId: "browser-live-review",
          input: { task: "slow live review", question: "Review the live fixture" },
        })
        .catch(() => {});
    }
  }

  async run(input: Parameters<HarnessAdapter["run"]>[0]): ReturnType<HarnessAdapter["run"]> {
    if (!input.role.startsWith("web-session-")) return this.scripted.run(input);
    const emit = (type: HarnessEvent["type"], data: JsonValue) =>
      input.onEvent?.({ type, at: new Date().toISOString(), data });
    if (input.role === "web-session-configured")
      return {
        status: "succeeded",
        output: { summary: "Typed launch accepted" },
        events: [],
        usage: {},
      };
    if (input.role === "web-session-large") {
      for (let index = 0; index < 4210; index++)
        emit("log", { status: `Durable history marker ${index}` });
      emit("tool", {
        id: "large-output",
        name: "Large report",
        status: "completed",
        input: { path: "report.txt" },
        output: {
          stdout: `${"Readable preview ".repeat(20000)}FULL_OUTPUT_END_MARKER`,
          exitCode: 0,
        },
      });
      return {
        status: "succeeded",
        output: { summary: "Large history retained" },
        events: [],
        usage: { quality: "unavailable" },
      };
    }
    if (input.role === "web-session-interrupt") {
      this.interruptedTurns++;
      if (this.interruptedTurns === 1) {
        emit("text", "Agent is waiting for operator interrupt");
        while (!input.signal?.aborted) await Bun.sleep(50);
        return {
          status: "cancelled",
          error: "operator interrupted",
          events: [],
          usage: { quality: "unavailable" },
        };
      }
      return {
        status: "succeeded",
        output: { summary: "Resumed through a fresh attempt" },
        events: [],
        usage: { quality: "unavailable" },
      };
    }
    if (input.role === "web-session-failure") {
      this.failedTurns++;
      emit("text", `recovery-attempt-${this.failedTurns}`);
      return {
        status: "succeeded",
        output: (this.failedTurns <= 2
          ? { wrong: true }
          : { summary: "Recovered browser session" }) as JsonValue,
        events: [],
        usage: { quality: "unavailable" },
      };
    }
    if (input.role === "web-session-reviewer") {
      emit("log", { status: "Thinking", channel: "thinking", text: "Reviewing the fixture" });
      emit("tool", { id: "shared-tool", name: "Read", status: "started", input: "child.ts" });
      emit("text", "Child session marker\n");
      const task =
        input.context?.segments.find(
          (segment) => segment.source === "artifact-input" && segment.id.endsWith(":task"),
        )?.content ?? "";
      if (task.includes("slow live review")) {
        emit("text", "Live child is inspecting the fixture\n");
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !input.signal?.aborted) await Bun.sleep(50);
      }
      emit("tool", {
        id: "shared-tool",
        name: "Read",
        status: "completed",
        output: { content: [{ type: "text", text: "Child tool result" }] },
      });
      return {
        status: "succeeded",
        output: { summary: "Reviewed by child" },
        events: [],
        usage: { quality: "unavailable" },
      };
    }
    const turn = { input, finished: false };
    this.active.set(input.invocationId, turn);
    try {
      emit("text", "Parent session marker\n");
      emit("tool", { id: "shared-tool", name: "Read", status: "started", input: "parent.ts" });
      const report = await input.collaboration?.subagent?.({
        subagentId: "reviewer",
        requestId: "browser-review",
        input: { task: "review fixture", question: "Review the fixture" },
      });
      if (report?.state !== "succeeded")
        throw new Error(`fixture subagent failed: ${JSON.stringify(report)}`);
      emit("tool", {
        id: "shared-tool",
        name: "Read",
        status: "completed",
        output: { stdout: "Parent tool result", exitCode: 0 },
      });
      while (!turn.finished && !input.signal?.aborted) await Bun.sleep(50);
      return {
        status: input.signal?.aborted ? "cancelled" : "succeeded",
        output: { summary: "Parent completed" },
        events: [],
        usage: { quality: "unavailable" },
      };
    } finally {
      this.active.delete(input.invocationId);
    }
  }
}

/** Exercise the production template loader and launch form with typed inputs and child definitions. */
export async function prepareLaunchTemplate(dataDir: string): Promise<string> {
  const root = join(dataDir, "templates");
  const directory = join(root, "browser-configured");
  await mkdir(directory, { recursive: true });
  const existingRoot = resolve(process.cwd(), ".kouro");
  for (const entry of await readdir(existingRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const original = join(existingRoot, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(original, "manifest.json"), "utf8"));
    } catch {
      continue;
    }
    const exported = (await import(pathToFileURL(join(original, manifest.entrypoint)).href))
      .default;
    const source = typeof exported === "function" ? await exported() : exported;
    const target = join(root, entry.name);
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "manifest.json"),
      JSON.stringify({ ...manifest, entrypoint: "workflow.ts" }),
    );
    await writeFile(join(target, "workflow.ts"), `export default ${JSON.stringify(source)};\n`);
  }
  const report = artifactType<{ summary: string }>("browser-configured-report", {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  });
  const builder = new WorkflowBuilder({ id: "browser-configured" });
  const enabled = builder.input("enabled", artifactType("browser-flag", { type: "boolean" }));
  const count = builder.input(
    "count",
    artifactType("browser-count", { type: "integer", minimum: 0 }),
  );
  const settings = builder.input(
    "settings",
    artifactType("browser-settings", {
      type: "object",
      required: ["label"],
      properties: { label: { type: "string", minLength: 1 } },
    }),
  );
  const first = builder.subagent(
    "first",
    { prompt: "first", produces: report },
    { optional: true },
  );
  const second = builder.subagent(
    "second",
    { prompt: "second", produces: report },
    { optional: true },
  );
  const parent = builder.agent("parent", {
    role: "web-session-configured",
    prompt: "launch fixture",
    input: { enabled, count, settings },
    uses: [first, second],
    produces: report,
  });
  builder.startAt(parent);
  builder.sequence(parent, builder.complete("done"));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      id: builder.id,
      name: "Typed launch and child settings",
      version: "1",
      entrypoint: "workflow.ts",
    }),
  );
  await writeFile(
    join(directory, "workflow.ts"),
    `export default ${JSON.stringify(builder.build())};\n`,
  );
  return root;
}

export async function seedSessionFixtures(service: ApplicationService) {
  const report = artifactType<{ summary: string }>("web-session-report", {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
    additionalProperties: false,
  });
  const string = artifactType<string>("web-session-task", { type: "string" });
  for (const fixture of ["live", "failure", "cancel", "interrupt", "large"]) {
    const builder = new WorkflowBuilder({
      id: `web-session-${fixture}`,
      version: "1",
      limits: { maxRunDurationMs: 900_000 },
    });
    const reviewer = builder.subagent("reviewer", {
      role: "web-session-reviewer",
      prompt: "Review fixture",
      input: { task: string, question: string },
      produces: report,
    });
    const agent = builder.agent("parent", {
      role:
        fixture === "failure"
          ? "web-session-failure"
          : fixture === "interrupt"
            ? "web-session-interrupt"
            : fixture === "large"
              ? "web-session-large"
              : "web-session-parent",
      prompt: "Browser acceptance fixture",
      produces: report,
      uses: ["failure", "interrupt", "large"].includes(fixture) ? [] : [reviewer],
    });
    const done = builder.complete("done");
    builder.startAt(agent);
    builder.sequence(agent, done);
    await service.coordinator.createRun({
      workflowId: builder.id,
      bundle: await compileWorkflow(builder.build()),
      input: {},
      idempotencyKey: builder.id,
      actor: "browser-fixture",
    });
  }
}
