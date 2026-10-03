#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ApplicationService } from "./application/service.ts";
import { createHostServer } from "./http/server.ts";
import { serveScoutMcp } from "./adapters/harness/scout-mcp.ts";
import { parseTaskArgs, taskCommand, taskUsage } from "./cli/tasks";
import { connectedTaskCommand, dashboardUrl, findHost, registerHost } from "./cli/host-connection";
import {
  cliUsage,
  cliVersion,
  createPresentation,
  helpFor,
  presentationArgs,
} from "./cli/presentation";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "__scout_mcp") {
    await serveScoutMcp();
    return 0;
  }
  const parsed = presentationArgs(argv);
  argv = parsed.argv;
  const command = argv[0] ?? "serve";
  const output = createPresentation(parsed.mode);
  if (command === "--version") {
    process.stdout.write(`${cliVersion}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help" || parsed.help) {
    const topic = command === "help" ? argv[1] : command;
    process.stdout.write(topic === "task" ? taskUsage : (helpFor(topic ?? "") ?? cliUsage));
    return 0;
  }
  if (
    !new Set([
      "serve",
      "run",
      "task",
      "plugin",
      "inspect",
      "control",
      "retry",
      "checkpoint",
      "fork",
      "create",
    ]).has(command)
  ) {
    process.stderr.write(output.error(`Unknown command: ${command}`) + "Try kouro --help.\n");
    return 2;
  }

  if (command === "create") return createCommand(argv.slice(1), output);

  if (command === "plugin") {
    const root = firstExistingPath(
      [resolve(import.meta.dir), resolve(import.meta.dir, "../../..")].filter((candidate) =>
        existsSync(resolve(candidate, ".agents/plugins/marketplace.json")),
      ),
    );
    if (argv[1] !== "path") {
      process.stderr.write("Usage: kouro plugin path\n");
      return 2;
    }
    if (!root) {
      process.stderr.write("Kouro plugin assets are not installed\n");
      return 1;
    }
    process.stdout.write(`${root}\n`);
    return 0;
  }

  if (command === "task") {
    if (argv[1] === "help") {
      process.stdout.write(taskUsage);
      return 0;
    }
    let args;
    try {
      args = parseTaskArgs(argv.slice(1));
    } catch (cause) {
      process.stderr.write(output.error(cause) + "Try kouro task --help.\n");
      return 2;
    }
    const project = args.workspace;
    let taskService: ApplicationService | undefined;
    let taskHost: ReturnType<typeof createHostServer> | undefined;
    let unregister: (() => Promise<void>) | undefined;
    try {
      const dataDir = resolve(
        args.get("--data-dir") ?? process.env.KOURO_DATA_DIR ?? resolve(project, ".kouro-data"),
      );
      const connection = await findHost(dataDir);
      if (connection) {
        const url = dashboardUrl(connection);
        if (args.command !== "workflows") process.stderr.write(output.workbench(url, dataDir));
        const forwarded = argv
          .slice(1)
          .map((argument, index, arguments_) =>
            argument.startsWith("--workspace=")
              ? `--workspace=${project}`
              : arguments_[index - 1] === "--workspace"
                ? project
                : argument,
          );
        return await connectedTaskCommand(
          connection,
          [...forwarded, ...(args.get("--workspace") ? [] : ["--workspace", project])],
          taskOutput(output, url),
        );
      }
      taskService = new ApplicationService({
        dataDir,
        templateRoot: resolve(project, ".kouro"),
      });
      await taskService.start();
      if (!["workflows", "status"].includes(args.command)) {
        const instanceId = randomUUID();
        taskHost = createHostServer(taskService, {
          staticRoot: webStaticRoot(),
          port: 0,
          cli: { instanceId, workspace: project },
        });
        taskHost.start();
        const hostConnection = {
          protocol: 1 as const,
          url: `http://127.0.0.1:${taskHost.port}`,
          token: taskHost.token,
          instanceId,
        };
        unregister = await registerHost(dataDir, hostConnection);
        process.stderr.write(output.workbench(dashboardUrl(hostConnection), dataDir));
      }
      return await taskCommand(
        args,
        taskService,
        taskOutput(
          output,
          taskHost
            ? dashboardUrl({ url: `http://127.0.0.1:${taskHost.port}`, token: taskHost.token })
            : undefined,
        ),
      );
    } catch (cause) {
      process.stderr.write(output.error(cause));
      return 1;
    } finally {
      await unregister?.();
      if (taskHost) await taskHost.stop();
      else await taskService?.close();
    }
  }

  const project =
    command === "run" ? resolve(optionValue(argv, "--workspace") ?? process.cwd()) : process.cwd();
  const dataDir = resolve(process.env.KOURO_DATA_DIR ?? resolve(project, ".kouro-data"));
  const staticRoot = webStaticRoot();
  if (command === "serve") {
    const connection = await findHost(dataDir);
    if (connection) {
      process.stdout.write(output.workbench(dashboardUrl(connection), dataDir));
      return 0;
    }
  }
  const service = new ApplicationService({ dataDir, templateRoot: resolve(project, ".kouro") });
  try {
    await service.start();
    if (command === "run") {
      const valueOptions = new Set(["--profile", "--task", "--workspace", "--ticket"]);
      let workflowId = "tiny";
      for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (valueOptions.has(arg)) {
          index += 1;
          continue;
        }
        if (arg.startsWith("--")) continue;
        workflowId = arg;
        break;
      }
      const profileArg = argv.find((arg) => arg.startsWith("--profile="));
      const profileIndex = argv.indexOf("--profile");
      const profile =
        profileArg?.slice("--profile=".length) ??
        (profileIndex >= 0 ? argv[profileIndex + 1] : undefined);
      const task = optionValue(argv, "--task");
      const workspace =
        optionValue(argv, "--workspace") !== undefined || (await hasGitHead(project))
          ? { repositoryPath: project }
          : undefined;
      const ticket = optionValue(argv, "--ticket");
      if (
        profile !== undefined &&
        profile !== "scripted" &&
        profile !== "codex-readonly" &&
        profile !== "codex-workspace-write" &&
        profile !== "claude-readonly" &&
        profile !== "claude-workspace-write" &&
        profile !== "pi-readonly"
      ) {
        process.stderr.write(`Unknown execution profile: ${profile}\n`);
        await service.close();
        return 2;
      }
      const run = await service.createRun({
        workflowId,
        idempotencyKey: crypto.randomUUID(),
        actor: "cli",
        executionProfile: profile as
          | "scripted"
          | "codex-readonly"
          | "codex-workspace-write"
          | "claude-readonly"
          | "claude-workspace-write"
          | "pi-readonly"
          | undefined,
        allowUnrestrictedCommands: argv.includes("--allow-unrestricted-commands"),
        input: {
          ...(task === undefined ? {} : { task }),
          ...(ticket === undefined ? {} : { ticket }),
        },
        ...(workspace ? { workspace } : {}),
      });
      let view = service.getView(run.runId);
      while (
        view &&
        (view.state.status === "pending" || view.state.status === "running") &&
        !Object.values(view.state.approvals).some((approval) => approval.status === "pending")
      ) {
        await Bun.sleep(50);
        view = service.getView(run.runId);
      }
      process.stdout.write(
        output.record({
          runId: run.runId,
          status: view?.state.status ?? "unknown",
          revision: view?.revision ?? 0,
          unrestrictedCommandOptIn: argv.includes("--allow-unrestricted-commands"),
        }),
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
          output.record(
            service.coordinator.control({
              runId,
              action,
              expectedRevision: revision,
              actor: "cli",
              idempotencyKey: randomUUID(),
            }),
          ),
        );
        await service.close();
        return 0;
      } catch (cause) {
        process.stderr.write(output.error(cause));
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
          output.record(
            service.coordinator.retry({
              runId,
              invocationId,
              expectedRevision: revision,
              actor: "cli",
              idempotencyKey: randomUUID(),
            }),
          ),
        );
        await service.close();
        return 0;
      } catch (cause) {
        process.stderr.write(output.error(cause));
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
          output.record(
            await service.captureCheckpoint(runId, { idempotencyKey: `cli:checkpoint:${runId}` }),
          ),
        );
        await service.close();
        return 0;
      } catch (cause) {
        process.stderr.write(output.error(cause));
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
          output.record(await service.forkCheckpoint({ checkpointId, requestKey })),
        );
        await service.close();
        return 0;
      } catch (cause) {
        process.stderr.write(output.error(cause));
        await service.close();
        return 1;
      }
    }
    const instanceId = randomUUID();
    const host = createHostServer(service, { staticRoot, cli: { instanceId, workspace: project } });
    host.start();
    const unregister = await registerHost(dataDir, {
      protocol: 1,
      url: `http://127.0.0.1:${host.port}`,
      token: host.token,
      instanceId,
    });
    const url = `http://127.0.0.1:${host.port}/#token=${encodeURIComponent(host.token)}`;
    process.stdout.write(output.workbench(url, dataDir));
    if (process.env.SSH_CONNECTION) {
      process.stdout.write(
        `SSH browser access: on your computer run:\n  ssh -N -L ${host.port}:127.0.0.1:${host.port} <same-SSH-target>\nThen open the workbench URL above in your local browser. Keep the tunnel running.\n`,
      );
    }

    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await unregister();
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
  } catch (cause) {
    await service.close();
    process.stderr.write(output.error(cause));
    return 1;
  }
}

/** Keep dashboard links in both terminal reports and machine records. */
function taskOutput(output: ReturnType<typeof createPresentation>, url?: string) {
  return (value: unknown) => {
    if (url && value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.runId === "string") {
        const link = new URL(url);
        link.searchParams.set("run", record.runId);
        value = { ...record, dashboardUrl: link.href };
      }
    }
    process.stdout.write(output.record(value));
  };
}

function webStaticRoot() {
  return firstExistingPath([
    resolve("packages/web/dist"),
    resolve(import.meta.dir, "web"),
    resolve(import.meta.dir, "../../web/dist"),
    resolve(import.meta.dir, "../web"),
  ]);
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function hasGitHead(project: string): Promise<boolean> {
  try {
    const child = Bun.spawn(["git", "-C", project, "rev-parse", "--verify", "HEAD"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
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

async function createCommand(
  args: string[],
  presentation: ReturnType<typeof createPresentation>,
): Promise<number> {
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
    process.stderr.write(presentation.error(cause));
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

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (cause) {
    process.stderr.write(createPresentation("auto").error(cause));
    process.exitCode = 1;
  }
}
