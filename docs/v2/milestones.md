# V2 milestone implementation and orchestration handoffs

Status: M1–M5 complete; M6 remains partial because live second-harness model
exchange is unverified; M7 and M8 are complete for the documented local acceptance.
M6's bounded collaboration is verified with scripted providers, and its second-harness
path has a separate real local Pi workflow acceptance. This document is the
execution handoff accompanying [plan.md](../../plan.md). The user authorized M1 with
Luna as implementor and the primary agent as orchestrator/reviewer, using ElysiaJS.
This does not authorize publication or modifications to v1.

## Execution protocol

Use the primary agent as architect/integrator and Luna for bounded implementation work,
as requested. Use Luna at **medium** effort by default to conserve the user's rolling
usage allowance; do not select high/xhigh unless the user explicitly changes this.
Do not assign a milestone as one vague
“build it all” task. Break it into the task rows below with concrete file ownership.

The main agent must read the applicable instructions, inspect the worktree, and freeze
the milestone's small contract/fixture set before delegating. Use independent worktrees
or non-overlapping file ownership. Never let multiple workers edit shared contracts,
lockfiles or the composition root concurrently. The primary agent owns those files.
When spawning a model override, provide an explicit bounded handoff with a fresh or
limited context fork. Do not assume model selection alone makes the task well scoped.

With four slots: primary integration plus at most three workers. Runtime and UI work
can proceed concurrently **after** DTOs/events and fixture identities are agreed.
Cross-boundary integration and final review are sequential. Do not manufacture parallel
tasks where one directly depends on another's unfinished contract.

Every worker receives:

```text
Milestone and task ID:
User-authorized scope:
Read these plan sections and accepted decisions:
Inputs / frozen interfaces / fixture IDs:
Own these files only:
Required behavior and invariants:
Explicit exclusions:
Tests/demo to deliver:
Return changed paths, decisions, evidence, risks and remaining work.
Do not weaken tests or invent unsupported harness capabilities.
Escalate a contract contradiction to the integrator; do not redesign it silently.
```

Every milestone closes with: complete diff review, formatting/lint/typecheck/build,
relevant unit/contracts/crash/integration/browser tests, direct visual inspection of
the demo, and an evidence note containing commands/results/screenshots and reference
environment. V1 test results are not v2 evidence. A green unit suite does not establish
graph/timeline UX quality. No acceptance based solely on screenshots or mocked backend
responses when the milestone requires durable execution.

Maintain one milestone status table here, updated only from reproduced evidence.
Commit/publication choices follow the user's implementation-session instructions;
these milestones do not imply permission to release packages or publish a site.

| Milestone | Depends on | Current state |
| --- | --- | --- |
| M1 Walking skeleton | None | Complete |
| M2 Real harness/evidence | M1 | Complete |
| M3 Safe development loop | M2 | Complete |
| M4 Parallel/subworkflows | M3 | Complete |
| M5 Eval workbench | M4 | Complete |
| M6 Collaboration/portability | M5 | Complete for scoped local acceptance; live Pi workflow verified |
| M7 Checkpoints/forks | M6 | Complete for supported cuts; nested/arbitrary rewind remains out of scope |
| M8 DX/hardening | M7 | Complete for the documented local reference fixture |

The ordering is an integration path, not a claim every internal task depends on every
earlier feature. For example, checkpoint schema/retention roots begin in M1/M3, and
prompt schema fixtures begin in M2. A safe independent UI fixture can be prepared
early, but its milestone is not complete until integrated with the real host.

## M1 — Walking skeleton: execute and watch

Outcome: launch a scripted agent → safe real command → complete run from web or CLI,
watch graph state and an expanding timeline, restart and inspect durable history.

Freeze before delegation: minimum Bundle/Definition/Node/Port schema, run/scope/
invocation/attempt IDs, event envelope, three node kinds, automatic CommandResult, projection
frame, snapshot cursor, application command receipt and errors. Include scope identity
and input-binding structures now; reject unsupported call/fork nodes rather than
pretending future semantics already execute. Use finite default limits and declare
them in the bundle. Document the accepted kernel/journal/transport decisions.

