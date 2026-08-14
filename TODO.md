# Kouro — Milestone TODO

> Auto-generated from `plan.md`. Update checkboxes as work progresses.

---

## M1 — Deterministic compiler and simulator

Status: **Complete** (accepted 2026-07-26)

### Deliverables

- [x] Terminology and invariants (`docs/terminology.md`, `docs/invariants.md`)
- [x] Five foundational ADRs (`docs/adrs/0001-0005`)
- [x] Content-addressed compiled bundle
- [x] Canonical serialization and checksum
- [x] Pure reducer
- [x] Exact transition selection
- [x] Explicit loop counters
- [x] Deterministic scheduler intents
- [x] Executable replay simulations

### Exit criteria

- [x] Recompiling unchanged input is byte-identical
- [x] Same bundle and events always produce same state and intents
- [x] Invalid, missing, or ambiguous transitions produce typed failures
- [x] Every cycle has an explicit bound
- [x] Retries do not increment repair counters
- [x] Recovery decisions depend only on recorded state and declared policy

### Evidence

| Test | Status |
| --- | --- |
| `package-compiler.test.ts` | [x] |
| `deterministic-replay.test.ts` | [x] |
| `compiler-validation.test.ts` | [x] |
| `transition-selection.test.ts` | [x] |
| `invocation-vs-attempt.test.ts` | [x] |
| `bounded-loop.test.ts` | [x] |
| `recovery-decision.test.ts` | [x] |
| `command-approval-command.test.ts` | [x] |
| `malformed-history.test.ts` | [x] |

### Packages delivered

- [x] `@kouro/domain` — pure types
- [x] `@kouro/adw` — ADW compilation
- [x] `@kouro/runtime` — pure reduction, scheduling, transition

---

## M2 — Durable command and approval runtime

Status: **Complete** (accepted 2026-07-26)

### Packages to create

- [x] `packages/persistence-sqlite/` — scaffold via `bun run create-package persistence-sqlite`
- [x] `packages/executors/` — scaffold
- [x] `packages/api-contracts/` — scaffold

### Deliverables

- [x] SQLite event store and projections
- [x] Command, approval, and complete executors
- [x] Invocation and attempt persistence
- [x] Idempotency records
- [x] Restart recovery

### Exit criteria

- [x] Command -> approval -> command -> complete survives restart
- [x] Approvals remain pending across restart
- [x] Completed invocations are not duplicated
- [x] Duplicate event sequences are rejected

### Evidence

| Test | Status |
| --- | --- |
| `sqlite-event-store.test.ts` | [x] |
| `run-store.contract.ts` | [x] |

---

## M3 — Worktree and Git recovery

Status: **Complete** (accepted 2026-07-26)

### Packages to create

- [x] `packages/sandbox-worktree/` — scaffold

### Deliverables

- [x] Repository registration and pinned starting commit
- [x] One worktree per run
- [x] Git status and diff artifacts
- [x] Controlled commit operations
- [x] Repository mutation coordination
- [x] Cleanup and recovery

### Exit criteria

- [x] Concurrent runs use isolated worktrees
- [x] Interrupted creation reuses or safely reconciles the worktree
- [x] Commit recovery verifies the expected tree and does not duplicate commits

### Evidence

| Test | Status |
| --- | --- |
| `worktree-sandbox-provider.test.ts` | [x] |

---

## M4 — Harness-independent agent execution

Status: **Complete** (accepted 2026-07-26)

### Packages to create

- [x] `packages/harnesses/` — scaffold

### Deliverables

- [x] Normalized harness contract and registry
- [x] Scripted fake harness
- [x] Agent executor
- [x] Structured output validation
- [x] Event and artifact persistence
- [x] Claude Code, Codex, OpenCode, and Pi adapters
- [x] Per-agent-node harness routing with node-specific fallback order
- [x] Optional workflow-level agent harness pins
- [x] Explicit fallback and resume policies

### Exit criteria

- [x] The same ADW runs through every supported harness
- [x] One run routes different agent nodes through different harnesses
- [x] Workflow pins override run policy; omitted pins use CLI routing
- [x] Harness-specific details do not leak into workflow definitions
- [x] Invalid structured output becomes a typed node failure
- [x] Retry and fallback remain attempts of one invocation

### Evidence

| Test | Status |
| --- | --- |
| `harness-independent-agent.test.ts` | [x] |

---

## M5 — Feature-development vertical slice

Status: **Complete** (accepted 2026-07-26)

### Workflow

```
worktree -> plan -> approval -> implement -> validate
                                      ^ failure |
                         review --changes------+
                            | approved
                    delivery approval -> complete
```

### Limits

- [x] Maximum validation-feedback traversals to the implementation agent: 3
- [x] Maximum review-feedback traversals to the implementation agent: 2
- [x] Maximum run duration: 8 hours
- [x] Maximum node invocations: 30

