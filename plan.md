# Kouro — Product and Implementation Plan

## 1. Product definition

Kouro is a programmable, deterministic execution engine for Agent Development
Workflows (ADWs).

It orchestrates software-development workflows that combine:

- coding agents;
- deterministic commands;
- Git operations;
- validation steps;
- durable human approvals;
- conditional transitions;
- bounded repair loops;
- pause, resume, retry, and crash recovery.

Kouro is separate from the surrounding products:

| Product | Responsibility |
| --- | --- |
| Kouro | Deterministic coding-workflow orchestration |
| Yumi | Personal and home assistance |
| Kyuki | Company/team-wide organizational memory; outside Kouro |
| Vedh | Optional repository-intelligence provider |

Kouro does not use Kyuki for workflow context, repository-local evaluations,
or agent memory. Vedh remains an optional future repository-intelligence
integration and is not required for the initial release.

## 2. Determinism contract

Kouro's core guarantee is:

> Given the same compiled workflow and ordered durable event history, Kouro
> reconstructs the same state and emits the same next orchestration decisions.

This is divided into four independently testable guarantees:

1. The same source bundle produces the same compiled bundle and checksum.
2. The same compiled bundle and event history produce the same projected state.
3. The same projected state produces the same ordered orchestration decisions.
4. An interrupted effect produces the same declared recovery decision.

Kouro does not guarantee deterministic shell commands, Git effects, filesystem
behavior, provider behavior, or model output. Those outcomes are recorded as
events. The runtime deterministically decides what to do with the recorded
outcomes.

The deterministic runtime owns:

- workflow selection and version pinning;
- dependency and transition evaluation;
- stable scheduling;
- retry and repair limits;
- recovery-policy selection;
- permission-policy evaluation;
- artifact validation;
- approval gates;
- Git side-effect rules;
- crash-recovery decisions.

Agents and external tools may produce nondeterministic data. They cannot alter
the workflow graph, schedule nodes, raise limits, grant permissions, bypass
approvals, or select undeclared workflows.

## 3. Product boundaries

Kouro is not:

- a general chat-agent framework;
- a personal assistant;
- a replacement for coding harnesses;
- a free-form multi-agent room;
- a visual editor first;
- a distributed or Kubernetes-first system;
- an autonomous merge-and-deploy system by default;
- a guarantee that model or command output is reproducible.

The MVP is a trusted local execution mode. Git worktrees isolate repository
changes between runs, but are not a security sandbox. Capabilities such as
`network.none` and `repository.read` are policy declarations until an OS,
container, VM, or remote-worker boundary enforces them.

## 4. Foundational runtime model

The runtime distinguishes three identities:

```text
NodeDefinition
└── immutable node in the compiled workflow

NodeInvocation
└── one graph activation of a node definition

NodeAttempt
└── one retry or harness-fallback attempt within an invocation
```

A repair loop creates another invocation. An operational retry creates another
attempt within the current invocation.

Example:

```text
test invocation 1
└── attempt 1: tests failed

repair invocation 1
└── attempt 1: succeeded

test invocation 2
├── attempt 1: process interrupted
└── attempt 2: tests passed
```

## 5. Transition contract

The first runtime is sequential:

- exactly one outgoing transition must match a completed invocation;
- multiple matches are a typed runtime failure;
- no match is a typed runtime failure unless an explicit default exists;
- declaration order never changes transition selection;
- fan-out and joins are not supported in the first runtime;
- loop counters increment only on explicitly annotated transitions;
- loop counters represent graph traversal, not executor retries.

Example:

```ts
test
  .on('failed')
  .when(testRepairs.belowLimit())
  .increment(testRepairs)
  .to(repair);
```

The expression language is restricted, deterministic, and versioned. It cannot
execute JavaScript or access the clock, filesystem, database, network, random
values, or process state.

The compiler assigns a stable ordinal using canonical node IDs. Initial
scheduler ordering is:

1. declared priority;
2. compiler-assigned ordinal;
3. invocation sequence.

Strongly connected components are used for cycle validation, not runtime
ordering.

