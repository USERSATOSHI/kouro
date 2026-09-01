# `@kouro/cli` — Local Kouro Host and Operator CLI

The CLI package provides a **runnable single-process Kouro host** with an operator command-line interface. It composes all infrastructure layers — persistence, sandbox, harnesses, and HTTP API — into a stand-alone application that can run workflows locally.

## Quick Start

Install the root package directly from GitHub:

```bash
npm install --global github:usersatoshi/kouro
kouro --help
```

The installed executable requires Bun. The repository and published package
ship a self-contained bundle, while these workspace dependencies remain for
development.

From a repository checkout:

```bash
# Create an ADW package from a starter template
bun run kouro create adw my-feature --template feature-development

# Run a feature development workflow
bun run kouro run feature-development --repo /path/to/repository \
  --task "Implement the requested change" --harness codex

# Create and run a durable local ticket
ticket_id=$(bun run kouro ticket create \
  --project personal \
  --title "Add CSV export" \
  --description "Export filtered results as CSV." \
  --priority high \
  --label feature | jq -r .id)
bun run kouro ticket move "$ticket_id" --revision 1 --status ready
bun run kouro run feature-development --repo /path/to/repository \
  --ticket "kouro:$ticket_id" --harness codex

# List runs for the current repository
bun run kouro runs

# Check run status
bun run kouro status <run-id>

# Evaluate a terminal run against a checked-in dataset case
bun run kouro eval run <run-id> --dataset feature-regression \
  --case add-health-check --experiment prompt-v2

# Inspect and annotate evaluation evidence
bun run kouro eval reports --experiment prompt-v2
bun run kouro eval annotate <report-id> --verdict pass --note "Meets acceptance criteria"

# Permanently remove a terminal run
bun run kouro delete <run-id> --yes

# Approval operations
bun run kouro approve <run-id> <invocation> --reason "plan accepted"
bun run kouro reject <run-id> <invocation> --reason "changes needed"

# Lifecycle operations
bun run kouro pause <run-id>
bun run kouro resume <run-id>
bun run kouro cancel <run-id> --reason "abandoned"

# Invocation operations
bun run kouro steer <run-id> <invocation> --message "preserve the public API"
bun run kouro interrupt <run-id> <invocation> --reason "taking too long"
bun run kouro retry <run-id> <invocation> --reason "transient error"
bun run kouro skip <run-id> <invocation> --reason "not applicable"

# Diagnostics
bun run kouro diagnostics
bun run kouro sandbox status

# Native Windows only: one-time elevated sandbox provisioning
bun run kouro sandbox setup

# Start the current repository dashboard and API (default port 4317)
bun run kouro serve [--port <number>] [--repo <path>]

# Help
bun run kouro --help
```

`steer` persists operator guidance before the worker forwards it to the exact
active agent turn. `status` and the event stream show whether the runtime
applied or rejected the request.

## Architecture

```
CLI (main.ts)
  │
  ▼ dispatches commands
LocalKouroHost (local-host.ts)
  ├── SqliteEventStore (persistence-sqlite)
  ├── WorktreeSandboxProvider (sandbox-worktree)
  ├── HarnessRegistry (harnesses)
  │   ├── CodexHarness (App Server)
  │   ├── ClaudeCodeHarness (Claude Agent SDK)
  │   ├── OpenCodeHarness (SDK + supervised server)
  │   └── PiHarness (in-process AgentSession)
  ├── LocalArtifactWriter (harnesses)
  ├── TicketService + SQLite ticket stores
  ├── GitHubTicketProvider (when KOURO_GITHUB_* is configured)
  ├── ForgejoTicketProvider (when KOURO_FORGEJO_* is configured)
  ├── LocalWorker (worker.ts) — leased polling loop
  │   └── RunCoordinator (executors)
  └── createKouroApp (api)
       └── Elysia HTTP server
```

## Commands

### `kouro create adw <name> [--template <template>] [--output <directory>]`

Creates a compilable ADW package in `<directory>/<name>`. Names must be
lowercase kebab-case identifiers. The output directory defaults to `.kouro`
under the current directory, producing `.kouro/<name>`. The template defaults
to `feature-development`.

Available templates:

- `feature-development` — scout, plan, approve, implement, and validate a feature
- `hotfix` — scout, assess, implement, and validate an urgent correction
- `bug-fix` — scout, reproduce, fix, and validate a defect
- `chore` — implement and validate a focused maintenance task

