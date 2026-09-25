# Normative protocol and data contracts

This supplements [plan.md](../../plan.md). These are proposed serialized contracts
and algorithms, not implementation code. Names can change during initial scaffolding;
identity, lifecycle and authority semantics must not change silently.

## A. Plain ports, bindings and control tokens

Use a single explicit JSON Schema dialect (2020-12 initially) and a pinned validator.
Bundle stores every referenced schema by checksum; no remote `$ref` fetch during a
run. Schema IDs/versions are labels; digest determines exact identity. The authoring
helper can accept a schema-library adapter but compiler output is plain JSON.

```text
Port {
  name, schemaDigest, required, defaultValue?, outcomes?: string[]
}
Binding {
  targetPort,
  source: { kind: input | producer | branch | carry | feedback | literal,
            sourceId?, port?, branchId?, value? },
  path?: string[], missing: error | omit | default
}
ControlEdge {
  id, sourceNodeId, outcome, targetNodeId, guard?, default?,
  counterIncrement?, feedbackBindings?, kind: sequential | fork | return
}
ControlToken {
  id, scopeId, sourceInvocationId?, edgeId,
  groupId?, branchId?, iteration?, bindingEnvironment, consumedBy?
}
```

No arbitrary transform callback. Initial bindings support identity, bounded JSON path
selection, literals and explicit record/array assembly. Nontrivial transformation is
an explicit deterministic operation with versioned code. Compile-time compatibility
uses equal schema digests or the validator's deliberately supported structural subset;
otherwise require an explicit conversion/output schema and runtime validation. Do not
claim general JSON Schema implication can be decided by a quick assignability check.
Any selected path is validated against the receiving port before effect admission.

Control-token creation is part of a selected-transition transaction. A sequential edge
consumes one eligible token and creates one invocation with frozen input bindings and
scope-local activation ordinal. Unique key `(scopeId, tokenId, targetNodeId)` prevents
duplicate activation after restart. Explicit fan-out creates one token per declared
branch and freezes the group's expected membership. Join consumes group-terminal
records once via `(groupId, joinNodeId)`, not unrelated incoming tokens. Non-selected
sequential edges create no invocation; a conditional branch inside a declared group
records its not-taken terminal outcome so the join can finish.

Unnamed edge IDs derive from canonical edge contents (source/outcome/target/guard/
increment/bindings), not only source/outcome/target. Exact duplicate edges are rejected;
authors can supply stable explicit IDs. Priorities are finite signed integer fields
on run admission and node definitions, default zero; lower values are admitted first.

Counter increments and successor invocation/token creation commit together. A bounded
counter cannot be reset in its lifetime. Loop helper scopes may create a fresh local
counter in a fresh outer iteration; the outer iteration itself is bounded. Each child
call attempt owns exactly one child scope identified by parent invocation + attempt;
call retry creates a new scope and cannot accidentally reuse a late child return.
Parent call output is validated and published once at the matching scope completion.

Compiler emits a bound summary for nodes/branches/maps/loops/calls and declared attempts.
Use conservative multiplication/addition with saturation at configured global caps;
do not enumerate every path. Every accepted cycle consumes a bound and every dynamic
template has a finite expansion maximum. Track separate finite limits for scopes,
invocations, attempts, turns, messages and concurrent effects. Summaries aid preflight;
atomic runtime counters are authoritative even when a conservative static maximum is
larger than the global allowed execution. Reaching the global cap is a declared limit
outcome, not permission to increase it. Negative/overflow/infinite bounds are rejected.

## B. Coordinator ownership, admissions and effect dispatch

Single-host ownership uses an exclusive OS-backed data-directory lock held for the
coordinator process lifetime. The host increments a durable owner epoch after acquiring
that lock. Database rows record owner epoch, process identity (including boot/start
identity), heartbeat and claims. Heartbeat expiry alone never authorizes takeover while
the OS lock is held. A second host/CLI attaches to the existing service or fails with
an actionable owner error. SQLite's one-writer limit is not sufficient dispatch locking.

