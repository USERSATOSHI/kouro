# V1 review: evidence, lessons and disposition

Reference: [USERSATOSHI/kouro](https://github.com/USERSATOSHI/kouro), commit
`90b5cc69b6657b7ced21b4bee5d2696cb3781fae`. GitHub main was checked with
`git ls-remote`; the clean local `/home/usersatoshi/homelab/projects/kairo` checkout
matched exactly. This is a source/test/document review, not a reproduced runtime or
performance benchmark. No v1 test suite or real model calls were run for this plan.
Source paths below are relative to that pinned repository, not the new v2 checkout.

## Review coverage

Three requested Luna xhigh review tracks examined core execution, web/evaluations,
and harness/workspace execution. The primary agent inspected cross-cutting sources,
invariants, plan/TODO, representative implementations/tests, and reconciled design
recommendations. Their suggested package lists and milestone sequences were treated
as review input, not copied mechanically.

| Area inspected | Principal evidence |
| --- | --- |
| Repository/package structure | Root `package.json`, `README.md`, `AGENTS.md`; package manifests/READMEs |
| Builder | `packages/adw/src/sdk.ts`; `tests/simulations/adw-sdk.test.ts` |
| Compiler/IR | `packages/adw/src/compiler.ts`, `package-compiler.ts`, `canonical.ts`, `composition.ts`; `packages/domain/src/types.ts` |
| Runtime | `packages/runtime/src/reducer.ts`, `scheduler.ts`, `transitions.ts`, `expression.ts`, `simulate.ts`, `trace.ts` |
| Persistence | `packages/persistence-sqlite/src/sqlite-event-store.ts`, `sqlite-evaluation-store.ts`; run/evaluation store contracts |
| Effects | `packages/executors/src/run-coordinator.ts`, `agent-executor.ts`, `ports.ts`, `structured-output.ts`, `bun-command-runner.ts` |
| Harnesses | `packages/harnesses/src/*-harness.ts`, Codex transport, registry, fake harness, activity/artifact stores, tool bridges |
| Workspaces/sandbox | `packages/sandbox-worktree/src/worktree-sandbox-provider.ts`, `worktree-path-guard.ts`, command sandbox and Git runner |
| API/host | `packages/api/src/app.ts`, `use-cases.ts`, `evaluation-use-cases.ts`, `composition-root.ts`; `packages/cli/src/local-host.ts` |
| Web | `packages/web/src/App.tsx`, `api.ts`, `timeline.ts`, `execution-presentation.ts`, `run-comparison.ts`, `transcript.ts` |
| Evals | `packages/evaluations/src/{types,compiler,evaluate,record,ports}.ts`, API dataset source and SQLite evaluation store |
| Workflow | Packaged `packages/cli/assets/adw-templates/feature-development/kouro.adw.ts`, prompts/schemas, corresponding test fixture |
| Decisions and status | `docs/invariants.md`, `docs/runtime-model.md`, `docs/terminology.md`, `plan.md`, `TODO.md`, ADRs 0001–0042 relevant to each area |
| Tests | Simulation, contract, unit and integration suites listed below; assertions inspected as behavioral oracles |

## Major concept disposition

“Keep” means preserve semantics; it never implies copying an implementation or API.

| V1 concept | Disposition | V2 decision / reason |
| --- | --- | --- |
| Deterministic compilation/checksum | Keep | Runs pin complete immutable executable inputs |
| Pure reducer and scheduler | Keep | Ordered facts determine orchestration, independently of real agent output |
| Definition/invocation/attempt | Keep | Essential to retries, loops, metrics, selection and recovery |
| Exact transition selection | Keep | Multiple matches fail; default only if none match; declaration order irrelevant |
| Bounded counters | Redesign implementation | Clear cycle proof and concise loop helper; no counter reset within consuming scope |
| Recovery classifications | Keep | Operations verify/resume/reconcile explicitly; no arbitrary exactly-once promise |
| Atomic event/projection/idempotency | Keep boundary, redesign storage | Incremental transactional projections instead of replay/rewrite on ordinary operations |
| Compiler-expanded subworkflows | Redesign | Hierarchical definitions and scope instances with typed I/O |
| Parallel groups | Redesign | General ready set, explicit branch output joins, cancellation and resource claims |
| Parallel Git integration | Move out of join | Explicit workspace integration effect followed by validation |
| `.withContextFrom` | Redesign | Frozen artifact bindings and per-attempt context manifests |
| Context-preserving repair | Keep intent | Explicit continuation key and feedback inputs; fresh handoff when native resume is unsafe |
| Harness interface | Redesign | Small streaming lifecycle, capability discovery, native configuration escape hatch |
| Built-in harness/model maps in SDK | Remove | Provider IDs and reasoning/model syntax do not define core authoring types |
| Scripted harness | Keep and expand | Full lifecycle/control/stream/message/recovery fixtures |
| Subordinate read-only subagents | Move to optional adapter observation | Durable collaborative roles become normal invocations; no second subordinate scheduler |
| Explicit Kouro tool routing | Keep and expand | Authenticated messages and declared role activation, never prose parsing |
| Structured output validation | Keep | Host validates even with provider-native schema support |
| Content-addressed artifacts | Keep, promote | Typed ports, lineage and immutable copies |
| Worktree isolation/Git recovery | Keep behavior, adapter ownership | Exact trees, controlled mutations, cleanup validation |
| Terminal sandbox enforcement | Keep boundary | Worktree is not sandbox; actual native/OS enforcement and honest diagnostics |
| Human approvals/eligible skips | Keep | Bind exact action, actor, invocation, artifact/tree digests; reject stale decisions |
| `delivery_review` primitive | Remove | Ordinary approval over a prepared-action artifact + workspace effect |
| Live activity vs durable facts | Keep | Ephemeral tail cannot determine state; completed evidence is retained |
| Durable invocation timestamps | Keep and extend | Independent attempt/tool/scope spans and honest unknown timing |
| Fixed graph positioning | Replace | Hierarchical layout with stable source/execution identity |
| Timeline slot fallback | Remove | No old-history compatibility; unknown spans never fabricate durations |
| Browser-derived duplicate states | Replace | Shared authoritative execution projection and common selectors |
| Durable event cursor | Keep, redesign delivery | Continuous replay-then-tail with snapshot revision handshake |
| Dataset checksums/evidence binding | Keep | Expand into experiments launching ordinary runs |
| Unavailable eval evidence | Keep | Missing usage/metrics never become zero or pass |
| Pairwise preferences | Keep and improve | Immutable assignment, blinding, tie/abstain, reveal after decision |
| Ticket/work-item snapshots | Move to input integration | Generic typed inputs remain core; issue resolution is optional |
| Tickets/Kanban/provider sync | Defer | Unrelated to proving the agent workflow workbench |
| Publication providers | Defer | Local exact-tree development precedes external delivery |
| OTLP export | Move to observer integration | Export failure must not affect orchestration |
| Old IR/persistence compatibility | Remove | Rewrite explicitly has no compatibility obligation |

## Concrete pressure points

1. `packages/executors/src/run-coordinator.ts` is 1,963 lines at the reference
   revision. It combines dispatch, event commits, clocks, context, retries, sessions,
   approvals, timers, external events, branch workspaces and recovery. Size is evidence
   of concentration, not proof every function is poor. V2 keeps one coordinator owner
   but splits effect families and pure decisions into focused modules.
2. `packages/domain/src/types.ts` is 907 lines and includes IR, runtime, Git/delivery,
   subagents and operational details. Plain records are good; a global optional-field
   model is not a reason to bind every workflow to Git or built-in providers.
3. `packages/executors/src/ports.ts` places ticket-provider, command, harness, workspace
   and observation contracts together. A port is justified by a dependency boundary,
   not by proximity to one coordinator.
4. `sqlite-event-store.ts` calls `reduceRun` when loading and appending, and
   `replaceProjections` deletes/recreates invocation/attempt/artifact/approval rows.
   This prioritizes correctness but makes work grow with history size. V2 retains
   replay verification while normal reads use indexed current projections.
5. `packages/web/src/App.tsx` is 3,414 lines. Routing, ticket UI, graphs, timeline,
   inspectors, controls and comparisons share a file. `graphDepths`/`flowchartNodes`
   use BFS/fixed spacing and mostly latest-definition status. This cannot faithfully
   display simultaneous invocations of the same definition or nested scopes.
6. `RunTimeline` has five ticks, a 720px time track, and one-second browser clock
   updates. `timeline.ts` falls back to activation slots when timing is incomplete.
   Durable spans are right; fixed axis and fallback are compatibility-era choices.
7. V1's SSE response is a finite replay of currently available events with a reconnect
   interval, rather than a continuously tailed stream. The client refetches aggregates
   and polls activity every 750ms. V2 makes the snapshot/cursor protocol explicit and
   updates one entity store from committed projection frames.
8. `adw/src/composition.ts` namespaces and flattens calls/templates into generated
   gateways/branch-return nodes. It already supports bounded calls/maps/parallelism
   but restricts some branch contents. V2 preserves source hierarchy and eliminates
   implicit child I/O and compiler-generated presentation reconstruction.
9. Context source selection is latest-prior structured output, and collection lookup
   similarly searches prior node invocations. Typed causal bindings avoid ambiguity
   when scopes/branches/iterations repeat. V1's refusal to share ambient transcripts
   remains valuable.
10. Evaluation is primarily post-hoc reports over terminal runs, with four built-in
    expectation types. Checksums and append-only human evidence are solid foundations;
    experiment launch/matrix/variant/repetition lifecycle is the missing workbench layer.

## V1 behaviors that must not get lost

The feature workflow preserves implementation context through bounded validation and
review returns. A graph loop does not mean “forget everything and start another agent.”
In v2 it means another invocation, deliberately continued session, frozen new feedback,
and explicit handoff if continuity is unavailable.

Approval diffs must include authorized untracked/new files and belong to the exact
invocation and prepared tree. A generic latest diff is not enough. Worktree changes
after approval invalidate the operation; publication/local delivery must not recapture
different bytes under the previous authorization.

Pausing admission, interrupting an attempt, detaching a client and cancelling a run
are distinct operations. Durable steering is recorded before delivery and can fail
delivery independently. Preserve these operator semantics across web and CLI.

The OS-enforcement work distinguishes harness availability from safe terminal
availability and fails closed when required containment is absent. Simplifying v2
must not collapse this into a prompt telling agents to behave.

Agent QA/review output is a claim or structured judgment. Commands, schemas, trees
and test evidence remain independent facts. V1's feature fixture uses formatting in
a validation command; v2 must correctly grant write permission for formatting and
must not assume all tests are replay-safe.

## Documentation versus implementation

`TODO.md` marks subworkflows and parallel branches as deferred, but ADR-0042 and the
compiler/runtime/integration tests implement composition, bounded collections, parallel
workspaces, durable timers and targeted events. `docs/runtime-model.md` also retains
M1-era sequential explanations alongside later additions. Thus the TODO is a historical
planning artifact, not an authoritative capability list. V2 milestone completion should
link exact evidence and update one status source rather than maintain duplicated claims.

## Regression inventory for v2

Adapt the behavior, not source imports or persisted snapshots:

- `tests/simulations/{deterministic-replay,compiler-validation,transition-selection,invocation-vs-attempt,bounded-loop,recovery-decision,malformed-history,workflow-composition}.test.ts`.
- `tests/integration/{sqlite-event-store,parallel-concurrency,worktree-sandbox-provider,harness-independent-agent,agent-steering-api,subagent-execution,feature-development-vertical-slice}.test.ts`.
- `tests/contracts/{run-store,evaluation-store}.contract.ts`.
- `tests/unit/{web-timeline,web-run-comparison,harness-structured-output,attempt-usage,web-execution-controls}.test.ts`.
- `tests/integration/{evaluations,api-web-mvp,workflow-events-api}.test.ts`.

Use ADRs 0001–0009 for deterministic identity/recovery/limits; 0010–0015 for boundaries,
controls and context-preserving authoring; 0027–0032 for exact-tree delivery/native
harness/tool enforcement; 0035–0042 for live observations, usage, context, evaluations,
timestamps and composition. Their compatibility constraints are deliberately not v2
constraints.
