# Kouro v2 — architecture and implementation plan

Status: design accepted; M1–M5 implemented and locally verified through 2026-09-19;
M6 is partial/in progress: bounded collaboration and the Pi RPC adapter are locally
verified with scripted/fake providers, but no paid or live Pi model exchange has been
performed. M7 and M8 are complete for their documented local acceptance scope.

Prepared 2026-09-18. V1 reference: GitHub `USERSATOSHI/kouro` main at
`90b5cc69b6657b7ced21b4bee5d2696cb3781fae`, inspected in the clean adjacent
`/home/usersatoshi/homelab/projects/kairo` checkout. The working v2 checkout is
`/home/usersatoshi/homelab/projects/kouro`, branch `v2`, initially containing
only LICENSE at `1ad20ed`. No v1 compatibility or migration is required.

Companion documents:

- [V1 evidence and disposition](docs/v2/v1-review.md)
- [Milestone implementation and orchestration handoffs](docs/v2/milestones.md)
- [Normative protocol and data contracts](docs/v2/contracts.md)

The contract supplement resolves implementation-level details referenced below. It
is part of this plan, not a later architecture exercise.

## 1. Goals and non-goals

Build a programmable framework and local web workbench for authoring, running,
observing, controlling, debugging, and evaluating agentic development workflows.
Agents perform probabilistic work. Kouro owns scheduling, boundaries, permissions,
budgets, and recovery. Deterministic commands establish the evidence behind claims.

The first executable milestone must run `scripted agent → command → complete`,
persist its execution, and show the actual graph and growing timeline in a browser.
CLI and embedding use the same application service. The browser remains a client.

Optimize for a single developer operating one local runtime with concurrent runs.
Keep workflows declarative, artifacts explicit, harnesses replaceable, and experiments
attributable to immutable inputs. Visual inspection is an acceptance requirement.

Do not initially rebuild tickets, Kanban, issue sync, publication providers,
marketplaces, visual graph editing, distributed workers, PostgreSQL, cloud hosting,
deployment automation, or every existing harness adapter. No automatic universal
model router. No generic autonomous society. No promise of reproducible model output
or exactly-once arbitrary external effects.

## 2. Architecture overview and decisions

