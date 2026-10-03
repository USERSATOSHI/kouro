import { version } from "../../package.json";

export const cliVersion = version;

export const cliUsage = `Kouro ${version} · Local agent workflows

Usage: kouro <command> [options]

Work
  serve                         Open the local workbench (default command)
  task                          Plan and execute milestones; see task --help
  run [WORKFLOW]                Execute a workflow headlessly
  create template NAME          Scaffold a workflow with --template ID

Manage runs
  inspect RUN                   Print the complete durable run as JSON
  control ACTION RUN REV        Pause, resume, cancel, interrupt or detach
  retry RUN INVOCATION REV      Retry a failed invocation
  checkpoint RUN                Capture a quiescent checkpoint
  fork CHECKPOINT [REQUEST]     Fork two isolated child runs

Tools
  plugin path                   Print the bundled plugin marketplace path
  --help, -h                    Show help; also available on each command
  --version                     Print the installed version
  --json                        Keep structured JSON output in a terminal
  --plain                       Show readable output without terminal colors

Examples
  kouro create template research --template feature-fusion
  kouro run research --task "Research this proposal"
  kouro task status RUN

Environment
  KOURO_DATA_DIR                State directory (default: .kouro-data)
  KOURO_PORT                    Loopback port (default: 43127)
  KOURO_TOKEN                   Optional fixed browser pairing token
  NO_COLOR                      Disable terminal colors

Redirected output stays JSON. Use kouro <command> --help for options.
`;

const commandUsage: Record<string, string> = {
  serve: `Usage: kouro serve\n\nStart the local workbench or show the existing host URL.\nSet KOURO_DATA_DIR and KOURO_PORT to choose state and port.\n`,
  run: `Usage: kouro run [WORKFLOW] [options]\n\nOptions\n  --task TEXT                   Task instructions\n  --workspace PATH              Project repository (default: current directory)\n  --profile ID                  Execution profile, e.g. claude-readonly\n  --ticket TEXT                 Ticket input\n  --allow-unrestricted-commands  Opt into unrestricted workflow commands\n  --json / --plain               Choose structured or readable output\n`,
  create: `Usage: kouro create template NAME --template ID [--output PATH]\n\nTemplates\n  feature, refactor, chore, bugfix, hotfix, feature-fusion, refactor-fusion\n\nNAME uses lowercase kebab-case. Output defaults to .kouro/NAME.\nConfigure the generated workflow before running it.\n`,
  plugin:
    "Usage: kouro plugin path\n\nPrint the bundled Codex/Claude plugin marketplace directory.\n",
  inspect: "Usage: kouro inspect RUN\n\nPrint the complete durable run view as JSON.\n",
  control:
    "Usage: kouro control ACTION RUN REV\n\nActions: pause, resume, cancel, interrupt, detach.\nREV is the current run revision from kouro inspect RUN.\n",
  retry:
    "Usage: kouro retry RUN INVOCATION REV\n\nRetry one failed invocation using the current run revision.\n",
  checkpoint: "Usage: kouro checkpoint RUN\n\nCapture a quiescent checkpoint of a durable run.\n",
  fork: "Usage: kouro fork CHECKPOINT [REQUEST]\n\nFork two isolated child runs. REQUEST is an optional idempotency key.\n",
};

export function helpFor(command: string): string | undefined {
  return commandUsage[command];
}

// Skip option values: a task whose literal text is '--json' is still a task.
const valueOptions = new Set([
  "--task",
  "--workflow",
  "--workspace",
  "--harness",
  "--model",
  "--profile",
  "--ticket",
  "--template",
  "--output",
  "--planner-harness",
  "--planner-model",
  "--executor-harness",
  "--executor-model",
  "--max-milestones",
  "--max-concurrent",
  "--idempotency-key",
  "--data-dir",
  "--decision",
  "--revision",
  "--feedback",
  "--binding-digest",
  "--subject-revision",
]);

export function presentationArgs(input: readonly string[]) {
  const argv: string[] = [];
  let mode: "auto" | "json" | "plain" = "auto";
  let help = false;
  for (let index = 0; index < input.length; index++) {
    const argument = input[index]!;
    if (valueOptions.has(argument)) {
      argv.push(argument);
      if (input[index + 1] !== undefined) argv.push(input[++index]!);
    } else if (argument === "--json" || argument === "--plain") {
      mode = argument === "--json" ? "json" : "plain";
    } else {
      argv.push(argument);
      if (argument === "--help" || argument === "-h") help = true;
    }
  }
  return { argv, mode, help };
}

