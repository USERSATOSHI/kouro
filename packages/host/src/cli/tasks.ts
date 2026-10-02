import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { taskModel } from "../application/tasks";
import type { ApplicationService } from "../application/service";

export const taskUsage = `Usage:
  kouro task workflows [--workspace PATH]          List available workflows as JSON
  kouro task run --task TEXT --harness HARNESS --model ID [options]
  kouro task status RUN [--workspace PATH]         Print milestone progress and pending approvals
  kouro task resume RUN [--workspace PATH]         Continue a durable task until completion or approval
  kouro task decide RUN INVOCATION --decision approve|reject|request-changes --revision N

Run options:
  --workflow ID           Allowed workflow (repeatable; defaults to eligible project workflows)
  --workspace PATH        Git repository with a committed HEAD (default: current directory)
  --planner-harness NAME  Override planning harness
  --planner-model ID      Override planning model
  --executor-harness NAME Override execution harness
  --executor-model ID     Override execution model
  --max-milestones N      Milestone limit, 1-12 (default: 8)
  --max-concurrent N      Concurrent milestones, 1-4 (default: 2)
  --idempotency-key KEY   Reuse a task creation or decision request
  --data-dir PATH         Durable state directory (default: workspace/.kouro-data)

Decision options: --feedback TEXT, --binding-digest DIGEST, --subject-revision N.
Output is JSON. Exit codes: 0 success, 1 failure, 2 invalid arguments, 3 waiting for approval or paused.
Approval gates are preserved. Only one CLI or web host may own a data directory at a time.
`;

const valueOptions = new Set([
  "--task",
  "--workflow",
  "--workspace",
  "--harness",
  "--model",
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

export function parseTaskArgs(args: string[]) {
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const separator = arg.indexOf("=");
    const name = separator < 0 ? arg : arg.slice(0, separator);
    if (!valueOptions.has(name)) throw new Error(`Unknown task option ${name}`);
    const value = separator < 0 ? args[++i] : arg.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name !== "--workflow" && options.has(name))
      throw new Error(`Duplicate task option ${name}`);
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  const command = positional[0] ?? "run";
  if (!["run", "workflows", "status", "resume", "decide"].includes(command))
    throw new Error(`Unknown task command ${command}`);
  const expected = command === "decide" ? 3 : ["status", "resume"].includes(command) ? 2 : 1;
  if (positional.length > expected || (expected > 1 && positional.length !== expected))
    throw new Error(`task ${command} requires ${command === "decide" ? "RUN INVOCATION" : "RUN"}`);
  const get = (name: string) => options.get(name)?.[0];
  const shared = new Set(["--workspace", "--data-dir"]);
  const decisions = new Set([
    "--decision",
    "--revision",
    "--feedback",
    "--binding-digest",
    "--subject-revision",
  ]);
  for (const name of options.keys()) {
    const permitted =
      shared.has(name) ||
      (command === "run" && !decisions.has(name)) ||
      (command === "decide" && (decisions.has(name) || name === "--idempotency-key"));
    if (!permitted) throw new Error(`${name} is not an option for task ${command}`);
  }
  const integer = (name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = get(name);
    if (value === undefined) return undefined;
    const number = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(number) ||
      number < minimum ||
      number > maximum
    )
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    return number;
  };
  const model = (prefix: "planner" | "executor") =>
    taskModel({
      harness: get(`--${prefix}-harness`) ?? get("--harness"),
      modelId: get(`--${prefix}-model`) ?? get("--model"),
    });
  if (command === "run" && !get("--task")?.trim()) throw new Error("task run requires --task TEXT");
  const planner = command === "run" ? model("planner") : undefined;
  const executor = command === "run" ? model("executor") : undefined;
  const maxMilestones = integer("--max-milestones", 1, 12);
  const maxConcurrent = integer("--max-concurrent", 1, 4);
  const revision = integer("--revision", 0);
  const subjectRevision = integer("--subject-revision", 0);
  const decision = get("--decision");
  if (
    command === "decide" &&
    (!decision ||
      !["approve", "reject", "request-changes"].includes(decision) ||
      revision === undefined)
  )
    throw new Error(
      "task decide requires --decision approve|reject|request-changes and --revision N",
    );
  if (command === "decide" && decision === "request-changes" && !get("--feedback")?.trim())
    throw new Error("request-changes requires --feedback TEXT");
  return {
    command,
    workspace: resolve(get("--workspace") ?? process.cwd()),
    runId: positional[1],
    invocationId: positional[2],
    get,
    planner,
    executor,
    maxMilestones,
    maxConcurrent,
    revision,
    subjectRevision,
    workflowIds: options.get("--workflow"),
  };
}