Startup after ownership change fences old callbacks via epoch checks, inspects unresolved
effects and surviving provider/process handles, and records recovery observations before
releasing resource claims. A database fence cannot stop an old remote effect; unknown
external execution still requires adapter verification or human reconciliation.

Admission protocol:

1. Decide from revision R and durable resource state. Assign effect/attempt IDs outside
   the pure function. Stable operation key is `(run, invocation, attempt, operation)`.
2. One transaction compares expected run/resource revision and owner epoch; checks
   policy and limits; appends `attempt.reserved`, `resource.acquired`, and any budget
   reservation facts; updates projections; inserts the outbox effect request and receipt.
3. Dispatch claim transaction checks owner epoch and state, writes `effect.dispatch_claimed`
   and starting state before external dispatch. Duplicate claim keys return prior receipt.
4. Adapter starts the effect; process/session identity becomes a durable observation as
   soon as available. Effects stream bounded observations through the coordinator sink.
5. Terminal transaction validates epoch/attempt/effect, publishes already-durable artifact
   references, completes attempt/invocation as appropriate, releases resources and settles
   budget reservations. All dependent transitions see only committed completion.

Admission/claim/resource events can be transaction-batched; they are not a distributed
queue protocol. Outbox and claim rows are indexed projections of these facts. Provider
idempotency keys are used where available but do not establish general exactly-once.
Consumer callbacks from old epochs are quarantined as observations and reconciled;
they cannot directly update a terminal attempt. Local resource acquisition order is
canonical, and all-or-none acquisition prevents lock-order deadlocks.

## C. Recovery matrix and control races

| Durable / verified condition | Action |
| --- | --- |
| Reserved, never claimed | Dispatch the existing reserved attempt once |
| Claimed, start not confirmed | Mark unknown; inspect adapter operation key/process/session before further action |
| Known running, reattach supported | Reattach same attempt; journal link and ownership change |
| Interrupted and native resume valid | New attempt in same invocation, same permitted session reference |
| External success verified after missing completion | Commit verified outcome/artifacts if sufficient; otherwise reconcile missing output |
| Retry-safe operation, old effect proven stopped | New bounded attempt; never overlap the old effect |
| Verify-then-replay | Verification intent → verified-success completion, verified-not-applied retry, or unknown reconciliation |
| Manual reconciliation | No automatic execution; operator records evidence and accepts/rejects an admissible resolution |
| Never automatically retry | Halt automatic retry; changing this policy requires an explicit new run/config decision |
| No required resume token | Handoff only if snapshotted policy permits; otherwise reconciliation |
| Cancellation requested without acknowledgement | Cancelling/unknown; retain claims; no safe checkpoint or cleanup |
| Completion arrives after terminal cancellation | Record late evidence; no outgoing control transition |

Recovery class is attached to each effect descriptor. “Retry-safe” does not mean an
agent/testing label; author and adapter must justify the actual operation. Verification
itself has read-only/effect policy and a bounded deadline. If verification cannot prove
the effect's state, do not interpret its failure as proof the effect never happened.

For deadline versus completion, the first valid committed decisive fact wins. A recorded
deadline observation prevents a later completion from turning timed-out work into
success; that later result remains inspectable evidence. Approval/reject/skip races
similarly use subject revision + binding + idempotency. Journal sequence establishes
the result; provider timestamps do not reorder it.

Reconciliation commands are typed (`recordVerifiedSuccess`, `recordNotApplied`,
`abandonEffect`) with actor, reason, evidence and expected effect revision. They cannot
fabricate missing required typed outputs or release a live workspace writer. If an
operator deliberately accepts unresolved external consequences, record that explicitly
and do not mark a checkpoint safe. Cancelled runs may retain reconciliation tasks.

## D. Harness turn lifecycle and enforcement

```text
HarnessDescriptor { id, adapterVersion, nativeConfigSchema, capabilities }
StartRequest {
  attemptId, operationKey, role, workspaceRef?, resolvedConfig,
  effectivePolicy, contextManifestRef, toolGatewayGrant?, outputSchemaDigest?
}
TurnHandle {
  observations: AsyncIterable<Observation>,
  cancel(reason), resume?(), reattach?(), steer?(), close()
}
SessionReference {
  harness, adapterVersion, opaqueSecretRef, modelIdentity?,
  workspaceIdentity?, continuationKey, permissionDigest, contextLineageRef
}
```