Use TypeScript with Bun for the local host and CLI, SQLite on local storage,
content-addressed filesystem blobs, React/Vite for the web client, React Flow for
graph interaction, and a purpose-built virtualized timeline using D3 scale utilities.
Use ElysiaJS in the host (selected by the user),
runtime-validated JSON contracts, and SSE for committed projection updates. Pin
actual dependency versions and validate the selected Bun/browser combination in M1.
ElysiaJS is [optimized for Bun](https://elysiajs.com/quick-start);
keeping transport DTOs independent avoids coupling the client to a server framework.

```text
Trusted workflow source ─→ Builder ─→ Compiler ─→ immutable bundle
                                                     │
Web / CLI / embedding ─→ application commands ─→ deterministic kernel
                                 │                   │
                                 │              durable intents
                                 ▼                   ▼
                          local coordinator ─→ effect adapters
                                 │              harness / process / Git
                                 ▼                   │
                      SQLite journal + projections ← facts
                                 │
                      projection frames + queries
                                 ▼
                       one client execution store
                      /          │             \
                   graph      timeline       inspector
```

An abstraction must earn its boundary:

| Abstraction / owner | Concrete problem; why simpler is insufficient | Consumers |
| --- | --- | --- |
| Immutable bundle / core compiler | Runs must not reopen changed source; executing builder closures cannot be replayed | Kernel, host, graph, comparison |
| Execution scope / core | One node can activate repeatedly and concurrently; a global latest-output lookup is ambiguous | Scheduler, binding, inspector |
| Typed artifact reference / core + host storage | Dataflow and provenance cannot be recovered reliably from transcript text | Context, evaluators, forks |
| Pure reducer/decision function / core | Crash recovery and simulation must agree with live behavior | Host and tests; browser does not schedule |
| Journal transaction / host | Event, state, and dispatch reservation must not disagree after a crash | Coordinator, queries, stream |
| Small harness port / core contract | Provider lifecycle differs; importing SDKs into the kernel prevents fake execution and portability | Host adapters |
| Workspace port / host | Git/process effects need verification and locks without making graphs Git-specific | Command, agent, checkpoint effects |
| Execution projection / core read model | Graph and timeline must not independently infer status | Host API, all web views |
| Experiment service / host | Case/variant launches need durable identity; a second run engine would diverge | Eval UI and CLI |

Alternatives and recommendations:

- Full generic event-sourcing framework versus mutable tables plus audit log:
  use a narrowly event-sourced **execution aggregate**, transactional projections,
  and ordinary versioned records for catalog/settings data. No event bus framework.
- Global flat graph versus a separate engine per child: retain nested definitions
  and execute scope instances in the same scheduler. This preserves hierarchy and
  shares one budget/recovery model without flattening source identity away.
- Many independently published packages versus one undifferentiated application:
  use three workspaces with explicit module imports. Split provider dependencies
  later only when installation size or isolation warrants it.
- WebSocket versus SSE: commands use HTTP and updates use SSE. Bidirectional sockets
  solve no initial need; native interactive terminals may introduce one later.
- Generic Gantt component versus custom renderer: own the relatively small span,
  viewport, selection, and row model; reuse scale/layout utilities. Workflow attempts,
  waits, missing evidence, and cross-run alignment are more important than calendar
  scheduling features.

## 3. Core conceptual model

| Object | Meaning and identity |
| --- | --- |
| Workflow definition | Named source graph; human version is a label, checksum is identity |
| Bundle | Immutable executable definitions, schemas, prompts, policies, source map and hashes |
| Run | One execution, pinned configuration and inputs; optional experiment/fork metadata |
| Scope instance | Root, child call, branch, or loop iteration; owns local activations and bindings |
| Invocation | One logical activation of a node in a scope, with frozen input artifact IDs |
| Attempt | One concrete try, with resolved harness/model/policy/context and effect identity |
| Session | Provider conversational context; scoped handle with explicit continuation ownership |
| Role | Job specification and prompt/output expectations, separate from execution choice |
| Artifact | Immutable bytes/JSON, schema identity, provenance, and content checksum |
| Message | Authenticated, bounded communication with durable routing/delivery state |
| Approval | Pending decision bound to exact action and evidence; actor-attributed result |
| Checkpoint | Consistent execution cut plus retained artifact/workspace state |
| Experiment | Immutable matrix specification producing normal runs and evidence records |

Use stable opaque run/invocation/attempt/session IDs. A node's source ID never stands
in for an invocation ID. Hierarchical addresses include definition, call site, scope,
branch and iteration; use structured fields internally, formatted paths in the UI.
Event sequence establishes order; timestamps establish observed timing, not identity.

## 4. Proposed package/module structure

```text
packages/
  core/                         @kouro/core
    authoring/                  builder, handles, composition
    compiler/                   validation, canonicalization, source maps
    model/                      plain bundle, identities, schemas, events
    execution/                  reducer, decisions, bindings, limits, recovery
    projections/                execution entities and span selectors
    contracts/                  application DTOs, port contracts, validation
    evaluation/                 dataset/matrix/evidence schemas, pure reducers
    testing/                    in-memory journal, simulator, scripted scenarios
  host/                         @kouro/host; publishes kouro binary
    application/                run/control/catalog/experiment/checkpoint services
    coordinator/                ownership, intent dispatch, deadlines, recovery
    storage/                    SQLite migrations, transactions, blobs
    adapters/harness/           fake plus individually loaded native adapters
    adapters/workspace/         Git worktrees, snapshots, locks
    adapters/process/           process lifecycle and OS enforcement
    context/                    source resolution, manifests, token accounting
    messaging/                  authenticated tools, mailbox and channel delivery
    http/                       routes, auth, SSE
    cli/                        commands, attach, JSON output
    composition.ts              the single composition factory
  web/                          private web build, served by host
    app/                        routes, shell, command palette
    data/                       query client, execution store, stream lifecycle
    features/runs/              graph, timeline, inspector, logs, controls
    features/workflows/
    features/experiments/
    features/compare/
    features/prompts/
    components/                 panes, tables, source/diff views, status tokens
examples/                       tiny, feature, planning, review, collaboration
fixtures/                       scenarios, repositories, datasets, golden bundles
docs/decisions/                 accepted v2 decisions, one per real boundary
```

Core imports no React, HTTP framework, provider SDK, SQLite, filesystem, or Git.
Host depends on core. Web imports browser-safe core contracts/projections only,
never host types that drag server dependencies into its build. Export explicit
subpaths. Add an import-boundary check in M1. Do not create a package per port,
error union, executor type, or provider by default.

## 5. Workflow builder and authoring API

The following is proposed contract notation, not implemented code. Supply a small
`artifactType<T>(id, jsonSchema)` helper: TypeScript helps authors; runtime JSON Schema
validation establishes validity. A supported schema-library adapter may infer T.
Do not claim a handwritten T proves the supplied schema matches it.

```ts
// Example author-owned resources; these are explicit imports, not implicit globals.
import { Task, Plan, prompts } from "./feature-resources";

const w = new WorkflowBuilder({ id: "feature", version: "2" });
const task = w.input("task", Task);

const plan = w.agent("plan", {
  role: "planner", prompt: prompts.plan,
  input: { task }, produces: Plan,
});
const approve = w.approval("approve-plan", {
  input: { plan: plan.output },
});
const implement = w.agent("implement", {
  role: "implementer", prompt: prompts.implement,
  input: { task, plan: plan.output },
});
const validate = w.command("validate", {
  executable: "bun", args: ["test"],
});
const done = w.complete("done");
const failed = w.complete("failed", { result: "failed" });

w.startAt(plan);
plan.on("success").to(approve);
approve.on("approved").to(implement);
approve.on("rejected").to(failed);
implement.on("success").to(validate);
validate.on("success").to(done);
validate.on("failure").repair(implement, {
  maxRepairs: 3,
  feedback: validate.output,
  exhausted: failed,
});
export default w.build();
```

Structured output is a dataflow feature, not a requirement for an agent. An agent
without `produces` has no typed `.output`; it still has automatically captured execution
evidence. Commands expose a standard result automatically through `.result` and, unless
a custom parser is declared, `.output`. Result includes nullable exitCode, signal,
timedOut/spawnError, stdout/stderr references and observed timestamps/duration. Parsing
custom workflow output never replaces original command evidence. Do not infer OOM
solely from exit code 137. Evidence may be unavailable when native harnesses cannot
report it. Outputs, evidence, immutable artifacts and workspace resources stay distinct.

The repair helper explicitly binds feedback to the target's standard repair-context
channel, with provenance, without requiring a custom implementer output/feedback schema.
Its budget is per repair edge within the owning workflow scope; shared budgets require
an explicit shared counter. `maxRepairs: 3` allows three additional graph returns after
initial implementation. It creates invocations, not operational retry attempts. Default
session continuation can preserve the same compatible session; advanced authors may
override it. No result claims correctness until deterministic verification runs.

Node policies declare which outcome has each output schema. A failed command can
still publish its standard result; malformed agent output cannot publish typed success.
All remaining unhandled execution failures terminate that scope as failed. Authors
can explicitly handle them. Successful outcomes with ambiguous routing fail typed.

Handles validate builder ownership and duplicate IDs immediately. `compile` returns
all useful diagnostics with source node/port paths. Expressions are small plain ASTs:
literal, input/output path, counter reference, comparison, boolean operations. No
arbitrary callbacks in guards, reducers, joins, or persisted runtime configuration.
Trusted source loading can execute TypeScript once in a separate build process;
compilation of the resulting plain definition is pure. Dry run is not a sandbox
for untrusted source.

## 6. Convenience/composition API

- `w.sequence(a, b, c)` creates success edges; it rejects conflicting existing edges.
  Inputs remain explicitly bound. It is not implicit context forwarding.
- `node.on(outcome).repair(target, { maxRepairs, feedback, exhausted })` lowers to
  a generated counter, bound guard, atomic increment and explicit fallback edges.
  It requires an existing graph path back to the validation node; it does not add a
  hidden validation pass. Source mapping lets users expand the generated semantics.
  Retain `w.counter` and `.when(...).increment(...).to(...)` for advanced conditions.
- `w.retry(node, { maxAttempts, onErrors, backoff, fallback })` writes attempt policy
  metadata. Retry retains invocation inputs and never creates a graph repair loop.
- `w.loop(id, { body, initial, carry, maxIterations, until })` creates a bounded scope,
  typed loop-carried ports and exit transitions. `maxIterations` includes iteration 1.
- `w.parallel(id, { branches, maxConcurrent })` creates a declared fork group;
  `w.join(group, { mode: "all", failure: "cancel-remaining" })` creates its join.
- `w.call(id, child, { input })` references a pinned child definition and exposes its
  declared outputs. `w.forEach` expands a pinned template over an immutable collection
  with mandatory `maxItems`, `maxConcurrent`, and stable item-index identities.

Composition builds the same IR as explicit nodes/edges. Preview can show generated
control nodes and source-helper attribution. No hidden runtime JavaScript control
flow. Fusion planning, multi-review, QA loops and swarms are examples/subworkflows,
not special semantic node types. Ship helpers only with a real example and a golden
equivalence test against the explicit graph.

## 7. Compiled workflow / IR design

Bundle format v1 for the rewrite, with explicit compiler, IR, expression and schema
dialect versions. Logical contents:

```text
Bundle {
  rootDefinitionId, definitions[id], roles[id], schemas[digest], prompts[digest],
  policies, resourceRequirements, sourceMap, contentManifest, semanticVersions
}
Definition {
  id, inputPorts, outputPorts, nodes[], controlEdges[], dataBindings[],
  counters, limits, entry, exits
}
Node = agent | command | approval | call | fork | join | complete
       | wait (only when durable timers/signals are delivered)
```

Nodes are a discriminated union with kind-specific fields, not a giant all-optional
record. `call` references another definition in the same bundle. Bounded map templates
and collaboration activation templates are fully present before run creation.
Runtime may instantiate declared definitions, never create new code or edges.

Compiler pipeline: load trusted source/resources → lower convenience syntax → resolve
child definitions → normalize IDs/expressions → validate schemas/ports → validate
control/data graph → validate bounds/permissions/resources → canonical serialize/hash.
Sort semantic maps and edge IDs, preserve explicitly ordered lists, reject NaN,
undefined and cycles in serialized data. Timestamps and absolute local source paths
do not enter canonical executable bytes. Retain portable source paths and source
content hashes. Every transitive prompt, schema, child and policy is captured.

Validate unreachable nodes, foreign/missing bindings, impossible required inputs,
multiple defaults, unsupported outcomes, recursive calls, unbounded map/loop, illegal
joins, permission escalation and unsupported feature versions. Generic conditions
need not be proven mutually exclusive statically; evaluate all matches at runtime
and reject ambiguity rather than using declaration order.

Cycle proof: every cycle must consume a bounded monotonic counter that cannot reset
within its owning scope. Remove all valid guarded increment edges; the residual graph
must be acyclic. Merely finding one increment somewhere in a strongly connected
component is insufficient. Compiler additionally rejects nested scope recursion;
global invocation/attempt/deadline limits bound the combined execution.

## 8. Typed artifacts and explicit dataflow

Keep control eligibility separate from data availability. A bound artifact does not
silently bypass approval or activate a node. Invocation creation requires an eligible
control token **and** all required inputs, then freezes exact artifact IDs/JSON paths
in an `invocation.created` fact. Optional inputs have explicit absence/default rules.

Default `node.output` means the causally upstream successful producer carried by this
activation's control lineage, not the latest global occurrence of that node. Transition
tokens carry an immutable binding environment. Sequential traversal updates a
producer binding; fork copies it; a join returns branch-keyed bindings. Repeated raw
graph traversal replaces a producer only within that lineage. A required producer
must dominate the consumer on every eligible path unless explicitly optional.

Loop-carried values cross iteration boundaries only through declared carry ports or
explicit transition feedback. Sibling branch outputs require join outputs. A call
can access only its input ports; child private outputs do not leak to its parent.
Reject ambiguous binding at compile time where possible and typed-fail before any
effect otherwise. This eliminates v1's global latest-prior lookup as an execution rule.

Artifact metadata includes ID, content digest, media type, schema digest, byte size,
producer run/scope/invocation/attempt, workflow digest, resolved execution digest,
input artifact IDs, creation event, sensitivity and retention class. Identical bytes
may share blob storage while separate provenance records remain distinct.

Small JSON can be inlined under a fixed configured size limit; patches, logs, reports,
images and transcripts are blobs. Validate output before publishing the artifact and
completing the attempt transaction. Invalid raw output remains inspectable as untyped
evidence. File artifacts are immutable copies, never references to mutable worktree
paths. Structured data and control expressions operate on bounded JSON only.

Do not cache agents initially. Later opt-in pure transformations may cache using all
input/config/tool/environment digests and an explicit effect-free contract. A cache
hit records provenance and cannot reuse approval, publication, or workspace mutation.

## 9. Runtime and scheduler

The pure boundary is `reduce(state, event)` plus `decide(bundle, state)` producing an
ordered list of orchestration intents. Clock observations, available resource slots,
policy resolution and external verification results enter as durable facts.

The host owns one coordinator per open data directory, serializes commits, and allows
multiple effects concurrently. For each run: reduce committed facts, resolve ready
activations, reserve budget/resource capacity, append intent and reservation, dispatch
outside the transaction, then commit observations. Never hold SQLite transactions
while waiting for an agent or subprocess.

Within a run order ready work by explicit priority, canonical scope/branch address,
node ID and activation ordinal. Across runs use round-robin admission with declared
priority; record admissions so replay never guesses resource availability. This
guarantees deterministic decisions given ordered observations, not identical physical
completion order across real runs. Completed parallel results assemble in branch-ID
order independent of completion order.

Run admission reserves workflow/global max invocations, attempts, concurrent effects
and per-resource capacity atomically. Attempts do not increment graph counters.
Deadlines are durable scheduled timestamps. Host timers record deadline observations;
on restart overdue deadlines are recorded before admitting more work. No periodic
clock polling in the reducer. Use a single timer for the earliest pending deadline.

Resource claims are small named read/write locks (workspace, session, Git repository
metadata) plus capacity counters (harness/profile). Acquire all needed claims atomically
in sorted resource order; never hold some while waiting for others. Release only after
effect completion or verified termination. Nested scopes do not occupy execution
slots while waiting for children.

## 10. Durable execution journal and state

SQLite tables: bundles, immutable run specifications, run events, run projection,
invocation/attempt/span query rows, pending effects, command receipts, artifacts,
messages/delivery batches, approvals, checkpoints, experiments/cells/evidence,
catalog versions and append-only human annotations. Avoid a generic repository class
per table. A small `Journal.transact` boundary validates and atomically writes facts,
projection changes, dispatch records and idempotency receipts.

Event envelope: event ID, run ID, per-run sequence, schema version, type, recorded UTC
time, subject IDs, actor, causation/command ID, and small payload. Add process monotonic
timing observations to lifecycle facts where available. Provider timestamps are
separate observational fields; provider event order never rewrites journal order.

Projection reads carry `revision = last run sequence`. The canonical aggregate is
rebuildable from the pinned bundle and journal. Query indexes are rebuildable. Start
with transactional incremental projection; snapshots accelerate old-run replay only
when measurement warrants them. Validate schema versions and refuse unknown semantics
with an actionable compatibility error rather than guessing.

SQLite is local and has one writer; WAL supports concurrent readers. Use short
transactions, foreign keys, busy timeout, and explicit durability configuration
(`synchronous=FULL` initially). This fits the single-host scope; do not place the
database on a network filesystem. See [SQLite WAL documentation](https://www.sqlite.org/wal.html).

Blob protocol: write temporary file → compute/verify checksum → fsync file → atomic
rename into content store → fsync directory → transaction publishes reference. An
orphan blob is harmless; a committed reference to absent bytes is not. Cleanup is
mark-and-sweep from retained roots after a grace period, never during active writes.

Dispatch uses a durable outbox table in the same database, not a broker. A crash after
intent commit but before dispatch is recoverable; a crash after an effect but before
completion may be ambiguous. Recovery class governs it. Never promise exactly-once.
Late completion after cancellation is recorded as evidence of an orphaned/late effect
and cannot resurrect terminal workflow state.

Record lifecycle, routing, control, artifact, usage and message facts durably. High
volume tool text/log chunks use ordered append-only chunk records plus blobs, bounded
queues and flush intervals; committed chunks are replayable. An optional uncommitted
tail is explicitly ephemeral and must never drive status or durable evaluation.

## 11. Invocation, attempt and session semantics

Invocation lifecycle: pending → ready → active → succeeded/failed/skipped/cancelled;
waiting approval/children/resources and needs-reconciliation are explicit states or
wait reasons. Attempts: reserved → starting → running → succeeded/failed/interrupted/
cancelled/unknown. Persist start and finish for attempts and invocations independently.
An approval has a wait span; it does not invent an agent attempt.

An operational failure creates another attempt in the same invocation under bounded
retry policy. A graph repair return creates another invocation with new feedback.
Attempt inputs remain frozen; new context may include attributed recovery/handoff
evidence and a newly resolved fallback execution choice. Editing the objective or
input artifacts requires a new invocation/fork, not a disguised retry.

A session is owned by a continuation key within one run and compatible workspace/
permission envelope. A repair invocation may continue that session when declared.
Only one active attempt may hold its session lock. Native resume may reuse session
identity but an interrupted try always closes its attempt; resumed execution is a
new attempt with a durable link. Retransport attachment to an already-running try is
reattachment, not a new attempt. Do not blindly resume across reduced permissions.

Harness/model changes resolve compatibility first. If native continuity cannot be
established, create a new session using an explicit `AgentHandoff` artifact containing
objective, completed work, decisions, important files, unresolved questions, evidence
and suggested next steps. Handoff fields are attributed claims, not verified facts.
Any summarization model call is a visible bounded invocation, never hidden overhead.

## 12. Parallel execution and joins

Fork creates one durable group with the exact required branch IDs. Each branch gets
a scope and frozen inputs. Joins reference that group activation, so concurrent or
repeated forks cannot cross-wire results. Empty bounded map groups resolve to an empty
typed collection. Branch outputs are keyed records (map outputs use stable item index).

Initial join modes: `all` with either cancel-remaining on failure or wait-for-all;
`all-settled` returns tagged success/failure/skipped/cancelled values. A skip is not a
success unless author policy explicitly supplies the required output. A conditional
branch marked not-taken is terminal for that group; do not wait for a node that can
never run. Required-output joins reject paths where output cannot exist.

Fail-fast requests sibling cancellation and waits for termination/reconciliation;
it does not immediately release their workspace locks. Native cancellation is best
effort and gets durable requested/applied/failed evidence. Unstarted siblings become
cancelled without attempts. Add first-success/quorum later only with explicit recorded
winner semantics; do not silently pick the fastest arrival as a deterministic choice.

Read-only branches may share an immutable repository snapshot. Parallel writers get
separate child worktrees. **Joining artifacts does not merge Git changes.** An explicit
workspace integration command combines branch patches/trees, verifies its expected
base and detects conflicts. No automatic assumption that disjoint paths imply semantic
compatibility; rerun deterministic validation after integration. Shared writable-tree
concurrency is unsupported initially, even if a user declares disjoint paths.

## 13. Subworkflows and explicit I/O

Child definitions are immutable bundle members with typed input/output ports. Each
call activation creates a child scope and a parent invocation waiting for its result.
Child nodes use the same scheduler, journal, attempt policy and global budgets.
The parent's policy envelope always bounds the child; local child limits may narrow it.

Scopes carry parent invocation, call-site ID, branch ID and iteration where applicable.
Cancellation/pause propagate according to the root control state. Child failure becomes
a typed call outcome available to parent transitions. Child outputs are published only
after their declared schema validates. A retry of an entire failed call creates a fresh
child scope under another call attempt, with explicit effect-recovery checks; never
reset succeeded child effects by clearing state.

Nested definitions stay hierarchical in storage. The graph can render a flattened
visible subset without changing runtime identity. Recursive workflow references are
rejected. Reusable planning/review subworkflows have no privileged runtime status.

## 14. Harness interface and capability negotiation

Portable minimum: discover adapter availability/capabilities; start a turn with an
opaque resolved configuration, context and tool gateway; observe an async event stream
and terminal result. Lifecycle handle offers cancel, with supported optional methods
for resume/reattach/steer. Core events: text/log reference, tool activity, usage,
session reference, terminal output/error. Retain a namespaced native event payload
when normalized metadata would lose useful detail.

Capability descriptors use `supported | unsupported | conditional`, with constraints
and enforcement level, for structured output, resume, reattach, cancellation, tool
events, custom tools/MCP, steering, usage, reasoning settings and native subagents.
Distinguish selecting a model from enumerating installed models. Do not standardize
all reasoning values into a universal enum; native config is schema-validated by its
adapter and included in the attempt snapshot.

Preflight requested features and permissions before side effects. If native structured
output is absent, the declared policy may allow text plus deterministic JSON/schema
validation; this is a visible downgrade, not a fictional provider capability. Invalid
output ends that attempt; bounded retry/repair is workflow policy. Unsupported required
features reject launch. Optional features display unavailable.

Provider-native escape hatch: `{ adapterId, configSchemaVersion, config }` with plain
JSON; adapter owns parsing and secret-reference resolution. It cannot override the
permission envelope or mutate scheduler state. Native sessions are opaque handles,
not portable transcripts. Provider adapters never own Kouro's artifact storage or
runtime decisions; the host supplies sinks and authenticated tools.

Choose the first real adapter during M2 preflight based on installed usable tooling
and the needed containment/tool capability, not a user's particular model. Prove the
same workflow with a second materially different harness in M6. No specific provider
API method is assumed by this plan; verify its native SDK contract when implementing.

## 15. Role, model, harness and execution policies

Roles describe objective/prompt/output/capability needs. Profiles map roles onto an
ordered set of harness/model/native-config choices and concurrency/budget limits.
Names such as local/balanced/quality are user catalog entries, not built-in routing.

Resolution order: hard security/budget envelope → workflow/node execution pins →
explicit run role overrides → selected profile role mapping → profile default.
A conflicting hard pin is a diagnostic, never silently overridden. Resolved choices
and capability checks are persisted before attempt admission. Profile changes do not
alter an active run. A fallback consumes another bounded attempt; its reason and
resolved configuration are recorded. Policy plugins may propose a choice from the
allowed candidate set; deterministic admission still enforces bounds.

Token/cost accounting distinguishes exact/reported/estimated/unavailable and specifies
whether parent usage includes native children. Never double count inclusive usage.
Cost uses immutable rate-card provenance and currency. Hard token/cost ceilings require
an enforceable per-request maximum or conservative reservation; if a harness cannot
provide it, preflight rejects a hard ceiling or the user explicitly selects a soft
observed budget. Delayed usage cannot support a truthful hard cap. Duration, message,
turn, invocation and concurrency bounds remain enforceable independently.

## 16. Agent messaging and bounded collaboration

A collaboration is a subworkflow with a declared participant/role roster, communication
ACL, typed channel schemas, objective, activation templates and budgets. The work graph
remains ordinary agent turns, joins, checks and complete nodes. A small host messaging
service handles delivery; it is not a second agent scheduler.

`send_message({ to, message, attachments?, replyTo? })` is invoked by the model through
a Kouro-authenticated tool gateway. Sender identity comes from a scoped attempt token,
never a model-supplied `from`. Token binds run, scope, participant, invocation, attempt,
capabilities and expiry. A tool-call idempotency key deduplicates replay. Validate
recipient, byte length, attachment authorization, remaining send/turn budgets, scope
liveness and rate limits in the same transaction as message creation. Unauthorized
sends return a typed tool error and are auditable without storing sensitive payloads.

Messages are immutable objects with sender/recipient, body/ref, causation, logical
sequence and status facts. `sent`, `queued`, `included in context`, `provider accepted`
and `failed` are distinct. Do not claim a model understood a delivered message.
At turn start freeze a bounded delivery batch and record its IDs in the context
manifest before calling the harness. Crash retries reuse/deduplicate the batch;
session-native redelivery may remain uncertain and must be labeled.

Channels/blackboard store immutable typed entries: decision, finding, risk, todo,
question and evidence. Corrections append `supersedes` links with an optimistic
revision check, not mutation of history. Consumer cursors plus explicit queries/tags
select entries. Attach artifact references; never broadcast full transcripts.
Enforce per-entry and per-turn context byte/token limits, with recorded omissions.

Initially deliver on the recipient's next **declared** turn. Messages do not resurrect
completed nodes or automatically create unlimited turns. A collaboration template may
declare a bounded receive/respond loop; queued work then enables a declared activation
through normal scheduling. A waiting loop reserves no execution slot. All participants
waiting with no deliverable messages triggers the declared idle deadline outcome;
it must not deadlock forever. Live steering is capability-dependent and explicitly
recorded. Dynamic delegation can later instantiate only declared role templates with
reserved invocation/turn/concurrency capacity inside the same envelope.

Mandatory finite duration, turn, message and invocation budgets; optional token/cost
budgets with the enforcement limits above. Models cannot amend them. A model's
`propose_complete` produces an artifact; schema, required evidence, join and declared
termination predicate decide completion. Missing evidence follows a bounded repair
edge or failure. QA findings lead to reproduction/command evidence, never self-certified
success. Native harness subagents remain separately labeled observations unless they
are Kouro-scheduled participants; do not count unknown native turns as fully observed.

## 17. Context construction and inspection

Persist a `ContextManifest` per attempt before execution. Each segment includes source
type/ID/digest, rendered content reference, ordering, inclusion rule/reason, sensitivity,
byte count, token count quality, truncation/omission reason, and any summary provenance.
Record system/role/task text, artifact inputs, explicit files and repository snapshot,
feedback, message batch, tool definitions and prior-session reference separately.

Construct context deterministically from frozen inputs and declared policies. Prefer
artifact excerpts with explicit paths over full transcripts. A budget allocator has
priority and maximums per source class; required inputs that cannot fit fail preflight
instead of silently disappearing. Summaries are separate artifacts with source IDs,
generator/version and validation metadata; a model summary is a visible invocation.

The UI must distinguish **Kouro supplied**, **harness reported**, **inferred/estimated**
and **unavailable**. Native harness system text, internal compaction, tool injections,
hidden reasoning and retained session contents may be opaque. Never claim the manifest
is the full model prompt when the provider cannot expose it. Show the exact supplied
delta and session lineage. Per-source token counts are estimates unless measured by
the actual tokenizer; totals from provider usage need not equal segment estimates.

Store secrets as references; redact before durable logging. Users may opt into richer
local transcript retention. Raw unredacted prompt capture is not the default. Restricted
artifacts remain restricted in API responses and fork/export flows.

## 18. Checkpoints, forks and comparison

Distinguish replay (reconstruct history, no effects), retry (new try), fork (new run),
and rollback/rewind (a new explicit action that may alter external state). Never truncate
the journal or turn back an existing run's event sequence.

Initial durable checkpoints require quiescence: pause admission, drain/stop active
effects, prove no workspace writer remains, then capture an exact consistent cut.
Record bundle/config digests, journal revision, ready frontier, counters, committed
inputs/outputs, messages/cursors, artifact retention roots, Git base/tree and environment
manifest. Pending approvals can be represented but their decisions are not transferable.
Running provider sessions/processes are not checkpointed memory images.

Fork creates a new run and worktree rooted at the retained tree. Import eligible prior
results as **inherited** provenance, not freshly executed invocations. A fork certificate
records which frontier/bindings were reused and why. Recompute permissions and limits;
child budgets default to the checkpoint's remaining budget and cannot be increased by
an agent. User-created independent experiments can specify fresh budgets explicitly.
Approvals, active session tokens and pending communication delivery are not reused as
authority. Private mailbox histories require an explicit context inheritance choice.

Safety classes:

| Operation | Fork/recovery rule |
| --- | --- |
| Pure artifact computation | Reuse exact validated artifact or recompute |
| Read-only external query | Retain historical evidence or explicitly refresh and mark new observation |
| Workspace writes | Recreate captured tree in a new workspace; untracked policy is explicit |
| Controlled Git commit | Verify expected tree/parent/ref before reusing effect evidence |
| Live session | New session + handoff unless native fork is explicitly supported and safe |
| Network write / publish / arbitrary command | No implicit replay; verify or reconcile under effect policy |

Historical event revisions are always inspectable but only materialized valid checkpoints
are initially forkable. No magical reconstruction of lost worktree bytes. A changed
prompt/profile for an unexecuted node may resume the same structural frontier with a
new configuration digest. Changes affecting completed nodes invalidate their downstream
reuse; offer an earlier checkpoint or a fresh run. A changed graph defaults to fresh
execution; advanced compatible frontier mapping is deferred. UI explains the exact
reused prefix and excludes it from fresh-run efficiency claims.

## 19. Git and worktree architecture

Workspace adapter owns repository registration, canonical path validation, starting
commit, worktree creation, child workspaces, snapshot/diff/integration, controlled commit
and cleanup. The pure graph describes resources/effects, not branches or Git commands.
One run worktree by default; no writes to the user's original checkout. Record base
commit and dirty-source handling explicitly; default is pinned committed content, with
an optional deliberate import of a captured dirty tree.

Use executable/argv subprocess calls. Commands have cwd/resource claims, environment
references, timeout, output limits, accepted exit codes, permissions, and recovery
classification. Shell scripts require an explicit shell form; do not interpolate model
text into shell code. Formatting that writes files requires repository.write. Tests
can mutate files or contact services: being deterministic verification does not make
an arbitrary test command replay-safe or read-only.

Capture tracked and authorized untracked files through a temporary Git index into an
exact tree and diff; never mutate the user's index. Record file modes, deletions,
renames, binary changes and symlink behavior. Ignore generated/excluded files by a
declared capture policy; report exclusions. Submodules/LFS/external dependencies need
explicit support or an incomplete-snapshot diagnostic.

Approval binds action digest, invocation, evidence digests and expected base/tree.
Controlled commit verifies those exact bytes and parent before acting. Any drift makes
approval stale. Recovery verifies expected object/ref state; do not recapture a changed
tree under old approval. Use OS process ownership plus registered resource identities
for locks; a stale PID alone is not proof a child stopped. Keep runtime metadata outside
agent-writable worktrees. Cleanup accepts registered workspace IDs, validates paths,
checks live owners and retained checkpoint refs, then performs a scoped recoverable
removal where practical. Publication remains a later explicit integration.

## 20. Permissions and security model

Envelope intersection: host policy ∩ workflow ∩ subworkflow ∩ role/node ∩ attempt.
Use repository.read/write, terminal.execute, network with optional destination scope,
git.write, delivery.publish, agent.message, channel.read/write and tool-specific grants.
Profiles and delegated roles cannot broaden hard bounds. Operator approval authorizes
only its bound action, not a persistent capability expansion.

Declared policy is not OS enforcement. Worktrees isolate changes but are not a sandbox.
An adapter must report actual native/OS containment, filesystem restrictions and tool
mediation. Unsupported required containment fails before launch. A clearly labeled
trusted-local profile may permit unenforced native behavior only through explicit user
configuration; do not advertise it as restricted. Start with the runtime host platform's
enforced adapter; platform parity is later adapter work, not invented portability.

Local server binds loopback by default, authenticates browser/CLI sessions, validates
Origin/Host, protects command requests against CSRF, and resolves artifact/workspace IDs
through storage rather than accepting arbitrary filesystem paths. Same-origin session
cookies support EventSource; do not put bearer secrets in URLs. Remote exposure is not
an initial supported deployment mode.

Tool gateway tokens are per attempt and unavailable to other participants; loopback
alone is not authentication. Agent processes must not read Kouro's database, other
workspaces or gateway credentials. Render markdown, logs, HTML artifacts and diff
paths as untrusted data, with sanitization and isolated previews. No default arbitrary
HTML execution in the workbench. Trusted local workflow/evaluator/plugin code has host
authority and must be clearly distinguished from model-provided JSON/tool input.

## 21. Evaluation and experiment architecture

An experiment is an immutable dataset version + case selection + variant configurations
+ repetitions + evaluator versions + seed/admission policy. A durable cell key is
`experiment/case/variant/repetition`. Transactionally reserve cell → call the normal
create-run use case with an idempotency key → store run association. Recovery cannot
duplicate a cell. Experiment service schedules **runs**, never nodes or harness calls.

Evaluate a pinned terminal run revision. Ordinary runtime projections/artifacts supply
behavior and efficiency evidence. Extra acceptance commands execute in isolated verifier
workspaces, bound to the candidate's exact tree. Model judges execute normal Kouro judge
workflows linked to the candidate run; their cost and contexts are inspectable separately.
No evaluator silently modifies the candidate's journal or turns its run success into
an assertion of correctness.

Experiment cancellation cancels queued cells and issues ordinary cancellation commands
for running cells. Case execution failures, infrastructure failures, evaluator errors,
skipped cells and unavailable metrics remain separate. Resume launches only unbound
cells, or explicit additional repetitions; never overwrite old results.

## 22. Dataset and evaluator model

Dataset: ID, human version, schema version, case IDs, tags, typed inputs, fixture/base
commit/tree, acceptance/evaluator definitions, optional environment/dependency manifest,
and content digest. Repository-local JSON and referenced blobs are the initial authoring
format. Freeze all case inputs before admission. No ticket provider is required.

Evaluator contract: ID/version/code digest, evidence class, configuration schema,
required artifact/metric inputs, permission/recovery needs, result schema. Deterministic
pure metrics can run as bounded host functions; command evaluators use the process
boundary. Trusted custom functions are hashed modules loaded outside the kernel; they
cannot directly update run state. Effectful or agent judges use ordinary runs.

Evidence result: evaluator identity, target run+revision+tree, metric/check name,
`passed | failed | unavailable | error | not-applicable`, typed value/unit, explanation,
supporting artifact IDs, completeness and producer provenance. Categories:

- Deterministic: process exit/tests/schema/file constraints/acceptance rules.
- Behavior: invocation/attempt/repair/fallback/message/turn/tool counts.
- Efficiency: elapsed, active attempt, command, waiting, token/cache usage and cost.
- Judge opinion: rubric, judge configuration, raw structured judgment and uncertainty.
- Human: actor, rubric, rating/note/preference and immutable decision revision.

Do not collapse categories into an opaque score. Missing usage is unavailable, not zero.
Test reports distinguish passed assertions from a merely successful command. Keep
acceptance checks outside the agent-writable tree when evaluating susceptibility to
test tampering; retain exact evaluator source and execution tree. QA may propose tests,
but its own output never substitutes for executing them.

## 23. Run and experiment comparison model

Compare immutable run IDs/config digests and evidence revisions. Matrix axes are cases
and variants, with repetitions expandable. A cell opens the exact run; status does not
hide incomplete/error results. Show per-check pass rate with explicit denominator,
missingness, sample count and dispersion. Use paired case/repetition deltas where
possible; show seeds as recorded settings, not guarantees of model determinism.

Compare workflow bundles structurally by source node IDs/call paths and prompts/configs
by content digest. Matching across changed graph topology is explicit/manual where
ambiguous. A role label alone cannot establish correspondence. Timeline comparison
aligns start-at-zero by default; optional selected milestone anchors require matching
invocations and clearly show the shift. Absolute timing remains available.

Pairwise assignment freezes left/right run, artifact/evidence set, rubric and randomized
display order. Blinded mode strips model/variant names from API display DTOs and handles
artifact filenames/embedded metadata with an explicit leakage warning. Do not claim
perfect blinding of code style or text content. Record A/B/tie/abstain, actor, reason
and assignment ID before reveal. Later corrections append decisions. Human ratings
do not overwrite deterministic evidence.

## 24. Web/API architecture and information hierarchy

Primary navigation: Runs, Workflows, Experiments, Compare, Library, Settings.
Library contains prompts, artifact search and checkpoints. Checkpoints also live in
run context; datasets live in Experiments. This gives the requested capabilities without
nine equally prominent top-level destinations.

Run page has persistent run header (objective, status, elapsed, profile, repo, controls),
central Graph / Timeline / Split view switch, shared inspector pane and an auxiliary
drawer for Events, Logs, Messages, Context, Artifacts, Diff and State. Deep links carry
run, scope, invocation, attempt, tab and optional event revision. Switching views keeps
selection, filters and run context. Workflow page offers Graph, Source, Versions and
Validation; experiments offer Dataset, Matrix, Evidence and Compare.

Host application use cases own commands and authorization. HTTP validates request,
calls a use case and maps a typed result. Suggested surfaces:

```text
GET/POST /api/workflows/versions       compile/register trusted local definitions
POST     /api/workflows/validate      validation/preview from supported local source
GET/POST /api/runs
GET      /api/runs/:id/view           projection + revision + server clock sample
GET      /api/runs/:id/events         paginated durable facts
GET      /api/runs/:id/stream         resumable projection SSE
POST     /api/runs/:id/commands       typed lifecycle/approval command
GET      /api/runs/:id/attempts/:aid/context
GET      /api/artifacts/:id           metadata + authorized content/ranges
POST     /api/runs/:id/checkpoints
POST     /api/checkpoints/:id/forks
GET/POST /api/datasets/versions
GET/POST /api/experiments
GET/POST /api/comparisons/:id/decisions
```

Command envelope includes client idempotency key, actor session and expected subject
revision; approval adds its binding digest. Use entity revisions for hot-run controls
so unrelated log events do not make every click stale. Commands return accepted/rejected
receipt and committed revision; the UI waits for authoritative status. No optimistic
approval or cancellation success. Show pending request state separately.

Pause stops new admission, lets running attempts finish, and persists across restart.
Resume restores admission after checks. Cancel requests termination and stays cancelling
until effects are settled or explicitly needs-reconciliation. Interrupt targets an
attempt; retry targets a failed/interrupted invocation and checks policy. Skip requires
a declared outcome/output binding. Checkpoint and fork are capability/eligibility driven.
Steering never changes graph or permissions. Multiple tabs see identical committed results.

## 25. Graph architecture and UX

Render bundle control edges and nested definitions; overlay actual scope/invocation
state from the shared execution projection. Do not infer execution from graph position.
Default top-to-bottom layout, restrained orthogonal edges, explicit outcome labels,
back edges in a side gutter for loops, parallel branches in columns with visible joins.
Use React Flow interaction and an ELK layered-layout adapter behind a small pure layout
request/result boundary. Cache positions by bundle+expanded-scope+layout preferences;
status updates do not rerun layout. Source IDs and sizes are stable.
The [ELK layered algorithm](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html)
supports compound graphs and orthogonal routing; adapter fixtures must verify the
actual nesting/port options used by Kouro.

React Flow supports nested nodes through parent identity; Kouro supplies the actual
scope semantics. See [React Flow subflows](https://reactflow.dev/learn/layouting/sub-flows).
Expanded groups have input/output boundary ports; collapsed groups summarize running,
failed and completed counts and preserve the selected descendant via breadcrumb.
Large repeated/map scopes show a definition plus instance picker/count, not thousands
of permanently expanded copies. Optional data edges are dashed and revealed for selected
nodes, avoiding a default tangle.

Node badges distinguish pending/active/waiting/failed/skipped/cancelled. A definition
with multiple live invocations shows counts and an invocation picker, not one misleading
latest status. Show attempt badge and active elapsed time. A node can be both historically
failed and currently running on another activation. Details include exact input/output,
context, tools, log, messages, usage completeness, recovery and Git evidence.
Repair loops display “repair pass 2 of 3” separately from “execution attempt 1,” the
triggering validation evidence, and a “Repair · up to 3 passes” edge label. Expand
semantics reveals the underlying counter and guards; normal UI does not expose raw
counter arithmetic as the primary explanation.

Keyboard graph navigation follows control adjacency; tab moves into inspector controls.
Provide an accessible outline/table equivalent. Selection is `{runId, scopeId,
invocationId?, attemptId?, definitionId}` in the route/store and shared with timeline.

## 26. Real-time timeline and automatic scaling

Use the same execution entities to derive spans: root run → nested scope/call → invocation
→ attempt → optional tool/native-child spans. Record real lifecycle timestamps for each
observable span. Unobserved native child durations are point markers or unknown, never
the parent's borrowed duration. Ready/queue time, attempt runtime, approval waiting,
retry backoff and unknown recovery intervals have distinct visual treatment.

Each span has start, optional end, state, parent, timing source and precision. Attempt
duration differs from invocation elapsed including retries/waits. Critical-path wall
time differs from summed parallel work; both get explicit labels. Completed bars use
durable endpoints. Active bars use the current display clock and grow even with no new
events. Animation is presentation interpolation, not periodic synthetic execution facts.

Clock strategy: API/SSE supplies server UTC plus sample identity. Browser estimates
offset using request midpoint and RTT, anchors to `performance.now()`, and advances
monotonically. Resample on reconnect/visibility change and periodic transport heartbeat;
never let normal client clock changes move bars backwards. Freeze/mark live extrapolation
as stale when disconnected. Completed timestamps replace extrapolated ends. Clock
correction is displayed if necessary; never silently repair journal facts. For host
clock jumps record a clock-adjustment observation, monotonic elapsed within a process,
and uncertainty across restart; UI can show approximate cross-process elapsed while
preserving observed UTC. Duration limits use durable host deadline observations.

Time-axis algorithm (no run-length buckets):

1. Store numeric viewport domain `[a,b]` in milliseconds relative to run start and
   plot width W after subtracting row headers. `x(t)=W*(t-a)/(b-a)`.
2. In Fit mode let `D=max(1000, lastObservedOrLiveEnd-runStart)`. Target `[0, D*1.08]`.
   Extend the right bound only when live now reaches 92% of visible range; grow by at
   least 15%, round outward to a nice tick, and do not shrink while running. This
   hysteresis avoids continuous zoom jitter. Explicit Fit recomputes immediately;
   completion may tighten to a padded exact extent.
3. Derive target tick count from measured label width plus gap (start near W/100).
   Select a nice numerical step around `(b-a)/count`, using D3 numeric tick utilities
   for elapsed time. Format dynamically as milliseconds, seconds, m:ss, h:mm:ss, or
   days based on span/step. Recalculate only when labels would collide or become too
   sparse. Use UTC calendar scales only for the optional absolute-time mode.
4. Zoom scales the domain around the pointer anchor. Pan translates it. Manual
   interaction disables Fit/Follow until explicitly restored. Follow keeps a fixed
   selected window ending slightly after now; it is distinct from Fit-to-whole-run.
5. Clamp the minimum viewport to 100ms initially, maximum to retained run extent plus
   sensible padding. Tiny spans retain real geometric width; add a separate >=4px hit
   target/point marker rather than falsifying duration. Tooltip always shows actual time.
6. Advance visible active bar transforms using requestAnimationFrame; rerender axis
   only on domain/size changes. Stop frames for hidden tabs, completed runs, offscreen
   rows and reduced-motion preferences; reduced motion still updates readable elapsed
   values at a modest cadence. Recompute from timestamps upon return.

The numerical tick algorithm is scale-derived rather than a fixed 30-second/5-minute/
8-hour category list. [D3 ticks](https://d3js.org/d3-array/ticks) provide nice numerical
steps; [D3 time scales](https://d3js.org/d3-scale/time) support the optional UTC view.

Virtualize rows and horizontally cull spans. Sticky row labels and axis, vertical now
line, wheel/pinch zoom, scrollbar/pan, Fit and Follow controls, expand/collapse attempts,
scope breadcrumbs, keyboard selection and jump-to-active. Maintain stable rows while
running; never reorder branches by completion time. Three-second, three-hour and eight-hour
fixtures, clock skew, resize and 10,000-span histories are required browser fixtures.

## 27. Swarm visualization

Normal graph shows a collaboration subworkflow tile and execution status, not every
message edge. Selecting it opens a dedicated workspace within the run: participant
list with role/harness/model/state, objective and budget strip; durable message stream;
blackboard/artifacts panel; participant timeline. Optional topology is a filtered summary
of authorized routes and observed message counts, not the workflow control graph.

Filter by participant, channel, message type or turn. Clicking a message highlights
sender attempt and recipient delivery batch/context. Show queued versus included versus
delivery-failed, remaining budgets, idle deadline and termination evidence. Sparse
animation can indicate a selected message route; no constant animated traffic. Unknown
native subagent activity remains labeled as observational and does not imply Kouro
controlled its internal scheduling.

## 28. Eval/comparison UI and visual system

Runs are the default landing screen: dense sortable list with objective, workflow,
state, elapsed, waiting reason, profile and experiment. Use a charcoal/ink background,
two restrained surface levels, quiet borders, readable neutral text, cyan active focus,
amber human wait, green success and red failure. Icons/text duplicate color meaning.
Prefer 13–14px workbench text, tabular numbers, monospace for source/logs, and a compact
spacing scale. These are proposed design tokens, not another product's identity.

Graph/timeline split uses a resizable horizontal divider; right inspector remains
consistent. Dedicated fullscreen views preserve route state. Inspector tabs are
Summary, I/O, Context, Activity, Artifacts/Diff, Recovery; feature panels load on demand.
Virtualized logs support search, wrap toggle, timestamp/source filters, copy and follow
tail with a clear paused-follow state. Raw Events and State remain accessible debugging
tools, never the primary readable transcript.

Experiment matrix has sticky case/variant headers, per-cell status and evidence quality,
repetition expansion, filterable failed cases and direct run links. Detail compares
deterministic checks, behavior, efficiency, judgments and human notes in separate groups.
Run comparison shares the same timeline renderer and entity inspector, with a common
elapsed scale. Prompt/workflow revision charts show sample counts, missing data and
configuration changes, so an apparent success-rate increase does not conceal a changed
dataset or evaluator.

Desktop prioritizes split panes. Medium widths switch to one visualization plus a
collapsible inspector. Small screens use a run outline/status list and full-height
detail drawer, with horizontal timeline scroll; do not shrink the entire graph to
illegibility. Keyboard shortcuts are discoverable and configurable, never shadow text
editing. Respect reduced motion, visible focus and accessible status announcements.

## 29. Live transport and frontend synchronization

One execution store per active run. The server produces revisioned projection frames
containing entity upserts/removals (invocations, attempts, scopes, spans, controls,
artifact/message summaries) from the same projection transaction. Graph/timeline
selectors consume those entities; the browser does not run transition/scheduling logic.
Raw event inspection is a separate paginated query of the same journal.

Initial GET returns a consistent view at revision R. SSE requests `after=R`; server
replays committed frames then tails from the database cursor. Publish notifications
only wake a cursor reader: the durable log closes snapshot/subscribe and missed-wakeup
races. Frame includes baseRevision and revision; apply atomically only to matching
base, ignore duplicates and resync on gaps. Multiple facts committed together may
produce one frame. Last-Event-ID carries the delivered revision. SSE reconnect support
uses [the documented event ID mechanism](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

Retain durable events; projection frame caching may be bounded. If the cursor is too
old or projection version changed, send reset-required and load a fresh snapshot.
Backpressure uses bounded client buffers; disconnect/resume slow clients instead of
unbounded memory. Heartbeats communicate transport health and server clock, not fake
workflow state. Reconnection preserves selection and viewport; inspector content is
keyed by exact attempt/artifact ID. No polling loop refetching the entire run on every
token. Run-list updates may use one multiplexed summary stream; detailed streams exist
only for open runs, with a connection budget.

## 30. Prompt/schema development tools

Prompt versions are immutable template bytes plus variable schema and content digest.
Source files remain the initial editing authority; web preview/playground can create
new catalog versions without overwriting a checked-in file unexpectedly. Compare
rendered context and source changes side by side.

Schema validator accepts fixture JSON and shows precise paths/errors. Compiler preview
shows actual graph, inferred required artifacts, permissions, budgets and diagnostics.
Scripted fixture runner invokes normal tiny workflows with fake agents/commands and
virtual time; no real credentials. Prompt playground executes a one-agent ordinary
run with selected input fixtures/profile so context, usage and artifacts remain
inspectable. A fake-output mode tests schema and parsing without spending model tokens.
No hidden alternate prompt execution engine.

## 31. CLI and headless interface

`kouro serve` opens the local host/API/web lifecycle. CLI connects to that host when
available; `kouro run --headless` can own the same composition in-process when no host
owns the data directory. It cannot start a second writer. Programmatic
`createLocalRuntime(options)` exposes the same compile/run/control/query operations.

Commands: workflow validate/graph, run, runs, inspect, events --follow, attach, pause,
resume, cancel, approve/reject, interrupt/retry/eligible-skip, steer, checkpoint, fork,
dataset validate, experiment run/status, compare/export and diagnostics. Interactive
commands link to the browser; machine use supports stable JSON/NDJSON, meaningful exit
codes and idempotency keys. Ctrl-C detach differs from cancel. CLI receives the same
stale-approval/recovery errors as the web. No required issue tracker or Git repository
for a workflow that does not request a workspace.

## 32. Testing strategy

Use v1 as a semantic regression inventory, not source compatibility fixtures. Core
tests cover byte-stable compilation, expression/transition ambiguity, invocation versus
attempt, counter bounds, binding lineage, join identity, deterministic replay, limits
and policy intersection. Golden convenience/explicit graphs prove identical semantics.

Scripted harness scenarios declare outputs, tool events, usage, messages, checkpoints,
disconnects, cancellation behavior and invalid structured output. Inject clocks and
IDs. Virtual time tests deadlines without sleeping; real subprocess tests verify actual
process termination. Reusable contract suites apply to fake and real harness adapters,
journal, process, blob and workspace boundaries.

Crash injection points: before/after intent transaction, dispatch, effect completion,
artifact rename and completion transaction; during approval/control races, parallel
reservation, message delivery and fork materialization. Reopen database and prove
completed effects do not repeat and ambiguous effects stop for verification.

Browser tests run against a real local host with scripted harness: live bar grows with
no incoming events, graph and timeline selection agree, repeated nodes are distinct,
reconnect catches up without duplication, hidden tab resumes correctly, approvals show
exact diff, nested parallel scope collapses, all matrix cells open exact runs, and
blinding hides identities until a decision. Add screenshots at agreed desktop/small
viewport sizes, accessibility checks and keyboard paths. Test rendered behavior, not
only selector functions or presence of source strings.

Initial performance targets, measured in M1/M4/M8 and adjusted only with recorded
evidence: committed event visible locally p95 <250ms; normal 500-node graph remains
interactive; 10,000-span timeline virtualizes without rendering all rows; active bars
animate within a 16.7ms frame budget on the reference desktop; inspection queries use
indexed projections, not full journal replay. Keep a reproducible benchmark fixture
and record browser/machine. No claim these targets are already achieved.

## 33. Error model

Use serializable tagged errors owned by compiler/execution/harness/workspace/storage/
application/evaluation modules. Keep a small shared transport envelope `{code, message,
subject, details, retryAdvice, evidenceRefs, correlationId}` with namespaced stable
string codes. Do not mirror an enum/helper boilerplate package for every module.
Expected failures return Result at public boundaries; internal programming defects may
throw and become a recorded host fault at the outer boundary.

Distinguish workflow outcome failure, adapter unavailable, malformed output, limit
exceeded, permission denied, stale command/approval, data unavailable, effect unknown,
storage corruption and evaluator error. A transient error is not automatic retry
authorization: policy plus recovery class decides. User-visible remedies explain what
can be retried, verified or reconciled. Redact causes before persistence. Unknown or
corrupt journal semantics halt that run; do not silently skip facts to make it load.

## 34. Extension/integration architecture

Start with explicit local registration at composition: harness adapters, workspace/
process adapters, context sources, evaluator modules, policy resolvers and observational
exporters. Each owns a small versioned contract, capability descriptor and tests.
Use direct imports/lazy provider loading; no service locator or plugin marketplace.

Custom deterministic commands may use registered effect handlers identified by ID and
version with input/output schema, capability needs and recovery policy; introduce this
only when built-in command operations are insufficient. Never let an extension register
an arbitrary scheduler callback or rewrite active graph/state. Observer/exporter failure
does not fail a run unless the workflow explicitly declares the export a required step.
Ticket resolution, Git hosting publication, Vedh/repository analysis and OTLP export
are later integrations. Complex planning/review behavior belongs in workflow libraries.

## 35. Explicitly do not rebuild initially

Do not carry v1's release/package fragmentation, broad domain unions with built-in
provider IDs/model syntax, ticket/sync/migration infrastructure, delivery-review special
node, compiler compatibility branches, raw-transcript context sharing, equal-width
timeline fallback, or frontend status re-interpretation into v2. Preserve the useful
behavior with smaller boundaries, not renamed packages. Defer all-platform sandbox
parity and all-harness parity; never relax the advertised enforcement to claim coverage.
Do not automatically merge branch trees as a join side effect. Do not make fusion,
review or swarm dedicated execution primitives.

## 36. Implementation milestones in dependency order

Each milestone's full task split, contract freeze, demo, tests and Luna orchestration
gate are in [milestones.md](docs/v2/milestones.md). Summary:

| Milestone | Executable / visible result |
| --- | --- |
| M1 Walking skeleton | Builder, small compiler/kernel, SQLite, scripted agent → real safe command, live web graph/timeline, CLI |
| M2 Real agent and deterministic evidence | First real harness, context/tool/log inspection, schema errors, budgets, commands |
| M3 Safe development loop | Complete: worktree, exact diffs/artifacts, bound approvals, repair loops and restart controls |
| M4 Parallel and reusable graphs | Explicit I/O subworkflows, fork/join/maps, scope-aware scheduling, nested graph/parallel timeline |
| M5 Evaluation workbench | Complete: dataset + variants + repetitions → ordinary runs; matrix, evidence, pairwise and timeline comparison |
| M6 Collaboration and portability | Partial/in progress: scripted bounded collaboration, Pi fake-RPC adapter, selective context, collaboration view; live second-harness model exchange remains |
| M7 Checkpoints and forks | Complete for supported cuts: quiescent capture, independent worktree forks, genealogy and inherited-prefix comparison |
| M8 Developer experience and hardening | Complete for the documented local fixture: prompt playground, source/version comparisons, performance/accessibility, recovery test matrix |

Parallelism and child scopes share one semantic milestone because splitting their
identity/binding designs would cause rework. Evals precede swarms so collaboration
experiments can be judged immediately. Checkpoint metadata foundations start in M1/M3;
arbitrary historical forking does not delay the first useful workbench. Every milestone
includes web behavior and an inspectable end-to-end fixture.

### Current M6/M7 status (2026-09-19)

M6 is only partially complete. The local evidence currently covers a scripted
multi-turn collaboration exchange and the native Pi CLI-RPC adapter through a fake
JSONL process. The focused run passed 18 tests across the collaboration gateway,
coordinator exchange/respond-loop, Pi adapter, handoff, and swarm DTO suites. Those
tests cover gateway ACLs (spoof, cross-run, expired-attempt and unauthorized-channel
rejection), payload and message/turn/concurrency bounds, idempotent restart recovery,
uncertain provider-delivery labeling, selective delivery/context manifests, bounded
respond loops and idle termination, the deterministic reproduction gate, and handoff
validation that creates a new session rather than pretending to resume native provider
state. The Pi tests cover native config redaction/checksums, streamed output/usage mapping, selected
model/context forwarding, invalid output/process death, abort, and unavailable
capability reporting; they do not call a model.

The collaboration view has two M6 browser tests: durable host snapshot rendering and
768px usability/no-horizontal-overflow. Their fixture uses the authenticated live host
route and durable scripted collaboration rows, and asserts participant/message,
blackboard, sender-attempt and context-linked UI evidence. A browser run is not counted
as passed verification in this status when the local port is unavailable; rerun those
two tests against the real local host before closing M6.

The remaining M6 gate is exact: run a small two-harness exchange in which the second
native harness performs an actual model-backed turn (including the configured Pi
provider/model, not the fake RPC process), then rerun the full checks and both M6
browser tests and record the model/runtime, capability mapping, usage, and evidence
artifacts. No paid/live Pi model exchange was performed for this update. If the real
second-harness run is required by the original acceptance, M6 remains partial/in
progress until that gate passes.

M7 is complete for supported cuts. The focused host suite and real-host browser
suite verify quiescent capture, crash-safe fork materialization, genealogy, and
inherited-prefix comparison. Nested-scope and arbitrary historical rewind remain
explicitly unsupported.