| Task | Owner / effort | Work and artifact |
| --- | --- | --- |
| M1.1 | Primary | Three-workspace scaffold, scripts, import boundaries, contracts and tiny fixture |
| M1.2 | Luna medium | Builder agent/command/complete + sequence, pure compiler/reducer/decision functions, artifact bindings, deterministic tests |
| M1.3 | Luna medium after kernel contract | SQLite event/projection/outbox transaction, blob protocol, scripted harness/process adapter, startup recovery |
| M1.4 | Luna medium parallel against frozen fixtures | Web shell, workflow graph preview, shared run store, graph/timeline/inspector components and adaptive scale |
| M1.5 | Primary | Application composition, API/SSE/CLI integration, auth baseline, real browser demo and recovery review |

Initial process fixture executes a known read-only command in a temporary fixture
directory, with fixed argv and timeout; no agent-generated shell text. No Git required.
Artificial scripted agent delay provides a visible live bar without spending tokens.

Acceptance:

- Recompiling the same source bundle is byte-identical; importing core in a browser
  does not import filesystem/SQLite/provider SDKs.
- Web launch returns a run ID and moves through three real durable invocations.
- Graph, timeline and inspector select the same invocation/attempt. Active bar grows
  over five seconds without any new lifecycle event; completion fixes its endpoint.
- Snapshot plus reconnect after a disconnected completion yields no gaps/duplicates.
- Kill host after completed command, reopen, and verify it is not executed again.
  Kill during command ambiguity and see explicit recovery state rather than replay.
- Continuous SSE is tested as a live stream, not only a finite successful HTTP response.
- Timeline tick/zoom/fit behavior is demonstrated for 3s/30s/3h/8h fixture spans.
- One documented command starts host and web; CLI run/inspect uses the same service.

Exclude real harnesses, worktrees, approvals, parallel execution, swarm and experiments.
M1 is deliberately small in node semantics, not backend-only.

Closure evidence (2026-09-18): 18 unit/integration tests passed; typecheck, lint,
core/browser boundary check, formatting check and production web build passed. Two
Playwright tests passed against the real Elysia host and Bubblewrap adapter, covering
live bar growth, graph/timeline/inspector selection, durable reload, zoom/fit and a
768px viewport. A separate real `kouro run` completed at journal revision 14 and
`kouro inspect` reloaded the same pinned bundle and execution state. Claimed-effect
restart tests enter `recovery-required`; command failure is observed rather than
self-certified. Screenshots are in `test-results/m1-workbench-{desktop,small}.png`.

## M2 — One real harness and deterministic evidence

Outcome: an ordinary run uses one installed native harness, produces schema-validated
artifact output, executes a deterministic check and exposes context/tools/logs in web.

Freeze: harness descriptor/start/turn result/control interface; native config schema
and secret references; effective permission manifest; structured artifact outcome
schemas; ContextManifest; usage quality model; attempt policy and handoff schema.
Verify native SDK/tool capabilities against current official documentation at this
implementation stage. Do not require a model/config named in earlier user sessions.

| Task | Owner / effort | Work |
| --- | --- | --- |
| M2.1 | Primary | Installed-provider/OS containment preflight and first-adapter selection |
| M2.2 | Luna medium | Native harness adapter and reusable contract scenarios; cancellation/reattachment honesty |
| M2.3 | Luna medium | Context manifest, artifact validation, usage/budget reservation and bounded retry policy |
| M2.4 | Luna medium | Context, tool, log and artifact inspector, retry timeline rows and diagnostics UI |
| M2.5 | Primary | Integrate live run and negative permission/schema/crash demonstrations |

Acceptance:

- Same tiny workflow runs with scripted and real harness without graph changes.
- Real output validates independently of the provider. Invalid output is retained
  as untyped evidence; failed attempt and bounded next attempt are visible.
- Inputs/profile/native config/prompt/schema are checksummed; secrets are absent
  from durable output and API logs.
- Context UI shows supplied segments, reasons and estimated/unavailable token data;
  native hidden context is explicitly unavailable.
- Unsupported required tools/permissions reject before work; live controls only
  appear when supported. Cancellation failure never reports fabricated success.