Concrete implementation may place resume/reattach on the harness factory instead of
the live handle (reattachment after a host restart necessarily uses the factory).
Their semantics are fixed: start allocates a new provider context; resume advances a
known interrupted context as a new try; reattach observes a still-running try. `close`
disposes observation resources and does not silently imply cancellation.

Exactly one terminal adapter observation per turn is accepted. Stream exhaustion or
transport disconnect without terminal evidence means unknown, not success. Duplicate
native observations are deduplicated when IDs exist; otherwise provider telemetry is
labeled best effort. Session references are persisted immediately through an encrypted/
restricted secret store reference; no raw resume credentials in public events. Host
session claims bind epoch and active attempt; release requires terminal/verified stopped.

Bound observation queues by bytes/count. Backpressure capable adapters await the sink;
others spool bounded chunks to disk or drop explicitly ephemeral progress with a dropped
count. Never drop terminal/control/artifact facts silently. Child provider processes
are owned by the adapter with tracked process-group identity and termination grace;
server-hosted native sessions use their native status/cancel reconciliation instead.

Persist `enforcementMode: enforced | trusted-unrestricted` per run/attempt. A command
node may explicitly request `terminal.execute` in its node capabilities; that workflow
author grant runs the command outside OS containment, matching v1 command-node
semantics. Legacy `executionMode: trusted-unrestricted` still requires affirmative
launch opt-in. Unrestricted execution is visible in command evidence and cannot satisfy
a request marked enforcement-required. M1's real command uses the enforced process
adapter by default; absent support blocks that demo. No implicit downgrade in fallback
resolution.

Distinguish network authority:

- Agent tool/process egress: OS/native sandbox enforcement for declared destinations.
- Provider API traffic: adapter infrastructure permission needed to reach selected
  provider, not a grant for agent terminal access to arbitrary Internet destinations.
- Git remote operations: workspace/publish capability with explicit remote allowlist.
- Kouro browser/API and tool-gateway traffic: authenticated runtime-control transport,
  not generic agent network authority. Per-attempt gateway grant only exposes allowed
  tool methods, never runtime admin routes.

The profile snapshot records enforcement for each boundary. A stronger-looking capability
name cannot compensate for a weaker adapter. First real harness work stays blocked on
required enforcement until a supported native/OS path is available or the user explicitly
chooses unrestricted operation.

## E. Mailbox activation and gateway protocol

Coordinator creates per-attempt gateway credentials on admission, stored outside
agent-readable runtime metadata; adapter exposes only the specific scoped grant needed
for its tool integration. Expiry is min(attempt deadline, run deadline); terminal attempt,
revocation, owner-epoch reconciliation or permission change revokes it. Credential
subject is immutable and is never accepted from the model's message body.

Send transaction: authenticate grant → validate current attempt/scope → authorize
recipient/channel and attachments/replyTo within readable scope → check byte/rate/
message budget → deduplicate `(attemptId, toolCallId)` → append message + usage facts
+ routing/mailbox row → return durable message ID. Same key with different content
is an idempotency conflict. ReplyTo cannot reveal a message the sender cannot read.

Receiving uses a declared wait/respond template with a finite max-turns value:

1. A receive node records `mailbox.waiting` with participant, allowed sources, cursor,
   batch limits and idle deadline. It occupies no agent execution slot.
2. An eligible queued message or deadline produces a durable decision. First committed
   batch selection or timeout wins for that wait revision. Later messages target a
   later wait or remain queued; they do not undo a timeout.
3. Admission transaction freezes `delivery.batch_created`, consumes the wait token,
   reserves a turn/invocation budget and records `turn.admitted` + `invocation.created`.
4. The ordinary agent attempt receives that immutable batch as an input/context source.
   Retry of the attempt does not reserve another workflow turn; new respond invocation
   does. No message can create an undeclared receive/respond edge.

