# V1 capability recovery for Kouro v2

Status: plan only. This document adapts the useful v1 workflow experience to the
current v2 contracts; it is not a request to restore v1's package or service
topology.

Implementation handoff: implement Phases A–D in order and record evidence at each
gate. Existing code is the baseline, not evidence that a gate already passes.
Do not add a second scheduler or silently substitute fixed pre-planning scouts
for planner-triggered delegation.

## Objective

Make a workflow a reusable task executor again. An operator supplies a task or
work-item reference at admission, the workflow declares typed inputs, planner
agents can delegate bounded repository/test scouts, and later agents receive the
durable evidence and decisions that belong to their scope.

The v2 implementation remains authoritative for journal facts, coordinator
ownership, workspace claims, harness selection, approvals, recovery, and
capability enforcement.

## What to recover

### 1. Durable task/work-item admission

Add a first-class run input contract:

```ts
type WorkItemInput = {
  version: 1;
  task: string;
  ticket?: { reference: string; snapshot: ResolvedTicketSnapshot };
  title?: string;
  description?: string;
  source?: string;
};
```

This is the normalized contract, not the raw admission request. Phase A accepts
nonblank task text; ticket-only requests fail with a clear unsupported-resolution
error until the optional resolver exists. A future resolver must produce nonblank
task text and a versioned immutable snapshot containing provider identity, external
ID, captured title/body, and revision or capture time. Never re-fetch a ticket
during replay. `ResolvedTicketSnapshot` is a proposed contract to define with that
adapter, not an existing SDK type. Do not make provider sync a prerequisite for
local task execution.

Persist the normalized object as `input.workItem` and the same task string as
`input.task`, retaining the existing starter `Task` string schema. Task-aware
starters declare both ports when they need source metadata. Reject conflicting
task values; preserve other declared workflow inputs. Keep work-item normalization
in the host/starter integration: generic core workflows need not accept a task.
Version the schema and include normalized input in the admission request digest
and checkpoint configuration digest. Host-owned configuration fields must not be
overridden by caller input.

Admission surfaces:

- Web run form: task text, optional ticket/reference, repository/workspace.
- CLI: `kouro run WORKFLOW --task ...` and later `--ticket ...`.
- HTTP API: typed `input` with schema validation and idempotency.
- Checkpoint/fork: preserve the immutable work-item input unless an explicit
  variant changes it.

Validate all declared root inputs before allocating a workspace, reserving an
effect, or scheduling execution. Invalid admission creates no executable run or
workspace. A repeated idempotency key with the same normalized request returns
the original run; a different input, bundle, profile, or requested workspace is a
conflict. A task-changing fork must invalidate dependent artifacts and approvals
and restart from a valid boundary; reject it when dependency invalidation cannot
be established. Never carry completed evidence for the old task into the new one.

### 2. Typed workflow inputs

Keep the v2 `WorkflowBuilder.input()` contract and require task-aware starters
to declare their root input:

```ts
const task = workflow.input("task", Task);
const plan = workflow.agent("plan", {
  prompt: planPrompt,
  input: { task },
  produces: Plan,
});
```

The host resolves root inputs before effects, validates them against the compiled
schema, records them in context evidence, and rejects missing or invalid inputs
before agent execution. Prompt text remains project-owned; the host does not
silently interpolate arbitrary strings into prompts.

### 3. Bounded scout delegation

Recover the useful v1 `subagent`/`.uses()` behavior as a v2 authoring surface,
implemented on top of v2 child definitions, invocation ownership, and context
bindings rather than a second runtime.

The following is a static child-call baseline using the current builder API.
`workflow`, `task`, `Task`, `ScoutReport`, and prompt strings are supplied by the
enclosing starter. It is not the final planner delegation API:

```ts
const scoutWorkflow = new WorkflowBuilder({ id: "repositoryScout" });
const scoutTask = scoutWorkflow.input("task", Task);
const scoutReport = scoutWorkflow.agent("inspect", {
  prompt: scoutPrompt,
  input: { task: scoutTask },
  produces: ScoutReport,
});
const scoutDone = scoutWorkflow.complete("done", { output: scoutReport.output });
scoutWorkflow.startAt(scoutReport);
scoutReport.on("success").to(scoutDone);
scoutWorkflow.output(scoutReport.output);

const repositoryScout = workflow.call("repositoryScout", scoutWorkflow, {
  input: { task },
});

const plan = workflow.agent("plan", {
  prompt: planPrompt,
  input: {
    task,
    repositoryScout: repositoryScout.output,
  },
});
const done = workflow.complete("done");
workflow.startAt(repositoryScout);
repositoryScout.on("success").to(plan);
plan.on("success").to(done);
```

The final API shape may use `workflow.subagent()` as authoring sugar, but it must
compile into ordinary v2 child definitions, typed ports, durable invocation
lineage, bounded budgets, and normal harness selection. Scouts must not receive
implicit authority or bypass workspace/tool capability checks.