export function createPresentation(
  mode: "auto" | "json" | "plain",
  terminal = Boolean(process.stdout.isTTY),
  env: Record<string, string | undefined> = process.env,
) {
  const human = mode === "plain" || (mode === "auto" && terminal);
  const color =
    human && terminal && mode !== "plain" && env.NO_COLOR === undefined && env.TERM !== "dumb";
  const tint = (text: string, code: number) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  // Provider reports are untrusted terminal text; keep JSON output untouched.
  const safe = (value: unknown) =>
    // eslint-disable-next-line no-control-regex -- Remove terminal escape/control bytes from provider text.
    String(value ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  const heading = (text: string) => tint(safe(text), 1);
  const status = (value: unknown) =>
    tint(
      safe(value),
      value === "succeeded"
        ? 32
        : ["failed", "cancelled", "rejected"].includes(String(value))
          ? 31
          : 33,
    );
  const detail = (label: string, value: unknown) =>
    value === undefined || value === null ? "" : `  ${label.padEnd(12)}${safe(value)}\n`;
  const shell = (value: unknown) => `'${safe(value).replaceAll("'", "'\\''")}'`;
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  function record(value: unknown): string {
    if (!human) return `${JSON.stringify(value)}\n`;
    if (Array.isArray(value)) {
      if (!value.length) return "No workflows available.\n";
      if (!value.every((item) => typeof object(item).eligible === "boolean"))
        return `${safe(JSON.stringify(value, null, 2))}\n`;
      return `${heading("Available workflows")}\n\n${value
        .map((item) => {
          const row = object(item);
          if (!row.id) return safe(JSON.stringify(item, null, 2));
          return `  ${safe(row.id)}  ${row.eligible === false ? status("unavailable") : status("ready")}\n${detail("Name", row.name)}${detail("Reason", row.reason ?? row.error ?? (Array.isArray(row.diagnostics) && row.diagnostics.length ? row.diagnostics.join("; ") : undefined))}`;
        })
        .join("\n")}\n`;
    }
    const row = object(value);
    if (row.event === "task.started")
      return `${heading("Task started")}\n${detail("Run", row.runId)}${detail("Workbench", row.dashboardUrl)}\n`;
    if (typeof row.runId !== "string" || typeof row.status !== "string")
      return `${safe(JSON.stringify(value, null, 2))}\n`;
    let text = `${heading("Kouro")} · ${status(row.waitingForApproval ? "awaiting approval" : row.status)}\n`;
    text +=
      detail("Run", row.runId) +
      detail("Revision", row.revision) +
      detail("Phase", row.phase) +
      detail("Workspace", row.workspace) +
      detail("Workbench", row.dashboardUrl);
    if (Array.isArray(row.milestones) && row.milestones.length) {
      text += `\n${heading("Milestones")}\n`;
      for (const entry of row.milestones) {
        const milestone = object(entry);
        text += `  ${status(milestone.status)}  ${safe(milestone.title ?? milestone.id)}\n${detail("Workflow", milestone.workflowId)}`;
      }
    }
    if (row.error) text += `\n${tint("Error", 31)}: ${safe(row.error)}\n`;
    if (Array.isArray(row.failedInvocations))
      for (const entry of row.failedInvocations) {
        const failure = object(entry);
        text += `\n${tint("Failed", 31)}: ${safe(failure.nodeId)}\n${detail("Invocation", failure.invocationId)}${detail("Reason", failure.error)}${detail("Stop reason", failure.stopReason)}${detail("Resume after", failure.resumeAfter)}`;
      }
    if (Array.isArray(row.approvals) && row.approvals.length) {
      text += `\n${heading("Pending approvals")}\n`;
      for (const entry of row.approvals) {
        const approval = object(entry);
        text += detail("Invocation", approval.invocationId);
        text += `  Review: kouro inspect ${shell(row.runId)}\n`;
        text += `  Decide: kouro task decide ${shell(row.runId)} ${shell(approval.invocationId)} --decision DECISION --revision ${safe(row.revision)}`;
        if (approval.bindingDigest) text += ` --binding-digest ${shell(approval.bindingDigest)}`;
        if (approval.subjectRevision !== undefined)
          text += ` --subject-revision ${safe(approval.subjectRevision)}`;
        text +=
          "\n  DECISION: approve, reject or request-changes; changes require --feedback TEXT.\n";
      }
    }
    if (row.resumeAvailable) text += `\nResume: kouro task resume ${shell(row.runId)}\n`;
    if (row.result !== undefined)
      text += `\n${heading("Result")}\n${safe(JSON.stringify(row.result, null, 2))}\n`;
    return `${text}\n`;
  }

  return {
    human,
    record,
    error: (cause: unknown) =>
      `${tint("error", 31)}: ${safe(cause instanceof Error ? cause.message : cause)}\n`,
    workbench: (url: string, dataDir: string) =>
      human
        ? `${heading("Kouro workbench")}\n${detail("Open", url)}${detail("Data", dataDir)}\n`
        : `Kouro workbench: ${url}\nData: ${dataDir}\n`,
  };
}