Delivery states reflect included context and provider acceptance only. A provider
transport failure may leave delivery uncertain. Native reattachment and new-session
handoff determine whether the same batch is resent, with recorded deduplication and
uncertainty rather than false exactly-once context delivery. Quotas reserve atomically
across participants. Idle timeout bounds the all-waiting/no-message state.

## F. Workspace, checkpoint and fork materialization

Workspace allocation identity is `(repositoryId, runId, workspaceId)`, with canonical
validated paths and pinned starting commit/tree. Common Git-directory metadata changes
are serialized across all worktrees. Durable workspace claims refer to owner epoch and
effect/process identity; OS lock/verified process termination protects actual mutation.
Interrupted creation inspects registered Git worktrees and expected identities before
reusing or completing creation. Never reuse an arbitrary directory at the desired path.

Branch result artifact contains base tree, result tree, patch/blob digest, changed-path
summary (including modes/binary status) and branch invocation provenance. Explicit
integration pins parent tree, branch ordering and integration strategy; produces a new
tree artifact or typed conflict with conflict evidence. It does not mark semantic
validation successful. Controlled commit fixes author/committer identity, timestamp,
message, parent and tree before dispatch; compare-and-swap ref update verifies expected
old ref. After interruption, verify exact object/ref instead of creating another commit.

Forkable checkpoint predicate: admission paused; no starting/running/unknown effect;
no claimed unresolved outbox request; no effect/resource writer or live session lease;
all included artifacts durably published; no unresolved effect reconciliation. Reserved
but undispatched effects must be converted into an explicitly recorded unstarted frontier
with reservations released before capture. Ready workflow invocations may remain pending.
An ineligible checkpoint request returns reasons; a diagnostic snapshot is inspectable
but never mislabeled forkable. Capture and cleanup serialize against workspace/retention
claims so GC cannot delete a tree while materialization starts.

Fork algorithm:

1. Validate checkpoint digest, retained blob/tree closure, compatibility of chosen
   unexecuted configuration changes, and fork authority. Record idempotent fork request.
2. Allocate child run/spec and new root/scope identities. Record parent run/checkpoint/
   revision and explicit effective budgets. Child remains preparing, not runnable.
3. Create new workspace at retained tree and verify it. Keep immutable artifact content
   references but create child provenance/import records with source run/attempt IDs.
4. Map completed source invocations to new **inherited** child execution records; map
   pending frontier to new invocation IDs/ordinals and rewrite bindings through that
   map. Do not copy historical event envelopes into the child journal.
5. Recreate checkpoint counters and declared loop/call frontier. Reject unresolved failed
   effects. Pending approvals are re-requested with fresh bindings; no prior approval
   decision, active session, delivery batch or pending mailbox is imported as authority.
   Selected old messages may be imported only as attributed context artifacts.
6. Commit `fork.materialized` with mapping certificate and workspace/artifact references;
   then normal admission may start. Crash resumes the same allocation by request key.

Initial supported forks keep the same structural workflow and completed-prefix contract.
Prompt/profile overrides apply only to still-unexecuted dependent work. A raw-graph loop
frontier whose change invalidates prior iterations needs an earlier checkpoint or fresh
run; do not build an ad hoc invalidation engine. Parent retention roots keep inherited
evidence readable after child creation. No live writable paths are inherited.

## G. Execution projections, graph identity and timing contracts

```text
RunView {
  projectionVersion, runId, revision, eventCursor, serverClock,
  entities: { scopes, invocations, attempts, spans, groups, artifacts, controls }
}
ProjectionFrame {
  projectionVersion, runId, baseRevision, revision, eventCursor, serverClock?,
  upserts, removals
}
```

`revision` and `eventCursor` both equal the last applied **run journal sequence**;
they are not independent counters. Separate naming makes transport meaning clear.
Transactions can cover a sequence range in one frame; baseRevision is the preceding
committed revision. Even a no-entity-change frame advances the cursor. Clients apply
whole frames atomically; gap/version mismatch causes snapshot reset. Cross-run list
notifications have their own host cursor and never substitute for run revisions.