Each generated entrypoint imports `WorkflowBuilder` from `@kouro/adw`. Install
that package in the repository before compiling the workflow. Templates can be
extended through node handles and fluent transitions instead of editing raw
node and transition records. Feature, hotfix, and bug-fix planning agents may
invoke bounded read-only repository and test scouts; chore intentionally keeps
its direct maintenance flow.

The command refuses to replace an existing folder.

### `kouro run <adw> --repo <path> <work-item> [--harness <id|node=id>]...`

Creates and executes a new run:

1. Compiles the ADW package (bundled `feature-development` or custom path)
2. Resolves and snapshots the work item
3. Registers the target Git repository
4. Pins the starting commit (`HEAD`)
5. Creates a Git worktree sandbox
6. Creates the run and advances it to its first stable boundary

The `<adw>` argument can be:
- `feature-development` — the bundled workflow
- A path to an ADW package directory

The built-in feature workflow requires exactly one work-item option:

- `--ticket <provider:reference>` resolves a configured ticket provider.
- `--task <text>` supplies an inline request.
- `--task-file <path>` reads a longer inline request.

The normalized work item is checksummed, persisted in durable run
configuration, and added to every agent prompt. Provider credentials are not
persisted.

An unqualified harness adds to the run's default ordered fallback policy.
Qualify repeated options with a compiled agent node ID to route different
agents independently:

```bash
bun run kouro run feature-development --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness plan=claude-code \
  --harness implement=opencode \
  --harness review=codex
```

Repeating a node route defines its fallback order, for example
`--harness implement=opencode --harness implement=pi`.

An agent node's compiled `harness` field takes precedence over both forms of
CLI routing. Omit the field when operators should choose a harness or configure
fallbacks at run creation.

### `kouro serve [--port <number>]`

Starts the Kouro HTTP API server:
- API routes under `/api/`
- Static web assets from `../../web/dist`
- SPA fallback to `index.html`
- Default port: `4317`
- Repository scope: `--repo <path>`, defaulting to the current directory

Only runs for the selected repository are exposed by default. Use
`--all-repos` for the explicit shared local view. The server can observe a run
started by another CLI process without interrupting it. A renewable SQLite
lease ensures only one process performs recovery and advancement, and lets the
server take ownership after the CLI releases or loses the lease.

### `kouro delete <run-id> --yes`

Permanently removes a terminal run, its Kouro-owned worktree, local artifacts,
events, idempotency records, and projections. Active and paused runs must first
be cancelled or otherwise reach a terminal state. The source repository and a
completed run's delivery branch are preserved.

### `kouro event <run-id> <invocation> <event> ...`

Delivers JSON to the exact invocation waiting for the named external event.
Use exactly one of `--payload <json>` or `--payload-file <path>`. Supplying
`--idempotency-key <key>` makes retries return the original durable result
without committing another event; omitted keys are generated per submission.

### `kouro eval ...`

Evaluation datasets are regular JSON files directly under
`.kouro/evaluations/`. `eval datasets` lists compiled IDs, versions, checksums,
and cases. `eval run` records deterministic evidence for a terminal run and
binds it to repository, workflow, configuration, dataset, and case checksums.
`eval reports`, `eval annotate`, and `eval prefer` query or append human
evidence without changing the deterministic report or run history.

### `kouro ticket ...`

Local tickets need no Git repository or remote account:

```bash
# Create
bun run kouro ticket create \
  --project personal \
  --title "Add CSV export" \
  --description "Export filtered results as CSV." \
  --priority high \
  --label feature \
  --assignee usersatoshi

# Inspect (use the id and revision returned by create)
bun run kouro ticket list --project personal
bun run kouro ticket show <ticket-id>

# Optimistic writes require the current revision
bun run kouro ticket update <ticket-id> --revision 1 \
  --title "Add filtered CSV export"
bun run kouro ticket move <ticket-id> --revision 2 --status ready
bun run kouro ticket comment <ticket-id> --body "Ready for implementation"
bun run kouro ticket close <ticket-id> --revision <current-revision>
bun run kouro ticket reopen <ticket-id> --revision <current-revision>

# Launch a linked workflow from the durable ticket
bun run kouro run feature-development --repo /path/to/repository \
  --ticket kouro:<ticket-id> --harness codex
```

