# Kouro

Kouro runs repeatable development workflows around coding agents, commands,
Git worktrees, and human approvals.

Give Kouro a workflow, a Git repository, and an authenticated agent runtime. It
creates an isolated worktree, runs the declared steps, pauses when a decision
needs you, and produces a merge-ready `kouro/<run-id>` branch when the workflow
finishes successfully.

## Requirements

- [Bun](https://bun.sh/) 1.2 or newer
- Git
- Authentication and provider configuration for at least one supported
  runtime:
  - Codex through the installed `codex` App Server
  - Claude through the bundled Claude Agent SDK
  - OpenCode through its SDK and installed `opencode` server binary
  - Pi through the bundled in-process Pi SDK

Kouro runs locally. Repository worktrees, run history, logs, and artifacts stay
on your machine.

Repository-local evaluation datasets can be compiled into stable checksums and
applied to durable run state with deterministic status, node-outcome,
invocation-budget, and token-budget rules. Evaluation reports are observational:
they do not schedule nodes, grant approvals, or publish changes.
Reports bind repository, workflow, configuration, dataset, and case checksums,
persist in SQLite, appear in run comparison, and retain append-only human
annotations and pairwise preferences separately from deterministic results.

Kouro also contains the accepted T1–T6 ticket system: local greenfield
planning, immutable run snapshots, GitHub Issues synchronization, and
capability-aware Forgejo Issues synchronization, including resumable migration
from local authority to either remote provider. The local dashboard provides a
unified planning and execution Kanban with ticket histories and redacted
provider configuration status.

## Install

Install directly from GitHub without cloning the repository:

```bash
npm install --global github:usersatoshi/kouro
```

Or install it globally with Bun:

```bash
bun add --global github:usersatoshi/kouro
```

Confirm that the command is available:

```bash
kouro --version
kouro --help
```

Kouro installs its normal `@kouro/*` package dependency graph; the root
package is a small Bun launcher rather than an embedded implementation bundle.

To upgrade, run the same global installation command again. Uninstall with the
package manager you used:

```bash
npm uninstall --global kouro
bun remove --global kouro
```

## Quick start

First, check which agent harnesses Kouro can use:

```bash
kouro diagnostics
```

The result reports provider availability separately from safe terminal
execution. Bundled in-process SDKs report available; Codex and OpenCode also
require their local executables:

```json
[
  { "id": "codex", "available": true, "terminalSandbox": "provider-native", "terminalAvailable": true },
  { "id": "claude-code", "available": true, "terminalSandbox": "provider-native", "terminalAvailable": true },
  { "id": "opencode", "available": false, "terminalSandbox": "sandbox-runtime", "terminalAvailable": false },
  { "id": "pi", "available": true, "terminalSandbox": "sandbox-runtime", "terminalAvailable": true }
]
```

OpenCode and Pi terminal tools use Seatbelt on macOS, Bubblewrap on
Linux/WSL2, and a provisioned account plus ACL/WFP enforcement on native
Windows. Check the portable sandbox separately with `kouro sandbox status`.
On Windows, run `kouro sandbox setup` once and approve its elevation prompt.

Run the built-in feature-development workflow against a Git repository:

```bash
kouro run feature-development \
  --repo /path/to/your/repository \
  --task "Add account export with tests" \
  --harness codex
```

For kanban-backed work, use a source-qualified ticket reference after
configuring that ticket provider:

```bash
kouro run feature-development \
  --repo /path/to/your/repository \
  --ticket kanban:ENG-123 \
  --harness codex
```

Kouro resolves the ticket before creating a worktree, stores an immutable
snapshot in the run, and gives the same objective and acceptance criteria to
every agent. Use `--task-file request.md` for longer standalone requests.

Kouro-owned planning tickets are usable through the CLI:

```bash
kouro ticket create --project personal \
  --title "Add CSV export" \
  --description "Export filtered results as CSV."
kouro ticket list --project personal
kouro run feature-development --repo /path/to/repository \
  --ticket kouro:<ticket-id> --harness codex
```

GitHub and Forgejo imports, synchronization, and local-to-remote migration are
composed from environment-only credentials. See
[`packages/cli/README.md`](packages/cli/README.md#kouro-ticket-) for setup and
command examples.

On a TTY, `kouro run` stays attached, advances the workflow, and presents each
approval until the run is terminal or you detach. Pressing Ctrl-C detaches
without cancelling. Reconnect with:

```bash
kouro attach <run-id>
```

Use `--no-interactive` (or non-TTY input/output) to advance only to the next
operator boundary and print the run ID plus pending action as structured JSON.
Kouro returns the new run ID and its current status:

```json
{
  "runId": "run-example",
  "status": "waiting_for_approval"
}
```

Keep the run ID. Use it to inspect and control the run:

```bash
kouro status run-example
kouro runs
```

When the workflow reaches an approval node, `status` shows the pending
invocation sequence. Approve the plan and let the workflow continue:

```bash
kouro approve run-example 3 --reason "Plan looks good"
```

The built-in workflow asks for approval twice:

1. Before implementation begins.
2. Before the completed changes are delivered.

The final review displays the exact bound diff and editable commit/PR metadata.
After approval, Kouro verifies that the worktree still produces the prepared
tree, creates the approved commit, and creates `kouro/<run-id>`. It never
silently recaptures changed contents.

Publish immediately from the interactive session or later:

```bash
kouro publish <run-id> --provider github --remote origin
```

GitHub and Forgejo use the existing `KOURO_*_OWNER`, `REPOSITORY`, `TOKEN`, and
endpoint configuration; project-board configuration is not required for pull
requests. Publication failures are retryable and do not change local success.

## What the built-in workflow does

The `feature-development` workflow runs this sequence:

```text
check repository
  -> plan with an agent
  -> wait for plan approval
  -> implement in an isolated worktree
  -> run validation
  -> review with an agent
  -> wait for delivery approval
  -> create a merge-ready branch
```

Validation failures can return to the implementation agent up to three times.
Review change requests can return to the same agent context up to two times.
Those bounds are part of the compiled workflow and cannot be increased by an
agent.

Your original checkout is not used as the agent's working directory. Kouro
pins its current `HEAD` and creates a separate worktree under Kouro's data
directory.

## Choose agent harnesses

Use one harness for every unpinned agent node:

```bash
kouro run feature-development \
  --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness codex
```

Route individual nodes to different harnesses:

```bash
kouro run feature-development \
  --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness plan=claude-code \
  --harness implement=opencode \
  --harness review=codex
```

Repeat a route to define fallback order:

```bash
kouro run feature-development \
  --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness implement=opencode \
  --harness implement=codex
```

If no `--harness` option is supplied, Kouro tries its default supported
harness order. Supplying an explicit harness is recommended so a missing CLI
does not surprise you.

## Select models in a workflow

Model identifiers belong to the workflow because each harness uses its own
model namespace. Add a `models` map to an agent node:

```typescript
const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  models: {
    codex: 'gpt-5.2-codex',
    opencode: 'openai/gpt-5.2',
  },
  capabilities: ['repository.read', 'repository.write'],
  recoveryPolicy: 'resume_supported',
});
```

Kouro selects the entry for the harness used by that attempt. This supports a
different model for each fallback harness. The selected model is included in
the compiled workflow checksum and durable attempt history, and resumed
sessions keep the same selection. If the selected harness has no entry, Kouro
leaves the model unset and that CLI uses its configured default.

## Set reasoning effort per agent

Reasoning effort belongs on each workflow role when stages need different
cost, latency, and depth:

```typescript
import { REASONING_EFFORT } from '@kouro/adw';

const scout = workflow.subagent('scout', {
  role: 'repository-scout',
  prompt: './prompts/scout.md',
  reasoningEffort: REASONING_EFFORT.LOW,
  capabilities: ['repository.read'],
  maxInvocations: 2,
  maxConcurrent: 2,
});

const plan = workflow.agent('plan', {
  role: 'planner',
  prompt: './prompts/plan.md',
  reasoningEffort: REASONING_EFFORT.HIGH,
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});

const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  reasoningEffort: REASONING_EFFORT.MEDIUM,
  capabilities: ['repository.read', 'repository.write'],
  recoveryPolicy: 'resume_supported',
});
```

The web launch setting is the fallback for agents without a compiled value.
A subagent without its own value inherits its parent's effective effort.
Omitting every level keeps the harness provider default.

## Create your own workflow

Create an editable ADW package in the current repository:

```bash
cd /path/to/your/repository
bun add --dev @kouro/adw
kouro create adw my-workflow --template feature-development
```

The default output is:

```text
.kouro/my-workflow/
  manifest.json
  kouro.adw.ts
  prompts/
```

The entrypoint imports the fluent `WorkflowBuilder` API from `@kouro/adw`. Add
nodes with `workflow.agent`, `workflow.command`, `workflow.approval`, or
`workflow.complete`, then connect their handles with `node.on(...).to(...)`.

Run it by passing its directory:

```bash
kouro run .kouro/my-workflow --repo . --harness codex
```

Available starter templates:

| Template | Intended use |
| --- | --- |
| `feature-development` | Scout, plan, approve, implement, and validate a feature |
| `bug-fix` | Scout, reproduce, fix, and validate a defect |
| `hotfix` | Scout, assess, implement, and validate an urgent correction |
| `chore` | Implement and validate focused maintenance work |

Use `--output <directory>` to create the workflow somewhere other than
`.kouro`. Kouro refuses to overwrite an existing workflow directory.
Feature, bug-fix, and hotfix planners can invoke bounded read-only repository
and test scouts. The chore template keeps its direct maintenance flow.

## Run operations

### Inspect runs

```bash
kouro runs
kouro status <run-id>
```

### Decide approvals

```bash
kouro approve <run-id> <invocation> --reason "Approved"
kouro reject <run-id> <invocation> --reason "Needs a different approach"
```

### Control a run

```bash
kouro pause <run-id>
kouro resume <run-id>
kouro cancel <run-id> --reason "No longer needed"
```

Pausing is recoverable. Cancellation is terminal.

### Control an invocation

```bash
kouro steer <run-id> <invocation> --message "Preserve the public API"
kouro interrupt <run-id> <invocation> --reason "Taking too long"
kouro retry <run-id> <invocation> --reason "Transient failure"
kouro skip <run-id> <invocation> --reason "Not applicable"
```

Steering is durably attached to the active agent attempt and delivered while
its provider turn is running. The event history records whether the provider
applied or rejected it.

Skipping works only when the workflow explicitly declares that invocation as
eligible to skip.

## Web console and API

Start the local server:

```bash
kouro serve
```

Then open:

```text
http://localhost:4317
```

Choose a different port when needed:

```bash
kouro serve --port 8080
```

The server exposes the API under `/api/` and serves the bundled execution
console from the same address. Keep the process running while using the web
console.

## Local data

Kouro follows the XDG Base Directory Specification:

| Data | Default location | Override |
| --- | --- | --- |
| Database and run data | `~/.local/share/kouro` | `KOURO_DATA_DIR` |
| Configuration | `~/.config/kouro` | `KOURO_CONFIG_DIR` |
| Artifacts | `~/.local/share/kouro/artifacts` | Derived from data directory |
| Worktrees | `~/.local/share/kouro/worktrees` | Derived from data directory |

`XDG_DATA_HOME` and `XDG_CONFIG_HOME` are respected when the Kouro-specific
variables are not set.

Use a separate data directory for an isolated experiment:

```bash
KOURO_DATA_DIR=/tmp/kouro-demo kouro runs
```

## Troubleshooting

### A harness is unavailable

Run:

```bash
kouro diagnostics
```

Install the missing Codex or OpenCode executable, or configure authentication
for the selected bundled SDK, then retry with its Kouro harness ID. Claude uses
the `claude-code` harness ID; Pi uses `pi`.

If the provider is available but `terminalAvailable` is false, run:

```bash
kouro sandbox status
```

Install the reported platform dependency. Native Windows requires the explicit
one-time `kouro sandbox setup` command.

### Kouro is waiting for approval

Inspect the run:

```bash
kouro status <run-id>
```

Find the pending approval invocation sequence, then pass that number to
`kouro approve` or `kouro reject`.

### A repository cannot be registered

Confirm that the path is a Git repository with a valid `HEAD`:

```bash
git -C /path/to/repository rev-parse HEAD
```

Kouro pins that commit before creating its worktree. Uncommitted changes in
your existing checkout are not part of the pinned starting commit.

### Where are the completed changes?

Inspect the target repository's Kouro branches:

```bash
git -C /path/to/repository branch --list 'kouro/*'
```

The branch name for a successful run is `kouro/<run-id>`.

## Documentation

- [Development and architecture guide](docs/development.md)
- [Runtime model](docs/runtime-model.md)
- [Terminology](docs/terminology.md)
- [Runtime invariants](docs/invariants.md)
- [Product and implementation plan](plan.md)
- [Milestone acceptance records](docs/milestones)
- [Architecture decisions](docs/adrs)

Kouro is licensed under [Apache-2.0](LICENSE).