Phase B must implement planner-triggered delegation: the planner may request
either declared scout with a typed question, consume its result, and request a
bounded follow-up before producing the plan. Static pre-planning calls alone do
not satisfy this requirement. Reuse the authenticated collaboration/tool routing
where applicable, with all child execution owned by the ordinary coordinator.

Define and test the following contract before adding authoring sugar:

- A request names an allowlisted child definition and carries typed inputs, a
  stable request ID, and the authenticated parent invocation/attempt identity.
  The child receives only declared inputs and a pinned read-only repository view.
- Persist request acceptance, budget consumption, child invocation lineage, and
  result/error attribution. Duplicate requests return the same child/result and
  cannot consume another budget or reserve a second effect.
- Default feature limits: at most two invocations per scout and two concurrent
  scouts per planner invocation. These counters survive retry/restart; graph
  returns cannot reset a budget intended to span the planning stage. Declare a
  finite planning-stage total, timeout, and output/context byte limit as well.
- Results are schema-validated artifacts bound to the requesting planner. Record
  the result delivery/context manifest before consumption; do not expose sibling
  private context. Distinguish child completion from result delivery.
- Define cancellation propagation, timeout, missing/invalid output, and unavailable
  harness outcomes. Required failed scouts prevent approval; optional scouts must
  be explicitly declared and their absence recorded. Never fabricate a report.
- Restart reconciles uncertain provider effects using existing recovery policies;
  it must not promise exactly-once provider execution when outcome is unknown.
  Mark uncertainty for recovery rather than blindly dispatching another scout.

No new `call(..., { limits })` option exists today. If added, specify its scope and
compiler lowering; concurrency uses existing scope/resource scheduling wherever
possible. Convert the baseline and final authoring examples into compiler fixtures.

Initial built-in scouts:

- `repositoryScout`: read-only repository structure, ownership, relevant files,
  invariants, and risks.
- `testScout`: read-only test/build commands and existing regression coverage.

Their outputs are structured artifacts. The planner receives them explicitly;
the implementer and reviewer receive only the declared plan/scout artifacts and
the task input.

### 4. Feature workflow recovery

Provide a current-style feature starter with this durable path:

```text
task/work-item
  -> planner <-> repository scout + test scout (requested, bounded, parallel)
  -> approval
  -> implementer
  -> validation commands
  -> bounded repair loop
  -> reviewer
  -> prepare exact delivery tree -> delivery approval -> local commit effect
  -> complete / failed
```

Use v2 nodes, approvals, counters, command evidence, workspace claims, and
checkpoint/recovery semantics. Do not reintroduce v1's separate executor,
ticket store, or provider-specific workflow runtime.

Repair contract:

- Validation failure and reviewer change requests return to the implementer with
  frozen structured feedback, exact command/review evidence, task, approved plan,
  declared scout reports, and current workspace identity. Re-run validation and
  review after repairs; a reviewer judgment cannot replace command evidence.
- Use one finite shared repair budget for validation and reviewer returns (default
  three repairs per implementation stage). Document how explicit counters lower
  it; separate `.repair()` edges currently create separate budgets. Exhaustion
  reaches `failed` with the final evidence and does not reopen approval forever.
- Each repair is a new invocation. Continue a provider session only with a
  compatible continuation key and workspace/permission envelope; otherwise supply
  an attributed fresh-session handoff. Test both paths and preserve feedback
  across restart. Retry of an attempt retains its frozen inputs.
- Validation commands come from project-owned configuration, have timeouts and
  explicit permissions, and retain exit status/output. Formatting needs write
  authority. Declare replay safety per command; tests are not assumed replay-safe.

Delivery contract:

- Initial delivery means a local commit in the run's managed workspace. Remote
  push/PR publication and merging into the operator's branch remain out of scope.
- Prepare a durable action artifact identifying repository/workspace, invocation,
  base and exact tree digest, authorized new/untracked files, validation and review
  evidence, and commit message. Reject changes after validation/review or rerun
  those stages against the new tree before preparing the action.
- Use an ordinary approval bound to that artifact and eligible actor. The commit
  effect verifies the approved tree immediately before mutation and uses a durable
  operation key for reconciliation. A stale approval cannot authorize new bytes.
- Rejection terminates without delivery. Crash before/after commit reconciles the
  same operation and commit identity; success requires retained commit evidence.
  No generic approval-to-complete shortcut satisfies delivery acceptance.

### 5. Harness and capability fidelity

Each agent keeps v2 per-agent harness/model selection (the current builder accepts
`harness` and `modelId`; preserve the compiled/runtime harness identity). A scout can use a
read-only Codex, Pi, or other declared harness, while the implementer requires
the workspace-write capability. Availability and capability failures remain
visible and durable; no silent scripted fallback is allowed for a requested
native agent.

The scripted harness remains a deterministic fixture for tests and UI exploration,
not evidence that a real provider performed the task.

### 6. Operator experience

Restore the useful v1 operator flow in the current v2 workbench:

- task/work-item entry before admission;
- repository/workspace selection where the workflow requires it;
- visible scout, planner, approval, implement, validation, review, and delivery
  stages in the graph/timeline;
