import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApplicationService } from "../src/application/service";
import { dashboardUrl, findHost, registerHost } from "../src/cli/host-connection";
import { createHostServer } from "../src/http/server";
import {
  installTaskFixture,
  prepareTaskProviderFixture,
  TaskFixtureHarness,
} from "../../../scripts/task-fixture";

const cli = process.env.KOURO_TEST_CLI_ENTRYPOINT ?? resolve(import.meta.dir, "../src/cli.ts");
const runArgs = [
  "task",
  "run",
  "--task",
  "Visible CLI work",
  "--workflow",
  "task-fixture",
  "--harness",
  "codex",
  "--model",
  "fixture",
];

async function projectFixture() {
  const project = await mkdtemp("/tmp/kouro-host-connection-");
  await installTaskFixture(join(project, ".kouro"));
  await writeFile(join(project, ".gitignore"), ".kouro-data/\n");
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ],
  ]) {
    const child = Bun.spawn(["git", ...args], { cwd: project, stderr: "pipe", stdout: "ignore" });
    const error = await new Response(child.stderr).text();
    if (await child.exited) throw new Error(error);
  }
  return project;
}

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Fixture condition was not reached");
}

function invoke(project: string, args: string[]) {
  return Bun.spawn([process.execPath, cli, ...args], {
    cwd: project,
    env: { ...process.env, KOURO_DATA_DIR: join(project, ".kouro-data") },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a real CLI task uses the running dashboard, remains observable and cancels only its own work", async () => {
  const project = await projectFixture();
  const dataDir = join(project, ".kouro-data");
  const harness = new TaskFixtureHarness("slow");
  const service = new ApplicationService({
    dataDir,
    templateRoot: join(project, ".kouro"),
    harness,
    harnessAdapters: { codex: harness },
  });
  await service.start();
  const host = createHostServer(service, {
    port: 0,
    token: "connection-fixture",
    cli: { instanceId: "fixture", workspace: project },
  });
  host.start();
  const connection = {
    protocol: 1 as const,
    url: `http://127.0.0.1:${host.port}`,
    token: host.token,
    instanceId: "fixture",
  };
  const unregister = await registerHost(dataDir, connection);
  const child = invoke(project, runArgs);
  const output = new Response(child.stdout).text();
  const error = new Response(child.stderr).text();
  try {
    await until(() => harness.calls.some((call) => call.role === "task-fixture-work"));
    const run = service.listRuns().find((run) => run.task === "Visible CLI work")!;
    expect(run.status).toBe("running");
    expect(await findHost(dataDir)).toEqual(connection);
    expect(await readFile(join(dataDir, "host.json"), "utf8")).toContain("fixture");

    // The browser's usual cookie session sees the same durable run and activity.
    const session = await fetch(`${connection.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: host.token }),
    });
    const headers = { cookie: session.headers.get("set-cookie")!.split(";")[0]! };
    const runs = await (await fetch(`${connection.url}/api/runs`, { headers })).json();
    expect(runs.find((item: { id: string }) => item.id === run.runId).state).toBe("running");
    const activity = await (
      await fetch(`${connection.url}/api/runs/${run.runId}/activity`, { headers })
    ).json();
    expect(activity.items.length).toBeGreaterThan(0);
    expect(
      (
        await fetch(`${connection.url}/api/cli/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ argv: runArgs.slice(1) }),
        })
      ).status,
    ).toBe(401);

    const status = invoke(project, ["task", "status", run.runId]);
    const statusOutput = await new Response(status.stdout).text();
    expect(await status.exited).toBe(0);
    expect(JSON.parse(statusOutput).runId).toBe(run.runId);
    const other = await service.createTask({
      task: "Unrelated dashboard work",
      workflowIds: ["task-fixture"],
      planner: { harness: "codex", modelId: "fixture" },
      executor: { harness: "codex", modelId: "fixture" },
      workspace: { repositoryPath: project },
      idempotencyKey: "other-task",
    });
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    await until(() => service.getView(run.runId)?.state.status === "cancelled");
    expect(service.getView(other.runId)?.state.status).toBe("running");
    expect(await error).toBe("");
    expect(JSON.parse((await output).trim().split("\n")[0]!)).toMatchObject({
      event: "task.started",
      runId: run.runId,
    });
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    await unregister();
    for (const run of service.listRuns()) {
      const view = service.getView(run.runId)!;
      if (["pending", "running", "paused"].includes(view.state.status))
        service.control({
          runId: run.runId,
          action: "cancel",
          expectedRevision: view.revision,
          actor: "fixture-cleanup",
          idempotencyKey: `cleanup:${run.runId}`,
        });
    }
    await host.stop();
    await rm(project, { recursive: true, force: true });
  }
}, 15000);