## 6. Compiled workflow bundle

TypeScript is the trusted authoring format. The runtime executes only a
data-only compiled bundle.

The content-addressed bundle includes:

- compiled workflow IR;
- prompt contents;
- resolved output schemas;
- exact subworkflow bundles and checksums;
- resolved permissions;
- decision-affecting defaults;
- manifest metadata;
- compiler version;
- IR/schema version;
- expression-language version.

Canonical serialization covers the entire bundle. Historical runs never reopen
mutable prompt, schema, manifest, or subworkflow files.

A run pins:

- workflow ID and version;
- compiled bundle and checksum;
- starting repository commit;
- all decision-affecting configuration;
- runtime semantic versions.

## 7. Side-effect recovery

Kouro does not claim universal exactly-once execution. Each side-effecting node
operation declares a recovery policy:

```ts
type RecoveryPolicy =
	| "replay_safe"
	| "verify_then_replay"
	| "resume_supported"
	| "manual_reconciliation"
	| "never_automatically_retry";
```

Recovery policy belongs to the concrete node operation, not merely its executor
type.

Examples:

| Operation | Recovery policy |
| --- | --- |
| Read-only test command | `replay_safe` |
| Git commit | `verify_then_replay` |
| Resumable harness session | `resume_supported` |
| Unknown deployment script | `manual_reconciliation` |
| Destructive migration | `never_automatically_retry` |

The scheduler emits pure orchestration intents. Timestamps, durable IDs, event
sequence numbers, and leases are assigned only when intents are committed at an
infrastructure boundary.

## 8. Durable state

Run state is reconstructed from an append-only ordered event history through a
pure reducer.

The reducer must not:

- read the current time;
- generate IDs;
- access infrastructure;
- read randomness;
- mutate previous state;
- execute workflow effects.

Large logs are stored as chunked artifacts rather than event payloads. Artifact
publication follows:

```text
temporary write
→ checksum
→ atomic rename
→ durable artifact reference
```

Approvals are bound to:

- workflow checksum;
- node invocation ID;
- artifact checksums;
- resolved action;
- repository HEAD;
- approving actor and reason.

An approval is rejected as stale when any bound value no longer matches.

Graceful pause stops new scheduling while allowing an active attempt to finish.
Interrupt is a separate explicit action against an active attempt.

Skipping is not an unrestricted administrative endpoint. A skip must be allowed
by the workflow and records the actor, reason, invocation, and selected result.

## 9. Initial architecture

The implementation boundary remains:

```text
Elysia transport
    ↓
Application use cases
    ↓
Workflow domain and runtime
    ↓
Infrastructure adapters
```

Elysia handlers validate transport input, invoke an application use case, and
map its typed result. They never schedule nodes or mutate workflow state
directly.

The first package set is intentionally small:

```text
packages/
├── domain/
├── adw/
├── runtime/
├── persistence-sqlite/
├── executors/
├── harnesses/
├── sandbox-worktree/
└── api-contracts/
```

Internal modules preserve future boundaries. A module becomes a separate
package only when it gains an independent API, dependency boundary, or release
lifecycle.

For the MVP, the API, coordinator, and one worker may share a process while
retaining separate interfaces.

## 10. Recommended stack

- TypeScript
- Bun
- ElysiaJS
- React and Vite
- React Flow for a read-only graph
- Eden Treaty
- SQLite in WAL mode
- local filesystem artifact storage
- Git worktrees
- Bun test
- `@usersatoshi/results` at expected failure boundaries

The MVP does not introduce Temporal, LangGraph, Kubernetes, Redis, a distributed
queue, or remote workers.

## 11. Error convention

Expected domain and operational failures use `Result.Err`. Unexpected
programming defects throw.

Each bounded domain owns:

- its error-kind enum;
- its discriminated error union;
- `toErr`;
- its domain-specific Result helper.

Thrown infrastructure errors are mapped at the infrastructure boundary.
Persisted and API-visible errors must be serializable. Kouro does not use one
global error union and does not depend on the patterns repository.

## 12. Revised implementation order