- A hard cost cap cannot be enabled under a capability incapable of enforcing it.
- Deterministic check evidence is distinct from agent's success claim.

Exclude all-provider parity and automatic routing. Repeat real model runs only for
specific adapter validation; use scripted fixtures for exhaustive failure cases.

Closure evidence (2026-09-19): the same pinned `tiny` bundle ran under the scripted
profile and the installed Codex CLI read-only profile. The real run completed at
revision 14 with independently validated typed output, a checksummed context manifest,
observed token fields and explicit unavailable total/cost fields, normalized harness
events, deterministic command evidence and persisted profile attribution. Scripted
negative coverage proves an invalid output closes attempt 1 and atomically reserves
attempt 2 under the same invocation, while retaining redacted untyped evidence. Core,
host and web suites passed 26 tests; typecheck, lint, boundary, formatting and production
build checks passed. Two Playwright workbench tests passed with profile discovery,
live graph/timeline behavior and a small viewport. The initial adapter deliberately
does not claim reattachment, native hidden context, or enforceable provider cost caps.

## M3 — Safe development loop, approvals and workspaces

Outcome: plan → bound approval → implement → deterministic validation → bounded repair
→ optional review → local exact-tree approval/commit in an isolated worktree.

Freeze: workspace IDs/claims, tree/diff artifact schema, prepared-action binding,
approval/control subject revision, recovery class and verification result, feedback
binding, session continuation policy. Optional review is a workflow choice; not a
required success primitive. Delivery publication is excluded.

| Task | Owner / effort | Work |
| --- | --- | --- |
| M3.1 | Luna medium | Git workspace/snapshot/temporary-index diff/controlled commit/cleanup and crash contracts |
| M3.2 | Luna medium | Approval/control lifecycle, counter-cycle proof, retry vs repair and session continuation |
| M3.3 | Luna medium | Approval/diff panel, stale-action explanation, lifecycle controls and repair navigation |
| M3.4 | Primary | Feature fixture, command permission audit, cross-tab/race/restart integration |

Acceptance:

- Two runs never edit the original checkout or each other's worktree.
- Approval diff includes a new untracked file, deletion, binary metadata and exact
  tree reference. Changing the tree after approval rejects commit.
- Crash after commit before result recording is verified without a duplicate commit.
- Validation failure returns explicit evidence to another implement invocation;
  native session continuation is recorded. Attempts do not consume repair counters.
- At the exact repair bound, the workflow takes the failure exit; an alternate
  unbounded cycle is rejected by the compiler.
- Pause lets active work finish but prevents admission; detach leaves work running;
  interrupt/retry/cancel remain distinct and actor-attributed across web and CLI.
- Formatting receives write permission. Test/network side effects have truthful
  recovery classifications. Unknown active subprocesses block unsafe cleanup.
- A run-level workspace/tree capture manifest is ready for later checkpoint use.

Closure evidence (2026-09-19): the real Elysia host browser suite passed 4 tests on a
free local port, including desktop and 768px layouts, feature workflow approval through
the revision/idempotency action, terminal success, truthful approval/control visibility,
repair and exhausted edge labels, and the no-workspace diff state. A repository-workspace
API fixture against the checkout passed and rendered the authoritative empty Git snapshot.
Web build and TypeScript typecheck passed; the verified browser run produced the M3
desktop approval screenshot at `test-results/m3-feature-approval-desktop.png`.

## M4 — Parallel execution and first-class subworkflows

Outcome: reusable planning/review child graphs execute concurrently with explicit
typed I/O, nested controls and readable live graph/timeline.

Freeze: child definition/scope model, control lineage/binding environment, fork group
identity, join modes, loop carry, bounded collection expansion, resource admission
and call-attempt policy. Implement the agreed hierarchical IR rather than flattening
all children into the root. Use the same coordinator and journal for child execution.