```text
SpanView {
  spanId, parentSpanId?, runId, scopeId, definitionId?, invocationId?, attemptId?,
  kind: run | scope | invocation | attempt | queue | approval | backoff | tool,
  startUtc?, endUtc?, elapsedMs?, state,
  timingSource: host | provider | inherited | unknown,
  precision: observed | estimated | unavailable, clockSegmentId?
}
ClockSample {
  sampleId, serverUtcMs, processEpoch, monotonicMs, sentAtUtcMs
}
```

Monotonic values are compared only within the same process epoch. HTTP midpoint/RTT
anchors client display time; one-way SSE samples refresh health but cannot alone prove
network delay. Initial staleness threshold is max(3 heartbeats, 15 seconds), configurable
and visible. Disconnected active spans freeze at last extrapolated point with a stale
marker; reconnection reanchors. Completed durable spans can correct a prior estimate.
Invocation elapsed includes wait/retries; active attempt time sums attempt segments;
queue span ends at first admission; approval/backoff are separate intervals. Unknown
intervals are not silently counted as active model execution. Overlap is never summed
as total run wall duration.

Graph definition node key is `(definitionId, sourceNodeId)`; visible instance key adds
scopeId. Control edge identity comes from compiled edge ID plus rendered scope. Runtime
transition highlights reference source invocation+edge+target invocation. Collapse
replaces a scope's visible descendants with its parent call tile; source edges are
projected through declared boundary ports. Loops keep stable layout/back-edge routing
while traversal counts/selected invocations change. The timeline uses actual scope and
invocation IDs, not graph coordinates. A selected collapsed descendant is retained and
can be revealed; it is never silently replaced by the latest invocation.

Additional query routes supporting the information architecture:

```text
GET /api/workflows/:digest/source|graph|validation
GET /api/workflows/:id/versions
GET /api/runs/:id/state?atRevision=
GET /api/runs/:id/artifacts
GET /api/runs/:id/messages?after=&participant=&channel=
GET /api/runs/:id/attempts/:aid/activity?after=
GET /api/runs/:id/attempts/:aid/logs?offset=&limit=
GET /api/runs/:id/attempts/:aid/context
GET /api/artifacts/:id/content    authorized ranges and safe media handling
```

Pipe notation above lists alternative routes, not a literal URL character. Historic
state may replay the retained journal on demand; normal live state reads projections.
All paginated resources return stable cursors. Large artifact bytes are separate from
projection frames, with immutability/cache headers and permission checks.

## H. Experiment and comparison records

Run specification includes `{experimentId, cellKey, variantId, caseId, repetition}`
at creation, plus immutable dataset/case/workflow/profile/prompt/config/evaluator/environment
digests. Candidate versus judge/verifier relationships are explicit fields. Cell
execution state is queued/reserved/running/succeeded/failed/cancelled; evaluation state
is pending/running/complete/error. Evidence can be unavailable without pretending the
candidate itself failed to execute. Cell identity is unique across restart.

Pairwise assignment stores server-owned randomized A/B→run mapping, frozen evidence
revision, rubric, eligible actor, createdAt and reveal state. Blinded DTO uses opaque
assignment-relative asset/side IDs, not variant-bearing run IDs. The server rejects
pre-decision identity queries through that comparison surface. Since the local owner
can inspect underlying runs/database, this is experimental blinding, not an adversarial
secrecy guarantee. Artifacts that cannot be safely redacted display known leakage risk.

Comparison alignment: same bundle uses definition/call path plus branch/iteration and
activation ordinal. Different bundles use explicit common source IDs only where kinds,
scope structure and port contracts agree; otherwise display unaligned rows or saved
manual mapping. Absolute run start or a chosen invocation anchor supplies timeline zero.
Do not stretch time to force stages to match. Persist mapping/anchor selection with the
comparison, separate from underlying run state. Missing stages appear as missing rather
than zero-duration work. All normal timeline mechanics use the same renderer.