### Exit criteria

- [x] A fixture task reaches a merge-ready branch
- [x] Interruption and restart preserve the run
- [x] Repair loops stop at their exact bounds
- [x] Review is read-only by policy
- [x] Final artifacts include plan, tests, review, and diff

---

## M6 — Observable Elysia and web MVP

Status: **Complete** (accepted 2026-07-26)

### Deliverables

- [x] Elysia application factory and composition root
- [x] Application use cases and typed API contracts
- [x] Eden client
- [x] Run, workflow, repository, artifact, event, and approval endpoints
- [x] Typed reconnectable event stream
- [x] Run list and read-only React Flow graph
- [x] Node details, logs, artifacts, diff, and approval controls

### Exit criteria

- [x] API tests run without opening a network port
- [x] Domain and runtime packages do not import Elysia
- [x] A run can be understood without reading SQLite
- [x] Approval can be completed through the web UI
- [x] Reconnecting clients replay events after the last received sequence

---

## M7 — Runnable local MVP and operator CLI

Status: **Complete** (accepted 2026-07-26)

### Package to create

- [x] `packages/cli/` — scaffold via `bun run create-package cli`

### Deliverables

- [x] Distributable `kouro` binary with stable help, version, and typed errors
- [x] Predictable local data and configuration paths
- [x] Local ADW run, run list, and run inspection commands
- [x] Approval and rejection commands
- [x] Pause, resume, cancel, steer, interrupt, retry, and policy-eligible skip commands
- [x] Long-lived worker loop with startup recovery and clean shutdown
- [x] Single-process SQLite, worktree, artifact, harness, API, and web composition
- [x] Packaged built-in feature-development ADW
- [x] Repository registration, starting-commit pinning, and run worktree orchestration
- [x] Automatic final test, status, diff, and review artifact publication
- [x] Controlled commit and named merge-ready branch delivery
- [x] Durable lifecycle events and application use cases
- [x] Run creation, lifecycle, and complete local repository API surfaces
- [x] IDE-style web run controls for pause, resume, cancel, steer, interrupt, retry, and skip
- [x] Harness availability diagnostics
- [x] Lifecycle, worker-ownership, and composition ADRs

### CLI surface

- [x] `kouro run <adw> --repo <path> [--harness <id>]`
- [x] `kouro runs`
- [x] `kouro status <run-id>`
- [x] `kouro approve <run-id> <invocation> --reason <text>`
- [x] `kouro reject <run-id> <invocation> --reason <text>`
- [x] `kouro pause|resume|cancel <run-id>`
- [x] `kouro steer <run-id> <invocation> --message <text>`
- [x] `kouro interrupt|retry|skip <run-id> <invocation> --reason <text>`
- [x] `kouro serve`

### Exit criteria

- [x] A fresh checkout can invoke `kouro --help` without a custom host script
- [x] The built-in feature workflow reaches a named merge-ready branch
- [x] CLI approvals stop and resume the same durable run
- [x] Process termination and restart do not duplicate completed work or Git effects
- [x] Pause and interrupt remain distinct durable operations
- [x] Resume and retry obey the declared recovery policy
- [x] Skip requires workflow eligibility and a durable bound actor and reason
- [x] CLI and web share one observable approval and run state
- [x] Decision-affecting CLI configuration is snapshotted into the run
- [x] End-to-end tests cover subprocess, SQLite, Git, worktree, restart, and HTTP boundaries

---

## M8 — Durable work-item input and ticket-driven runs

Status: **In progress** — provider-neutral core complete; first concrete
ticket-provider adapter pending

### Invariant

Every feature-development run is bound to an immutable work-item snapshot.
Agents receive that snapshot as workflow input and cannot replace, broaden, or
silently refresh it during the run.

### Deliverables

- [x] ADR for durable workflow inputs and external work-item resolution
- [x] Provider-neutral `WorkItem` contract and ticket-provider port
- [x] Source-qualified ticket references with a configured provider
- [x] Normalized title, description, acceptance criteria, labels, and source URL
- [x] Source revision and content checksum captured at run creation
- [ ] Large ticket attachments stored as checksum-bearing artifacts
- [x] Work-item snapshot recorded in durable run configuration
- [x] Deterministic prompt composition for planner, implementer, and reviewer
- [x] CLI support for `--ticket <reference>`
- [x] CLI fallback for `--task <text>` and `--task-file <path>`
- [x] API contracts and validation for ticket and inline task inputs
- [x] Run inspection displays the bound work item and its source
- [x] Ticket-provider contract tests and fake provider
- [x] Integration coverage for resolution, restart, replay, and prompt delivery
- [x] User-guide examples for ticket-driven and inline-task runs

### CLI surface

- [x] `kouro run <adw> --repo <path> --ticket <reference> [--harness <id>]`
- [x] `kouro run <adw> --repo <path> --task <text> [--harness <id>]`
- [x] `kouro run <adw> --repo <path> --task-file <path> [--harness <id>]`

