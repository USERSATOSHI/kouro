#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationService } from "./application/service.ts";
import { createHostServer } from "./http/server.ts";

const usage = `Kouro v2 M1

Usage:
  kouro serve     Start the loopback-only local workbench
  kouro create template NAME --template ID  Create a project template under .kouro
  kouro run [--profile ID]  Execute the tiny workflow headlessly
  kouro inspect ID  Print one durable run view as JSON
  kouro control ACTION ID REV  Pause/resume/cancel/interrupt/detach a run
  kouro retry ID INVOCATION REV  Retry one failed invocation
  kouro checkpoint ID           Capture a quiescent checkpoint
  kouro fork CHECKPOINT REQUEST Fork two isolated child runs
  kouro --help    Show this help

Environment:
  KOURO_DATA_DIR  Durable local state directory (default: .kouro-data)
  KOURO_PORT      Loopback port (default: 43127)
  KOURO_TOKEN     Optional fixed one-time browser pairing token
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "serve";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(usage);
    return 0;
  }
  if (
    !new Set(["serve", "run", "inspect", "control", "retry", "checkpoint", "fork", "create"]).has(
      command,
    )
  ) {
    process.stderr.write(`Unknown command: ${command}\n\n${usage}`);
    return 2;
  }

  if (command === "create") return createCommand(argv.slice(1));

  const dataDir = resolve(process.env.KOURO_DATA_DIR ?? ".kouro-data");
  const staticRoot = firstExistingPath([
    resolve("packages/web/dist"),
    resolve(import.meta.dir, "../../web/dist"),
    resolve(import.meta.dir, "../web"),
  ]);
  const service = new ApplicationService({ dataDir });
  await service.start();
  if (command === "run") {
    const profileArg = argv.find((arg) => arg.startsWith("--profile="));
    const profileIndex = argv.indexOf("--profile");
    const profile =
      profileArg?.slice("--profile=".length) ??
      (profileIndex >= 0 ? argv[profileIndex + 1] : undefined);
    if (
      profile !== undefined &&
      profile !== "scripted" &&
      profile !== "codex-readonly" &&
      profile !== "pi-readonly"
    ) {
      process.stderr.write(`Unknown execution profile: ${profile}\n`);
      await service.close();
      return 2;
    }
    const run = await service.createRun({
      workflowId: "tiny",
      idempotencyKey: crypto.randomUUID(),
      actor: "cli",
      executionProfile: profile as "scripted" | "codex-readonly" | "pi-readonly" | undefined,
    });
    let view = service.getView(run.runId);
    while (view && (view.state.status === "pending" || view.state.status === "running")) {
      await Bun.sleep(50);
      view = service.getView(run.runId);
    }
    process.stdout.write(
      `${JSON.stringify({ runId: run.runId, status: view?.state.status ?? "unknown", revision: view?.revision ?? 0 })}\n`,
    );
    await service.close();
    return view?.state.status === "succeeded" ? 0 : 1;
  }
  if (command === "inspect") {
    const runId = argv[1];
    if (!runId) {
      process.stderr.write("inspect requires a run ID\n");
      await service.close();
      return 2;
    }
    const view = service.getView(runId);
    if (!view) {
      process.stderr.write(`Run not found: ${runId}\n`);
      await service.close();
      return 1;
    }
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    await service.close();
    return 0;
  }
  if (command === "control") {
    const action = argv[1] as "pause" | "resume" | "cancel" | "interrupt" | "detach";
    const runId = argv[2];
    const revision = Number(argv[3]);
    if (
      !["pause", "resume", "cancel", "interrupt", "detach"].includes(action) ||
      !runId ||
      !Number.isSafeInteger(revision)
    ) {
      process.stderr.write("control requires ACTION ID REV\n");
      await service.close();
      return 2;
    }
    try {
      process.stdout.write(
        `${JSON.stringify(service.coordinator.control({ runId, action, expectedRevision: revision, actor: "cli", idempotencyKey: randomUUID() }))}\n`,
      );
      await service.close();
      return 0;
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      await service.close();
      return 1;
    }
  }
  if (command === "retry") {
    const runId = argv[1];
    const invocationId = argv[2];
    const revision = Number(argv[3]);
    if (!runId || !invocationId || !Number.isSafeInteger(revision)) {
      process.stderr.write("retry requires ID INVOCATION REV\n");
      await service.close();
      return 2;
    }
    try {
      process.stdout.write(
        `${JSON.stringify(service.coordinator.retry({ runId, invocationId, expectedRevision: revision, actor: "cli", idempotencyKey: randomUUID() }))}\n`,
      );
      await service.close();
      return 0;
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      await service.close();
      return 1;
    }
  }
  if (command === "checkpoint") {
    const runId = argv[1];
    if (!runId) {
      process.stderr.write("checkpoint requires ID\n");
      await service.close();
      return 2;
    }
    try {
      process.stdout.write(
        `${JSON.stringify(await service.captureCheckpoint(runId, { idempotencyKey: `cli:checkpoint:${runId}` }))}\n`,
      );
      await service.close();
      return 0;
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      await service.close();
      return 1;
    }
  }
  if (command === "fork") {
    const checkpointId = argv[1];
    const requestKey = argv[2] ?? randomUUID();
    if (!checkpointId) {
      process.stderr.write("fork requires CHECKPOINT REQUEST\n");
      await service.close();
      return 2;
    }
    try {
      process.stdout.write(
        `${JSON.stringify(await service.forkCheckpoint({ checkpointId, requestKey }))}\n`,
      );
      await service.close();
      return 0;
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      await service.close();
      return 1;
    }
  }
  const host = createHostServer(service, { staticRoot });
  host.start();
  const url = `http://127.0.0.1:${host.port}/#token=${encodeURIComponent(host.token)}`;
  process.stdout.write(`Kouro workbench: ${url}\nData: ${dataDir}\n`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await host.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });
  return 0;
}