The run command captures an immutable ticket snapshot before repository
execution, records a ticket-to-run link, and rejects a second active
implementation run for the same ticket. Later ticket edits cannot change the
active run input.

Available planning statuses are `backlog`, `ready`, `blocked`, `done`, and
`cancelled`. Use `move` for normal board movements and
`close`/`cancel`/`reopen` for terminal lifecycle actions. The command returns
JSON so scripts can read the resulting ticket ID and revision.

#### GitHub setup

Configure one GitHub repository connection in the process environment:

```bash
export KOURO_GITHUB_OWNER=usersatoshi
export KOURO_GITHUB_REPOSITORY=my-repository
export KOURO_GITHUB_PROJECT=my-repository
export KOURO_GITHUB_TOKEN=github_pat_...

# Optional for GitHub Enterprise
export KOURO_GITHUB_API_URL=https://github.example.com/api/v3

bun run kouro ticket providers
bun run kouro ticket import github --project my-repository
```

The token must be able to read issues for import/pull and write issues,
comments, labels, and assignees for push/migration. Kouro passes it directly to
the adapter and never persists or returns it.

#### Forgejo setup

```bash
export KOURO_FORGEJO_URL=https://git.example.com
export KOURO_FORGEJO_OWNER=usersatoshi
export KOURO_FORGEJO_REPOSITORY=my-repository
export KOURO_FORGEJO_PROJECT=my-repository
export KOURO_FORGEJO_TOKEN=...

bun run kouro ticket providers
bun run kouro ticket import forgejo --project my-repository
```

The Forgejo token likewise needs issue read/write access. Non-secret detected
instance metadata may be stored in Kouro SQLite; the token is not.

Remote operations use the stable Kouro ticket ID returned by import:

```bash
# Refresh Kouro from the authoritative remote issue
bun run kouro ticket pull <ticket-id>

# Push a Kouro edit to the bound remote issue
bun run kouro ticket push <ticket-id>

# Move a local ticket to a remote provider without changing its Kouro ID
bun run kouro ticket migrate <ticket-id> \
  --to github \
  --project my-repository
```

Migration is resumable and switches authority only after the created remote
issue is read back and verified. Run `kouro ticket providers` first when a
remote command reports that its provider is not configured.

### `kouro diagnostics`

Checks availability of agent runtimes:

- `codex` — OpenAI Codex App Server executable
- `claude-code` — bundled Anthropic Claude Agent SDK
- `opencode` — OpenCode SDK and required local server executable
- `pi` — bundled in-process Pi SDK

Codex and OpenCode executables are checked through `PATH`. Claude and Pi report
available because their SDK runtimes ship with Kouro; authentication and model
configuration are verified when an attempt starts. Each row separately reports
whether `terminal.execute` has a usable provider-native or portable OS sandbox.

OpenCode and Pi use Kouro's portable command sandbox. macOS uses Seatbelt and
requires `rg`; Linux and WSL2 use Bubblewrap and require `bwrap`, `socat`, and
`rg`. Native Windows uses a dedicated local account, filesystem ACLs, and a
Windows Filtering Platform egress fence. Run `kouro sandbox setup` once on
Windows and approve its elevation prompt; ordinary runs never self-elevate.

`kouro sandbox status` reports missing platform dependencies. A selected agent
node requiring `terminal.execute` is rejected before repository state is
created when none of its explicitly routed harnesses has a usable sandbox.

## Local State (XDG Paths)

Paths follow the XDG Base Directory Specification:

| Path | Default | Override |
|------|---------|----------|
| Data directory | `~/.local/share/kouro` | `$KOURO_DATA_DIR` / `$XDG_DATA_HOME/kouro` |
| Config directory | `~/.config/kouro` | `$KOURO_CONFIG_DIR` / `$XDG_CONFIG_HOME/kouro` |
| Database | `<dataDir>/kouro.sqlite` | — |
| Artifacts | `<dataDir>/artifacts` | — |
| Worktrees | `<dataDir>/worktrees` | — |

## LocalKouroHost

The `LocalKouroHost` class is the **central orchestrator**:

```typescript
import { LocalKouroHost } from '@kouro/cli';

const host = new LocalKouroHost();
await host.initialize();

// Create a run
const { runId, status } = await host.create({
  adw: 'feature-development',
  repositoryPath: '/path/to/repo',
  task: 'Implement the requested change',
  harnesses: ['codex'],
  actor: 'user',
});

// Get the HTTP API app
const app = host.app();

// Start the server
await host.serve(4317);

// Clean up
await host.dispose();
```