| Task | Owner / effort | Work |
| --- | --- | --- |
| M4.1 | Luna medium | call/parallel/join/loop/forEach authoring and compiler checks/source mapping |
| M4.2 | Luna medium | General ready-set scheduler, scope bindings, reservations, fail/cancel/settled joins |
| M4.3 | Luna medium | Nested graph layout/instance picker, parallel/nested timeline and shared selection |
| M4.4 | Primary | Workspace branch adapter/integration step and combined simulations/browser acceptance |

Acceptance:

- Two calls of the same child, including inside a loop, never resolve one another's
  outputs. Missing required branch input fails before effects.
- Three parallel read-only planners overlap in wall time and output is joined in
  canonical branch order. Completion order permutations yield the specified binding.
- All-settled, fail-fast, cancellation, skipped/not-taken, empty map and map overflow
  cases are exercised. Approvals inside branches survive restart and do not deadlock.
- Global and local limits remain enforced under nested branches. Waiting parent scopes
  consume no agent slot. Competing session/workspace writers cannot both be admitted.
- Parallel writers use child worktrees. Join produces artifacts without auto-merging;
  explicit integration detects conflict and validation runs after integration.
- Collapsing a child retains descendant selection and breadcrumb. Expanding attempts
  shows their own recorded time; status changes do not reshuffle layout.
- Golden helper graphs match explicit equivalents and retain inspectable source maps.

Closure evidence (2026-09-19): 67 core/host/web tests passed; typecheck, lint,
boundary checks, formatting and production build passed. The real-host Playwright
suite passed 6/6. Durable child calls, child approvals and replay were exercised,
along with fixed-count loops with carry, bounded `forEach`, fork/join modes with
cancellation and canonical ordering, resource admission, isolated branch worktrees,
and explicit atomic integration. The web acceptance covered nested graph/timeline
views, expansion/collapse, descendant selection and shared execution focus. These
results establish M4 completion without claiming provider-specific or distributed
execution features that are not part of this milestone.

## M5 — Evaluations as a workbench

Outcome: run a dataset against baseline, parallel planning and optional QA variants,
inspect a live matrix, compare timelines/evidence, and submit blinded pairwise decisions.

Freeze: dataset/variant/experiment/cell schemas, immutable manifest, evaluator contract,
evidence taxonomy, repetition identity, comparison and blind assignment contracts.
Experiment launch uses the existing run-creation service and resource admission.

| Task | Owner / effort | Work |
| --- | --- | --- |
| M5.1 | Luna medium | Dataset/experiment compilation, cell reservation/idempotency, resume/cancel orchestration |
| M5.2 | Luna medium | Deterministic metric/evaluator runner, verifier workspace and immutable evidence/annotations |
| M5.3 | Luna medium | Dataset/matrix/evidence pages, common-scale timeline comparison, blind pairwise UI |
| M5.4 | Primary | Small meaningful dataset, end-to-end experiment and attribution/recovery audit |

Acceptance:

- At least 3 cases × 3 variants × 2 repetitions produce 18 ordinary runs, using fake
  harness fixtures for reproducibility; optional small real subset is separate evidence.
- Every matrix cell links to a run with the same graph/timeline/context/diff inspection.
- Kill after cell reservation/before run association and resume without duplicate runs.
- Missing usage stays unavailable, evaluator error differs from failed acceptance, and
  canceled cells do not inflate success-rate denominator silently.
- Independent acceptance evidence runs on the exact candidate tree. An agent-editable
  test file cannot replace the evaluator's pinned acceptance source.
- Timeline comparison shows planning overhead and overlapping work on a shared scale,
  with role/node matching explicit across differing workflow structures.
- Blinded API response and rendered artifacts hide configured identity fields until
  decision; A/B/tie/abstain persist assignment/actor/time and reveal only afterward.
- One optional scripted judge workflow demonstrates judge evidence separate from facts
  and separately attributed cost. No bespoke judge execution engine.

