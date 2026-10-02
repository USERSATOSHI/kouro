import { WorkflowBuilder, artifactType, CAPABILITY, type MilestonePlan } from "@kouro/core";
import type { HarnessAdapter } from "../packages/host/src/types";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export function taskFixtureWorkflow(id = "task-fixture", gates = false, writes = false) {
  const workflow = new WorkflowBuilder({ id, version: "1" });
  const task = workflow.input("task", { type: "string" });
  const report = artifactType<{ summary: string }>("task-fixture-report", {
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
    additionalProperties: false,
  });
  const work = workflow.agent("work", {
    role: "task-fixture-work",
    prompt: "Execute milestone",
    input: { task },
    produces: report,
    capabilities: writes
      ? [CAPABILITY.REPOSITORY_READ, CAPABILITY.REPOSITORY_WRITE]
      : [CAPABILITY.REPOSITORY_READ],
    workspaceAccess: writes ? "workspace-write" : "read-only",
  });
  const check = workflow.agent("check", {
    role: "task-fixture-check",
    prompt: "Validate milestone",
    input: { task, result: work.output },
    produces: report,
    capabilities: [CAPABILITY.REPOSITORY_READ],
    workspaceAccess: "read-only",
  });
  const done = workflow.complete("done", { output: check.output });
  if (gates) {
    const approve = workflow.approval("approve", { action: "Approve milestone" });
    workflow.startAt(approve);
    approve.on("approved").to(work);
  } else workflow.startAt(work);
  workflow.sequence(work, check, done);
  return workflow;
}
export async function installTaskFixture(root: string, gates = false) {
  const workflow = taskFixtureWorkflow(gates ? "task-gated" : "task-fixture", gates);
  const directory = join(root, workflow.id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      id: workflow.id,
      name: gates ? "Approval task fixture" : "Automatic task fixture",
      version: "1",
      entrypoint: "workflow.ts",
    }),
  );
  await writeFile(
    join(directory, "workflow.ts"),
    `export default ${JSON.stringify(workflow.build())};\n`,
  );
}

/** An external provider stand-in for exercising the real headless CLI boundary. */
export async function prepareTaskProviderFixture(directory: string): Promise<string> {
  const executable = join(directory, "task-provider-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("--help")) {
  console.log("task fixture 1");
  process.exit(0);
}
const prompt = args.at(-1);
const context = JSON.parse(prompt.split("[KOURO_CONTEXT_BEGIN]\\n")[1].split("\\n[KOURO_CONTEXT_END]")[0]);
const values = Object.fromEntries(context.segments.filter(item => item.source === "artifact-input").map(item => [item.id.split(":").at(-1), JSON.parse(item.content)]));
if (Array.isArray(values.workflows)) {
  const workflowId = values.workflows[0].id;
  console.log(JSON.stringify({ milestones: [
    { id: "a", title: "Build A", task: "Build A", workflowId, dependsOn: [] },
    { id: "b", title: "Build B", task: "Build B", workflowId, dependsOn: [] },
    { id: "c", title: "Combine A and B", task: "Combine A and B", workflowId, dependsOn: ["a", "b"] }
  ] }));
} else console.log(JSON.stringify({ summary: "Finished " + String(values.task).split("\\n")[0] }));
`,
  );
  await chmod(executable, 0o755);
  return executable;
}
export class TaskFixtureHarness implements HarnessAdapter {
  readonly id = "scripted";
  readonly adapterVersion = "task-fixture";
  readonly calls: Array<{
    role: string;
    task: string;
    model?: string;
    started: number;
    ended: number;
    cwd?: string;
  }> = [];
  constructor(
    readonly mode: "normal" | "fail" | "slow" | "write" | "conflict" = "normal",
    readonly workflowId = "task-fixture",
    readonly overridePlan?: MilestonePlan,
  ) {}
  capabilities() {
    return { "structured-output": "supported" as const, cancel: "supported" as const };
  }
  async run(input: Parameters<HarnessAdapter["run"]>[0]): ReturnType<HarnessAdapter["run"]> {
    const values = Object.fromEntries(
      (input.context?.segments ?? [])
        .filter((segment) => segment.source === "artifact-input")
        .map((segment) => [segment.id.split(":").at(-1)!, JSON.parse(segment.content ?? "null")]),
    );
    const task = String(values.task ?? values.description ?? "");
    const call = {
      role: input.role,
      task,
      model: input.modelId,
      started: Date.now(),
      ended: 0,
      cwd: input.cwd,
    };
    this.calls.push(call);
    try {
      if (input.role === "task-decomposer")
        return {
          status: "succeeded",
          events: [],
          usage: {},
          output: (this.overridePlan ?? {
            milestones: [
              {
                id: "a",
                title: "Build A",
                task: "Build A",
                workflowId: this.workflowId,
                dependsOn: [],
              },
              {
                id: "b",
                title: "Build B",
                task: "Build B",
                workflowId: this.workflowId,
                dependsOn: [],
              },
              {
                id: "c",
                title: "Combine A and B",
                task: "Combine A and B",
                workflowId: this.workflowId,
                dependsOn: ["a", "b"],
              },
            ],
          }) as unknown as import("@kouro/core").JsonValue,
        };
      input.onEvent?.({
        type: "text",
        at: new Date().toISOString(),
        data: `${input.role}: ${task.split("\n")[0]}`,
      });
      if (this.mode === "slow") {
        while (!input.signal?.aborted) await Bun.sleep(10);
      } else await Bun.sleep(task.startsWith("Build A") ? 65 : 30);
      if (input.signal?.aborted)
        return { status: "cancelled", error: "cancelled", events: [], usage: {} };
      if (this.mode === "fail" && task.startsWith("Build A"))
        return { status: "failed", error: "A failed", events: [], usage: {} };
      if (["write", "conflict"].includes(this.mode) && input.cwd) {
        const prefix = task.startsWith("Build A") ? "a" : task.startsWith("Build B") ? "b" : "c";
        const path = join(
          input.cwd,
          this.mode === "conflict" && prefix !== "c" ? "shared.txt" : `${prefix}.txt`,
        );
        if (input.role === "task-fixture-work") {
          if (prefix === "c") {
            const a = await readFile(join(input.cwd, "a.txt"), "utf8");
            const b = await readFile(join(input.cwd, "b.txt"), "utf8");
            // A dependent milestone is allowed to extend a prerequisite's file.
            await writeFile(join(input.cwd, "a.txt"), `${a}extended\n`);
            await writeFile(path, a + b);
          } else await writeFile(path, `${prefix}\n`);
        } else await readFile(path, "utf8");
      }
      input.onEvent?.({
        type: "text",
        at: new Date().toISOString(),
        data: `Finished ${task.split("\n")[0]}`,
      });
      return {
        status: "succeeded",
        output: { summary: `Finished ${task.split("\n")[0]}` },
        events: [],
        usage: {},
      };
    } finally {
      call.ended = Date.now();
    }
  }
}