const templateIds = [
  "feature",
  "refactor",
  "chore",
  "bugfix",
  "hotfix",
  "feature-fusion",
  "refactor-fusion",
] as const;

async function createCommand(args: string[]): Promise<number> {
  if (args[0] !== "template") {
    process.stderr.write("create requires TEMPLATE\n");
    return 2;
  }
  const name = args[1];
  const templateArg = args.find((arg) => arg.startsWith("--template="));
  const templateIndex = args.indexOf("--template");
  const template =
    templateArg?.slice("--template=".length) ??
    (templateIndex >= 0 ? args[templateIndex + 1] : undefined);
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  const outputIndex = args.indexOf("--output");
  const output =
    outputArg?.slice("--output=".length) ?? (outputIndex >= 0 ? args[outputIndex + 1] : ".kouro");
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    process.stderr.write("template NAME must be lowercase kebab-case\n");
    return 2;
  }
  if (!template || !templateIds.includes(template as (typeof templateIds)[number])) {
    process.stderr.write(`unknown template; choose: ${templateIds.join(", ")}\n`);
    return 2;
  }
  const target = resolve(output!, name);
  if (await exists(target)) {
    process.stderr.write(`target already exists: ${target}\n`);
    return 1;
  }
  const templateRoot = firstExistingPath([
    resolve(import.meta.dir, "..", "assets", "templates"),
    resolve(import.meta.dir, "assets", "templates"),
  ]);
  if (!templateRoot) {
    process.stderr.write("Kouro CLI template assets are not installed\n");
    return 1;
  }
  const source = resolve(templateRoot, template);
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await renderDirectory(source, temporary, name);
    await mkdir(dirname(target), { recursive: true });
    await rename(temporary, target);
    process.stdout.write(`Created ${target} from ${template}\n`);
    return 0;
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}

function firstExistingPath(paths: readonly string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function renderDirectory(source: string, target: string, name: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const targetPath = resolve(target, entry.name);
    if (entry.isDirectory()) await renderDirectory(sourcePath, targetPath, name);
    else if (entry.isFile())
      await writeFile(
        targetPath,
        (await readFile(sourcePath, "utf8")).replaceAll("{{id}}", name).replaceAll(
          "{{name}}",
          name
            .split("-")
            .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
            .join(" "),
        ),
      );
  }
}

if (import.meta.main) process.exitCode = await main();