export type TaskArgs = ReturnType<typeof parseTaskArgs>;

export async function taskCommand(
  args: TaskArgs,
  service: ApplicationService,
  write: (value: unknown) => void = (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
): Promise<number> {
  if (args.command === "workflows") {
    write(await service.taskWorkflows());
    return 0;
  }
  let runId = args.runId;
  if (args.command === "run") {
    const workflowIds =
      args.workflowIds ??
      (await service.taskWorkflows())
        .filter((item) => item.eligible && !["tiny", "feature", "parallel"].includes(item.id))
        .map((item) => item.id);
    if (!workflowIds.length)
      throw new Error(
        "No eligible project workflows. Create one with kouro create template develop --template feature, configure its validation commands, then rerun.",
      );
    const run = await service.createTask({
      task: args.get("--task")!,
      workflowIds,
      planner: args.planner!,
      executor: args.executor!,
      maxMilestones: args.maxMilestones,
      maxConcurrent: args.maxConcurrent,
      idempotencyKey: args.get("--idempotency-key") ?? randomUUID(),
      workspace: { repositoryPath: args.workspace },
    });
    runId = run.runId;
  }
  const view = service.getView(runId!);
  if (!view || view.bundle.rootDefinitionId !== "automatic-task")
    throw new Error(`Workflow task not found: ${runId}`);
  if (args.command === "decide") {
    const decision = args.get("--decision");
    service.decideApproval({
      runId: runId!,
      invocationId: args.invocationId!,
      expectedRevision: args.revision!,
      decision:
        decision === "approve"
          ? "approved"
          : decision === "reject"
            ? "rejected"
            : "changes-requested",
      feedback: args.get("--feedback"),
      bindingDigest: args.get("--binding-digest"),
      subjectRevision: args.subjectRevision,
      actor: "cli",
      idempotencyKey: args.get("--idempotency-key") ?? randomUUID(),
    });
  }
  if (args.command === "resume" && view.state.status === "paused")
    service.control({
      runId: runId!,
      action: "resume",
      expectedRevision: view.revision,
      actor: "cli",
      idempotencyKey: randomUUID(),
    });
  if (args.command !== "status") {
    write({ event: "task.started", runId });
    let interrupted = false;
    const stop = () => {
      interrupted = true;
      const current = service.getView(runId!);
      if (current && ["pending", "running", "paused"].includes(current.state.status))
        service.control({
          runId: runId!,
          action: "cancel",
          expectedRevision: current.revision,
          actor: "cli",
          idempotencyKey: randomUUID(),
        });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      for (;;) {
        await service.coordinator.waitForCheckpointDrain(runId!);
        const current = service.getView(runId!)!;
        if (
          !["pending", "running"].includes(current.state.status) ||
          Object.values(current.state.approvals).some((item) => item.status === "pending")
        )
          break;
        await Bun.sleep(50);
      }
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    if (interrupted) {
      write(taskReport(service, runId!));
      return 130;
    }
  }
  const report = taskReport(service, runId!);
  write(report);
  return args.command === "status" || report.status === "succeeded"
    ? 0
    : report.waitingForApproval || report.status === "paused"
      ? 3
      : 1;
}

export function taskReport(service: ApplicationService, runId: string) {
  const view = service.getView(runId)!;
  const approvals = Object.values(view.state.approvals)
    .filter((item) => item.status === "pending")
    .map((item) => ({ ...item, inputs: view.state.invocations[item.invocationId]?.inputBindings }));
  return {
    runId,
    status: view.state.status,
    revision: view.revision,
    waitingForApproval: approvals.length > 0,
    approvals,
    ...service.coordinator.milestones(runId),
    result: Object.values(view.state.invocations).find(
      (item) => item.scopeId === view.state.rootScopeId && item.nodeId === "done",
    )?.output,
    workspace: service.coordinator.workspacePath(runId),
  };
}
