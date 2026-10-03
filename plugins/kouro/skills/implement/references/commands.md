# Kouro command execution

Find `kouro` on PATH and inspect its actual help. If it lacks the required
command, use a user-provided source checkout with
`bun /absolute/path/to/kouro/packages/host/src/cli.ts` as the prefix. Do not
invent an installation path, command or option. Preserve the user's arguments
and task text. Use structured process arguments or proper shell quoting;
never interpret task text as shell code.

When the user does not name a project, use the invoking session's current
project directory. Do not ask for a project path that is already available in
the session. Resolve it once and run Kouro from that directory; pass its absolute
path as `--workspace` for execution. Never use the plugin installation directory
as the target project. An explicit user-selected project overrides this default.

The plugin is an instruction package,
not a second scheduler or a bundled model provider. Provider authentication,
models and declared workflow tools must exist locally. Use the user's selected
harness and model, or a verified existing selection. Workflow-pinned models stay
pinned; `kouro run` does not accept a `--model` override. Configure agent handles
in the workflow when needed. If essential input is missing, ask only for it.

`KOURO_DATA_DIR` defaults to `.kouro-data` in the working directory. Task commands
default to the supplied workspace's `.kouro-data` and accept `--data-dir` as an
override. Keep that directory consistent for inspection and control. Only one
CLI or web host may own it; do not kill a host or bypass its lock to run another
command. `kouro task` connects to the running dashboard for that directory.
If the task starts first, it prints a temporary dashboard URL to stderr and
`kouro serve` returns the same URL. The temporary dashboard lasts until that
command returns; start `kouro serve` first for persistent operation. Other
headless commands still require ownership to have been released.

## Plugin entrypoints

| Plugin command                  | Meaning                                              |
| ------------------------------- | ---------------------------------------------------- |
| `/kouro:plan TASK`              | Produce the canonical spec and plan with fusion.     |
| `/kouro:run WORKFLOW TASK`      | Execute one existing workflow.                       |
| `/kouro:implement TASK_OR_SPEC` | Implement requirements through dependent milestones. |

The two shared skills are `plan` and `implement`: Claude invokes them as
`/kouro:NAME`, and Codex as `$kouro:NAME`. Claude also has one command alias,
`/kouro:run`, under `commands/`. Codex calls `kouro run` directly.
Do not invent a literal CLI `plan` command: the planning skill orchestrates
fusion workflows.

Other operations remain CLI tools, without separate plugin entrypoints. Use
`kouro --help` or `kouro task --help` to discover syntax. The caller can use
`kouro create template`, `task workflows`, `task status`, `task resume`,
`task decide`, `serve`, `inspect`, `control`, `retry`, `checkpoint`, `fork`
and `plugin path` when needed during the requested work.

## Single workflow runs

The first argument to `/kouro:run` is the workflow ID. Treat the remaining task
text as one `--task` value. Use the selected project and an appropriate workspace
for writable workflows. Keep long-running commands in the caller's managed job
mechanism, retain their run ID and await the outcome.

`kouro run` prints a JSON run summary. A nonzero result with a pending approval
can mean a durable gate rather than terminal failure; inspect the returned run
before declaring failure or retrying. Preserve every workflow gate. An ordinary
`run` is not automatically an `automatic-task`; do not call `kouro task resume`
or `task decide` on it. Review/decide ordinary workflow gates using Kouro's
available host API or web UI.

## Automatic tasks

`kouro task run` takes `--task`, allowed `--workflow` IDs (repeatable), a
`--harness` and `--model`, and optional `--workspace`. It supports separate
`--planner-harness`, `--planner-model`, `--executor-harness`, `--executor-model`,
`--max-milestones` (1-12), `--max-concurrent` (1-4), `--idempotency-key` and
`--data-dir`. Without selected IDs, it chooses eligible project workflows and
excludes the built-in demonstration workflows. Task text is limited to 20,000
characters. Use committed spec files for longer input.

Output is newline-delimited JSON: a `task.started` record with the run ID, then
a milestone report. Exit codes are 0 for completion or a successful query, 1
for failure, 2 for invalid arguments, 3 for approval/paused waits and 130 for
interrupted execution after cancellation. A pending gate is not completion.
Retain a stable key for each logical task or decision request and inspect after
an uncertain response rather than launch duplicate work.

```sh
kouro task status RUN_ID --workspace PROJECT
kouro task resume RUN_ID --workspace PROJECT
kouro task decide RUN_ID INVOCATION_ID --decision approve --revision REV \
  --binding-digest DIGEST --subject-revision SUBJECT_REV --workspace PROJECT
```

When a Claude or Codex agent hits a provider limit, keep the run ID and completed
outputs. After the user indicates quota is available, inspect `task status`, then
use `task resume` to continue saved native sessions. `resumeAvailable` and
`failedInvocations` explain recovery state. Do not launch a duplicate task to
replace a partially completed run. Native continuation requires the original
host's provider transcript; report an unavailable session instead of describing
a fresh invocation as continuation.

Use the user's authorization for that specific gate. `request-changes` needs
`--feedback TEXT`; `reject` follows the original workflow's rejection route.
Decisions continue until the next gate or terminal state. A stale revision or
digest requires fresh inspection and review. Resume keeps undecided gates
pending. Use `kouro inspect` with the same state directory for full references,
or use the dashboard URL to review artifacts and diffs while the task runs.

## Recovery, branches and delivery

Controls require a current revision; do not silently refresh and replay a stale
mutation. Retrying a failed invocation is different from creating a new task.
Do not retry uncertain external effects before reconciling their outcome.
Checkpoint eligibility and fork limits are enforced by the runtime; do not
claim an ineligible checkpoint was captured or that a fork restored external
side effects. Keep returned checkpoint, request and child-run IDs.

Serving is a persistent process. Use the caller's managed job mechanism, retain
the printed local URL for the user and respect the current owner. Starting a
server does not mean a workflow completed. Keep pairing tokens private.

Successful repository execution produces a private run workspace. Validate
that result and use Kouro's existing Delivery flow for integration when
authorized. Do not invent a CLI `deliver` command or silently merge/release it.
When CLI output includes `dashboardUrl`, include that link in the user-facing
progress report so the user can open the task's live dashboard. The terminal
also prints `Kouro workbench: ...` on stderr, including when connecting to an
existing host. `kouro serve` from the same project prints the active URL.

Report executed commands, run IDs, actual results, pending gates and remaining
recovery or delivery actions. Fixture success is not a live-provider claim.