1. Terminology, invariants, and ADRs
2. Content-addressed compiled bundle
3. Compiler and checksum
4. Event model and pure reducer
5. Definition/invocation/attempt model
6. Transition evaluator and deterministic scheduler
7. In-memory command → approval → command simulation
8. SQLite persistence and restart recovery
9. Elysia application boundary
10. Worktree and Git
11. Harness adapters
12. Feature-development ADW
13. Dashboard
14. Runnable local host and operator CLI

A minimal health route may exist earlier, but API design follows proven runtime
semantics.

## 13. Milestones

### M1 — Deterministic compiler and simulator

Status: Complete on 2026-07-26. See
[`docs/milestones/m1.md`](docs/milestones/m1.md) for acceptance evidence.

Deliver:

- terminology and invariants;
- five foundational ADRs;
- content-addressed compiled bundle;
- canonical serialization and checksum;
- pure reducer;
- exact transition selection;
- explicit loop counters;
- deterministic scheduler intents;
- executable replay simulations.

Exit criteria:

- recompiling unchanged input is byte-identical;
- the same bundle and events always produce the same state and intents;
- invalid, missing, or ambiguous transitions produce typed failures;
- every cycle has an explicit bound;
- retries do not increment repair counters;
- recovery decisions depend only on recorded state and declared policy.

### M2 — Durable command and approval runtime

Status: Complete on 2026-07-26. See
[`docs/milestones/m2.md`](docs/milestones/m2.md) for acceptance evidence.

Deliver:

- SQLite event store and projections;
- command, approval, and complete executors;
- invocation and attempt persistence;
- idempotency records;
- restart recovery.

Exit criteria:

- command → approval → command → complete survives restart;
- approvals remain pending across restart;
- completed invocations are not duplicated;
- duplicate event sequences are rejected.

### M3 — Worktree and Git recovery

Status: Complete on 2026-07-26. See
[`docs/milestones/m3.md`](docs/milestones/m3.md) for acceptance evidence.

Deliver:

- repository registration and pinned starting commit;
- one worktree per run;
- Git status and diff artifacts;
- controlled commit operations;
- repository mutation coordination;
- cleanup and recovery.

Exit criteria:

- concurrent runs use isolated worktrees;
- interrupted creation reuses or safely reconciles the worktree;
- commit recovery verifies the expected tree and does not duplicate commits.

### M4 — Harness-independent agent execution

Status: Complete on 2026-07-26. See
[`docs/milestones/m4.md`](docs/milestones/m4.md) for acceptance evidence.

Deliver:

- normalized harness contract and registry;
- scripted fake harness;
- agent executor;
- structured output validation;
- event and artifact persistence;
- Claude Code, Codex, OpenCode, and Pi adapters;
- durable per-agent-node harness routing with ordered node-specific fallback;
- optional compiled agent-node harness pins with CLI fallback when omitted;
- explicit fallback and resume policies.

Exit criteria:

- the same ADW runs through every supported harness;
- one run can route different agent nodes through different harnesses;
- workflow pins take precedence while unpinned nodes use run policy;
- harness-specific details do not leak into workflow definitions;
- invalid structured output becomes a typed node failure;
- retry and fallback remain attempts of one invocation.

### M5 — Feature-development vertical slice

Status: Complete on 2026-07-26. See
[`docs/milestones/m5.md`](docs/milestones/m5.md) for acceptance evidence.

Deliver:

```text
worktree → plan → approval → implement → validate
                                      ↖ failure │
                         review ─changes───────┘
                            ↓ approved
                    delivery approval → complete
```

Limits:

- maximum validation-feedback traversals to the implementation agent: 3;
- maximum review-feedback traversals to the implementation agent: 2;
- maximum run duration: 8 hours;
- maximum node invocations: 30.

Exit criteria:

- a fixture task reaches a merge-ready branch;
- interruption and restart preserve the run;
- repair loops stop at their exact bounds;
- review is read-only by policy;
- final artifacts include plan, tests, review, and diff.

### M6 — Observable Elysia and web MVP

