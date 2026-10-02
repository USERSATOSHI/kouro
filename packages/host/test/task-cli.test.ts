import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApplicationService } from "../src/application/service";
import { parseTaskArgs, taskCommand } from "../src/cli/tasks";
import {
  installTaskFixture,
  prepareTaskProviderFixture,
  taskFixtureWorkflow,
  TaskFixtureHarness,
} from "../../../scripts/task-fixture";

const runArgs = [
  "run",
  "--task",
  "Build and combine",
  "--workflow",
  "task-fixture",
  "--harness",
  "codex",
  "--model",
  "fixture",
  "--idempotency-key",
  "cli-task",
];

async function commitProject(project: string) {
  await writeFile(join(project, "project-context.txt"), "Current project fixture\n");
  await writeFile(join(project, ".gitignore"), ".kouro-data/\n");
  for (const args of [
    ["init", "--quiet"],
    ["add", ".kouro", "project-context.txt", ".gitignore"],
    [
      "-c",
      "user.name=Kouro Test",
      "-c",
      "user.email=kouro-test@localhost",
      "commit",
      "--quiet",
      "-m",
      "Fixture project",
    ],
  ]) {
    const child = Bun.spawn(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(error);
  }
}

test("CLI rejects missing, unsupported and misplaced options before execution", () => {
  for (const args of [
    ["run", "--task"],
    ["run", "--unknown", "value"],
    [...runArgs, "--max-concurrent", "0"],
    [...runArgs, "--model", "duplicate"],
    ["status", "id", "--task", "ignored"],
    ["decide", "run", "invocation"],
    ["decide", "run", "invocation", "--decision", "request-changes", "--revision", "1"],
  ])
    expect(() => parseTaskArgs(args)).toThrow();
  const separate = parseTaskArgs([
    "run",
    "--task=t",
    "--planner-harness=codex",
    "--planner-model=p",
    "--executor-harness=claude",
    "--executor-model=e",
    "--workflow=a",
    "--workflow=b",
  ]);
  expect(separate.planner).toEqual({ harness: "codex", modelId: "p" });
  expect(separate.executor).toEqual({ harness: "claude", modelId: "e" });
  expect(separate.workflowIds).toEqual(["a", "b"]);
  expect(separate.workspace).toBe(process.cwd());
  expect(parseTaskArgs([...runArgs, "--workspace", "/tmp/selected-project"]).workspace).toBe(
    "/tmp/selected-project",
  );
});

test("CLI runs an automatic task and returns durable progress and result references", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-task-cli-");
  const templateRoot = join(dataDir, ".kouro");
  await installTaskFixture(templateRoot);
  await commitProject(dataDir);
  const harness = new TaskFixtureHarness();
  const service = new ApplicationService({
    dataDir,
    templateRoot,
    harness,
    harnessAdapters: { codex: harness },
  });
  const output: any[] = [];
  try {
    await service.start();
    const args = [...runArgs, "--workspace", dataDir];
    expect(await taskCommand(parseTaskArgs(args), service, (value) => output.push(value))).toBe(0);
    expect(output[0]).toMatchObject({ event: "task.started" });
    const report = output.at(-1);
    expect(report.status).toBe("succeeded");
    expect(report.milestones.map((item: { status: string }) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(report.result).toHaveLength(1);
    expect(harness.calls.every((item) => item.ended > 0)).toBe(true);
    expect(await taskCommand(parseTaskArgs(args), service, (value) => output.push(value))).toBe(0);
    expect(output.at(-1).runId).toBe(report.runId);
    expect(harness.calls.filter((item) => item.role === "task-decomposer")).toHaveLength(1);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CLI gates survive restart and only explicit current decisions continue a task", async () => {
  const dataDir = await mkdtemp("/tmp/kouro-task-cli-gated-");
  const templateRoot = join(dataDir, ".kouro");
  await installTaskFixture(templateRoot, true);
  await commitProject(dataDir);
  const harness = new TaskFixtureHarness("normal", "task-gated");
  const open = () =>
    new ApplicationService({ dataDir, templateRoot, harness, harnessAdapters: { codex: harness } });
  let service = open();
  const output: any[] = [];
  const write = (value: unknown) => output.push(value);
  try {
    await service.start();
    const args = [
      ...runArgs.map((arg) => (arg === "task-fixture" ? "task-gated" : arg)),
      "--workspace",
      dataDir,
    ];
    expect(await taskCommand(parseTaskArgs(args), service, write)).toBe(3);
    const report = output.at(-1);
    expect(report.waitingForApproval).toBe(true);
    expect(report.approvals).toHaveLength(2);
    expect(harness.calls.filter((item) => item.role === "task-fixture-work")).toHaveLength(0);
    await service.close();
    service = open();
    await service.start();
    expect(await taskCommand(parseTaskArgs(["resume", report.runId]), service, write)).toBe(3);
    let current = output.at(-1);
    const first = current.approvals[0];
    await expect(
      taskCommand(
        parseTaskArgs([
          "decide",
          report.runId,
          first.invocationId,
          "--decision",
          "approve",
          "--revision",
          String(current.revision - 1),
        ]),
        service,
        write,
      ),
    ).rejects.toThrow("stale-action");
    for (let count = 0; count < 3; count++) {
      const approval = current.approvals[0];
      const code = await taskCommand(
        parseTaskArgs([
          "decide",
          report.runId,
          approval.invocationId,
          "--decision",
          "approve",
          "--revision",
          String(current.revision),
          "--binding-digest",
          approval.bindingDigest,
          "--subject-revision",
          String(approval.subjectRevision),
        ]),
        service,
        write,
      );
      current = output.at(-1);
      expect(code).toBe(count === 2 ? 0 : 3);
    }
    expect(current.status).toBe("succeeded");
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("CLI loads a rendered builder template from a greenfield project outside the checkout", async () => {
  const project = await mkdtemp("/tmp/kouro-task-greenfield-");
  const cli = process.env.KOURO_TEST_CLI_ENTRYPOINT ?? resolve(import.meta.dir, "../src/cli.ts");
  const command = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: project,
      env: { ...process.env, KOURO_DATA_DIR: join(project, ".kouro-data") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return out;
  };
  try {
    await command(["create", "template", "develop", "--template", "feature"]);
    const workflows = JSON.parse(await command(["task", "workflows", "--workspace", project]));
    expect(workflows.find((item: { id: string }) => item.id === "develop")).toMatchObject({
      eligible: true,
      requiresWorkspace: true,
      approvalGates: 1,
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("the actual task CLI defaults execution to the current project", async () => {
  const project = await mkdtemp("/tmp/kouro-task-cli-process-");
  await installTaskFixture(join(project, ".kouro"));
  await commitProject(project);
  const executable = await prepareTaskProviderFixture(project);
  const cli = process.env.KOURO_TEST_CLI_ENTRYPOINT ?? resolve(import.meta.dir, "../src/cli.ts");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        "task",
        ...runArgs
          .filter((arg) => arg !== "--idempotency-key" && arg !== "cli-task")
          .map((arg) => (arg === "codex" ? "opencode" : arg)),
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          KOURO_DATA_DIR: join(project, ".kouro-data"),
          KOURO_OPENCODE_BIN: executable,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(err || out);
    const records = out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "task.started" });
    expect(records.at(-1)).toMatchObject({ status: "succeeded", waitingForApproval: false });
    expect(records.at(-1).milestones.map((item: { status: string }) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    const resultWorkspace = records.at(-1).workspace;
    expect(resultWorkspace).toBeString();
    expect(resultWorkspace).not.toBe(project);
    expect(await readFile(join(resultWorkspace, "project-context.txt"), "utf8")).toBe(
      "Current project fixture\n",
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

for (const explicit of [false, true]) {
  test(`workflow CLI uses the ${explicit ? "explicit" : "current"} project for discovery, execution and state`, async () => {
    const project = await mkdtemp("/tmp/kouro-run-project-");
    const cli = process.env.KOURO_TEST_CLI_ENTRYPOINT ?? resolve(import.meta.dir, "../src/cli.ts");
    const workflow = taskFixtureWorkflow().build();
    const source = {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.kind === "agent" ? { ...node, harness: "opencode", modelId: "fixture" } : node,
      ),
    };
    await installTaskFixture(join(project, ".kouro"));
    await writeFile(
      join(project, ".kouro/task-fixture/workflow.ts"),
      `export default ${JSON.stringify(source)};\n`,
    );
    await commitProject(project);
    const executable = await prepareTaskProviderFixture(project);
    await writeFile(
      executable,
      (await readFile(executable, "utf8")).replace(
        "const prompt = args.at(-1);",
        `if (await Bun.file("project-context.txt").text() !== "Current project fixture\\n") throw new Error("Wrong project context");\nif (process.cwd() === ${JSON.stringify(project)}) throw new Error("Expected an isolated execution workspace");\nconst prompt = args.at(-1);`,
      ),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, KOURO_OPENCODE_BIN: executable };
    delete env.KOURO_DATA_DIR;
    const invoke = async (args: string[], cwd: string) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(error || out);
      return JSON.parse(out);
    };
    try {
      const result = await invoke(
        [
          "run",
          "task-fixture",
          "--task",
          "Use this project's context",
          ...(explicit ? ["--workspace", project] : []),
        ],
        explicit ? import.meta.dir : project,
      );
      expect(result.status).toBe("succeeded");
      const view = await invoke(["inspect", result.runId], project);
      expect(view.state.status).toBe("succeeded");
      expect(await Bun.file(join(project, ".kouro-data", "kouro.sqlite")).exists()).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
}

test("pure workflow CLI still runs outside a Git repository", async () => {
  const project = await mkdtemp("/tmp/kouro-run-pure-");
  const cli = process.env.KOURO_TEST_CLI_ENTRYPOINT ?? resolve(import.meta.dir, "../src/cli.ts");
  await installTaskFixture(join(project, ".kouro"));
  const workflow = taskFixtureWorkflow().build();
  const source = {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.kind === "agent"
        ? {
            ...node,
            capabilities: [],
            workspaceAccess: undefined,
            harness: "opencode",
            modelId: "fixture",
          }
        : node,
    ),
  };
  await writeFile(
    join(project, ".kouro/task-fixture/workflow.ts"),
    `export default ${JSON.stringify(source)};\n`,
  );
  const executable = await prepareTaskProviderFixture(project);
  try {
    const child = Bun.spawn([process.execPath, cli, "run", "task-fixture", "--task", "Pure task"], {
      cwd: project,
      env: {
        ...process.env,
        KOURO_DATA_DIR: join(project, ".kouro-data"),
        KOURO_OPENCODE_BIN: executable,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ status: "succeeded" });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
