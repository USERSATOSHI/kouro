import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createPresentation, presentationArgs } from "../src/cli/presentation";

const report = {
  runId: "run_full-copyable-id",
  status: "paused",
  revision: 42,
  waitingForApproval: true,
  milestones: [
    {
      id: "evidence",
      title: "Check proposal evidence",
      status: "succeeded",
      workflowId: "research",
    },
  ],
  approvals: [
    { invocationId: "inv_full-copyable-id", bindingDigest: "full-digest", subjectRevision: 40 },
  ],
  failedInvocations: [
    {
      nodeId: "review",
      invocationId: "inv_review",
      error: "Usage limit",
      stopReason: "usage-limit",
      resumeAfter: "2026-10-03T12:00:00Z",
    },
  ],
  dashboardUrl: "http://localhost:43127/?run=run_full-copyable-id",
};

test("redirected and explicit JSON records preserve the complete machine contract", () => {
  for (const output of [
    createPresentation("auto", false, {}),
    createPresentation("json", true, {}),
  ]) {
    const text = output.record(report);
    expect(JSON.parse(text)).toEqual(report);
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(text).not.toContain("\x1b");
  }
});

test("readable task reports preserve approval bindings, progress, reset time and full identifiers", () => {
  const text = createPresentation("plain", false, {}).record(report);
  for (const expected of [
    "awaiting approval",
    "Check proposal evidence",
    report.dashboardUrl,
    report.runId,
    "inv_full-copyable-id",
    "--revision 42",
    "--binding-digest 'full-digest'",
    "--subject-revision 40",
    "2026-10-03T12:00:00Z",
  ])
    expect(text).toContain(expected);
  expect(text).not.toContain("\x1b");
  expect(
    createPresentation("plain", false, {}).record({
      runId: "run_saved",
      status: "paused",
      resumeAvailable: true,
    }),
  ).toContain("kouro task resume 'run_saved'");
});

test("terminal output honors NO_COLOR and removes provider terminal control sequences", () => {
  expect(createPresentation("auto", true, {}).record(report)).toContain("\x1b[");
  for (const env of [{ NO_COLOR: "" }, { TERM: "dumb" }])
    expect(createPresentation("auto", true, env).record(report)).not.toContain("\x1b");
  const error = createPresentation("plain", false, {}).error("provider\x1b[2J\rmessage");
  expect(error).not.toContain("\x1b");
  expect(error).not.toContain("\r");
});

test("presentation flags and help are not taken from option values", () => {
  expect(presentationArgs(["run", "--task", "--help", "--json"])).toEqual({
    argv: ["run", "--task", "--help"],
    mode: "json",
    help: false,
  });
  expect(presentationArgs(["run", "--task=--json", "--plain", "--help"])).toEqual({
    argv: ["run", "--task=--json", "--help"],
    mode: "plain",
    help: true,
  });
});

test("every command supports help without creating state or starting providers", async () => {
  const project = await mkdtemp("/tmp/kouro-cli-help-");
  const cli = process.env.KOURO_TEST_CLI_ENTRYPOINT ?? resolve(import.meta.dir, "../src/cli.ts");
  try {
    for (const command of [
      "serve",
      "run",
      "task",
      "create",
      "plugin",
      "inspect",
      "control",
      "retry",
      "checkpoint",
      "fork",
    ]) {
      const child = Bun.spawn([process.execPath, cli, command, "--help"], {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, KOURO_DATA_DIR: resolve(project, "state") },
      });
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(error).toBe("");
      expect(out).toContain(`Usage:${command === "task" ? "\n  " : " "}kouro ${command}`);
    }
    expect(await readdir(project)).toEqual([]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20_000);