Status: Complete on 2026-07-26. See
[`docs/milestones/m6.md`](docs/milestones/m6.md) for acceptance evidence.

Deliver:

- Elysia application factory and composition root;
- application use cases and typed API contracts;
- Eden client;
- run, workflow, repository, artifact, event, and approval endpoints;
- typed reconnectable event stream;
- run list and read-only React Flow graph;
- node details, logs, artifacts, diff, and approval controls.

Exit criteria:

- API tests run without opening a network port;
- domain and runtime packages do not import Elysia;
- a run can be understood without reading SQLite;
- approval can be completed through the web UI;
- reconnecting clients replay events after the last received sequence.

### M7 — Runnable local MVP and operator CLI

Status: Complete on 2026-07-26. See
[`docs/milestones/m7.md`](docs/milestones/m7.md) for acceptance evidence.

Deliver:

- a `packages/cli/` package with a distributable `kouro` binary, stable help,
  version output, typed errors, and predictable local data/configuration paths;
- commands to run a local ADW, list and inspect runs, approve or reject gates,
  pause and resume scheduling, steer or interrupt active attempts, request
  policy-eligible retries or skips, and serve the local application;
- a long-lived local application host that composes SQLite, worktrees, artifact
  storage, harnesses, the coordinator loop, API, and built web assets;
- a worker loop that recovers active runs after restart and advances them until
  they become terminal, paused, blocked on approval, or require reconciliation;
- the feature-development ADW as a packaged built-in workflow rather than a
  test-only fixture;
- application orchestration for repository registration and pinning, run
  worktree creation, compiled-workflow selection, final test/status/diff
  artifact publication, controlled commit creation, and a named merge-ready
  branch;
- durable lifecycle events and use cases for graceful pause, resume, explicit
  interrupt, cancellation, operational retry, and workflow-authorized skip;
- complete local repository queries and run-creation/lifecycle API surfaces
  needed by the CLI and web application;
- startup recovery, signal handling, clean shutdown, and local harness
  availability diagnostics;
- ADRs defining lifecycle-control semantics, worker ownership, and the runnable
  single-process composition boundary.

CLI surface:

```text
kouro run <adw> --repo <path> [--harness <id>]
kouro runs
kouro status <run-id>
kouro approve <run-id> <invocation> --reason <text>
kouro reject <run-id> <invocation> --reason <text>
kouro pause|resume|cancel <run-id>
kouro steer <run-id> <invocation> --message <text>
kouro interrupt|retry|skip <run-id> <invocation> --reason <text>
kouro serve
```

Exit criteria:

- a fresh checkout can install dependencies and invoke `kouro --help` without
  writing a custom host script;
- `kouro run feature-development --repo <fixture>` compiles the exact workflow,
  creates an isolated worktree, stops at durable approvals, and produces a
  named merge-ready branch after approval without merging or deploying it;
- terminating the process during an active run and restarting it recovers the
  same run without duplicating completed invocations or controlled Git effects;
- graceful pause schedules no new work, interrupt is recorded separately from
  pause, and resume/retry follows the declared recovery policy;
- skip succeeds only when the compiled workflow allows it and records the actor,
  reason, invocation, selected result, workflow checksum, artifact checksums,
  and repository HEAD;
- `kouro serve` hosts the API and production web assets in one process, and an
  approval completed through either CLI or web is immediately visible through
  the other surface;
- capability policy and all decision-affecting CLI configuration are
  snapshotted into the run before execution;
- end-to-end CLI tests use real subprocess, SQLite, Git, worktree, restart, and
  in-process HTTP boundaries without requiring a real model provider.

### M9 — Review-bound delivery and pull requests

Status: Complete on 2026-07-28. See
[`docs/milestones/m9.md`](docs/milestones/m9.md) for acceptance evidence.

Deliver:

- explicit `delivery_review` authoring and compiled runtime semantics;
- checksum-bound diff, prepared tree, and editable commit/PR proposal;
- concurrent durable CLI and web decisions with first-valid-decision wins;
- interactive `run` and `attach`, structured non-TTY boundaries, and detach;
- exact-tree controlled commit and named base-branch snapshot;
- provider-neutral GitHub and Forgejo pull-request publication;
- verify-then-replay branch push and PR reconciliation;
- retryable publication failures that preserve local run success.