### Exit criteria

- [x] `feature-development` refuses to start without exactly one work-item input
- [x] A ticket is resolved before the repository worktree begins execution
- [x] Replaying or restarting a run uses the original snapshot without refetching
- [x] Editing the external ticket after run creation cannot alter the active run
- [x] Every agent node receives the same objective and acceptance criteria
- [x] Ticket-provider failures are typed and do not create a partial run
- [x] Inline tasks follow the same durable contract as provider-backed tickets
- [x] Provider credentials and secrets are never persisted in events or artifacts

---

## M9 — Review-bound delivery and pull requests

Status: **Complete** (accepted 2026-07-28)

- [x] Explicit `delivery_review` authoring and compiler validation
- [x] Exact prepared-tree, diff-artifact, and metadata proposal binding
- [x] Editable commit and pull-request metadata
- [x] Two bounded context-preserving delivery repair returns
- [x] Interactive `run`, `attach`, detach, and structured non-TTY boundaries
- [x] Shared CLI/web durable decisions with stale-submission conflicts
- [x] Named base-branch snapshot and detached-repository validation
- [x] Exact-tree controlled commit and `kouro/<run-id>` branch
- [x] Provider-neutral pull-request port
- [x] GitHub and Forgejo pull-request adapters
- [x] Verify-then-replay branch push and pull-request reconciliation
- [x] Retryable publication errors that preserve local success
- [x] ADR, milestone evidence, tests, and operator documentation

---

## M10 — Repository-local evaluations

Status: **Complete** (accepted 2026-08-14)

- [x] ADR for repository-local datasets and observational evaluator authority
- [x] Scaffold public `@kouro/evaluations` package
- [x] Validate and canonically checksum versioned dataset definitions
- [x] Deterministic run status, invocation budget, token budget, and node outcome rules
- [x] Preserve `unavailable` when best-effort usage evidence is incomplete
- [x] Load checked-in datasets from repository `.kouro/evaluations/`
- [x] Bind experiment execution to commit, workflow, dataset, case, and configuration checksums
- [x] Persist experiment reports and expose API/CLI queries
- [x] Connect evaluator reports to the existing run-comparison workspace
- [x] Add human annotations and pairwise preferences

---

## Ticket system

### T1 — Local ticket foundation

Status: **Complete** (accepted 2026-07-26)

- [x] Ticket domain and stable Kouro ticket IDs
- [x] Local SQLite persistence
- [x] Comments, labels, assignees, priorities, and relationships
- [x] Optimistic revisions and typed failures
- [x] Local provider with no Git, network, remote, or token dependency
- [x] Pure Backlog, Ready, Blocked, Done, and Cancelled Kanban projection
- [x] Explicit planning move rules
- [x] Unit and restart integration coverage

### T2 — Kouro run integration

Status: **Complete** (accepted 2026-07-26)

- [x] Immutable ticket snapshots
- [x] Ticket-to-run links
- [x] Existing run-start application service integration
- [x] Active implementation-run uniqueness
- [x] Derived execution columns
- [x] Active-run ticket-change policy

### T3 — GitHub Issues

Status: **Complete** (accepted 2026-07-26)

- [x] GitHub provider and contract coverage
- [x] Import, create, update, comments, labels, and assignees
- [x] Webhooks and polling reconciliation
- [x] Idempotent run-status synchronization

### T4 — Forgejo Issues

Status: **Complete** (accepted 2026-07-26)

- [x] Configurable instances and version detection
- [x] Per-instance capability detection
- [x] Core issue, comment, label, assignee, and milestone operations
- [x] Webhooks where supported and polling fallback

### T5 — Ticket migration

Status: **Complete** (accepted 2026-07-26)

- [x] Durable local-to-GitHub migration
- [x] Durable local-to-Forgejo migration
- [x] Remote verification and duplicate prevention
- [x] Interruption and resume coverage

### T6 — Ticket UI

Status: **Complete** (accepted 2026-07-26)

- [x] Ticket list and details
- [x] Unified planning and derived execution Kanban
- [x] Run, snapshot, sync, and migration history
- [x] Provider configuration

---

## Deferred (post-MVP)

- [ ] Bug-fix, chore, and hotfix ADWs
- [ ] Subworkflows and explicit input/output mapping
- [ ] Parallel branches, joins, branch cancellation, and leases
- [ ] Installable Git-based ADW packs and lockfiles
- [ ] Hosted registry or marketplace
- [ ] Optional Vedh integration
- [ ] Additional ticket providers and Git hosting integrations
- [ ] Docker, VM, SSH, or remote-worker sandboxes
- [ ] PostgreSQL and separate workers
- [ ] Visual workflow editing
- [ ] Deployment and merge automation
- [ ] Recovery-aware artifact evaluators and model judges
