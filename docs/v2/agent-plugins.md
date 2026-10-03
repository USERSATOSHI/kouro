# CLI workflow tasks and agent plugins

The CLI and web **Workflow task** launcher use the same planner, milestone
scheduler, pinned workflow bundles and approval gates. Agents calling the CLI
give Kouro one task; Kouro generates the dependency graph and executes ready
milestones in parallel.

## Run from a project

When no project is supplied, all three plugin entrypoints use the invoking
session's current project. CLI execution likewise defaults `--workspace` to the
current directory. An explicit project overrides that default. The plugin
installation directory is never the implied target project.

Use an existing Git repository with a committed HEAD. For a new project, create
the requested project and its initial commit first. Required input files must
be committed so isolated worktrees can see them. Ignore `.kouro-data/`.

```sh
cd /path/to/project
kouro create template develop --template feature
# Adapt .kouro/develop/kouro.ts validation commands to your project's checks.
kouro task workflows --workspace .
kouro task run --task "Build the requested app" --workspace . \
  --workflow develop --harness claude --model YOUR_MODEL \
  --max-milestones 3 --max-concurrent 2
```

`--harness` and `--model` set planning and execution defaults. Override either
with `--planner-harness`, `--planner-model`, `--executor-harness` and
`--executor-model`. Models explicitly declared by a workflow remain pinned.
Repeat `--workflow` to allow multiple workflows. Without that option, the CLI
uses eligible project workflows and excludes the built-in demonstration
workflows. Model IDs must be available through the authenticated harness.

The CLI loads `.kouro` from the supplied workspace and defaults its durable
state to `WORKSPACE/.kouro-data`. `--data-dir` overrides `KOURO_DATA_DIR`, which
overrides the default. Use the same state directory for subsequent commands.
CLI tasks connect to an existing host for that state directory. Without one,
execution owns a temporary dashboard until the command returns.

The installed CLI bundles the builder runtime used by templates: greenfield
projects do not need a separate `@kouro/core` installation to load their workflow
definitions. Template commands and agents still need their declared tools.

## Inspect and decide

Terminal output shows readable status, milestones, pending approvals and results.
Use `--plain` for the same report without colors, or `--json` for machine output.
`NO_COLOR` also disables terminal colors. Redirected output stays newline-delimited
JSON: a `task.started` record containing the run
ID, followed by a report with milestone status, dependencies, pending approvals,
result artifact references and the private run workspace path. A caller can
retain the first record while a long-running command executes.

```sh
kouro task status RUN_ID --workspace .
kouro task resume RUN_ID --workspace .
kouro task decide RUN_ID INVOCATION_ID --decision approve --revision REV \
  --binding-digest DIGEST --subject-revision SUBJECT_REV --workspace .
```

`status` prints progress. `resume` continues paused work and retains pending
gates. `decide` records an explicit decision and continues until the next gate
or terminal state. `request-changes` requires `--feedback TEXT`; `reject` keeps
the workflow's original rejection route. Stale revisions and binding digests
are refused. All CLI commands retain the same host/runtime limits.

Use `--idempotency-key KEY` to identify a logical creation or decision request.
When a caller loses a response, reuse its key or inspect the existing run rather
than creating a second task. An approval gate is a durable wait and is never
automatically accepted by these commands or plugins. Independent admitted work
drains before the CLI returns a pending-gate report.

Exit codes: `0` succeeded (`status` and `workflows` also use `0` for a successful
query), `1` failed, `2` invalid arguments, `3` waiting for approval or paused,
and `130` interrupted execution after cancellation. `kouro task --help` lists
all options.

After a CLI command returns at a gate, start `kouro serve` from the project to
review its artifacts and diff in the web UI. Subsequent task commands connect to
that host. Successful task execution
combines changes in the private run worktree; the source checkout is updated
through the existing **Delivery** flow.

## Install the shared plugin

`kouro plugin path` prints the marketplace root. The catalogs are outside the
plugin directory: `.agents/plugins/marketplace.json` for Codex and
`.claude-plugin/marketplace.json` for Claude, both pointing to `plugins/kouro`.
From source, register the repository root; `bun run build:cli` packages the
same layout under `dist/`, which is the installed CLI's marketplace root.
The marketplace and plugin are both named `kouro`; the install ID is
`kouro@kouro`.

Codex:

```sh
codex plugin marketplace add /absolute/path/printed/by/kouro/plugin/path
codex plugin add kouro@kouro
```

Start a new session and invoke `$kouro:implement`, or ask Codex to run a project
task through Kouro. This follows the supported [Codex marketplace and plugin
layout](https://developers.openai.com/plugins/build/plugins).

Claude Code:

```text
/plugin marketplace add /absolute/path/printed/by/kouro/plugin/path
/plugin install kouro@kouro
```

Start a new session and invoke `/kouro:implement`. For a development session
without installation, use `claude --plugin-dir /absolute/path/to/plugins/kouro`.
The package follows the [Claude Code plugin
layout](https://code.claude.com/docs/en/plugins-reference).

## Plugin commands and spec handoff

The plugin has three entrypoints:

| Claude entrypoint               | Operation                                           |
| ------------------------------- | --------------------------------------------------- |
| `/kouro:plan TASK`              | Produce the detailed spec and plan through fusion   |
| `/kouro:run WORKFLOW TASK`      | Execute one existing workflow                       |
| `/kouro:implement TASK_OR_SPEC` | Implement requirements through dependent milestones |

Only `plan` and `implement` are shared skills. `run` is a thin Claude command
alias. For example, `/kouro:run develop Build the requested feature` executes
`develop` with that task. In Codex, invoke `$kouro:plan` or
`$kouro:implement`, or call `kouro run` directly.

The remaining CLI operations, including serving, inspection, decisions and
recovery, remain available for the AI to call when needed. They have no separate
plugin commands. Use `kouro --help` or `kouro task --help` for supported syntax.
`/kouro:plan` orchestrates fusion workflows; there is no literal CLI `plan`
command.

The intended flow is fusion produces the canonical spec and plan, the calling
AI gives those requirements to `kouro task run`, and Kouro assigns milestones
to workflows. A supplied external fusion spec works too. Completion of fusion
does not automatically launch implementation. The shared `implement` skill
teaches this handoff, greenfield Git setup, long committed spec files, sequential
dependencies, independent parallel work, language-port parity checks, approval
decisions and delivery. A packaged reader retrieves final output JSON from
`kouro inspect` artifact references and verifies its checksums.

Use `--max-concurrent 1` for sequential milestone admission; required order still
needs dependency edges. Selected workflows can retain their own internal
parallel agents. Larger plans must be split into bounded phases (at most 12
milestones per task), with completed prerequisites explicitly carried forward.

The plugin uses the local CLI and the user's configured providers. It does not
ship a separate scheduler or require an MCP server. It teaches the caller to
prepare greenfield repositories, discover or adapt workflows, choose real
models, retain run IDs, inspect progress and preserve gates. CLI smoke and
fixture acceptance are separate from live-provider authentication and execution.