- context/evidence panels showing which task and scout artifacts each agent saw;
- clear retry/repair/recovery boundaries;
- task and source snapshot visible in run history.

Ticket boards/provider sync are a later adapter. A ticket reference may be
accepted as an immutable external identifier only when its snapshot/resolution
contract is implemented; it must not be recreated as an unbounded v1 service
surface.

## Delivery phases

### Phase A — contract and admission

1. Define `WorkItemInput` and run-input schema/version.
2. Validate and persist task/work-item input at admission.
3. Add CLI and web task entry.
4. Add compiler/runtime tests for required, optional, invalid, and forked inputs.

Also test normalized idempotency equality/conflicts, reserved-field rejection,
unsupported ticket-only admission, and invalid input before workspace allocation.

Gate: a task is present in the durable run input and in the agent context
manifest before any provider effect is reserved; invalid root inputs cannot cause
workspace allocation. Generic workflows without task ports still work.

### Phase B — delegation kernel

1. Implement the durable planner request/result contract over ordinary child
   invocations, then add bounded child/scout authoring sugar and typed ports.
2. Persist parent/child invocation lineage and source attribution.
3. Enforce scout budgets, read-only capability, timeouts, and cancellation.
4. Add restart, duplicate, missing-output, and provider-unavailable tests.

Gate: a planner can consume a repository scout result after coordinator restart,
with no duplicate dispatch caused by request replay or untracked context. Demonstrate
a planner-requested follow-up and limit rejection; uncertain provider outcomes
must remain explicitly recoverable.

### Phase C — feature starter and operator UI

1. Extend the existing task-aware feature starter with scout-aware prompts and
   source metadata; preserve CLI-bundled, project-editable prompts and schemas.
2. Add planner approval, implementer context, validation, repair, reviewer, and
   delivery review using current v2 nodes.
3. Show task/scout artifacts and stage ownership in the existing graph/timeline.
4. Keep scripted fixtures deterministic and label them as fixtures.

Gate: one real local task reaches approval and one scripted end-to-end fixture
reaches completion with durable evidence for every stage.

Browser acceptance must exercise task entry, scout request/result inspection,
plan approval/rejection, repair feedback, exact-tree delivery approval, and history.
The fixture must include real disposable-workspace command/commit effects with
scripted agent outputs, plus negative stale-approval and repair-exhaustion cases.

### Phase D — real provider and workspace acceptance

1. Run the feature workflow with a real Codex or Pi harness on Linux and macOS
   using the platform-native process adapter.
2. Verify repository read/write claims, validation commands, repair limits, and
   delivery review against a disposable repository.
3. Add operator recovery evidence for provider timeout, scout timeout, restart,
   and command failure.
4. Include one mixed-harness planner/scout or planner/implementer run. Record the
   exact harness/model versions and observed permission enforcement; harness
   availability alone does not prove read-only isolation or delegation support.

Gate: no claim of v1 parity until task delivery, delegation, workspace effects,
and recovery are all evidenced on the supported platforms.

## Explicitly not restored by this plan

- The v1 package graph or separate executor/runtime architecture.
- Implicit unrestricted subagent tools or provider authority.
- Ticket-provider synchronization as a hidden prerequisite for local runs.
- Unbounded loops, arbitrary historical rewind, or fabricated provider controls.
- Windows process isolation; it remains a separate platform adapter project.

## Completion evidence

The recovery is complete only when the repository contains:

1. versioned task/work-item contracts and admission validation;
2. typed task-aware starter bundles;
3. bounded scout delegation with durable lineage and context evidence;
4. web/CLI task entry and run history display;
5. focused compiler, coordinator, restart, provider, workspace, and browser tests;
6. a real provider-backed task run on each claimed supported platform.

## Implementation map and handoff checklist

- Core authoring/compiler/contracts: `packages/core/src/`; preserve owner-bound
  handles, typed child ports, explicit control flow, and finite scope limits.
- Admission/effects: `packages/host/src/coordinator/coordinator.ts`,
  `application/service.ts`, `storage/journal.ts`, `http/server.ts`, and `cli.ts`.
  Inspect existing input validation/idempotency before extending them; move root
  validation early enough to precede workspace effects.
- Delegation: existing coordinator, collaboration gateway, harness adapters, and
  context/handoff paths. Extend the shared lifecycle instead of introducing an
  adapter-owned durable scheduler.
- Recovery/delivery: checkpoint materializer and workspace Git adapter. Reuse
  prepared-commit support, adding approval/effect binding where missing.
- Starter: `packages/host/assets/templates/feature/`; the current starter already
  declares a string `Task`, but its validation command is a placeholder. Replace
  it with explicit project-configured checks. Update the existing workbench UI
  and bundled starter tests alongside the host contract.

For each phase, record changed contracts, focused test results, and remaining
unsupported boundaries. Run repository-required checks appropriate to the changes.
Keep provider/platform acceptance separate from deterministic fixtures. If a native
provider or platform is unavailable, finish independently testable implementation
and state the exact unverified gate; do not mark Phase D or recovery complete.
No package topology migration, publication, or external ticket synchronization is
authorized by this implementation plan.