Closure evidence (2026-09-19): the focused evaluator/comparison suite passed 17 tests
with 94 assertions. The reproducible fixture produced exactly 18 ordinary runs with
18/18 eligible and an explicit success-rate denominator; reservation recovery reused
the bound run, and cancellation preserved incomplete cells. Pinned acceptance ran
outside the candidate tree against the candidate tree digest and remained cell-linked;
evaluator errors, unavailable usage, deterministic evidence, and linked scripted-judge
opinion evidence remain distinct. Comparison alignment, the comparison API, and durable
pairwise assignment/decision/correction persistence were exercised, including identity
blinding until decision and reveal afterward. The prior real API-backed browser run
passed all 8 specs (the 6 earlier workbench specs plus 2 M5 specs), including desktop
and 768px views, matrix/evidence/run navigation, shared-scale comparison, and pairwise
review. Because M6 edits are currently in flight, the complete checks and browser suite
must be rerun after M6 integration; this note does not claim that post-M6 rerun.

## M6 — Bounded collaboration and a second harness

Status: complete for scoped local acceptance. Bounded collaboration is verified with
scripted providers; a real local Pi model also completed the same tiny workflow graph.

Outcome: implementer and QA exchange model-written messages through authorized tools,
publish structured findings, and converge through bounded evidence/validation turns.
The dedicated collaboration view explains activity, messages, contexts and remaining
budgets. A second native harness proves the portable contract's actual independence.

Freeze: participant/tool credentials, message/delivery batch schema, channel schema,
ACLs, turn activation template, idle/deadline termination, usage inclusivity, native
capability mappings and handoff validation. No unbounded dynamic delegation.

| Task | Owner / effort | Work |
| --- | --- | --- |
| M6.1 | Luna medium | Authenticated gateway/mailboxes/channels/idempotency/selective delivery |
| M6.2 | Luna medium | Second harness + handoff contracts and bounded collaboration template |
| M6.3 | Luna medium | Participants/messages/blackboard/topology/timeline detail view |
| M6.4 | Primary | Permission/budget/crash audit, real small exchange, experiment comparisons |

Acceptance:

- Sender spoof, cross-run recipient, expired attempt, unauthorized channel and oversized
  payload are rejected. Model writes body; host supplies identity.
- Restart after accepted send or context-batch reservation creates no duplicate durable
  message and labels uncertain provider delivery honestly.
- Message count, turn count, invocation count, duration and concurrency bounds hold
  under simultaneous sends. Agents cannot change budgets or instantiate undeclared roles.
- No incoming message implicitly resurrects a completed participant. The declared
  respond loop handles queued messages; idle/no-progress has a bounded exit.
- A missing deterministic reproduction/check prevents successful termination despite
  the models claiming completion.
- Context contains only the selected delivery batch/channel entries and records omitted
  material. UI links a message to sender attempt and recipient context manifest.
- First and second harness share workflow semantics while native configuration and
  unsupported features remain visible. A handoff is a new session, never a fake resume.
- M5 can compare collaboration versus no collaboration using ordinary variants.

### M6 closure evidence and live harness check (2026-09-20)

The focused local run passed 18 tests across the collaboration gateway, coordinator
multi-turn exchange/respond-loop, Pi native RPC adapter, handoff, and swarm DTO suites.
The gateway evidence covers authenticated sender identity and ACL rejection (spoof,
cross-run, expired attempt and unauthorized channel), payload/message/turn/concurrency
bounds, idempotent send and selective-batch recovery across restart, and explicit
`uncertain` provider-delivery state. Coordinator tests cover selected context delivery,
bounded respond loops, no resurrection of completed participants, idle termination, the
deterministic reproduction gate that rejects completion without recorded evidence, and
handoff validation that always starts a new session rather than faking native resume.
The Pi adapter evidence is fake JSONL RPC only: strict parsing, redacted/checksummed
native config, streamed text and usage mapping, selected model/context forwarding,
invalid output/process death, abort, and unavailable capability reporting.

The swarm UI acceptance has two M6 browser tests (`m6-collaboration.spec.ts`): durable
authenticated-host snapshot rendering and 768px usability/no horizontal overflow. The
fixture supplies durable scripted participant/message/blackboard rows and the assertions
cover sender-attempt and recipient-context links. These passed against the real local
host in the full M1–M8 browser suite on 2026-09-19.