test("a task started before the dashboard publishes a live URL and serve attaches without another owner", async () => {
  const project = await projectFixture();
  const dataDir = join(project, ".kouro-data");
  const provider = await prepareTaskProviderFixture(project);
  await writeFile(
    provider,
    (await readFile(provider, "utf8")).replace(
      "const prompt = args.at(-1);",
      "await Bun.sleep(1000);\nconst prompt = args.at(-1);",
    ),
  );
  const child = Bun.spawn(
    [process.execPath, cli, ...runArgs.map((arg) => (arg === "codex" ? "opencode" : arg))],
    {
      cwd: project,
      env: { ...process.env, KOURO_DATA_DIR: dataDir, KOURO_OPENCODE_BIN: provider },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = new Response(child.stdout).text();
  const error = new Response(child.stderr).text();
  try {
    await until(() => Bun.file(join(dataDir, "host.json")).exists());
    const connection = (await findHost(dataDir))!;
    expect(connection).toBeDefined();
    const serve = invoke(project, ["serve"]);
    expect(await new Response(serve.stdout).text()).toContain(dashboardUrl(connection));
    expect(await serve.exited).toBe(0);
    expect(await child.exited).toBe(0);
    expect(await error).toContain(dashboardUrl(connection));
    expect(JSON.parse((await output).trim().split("\n").at(-1)!)).toMatchObject({
      status: "succeeded",
    });
    expect(await Bun.file(join(dataDir, "host.json")).exists()).toBe(false);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("connection discovery rejects public credential files and ignores a stopped host", async () => {
  const project = await mkdtemp("/tmp/kouro-host-connection-stale-");
  const service = new ApplicationService({ dataDir: project });
  await service.start();
  const host = createHostServer(service, {
    port: 0,
    token: "private-fixture",
    cli: { instanceId: "stale", workspace: project },
  });
  host.start();
  const connection = {
    protocol: 1 as const,
    url: `http://127.0.0.1:${host.port}`,
    token: host.token,
    instanceId: "stale",
  };
  const unregister = await registerHost(project, connection);
  try {
    await chmod(join(project, "host.json"), 0o644);
    await expect(findHost(project)).rejects.toThrow("private");
    await chmod(join(project, "host.json"), 0o600);
    await host.stop();
    expect(await findHost(project)).toBeUndefined();
  } finally {
    await unregister();
    await host.stop();
    await rm(project, { recursive: true, force: true });
  }
});

test("CLI approval decisions use the dashboard host and retain revision checks", async () => {
  const project = await projectFixture();
  await installTaskFixture(join(project, ".kouro"), true);
  const dataDir = join(project, ".kouro-data");
  const harness = new TaskFixtureHarness("normal", "task-gated");
  const service = new ApplicationService({
    dataDir,
    templateRoot: join(project, ".kouro"),
    harness,
    harnessAdapters: { codex: harness },
  });
  await service.start();
  const host = createHostServer(service, {
    port: 0,
    token: "approval-fixture",
    cli: { instanceId: "approval", workspace: project },
  });
  host.start();
  const unregister = await registerHost(dataDir, {
    protocol: 1,
    url: `http://127.0.0.1:${host.port}`,
    token: host.token,
    instanceId: "approval",
  });
  const command = async (args: string[]) => {
    const child = invoke(project, args);
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      error,
      report: output.trim() ? JSON.parse(output.trim().split("\n").at(-1)!) : undefined,
    };
  };
  try {
    const start = await command(
      runArgs.map((arg) => (arg === "task-fixture" ? "task-gated" : arg)),
    );
    expect(start.code).toBe(3);
    expect(start.report.approvals).toHaveLength(2);
    const { runId } = start.report;
    const approve = (invocationId: string, revision: number) =>
      command([
        "task",
        "decide",
        runId,
        invocationId,
        "--decision",
        "approve",
        "--revision",
        String(revision),
      ]);
    expect((await approve(start.report.approvals[0].invocationId, 0)).code).toBe(1);
    expect(harness.calls.filter((call) => call.role === "task-fixture-work")).toHaveLength(0);
    const first = await approve(start.report.approvals[0].invocationId, start.report.revision);
    expect(first.code).toBe(3);
    expect(first.report.approvals).toHaveLength(1);
    const second = await approve(first.report.approvals[0].invocationId, first.report.revision);
    expect(second.code).toBe(3);
    expect(second.report.approvals).toHaveLength(1); // The dependent milestone has its own gate.
    const last = await approve(second.report.approvals[0].invocationId, second.report.revision);
    expect(last.code).toBe(0);
    expect(last.report.status).toBe("succeeded");
    expect(service.getView(runId)?.state.status).toBe("succeeded");
  } finally {
    await unregister();
    await host.stop();
    await rm(project, { recursive: true, force: true });
  }
}, 15000);