Exit criteria:

- new workflows without delivery review create no implicit commit or branch;
- approval cannot commit a tree different from the reviewed prepared tree;
- two change requests return to the same implementation context;
- CLI and web render and edit the same durable delivery proposal;
- detached repositories require an explicit base branch;
- publication retries do not duplicate branches or pull requests.

### M10 — Repository-local evaluations

Status: Complete.

Deliver in coherent slices:

- checked-in evaluation datasets with stable IDs, author-controlled versions,
  canonical compilation, and content checksums;
- deterministic rule evaluation over durable run state;
- experiment execution that binds repository commit, workflow checksum,
  dataset checksum, case, and run configuration;
- durable experiment reports and side-by-side comparison;
- human annotations and pairwise preference;
- optional artifact rubrics and model judges after deterministic evidence is
  established.

Exit criteria:

- declaration order does not change a compiled dataset checksum;
- missing best-effort telemetry cannot make a budget evaluator pass;
- evaluator output cannot schedule work, grant approval, or publish delivery;
- the same repository commit, workflow checksum, dataset checksum, and run
  configuration can be compared as one controlled experiment;
- no evaluation or context feature depends on company/team-wide Kyuki state.

## 14. Ticket-system roadmap

The ticket system is a planning bounded domain beside the existing runtime:

```text
Tickets describe what should be done.
Kouro runs record how the work was executed.
```

The implementation is split into six coherent milestones:

1. T1 local ticket foundation;
2. T2 immutable ticket snapshots, run links, and derived execution columns;
3. T3 GitHub Issues synchronization;
4. T4 capability-aware Forgejo Issues synchronization;
5. T5 resumable local-to-remote migration;
6. T6 ticket list, details, Kanban, provider configuration, and sync UI.

T1 through T6 were accepted on 2026-07-26. See
[`docs/milestones/t1.md`](docs/milestones/t1.md) and
[`docs/milestones/t2.md`](docs/milestones/t2.md),
[`docs/milestones/t3.md`](docs/milestones/t3.md),
[`docs/milestones/t4.md`](docs/milestones/t4.md), and
[`docs/milestones/t5.md`](docs/milestones/t5.md), and
[`docs/milestones/t6.md`](docs/milestones/t6.md).

The runtime continues to consume immutable work-item snapshots. Mutable ticket
rows, provider events, polling, migrations, and Kanban projections remain
outside the deterministic runtime.

## 15. Deferred work

After the core is stable:

- bug-fix, chore, and hotfix ADWs;
- subworkflows and explicit input/output mapping;
- parallel branches, joins, branch cancellation, and leases;
- installable Git-based ADW packs and lockfiles;
- hosted registry or marketplace;
- optional Vedh integration;
- provider-backed ticket synchronization beyond the ticket roadmap;
- Docker, VM, SSH, or remote-worker sandboxes;
- PostgreSQL and separate workers;
- visual workflow editing;
- deployment and merge automation.

## 16. Foundational ADRs

Before full implementation, Kouro must accept and test:

1. Event-history-based determinism
2. Node definition, invocation, and attempt identity
3. Exact transition-selection rules
4. Explicit loop-counter behavior
5. Side-effect recovery classifications

Each ADR contains:

- invariant;
- terminology;
- allowed behavior and state transitions;
- typed failure behavior;
- serialized representation;
- at least one counterexample;
- executable acceptance scenarios.

## 17. First proof

The first proof contains no database, HTTP server, Git operation, filesystem
effect, or real model call:

```text
compiled bundle + ordered events
               ↓
          pure projection
               ↓
      deterministic intents
```

Repeated execution must produce byte-identical projected state and orchestration
intents.

The complete product proof remains:

> A coding task moves through planning, approval, implementation, testing,
> bounded repair, review, and final approval using an exact versioned ADW; the
> run survives interruption; and the workflow remains independent of the
> underlying coding harness.