A real local Pi RPC run then completed the `tiny` agent → command → complete graph
at revision 14 using the configured `llama-server=http://models:8080` router and
`qwen-4b-daily` model. The agent published a schema-validated output, all three
invocations succeeded, and the durable attempt attributed model/harness and observed
usage (597 input, 17 output, 994 reported total tokens; cost unavailable). This exposed
and fixed an inherited five-second scripted-fixture timeout, RPC processes remaining
open after `agent_settled`, and Pi's native content-block/usage mapping. The local
acceptance run ID is `run_c99591c69ef2482caa4397e71c574938` in an isolated
temporary data directory. This validates the second harness on a real workflow, **not**
a live multi-agent Pi collaboration exchange. Native messaging and steering remain
capability-gated and unavailable unless the selected harness actually supports them.

## M7 — Checkpoints, safe forks and genealogy

Outcome: pause at a valid cut, capture a tree/runtime checkpoint, fork two approaches
into independent workspaces and inspect their divergence and inherited evidence.

Freeze: quiescence predicate, checkpoint/cut schema, retained roots, fork eligibility
certificate, inherited provenance, configuration invalidation and budget rules.
Arbitrary historical revision rewind and live provider-memory snapshots remain excluded.

| Task | Owner / effort | Work |
| --- | --- | --- |
| M7.1 | Luna medium | Quiescence capture/restore certificate, inherited execution projection and invalidation |
| M7.2 | Luna medium | Tree/blob retention, fork workspace creation, recovery and cleanup contracts |
| M7.3 | Luna medium | Checkpoint eligibility view, fork form, genealogy and inherited-prefix comparison |
| M7.4 | Primary | Side-effect audit, branch experiment fixture, crash and approval replay checks |

Acceptance:

- Checkpoint cannot claim consistency while an unverified writer/process is active.
- Both forks start at identical retained tree/input frontier in distinct workspaces.
- Parent journal remains unchanged; reused results are labeled inherited with source IDs.
- Changing an unexecuted prompt/profile records a new digest. Changing completed
  dependencies rejects that reuse or selects an earlier valid checkpoint.
- Approval decisions and live provider credentials are not imported as authority.
- Unsafe external effects request verification/reconciliation rather than replay.
- Crash during fork allocation/capture is idempotently recoverable. Cleanup retains
  checkpoint roots and cannot delete a live/foreign workspace.
- Comparison excludes inherited work from newly spent time/cost while showing total
  lineage evidence separately. Graph-changing forks default to fresh execution.

### M7 closure for supported cuts (2026-09-20)

The same-bundle fork path is end-to-end verified: a paused, drained Git-backed
feature run captures its tree; two children begin at the same tree, inherit the
completed plan without rerunning its attempt, receive fresh approval requests,
and complete independently. The parent revision remains unchanged. Repeating the
fork request reuses child identities; changed captured configuration rejects reuse.
The real-host browser suite passed all 12 M1–M7 specs, including the live
eligibility transition and fork genealogy. A review fixed an incorrectly labeled
certificate digest, stale approval-request reuse, scheduler rescheduling after an
immediate approval decision, checkpoint lookup by source run, and missing runtime
pause capability after a provider attempt.

The web and API offer execution-profile and
unexecuted-agent-prompt fork variants. The child has a new bundle/configuration
digest while retaining the completed prefix. Completed-node prompt edits and
arbitrary input/dependency changes are rejected; the browser checks a named
fork using both variant controls. Nested-scope prefix materialization is explicitly
ineligible rather than silently flattened; this is a supported-cut boundary,
not a claim that arbitrary historical or nested rewind works. Graph-changing
variants are rejected rather than silently inheriting incompatible work.
Uncertain external effects still require operator reconciliation, never automatic replay.
The checkpoint retention mark is now rebuilt from SQLite certificates on restart;
a crash-seam test removes the auxiliary mark after capture and confirms cleanup
still refuses the retained parent workspace. Another fault test raises after a
child worktree is allocated and confirms retry reuses the same child run and claim.
Additional fault tests cover a crash after certificate save but before the
capture-operation record: retry keeps the same certificate identity. If an
unprepared child worktree diverges after allocation, retry refuses to adopt it.
The focused M7 host suite passes all eight cases.

## M8 — Developer experience and hardening