### Lifecycle

1. **Initialization** (`initialize()`): Creates directories, boots SQLite, initializes the worktree sandbox, recovers previously running runs
2. **Run creation** (`create()`): Compiles ADW, registers repository, creates worktree, creates run, advances to first stable boundary
3. **Run advancement** (`LocalWorker`): Polling loop (250ms) that advances running runs to their next stable boundary
4. **Delivery preparation**: At an explicit `delivery_review` node, captures
   status/diff artifacts, stages the exact tree, and publishes editable commit
   and pull-request metadata.
5. **Approved finalization**: Verifies and commits only the prepared tree, then
   creates `kouro/<run-id>`. New custom ADWs without delivery review receive no
   implicit commit or branch.
6. **Pull-request publication**: Requires the selected Git remote and remote
   base branch to exist. Kouro pushes the reviewed `kouro/<run-id>` branch when
   it is absent, then creates or reconciles the pull request; it does not add
   repository remotes or publish the base branch implicitly.

## LocalWorker

The `LocalWorker` is a polling loop that advances runs:

```typescript
import { LocalWorker } from '@kouro/cli';

const worker = new LocalWorker(runServices);
await worker.recover();       // recover interrupted runs
worker.start();               // begin polling (250ms interval)
worker.runUntilStable(runId); // synchronously advance a run
worker.dispose();             // stop the loop
```

Features:
- **Recovery**: On startup, loads all running runs and runs `recoverRun()`
- **Stable boundary detection**: Stops advancing when a run reaches an approval gate or terminal state
- **Blocked run detection**: Skips runs that repeatedly encounter errors (avoids busy-looping)
- **Re-entrancy guard**: A `advancing` flag prevents concurrent ticks

## Bundled Workflow: `feature-development`

The CLI ships a pre-built ADW workflow for feature development:

```text
worktree → plan → planApproval → implement → validate → review
                                   ↑            │ failure  │ changes requested
                                   └────────────┴──────────┘
                                                ↓ approved
                                      deliveryApproval → complete
                                                ↓ rejected
                                              failed
```

Validation runs lint, format, and tests. Both validation failures (maximum 3)
and review change requests (maximum 2) return durable feedback to the same
context-preserving implementation agent. Delivery-review change requests have
their own two-return bound.

`kouro run` is continuous on a TTY. Use `kouro attach <run-id>` after detaching,
or `--no-interactive` for a structured one-boundary response. After local
delivery, use `kouro publish <run-id> [--provider github|forgejo] [--remote
origin]` to push without force and create or recover the reviewed pull request.

## Error Handling

| Error Kind | Code | Meaning |
|------------|------|---------|
| `InvalidArguments` | 0 | Bad CLI arguments |
| `Initialization` | 1 | Startup failure (SQLite, worktrees) |
| `Compilation` | 2 | ADW compilation failure |
| `Repository` | 3 | Git repo registration failure |
| `Persistence` | 4 | Run creation/store failure |
| `Lifecycle` | 5 | Run lifecycle operation failure |
| `Serve` | 6 | HTTP server startup failure |
| `HarnessUnavailable` | 7 | Agent harness not found |
| `Scaffolding` | 8 | ADW template creation failed |
| `Publication` | 9 | Push or pull-request publication failed |

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `LocalKouroHost` | class | `local-host.ts` |
| `LocalWorker` | class | `worker.ts` |
| `createLocalRequestHandler(app, webRoot)` | function | `local-host.ts` |
| `resolveLocalPaths(environment?)` | function | `paths.ts` |
| `CliError`, `CliErrorKind` | types | `errors.ts` |
| `WorkerRunServices` | interface | `worker.ts` |
| `LocalPaths` | interface | `paths.ts` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@kouro/adw` | ADW compilation |
| `@kouro/api` | HTTP API |
| `@kouro/api-contracts` | API DTOs |
| `@kouro/domain` | Domain types |
| `@kouro/executors` | RunCoordinator |
| `@kouro/harnesses` | CodexHarness, ClaudeCodeHarness, OpenCodeHarness, PiHarness |
| `@kouro/persistence-sqlite` | SqliteEventStore |
| `@kouro/sandbox-worktree` | WorktreeSandboxProvider |
| `@usersatoshi/results` | Result type |