Outcome: a usable personal workbench for prompt/schema/workflow iteration, sustained
runs and attributable comparisons, with documented operations and measured UI behavior.

| Task | Owner / effort | Work |
| --- | --- | --- |
| M8.1 | Luna medium | Prompt/schema fixture playground, source/version graph/config comparison |
| M8.2 | Luna medium | Full crash matrix, storage/projection performance and diagnostics/export integrity |
| M8.3 | Luna medium | Accessibility/keyboard/responsive/reduced-motion, timeline/graph performance fixtures |
| M8.4 | Primary | Cross-feature acceptance, developer docs, examples, final risk and scope review |

Acceptance:

- A developer tests a schema or prompt without running the feature workflow; actual
  prompt execution remains an inspectable ordinary run.
- Workflow source/version changes and profile changes show exact digests and affected
  nodes; missing model usage and unobservable native context remain explicit.
- 500-node graph and 10,000-span history benchmarks meet the agreed plan targets on
  a recorded reference machine; full history is not loaded for ordinary list queries.
- 3s and 8h active timeline fixtures have readable adaptive scales; hidden tab, clock
  skew, reconnect, pause, cancellation and reduced-motion paths behave correctly.
- Desktop/small viewport visual review, keyboard-only control, log search/follow and
  accessible outline alternatives pass. No color-only status indicators.
- Import boundaries hold; no new execution engine exists for eval, prompts or swarms;
  no workflow requires Git unless it requests a workspace.
- Backup/export captures a consistent SQLite state and retained blobs. Recovery docs
  distinguish replay, restart, retry, fork, reconciliation and external side effects.

### M8 local closure evidence (2026-09-20)

Schema and prompt fixtures render/validate without a run; an explicit action
compiles a tiny prompt workflow and executes it as an ordinary inspectable run.
Host and browser tests cover both paths. The SQLite export copies blobs referenced
by its database snapshot, including a concurrent-writer boundary test. Ordinary
run-list reads are bounded to 100 rows; the timeline renders a bounded row window.
An idle SSE stream now emits comment heartbeats; a browser test confirms it remains
live past the host timeout and refetches the durable snapshot on tab visibility.
Timeline history aggregation is memoized across active-clock ticks, and nested graph
fit now accommodates expanded child scopes. Focused real-host browser checks pass
for live bars, nested graph selection and quiet-stream recovery. The reference
fixture and its limits are recorded in `m8-storage-hardening.md`.

M8 local acceptance is complete for the stated reference fixture. The production
GraphPanel/ReactFlow and Timeline mounted 500 graph nodes and projected 10,000
durable invocation rows in Chromium. The full browser run measured 1,306 ms
initial mount, 84.1 ms graph selection, 17 virtualized bars in the DOM, and a
33.4 ms p95 interval across 90 scrolling frames, inside the documented budgets.
The test exposed and fixed a main-column containment bug that had expanded the
timeline viewport to thousands of bars. Synthetic one-hour client clock skew,
reduced motion, hidden-tab refresh and quiet-stream heartbeat checks pass.
Graph outline, timeline selection, log search/follow and no-overflow behavior
pass a 768px keyboard browser check. The full real-host browser suite passed
18/18 cases; 140 core/host/web tests, typecheck, lint, formatting and production
build also pass. Operator recovery boundaries are documented in `operator-guide.md`.
This is local reference-machine acceptance, not a universal performance or
comprehensive third-party accessibility certification.

## Change and stop rules during implementation

Within authorized implementation, the integrator resolves routine choices and continues
after tests pass. Ask for user direction only for a real product tradeoff outside this
plan, unavailable required credentials/runtime access, or an external/destructive action
not already authorized. A missing optional provider does not justify claiming harness
success; finish fake/contract/UI work and report that specific live verification gap.

If a worker proposes another package, runtime node type, provider-normalized field or
background agent call, require the concrete problem, owner, consumer, alternative and
acceptance test. Prefer a module, artifact, explicit command or subworkflow. No milestone
is complete with “backend done, UI later.” Remaining M7/M8 gates are listed above;
do not silently promote test-only browser fixtures or unsupported nested replay into
completed production acceptance.
