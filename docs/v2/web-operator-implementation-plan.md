# Web operator implementation plan

Status: historical implementation plan following the 2026-09-25 audit and user priorities. Current implementation and verification results, including native Codex browser acceptance, are tracked in the [2026-10-01 readiness audit](2026-10-01-web-readiness.md). The dated progress notes below describe their original completion pass.

## Implementation progress — 2026-09-25

Implementation status — 2026-09-25:

- **Phase 1, code complete:** delivery commit requires its reviewed action; preparation binds the reviewed tree and patch digest; stale run views do not authorize actions; the pinned run bundle supplies the graph; live capabilities refresh with frames; expired host sessions can re-pair from a tab-scoped token; API errors preserve server details; pairwise run/evidence identities share one randomized mapping. Transition/browser acceptance remains unrun in this completion pass.
- **Phase 2, implementation partial:** journal-backed history is cursor-paged; the session projection groups text and tools; the modal supports reconnect/history, steering idempotency, search, copy, bounded rendered rows/tool previews, basic safe Markdown, shareable session URLs, focus handling, auto-follow and a narrow-screen layout. Harness adapters normalize available Codex/Pi/Claude observations. Child-session navigation, measured large-history performance, comprehensive lifecycle reconciliation, and real live-provider acceptance remain open.
- **Phase 3, partial:** the approval inbox/count navigates to pending gates, and the existing exact-tree local delivery flow remains available. Request changes is intentionally unavailable at gates without a declared bounded repair route; the current feature workflow has no human reviewer-return route. Ticket management and remote push/PR publication remain deferred.
- **Phase 4, implementation partial:** the run/task header context, invocation retry, pageable event inspector, dataset-case inspector, saved view mode/panel widths, guarded browser storage, narrow-screen run picker and inspector drawer are implemented. Artifact access still relies on the existing browser/raw endpoint; a reusable file-by-file code/diff viewer, run-level usage totals, and task draft restoration are open.
- **Phase 5, host and UI implemented:** terminal/drained checks, retained-reference blockers, claimed-worktree cleanup, exclusive-blob deletion, durable progress/idempotency, retry discovery after restart, and a confirmation preview are implemented. Runtime regression coverage and injected filesystem/SQLite failure recovery have not been run.
- **Phase 6, implementation partial:** ordinary comparisons are explicit and pinned to selected revisions; evaluation resume reattaches to running cells and waits for actual terminal states; the workbench can create/select experiments, inspect dataset cases and load durable per-cell evidence. Creation currently starts with one scripted baseline variant; arbitrary multi-variant configuration and compatibility analysis remain limited. Tests for long runs, restart, pause and pinned comparison have not been run.

Current completion checks: `bun run typecheck`, `bun run lint`, `git diff --check`, and `bun run build:cli` pass; `bun dist/kouro.js --help` runs from the rebuilt bundle. The production bundle is rebuilt. No test or browser suite was run in this implementation pass. Live provider behavior is not verified and no provider was invoked for this pass.

## Scope decisions

- **Primary UX deliverable: proper live agent sessions**, usable while real agents work and after they finish or the browser reconnects.
- **Restore run deletion** as an operator feature with explicit ownership and retention handling.
- Improve the remaining run, review, inspection, comparison and navigation experiences described below.
- **Defer ticket management/integration and remote push/PR publication.** Task-based launch and local reviewed commits remain the complete delivery target for this plan. PR-specific metadata fields are deferred with publication.
- Preserve v2's graph, scopes, invocation/attempt identities, journal, workspace claims, approvals, checkpoints and declared capabilities. Recover useful v1 behavior through these contracts.

Source audit: [Code audit and web comparison](2026-09-25-code-and-web-audit.md). Finding numbers below refer to that report.

## Phase 1 — Make displayed state and operator actions trustworthy

**What:** Resolve findings 1–6 and 10 before building more controls on these paths.

**How:**

1. Require an approved delivery action for the public commit endpoint; validate run, workspace, exact tree and commit message at the effect boundary. Bind preparation to the reviewed tree or require review of the immutable prepared patch. Preserve idempotent recovery of an already completed commit.
2. Treat `{runId, revision}` as one command target. During a run change, clear the actionable view or show a non-actionable loading state until the matching snapshot arrives. Ignore obsolete fetch/stream responses. Source the active graph from the run's pinned bundle, including configured nodes and child definitions.
3. Separate host-supported operations from runtime eligibility; transmit or derive current eligibility consistently for snapshots and frames. Pause/resume must update without a reload.
4. Reset failed pairing promises, distinguish expired pairing from temporary disconnection, and expose structured server messages. Retain a mutation's idempotency key across a retry of the same intended action; a fresh user action gets a new key. Do not automatically replay a mutation with an unknown outcome until its result can be reconciled.
5. Shuffle complete run/evidence pairs for pairwise review. The displayed side, stored decision and eventual identity reveal must share one mapping.

**Main code:** `packages/web/src/app.tsx`, `types.ts`, `data/syncStore.ts`; host `http/server.ts`, `application/service.ts`, `coordinator/coordinator.ts`; core comparison contracts.

**Acceptance:**

- Switch A → B with slow/failed responses and equal revisions; no action shown for A can target B. Switch back during an outstanding request without stale content taking over.
- Running → paused → resumed works from one browser session, including a view initially loaded while pending.
- Direct HTTP commit without approval fails; changing the tree before preparation/approval/commit forces re-review. Repeating a successful commit returns its durable result.
- Failed initial connection and host restart have working recovery. Errors show useful server explanations and preserve unsent input.
- Both pairwise permutations reveal the run whose evidence was displayed.

## Phase 2 — Proper live and historical agent sessions

### What the operator should get

- Open a session from a graph node, timeline invocation, or inspector. Keep run, node, attempt, harness/model, and live/completed/disconnected state visible. Offer an expanded view with a shareable run/invocation/attempt URL.
- Read continuous assistant messages with Markdown, code blocks, copy controls and a plain-text/raw fallback. Streaming deltas update an existing message rather than producing hundreds of separate cards or rendering JSON wrappers as conversation.
- See each tool call as one stable card: name, readable input, pending/running/succeeded/failed status, duration when known, and expandable output/error. Group start/update/end by identity; concurrent tools stay separate.
- See delegated subagent work attributed to its parent, with expandable child session details and a return path. Parent and child output must not be concatenated into a misleading single reply.
- Follow the stream automatically while at the bottom. Scrolling up pauses follow; show a new-activity indicator and “Jump to latest”. Searching or reading an older message must not jump the viewport.
- Send steering from the active session, with pending/sent/rejected status. Preserve the draft on failure. Show supported invocation interruption/retry separately from whole-run cancellation.
- Reopen completed sessions and older attempts, reconnect, or refresh without silently losing earlier messages or duplicating text/tool results.
- Show only provider-exposed activity and supported summaries; do not invent reasoning or treat a generic “Thinking” status as a detailed transcript.

### How to build it

**A. Establish an explicit activity contract.** Extend the existing harness observation/journal path rather than introducing a second execution engine. Define a versioned discriminated event union with run, invocation, attempt, event identity, ordering cursor, timestamp, and applicable message/tool/parent identities. Represent text delta versus complete-message snapshot explicitly, along with tool start/update/result, operator steering acknowledgments, usage, and lifecycle/status observations.

Keep native IDs when available. Where providers omit IDs, assign stable attempt-local identities in the adapter and persist them; do not use React array indexes or a fresh timestamp as correlation identity. Final message snapshots must reconcile with earlier deltas rather than append them again. Document exactly what each adapter emits and which controls it supports.

**B. Make one deterministic session projection.** Add a focused session reducer and session UI components, extracted from `AgentSessionModal`, `OutputPanel` and related inspector logic. Use the same projection for live activity and historical replay. It should group messages, correlate tools, retain child lineage, deduplicate event identities, and handle partial/unknown observations without claiming completion. Unknown legacy payloads get a readable fallback. Add compatible normalization for existing persisted events; do not require deleting old run history.

**C. Make history durable and bounded in memory.** Today the coordinator caps its event array at 4,000 and the browser live buffer at 1,500; completion/reconnect must not silently turn those windows into the complete transcript. Reuse retained journal events and artifact storage to provide cursor-based session history plus a live tail. Verify historical retention first; where data is missing, show an explicit gap. Keep large tool results in bounded previews backed by artifacts, and keep browser state/rendered rows bounded with paging or virtualization. Any new artifact format needs versioning and restart recovery.

**D. Normalize each harness at the adapter boundary.** Inspect v1's transcript/activity code for behavior, then implement current v2 mappings in Codex, Pi, Claude and external CLI adapters as applicable. Ensure text, tool input/result, errors, usage and subagent attribution survive normalization and secret redaction. A provider that only returns final output must be labelled accordingly; it cannot pass the streaming acceptance gate. Do not gate steering solely on a hardcoded harness name: expose the actual active adapter's capability and invocation eligibility.

**E. Make steering a durable action.** Carry the idempotency key already required by HTTP through the service/coordinator. Bind it to the target invocation/attempt and frozen message. Record requested/applied/rejected outcomes, reconcile uncertain outcomes, and prevent duplicate delivery on browser retries. Clear the composer only after an accepted result, while preserving failed drafts. Frequent activity events should not make ordinary steering unusable: use a documented attempt/eligibility binding or an explicit stale-action recovery flow, without weakening approval tree/revision checks.

**F. Build accessible interaction.** Use an appropriate dialog/panel with focus entry, keyboard navigation, Escape/close, focus restoration and accessible labels. Announce meaningful state changes without reading every streaming token aloud. Tool result content and Markdown must not execute HTML/scripts; constrain outbound link schemes. Support a full-width session on narrow screens.

**Main code:** core `harness.ts` and applicable event contracts; host harness adapters, `recordHarnessActivity`, journal/history routes; web `data/syncStore.ts`, new session projection/components, inspector integration and CSS.

### Acceptance gates

| Scenario                                                              | Required evidence                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chunked text followed by final snapshot                               | One correct message, no repeated text; stable identity across replay.                                                                                                                                                                 |
| Two concurrent calls of the same tool                                 | Two distinct cards, correct input/result pairing, independent state/error.                                                                                                                                                            |
| Parent plus two subagents                                             | Correct attribution and navigation; no interleaved unlabelled transcript.                                                                                                                                                             |
| Disconnect, duplicate events, cursor gap, reload, completion          | Live and replay projections agree; history is recovered or a gap is disclosed.                                                                                                                                                        |
| More than 4,000 observations and a large tool result                  | Older content remains retrievable; UI stays bounded and responsive; no silent truncation.                                                                                                                                             |
| Steering accepted, rejected, timed out, retried, or racing completion | Draft/outcome remains clear; the same intended message is applied at most once where supported, with uncertainty exposed otherwise.                                                                                                   |
| Interrupt/retry versus cancel run                                     | Each action targets its stated scope; unsupported actions explain why.                                                                                                                                                                |
| Keyboard and 390px/768px/1440px layouts                               | Session remains readable and operable; focus returns correctly after close.                                                                                                                                                           |
| Real provider session                                                 | For each harness claimed as supported, show a real parent turn streaming text/tool activity and consuming a unique steering or child-result marker where that capability is claimed. Record unsupported/unavailable cases separately. |

Use deterministic adapter fixtures and reducer tests first, then browser coverage against the real local API. Perform live-provider acceptance only after those gates pass and within authorized provider usage. Mock streams, CLI version output, and green unit tests do not establish native session usability.

## Phase 3 — Review, repair and local delivery

**What:** An approval inbox/count; readable plan/proposal and evidence; file-by-file bound diff; review notes; editable local commit title/body; approve/reject/request changes; a visible resulting commit.

**How:**

- Add a run-level pending-approval list that navigates to the exact invocation/action. Resolve the reviewed proposal and diff from immutable bound evidence, and show whether the review is stale.
- Reuse the artifact/code viewer for changed-file navigation, binary-file notices and expandable patch sections. Store commit metadata in the prepared action binding; changing it invalidates or replaces the approval as appropriate.
- Add request-changes only through a declared workflow repair target/outcome and finite counter. Follow `v1-recovery-plan.md`'s feedback and shared repair-budget contract: freeze the operator feedback, carry task/plan/evidence/workspace identity, create a new repair invocation, then rerun validation and review. Preserve a compatible provider continuation or record a fresh-session handoff. Exhaustion terminates with evidence.
- For a workflow without a declared repair route, explain that request-changes is unavailable. Never invent a generic skip or arbitrary graph jump. Keep local delivery distinct from normal gate decisions where their bindings differ.

**Acceptance:** Multiple approvals are discoverable; request-changes survives restart and reaches the intended implementer; repaired trees require fresh review; exhausted repairs terminate; stale decisions cannot commit; commit metadata and the resulting SHA match the approved action. No ticket or PR integration is required.

## Phase 4 — Inspection and everyday navigation

| What                           | How                                                                                                                                                                                                                                                       | Done when                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Rich artifact viewer           | Dispatch by artifact kind/media type; render Markdown, JSON, code, diff and session history in reusable viewers, with download/raw fallback and bounded loading.                                                                                          | Agent outputs and command failures can be understood inside the workbench; malformed/large artifacts remain accessible. |
| Task/repository context        | Show full task/title, repository/worktree, base identity and pinned workflow in the run header/details; keep long text expandable.                                                                                                                        | Operator can identify the work and workspace without opening unrelated tabs.                                            |
| Invocation recovery            | Expose backend-declared interrupt/retry eligibility per invocation/attempt, with reason and durable outcome. Add skip only for explicitly declared and authorized workflow outcomes.                                                                      | Failed attempt recovery is reachable; concurrent invocation targeting is unambiguous.                                   |
| Usage summaries                | Aggregate declared usage with completeness and attribution; distinguish known totals, partial reporting and unavailable prices. Link totals to attempts/subagents without double counting.                                                                | Run and selected attempt usage are useful and agree with durable evidence.                                              |
| Durable event history          | Page/filter the existing event API, correlate entries with invocation/attempt and action outcomes, and provide expandable payloads.                                                                                                                       | Operators can explain a failure or control decision without querying SQLite.                                            |
| Narrow-screen run navigation   | Add an accessible run switcher/drawer when the sidebar collapses; make the inspector a tab/drawer rather than reserving 260px permanently.                                                                                                                | Existing runs, session, approvals and task launch are usable at 390px width.                                            |
| Saved graph/layout preferences | Persist view mode/orientation and existing widths with defensive storage handling; keep graph selection stable across modes and bound saved sizes to viewport.                                                                                            | Refresh retains valid preferences; unavailable storage does not crash the app.                                          |
| Launch ergonomics              | Validate declared required inputs, preserve draft/settings across errors, disable every launch entry point consistently, show selected workspace/base and actual harness capabilities. Introduce base/effort options only with validated backend support. | Header and form launch the same reviewed configuration; errors explain what to correct.                                 |

**Main code:** web App/Inspector/Sidebar/Topbar/Preview, extracted shared viewers and styles; host DTOs/history APIs where information is missing. Avoid growing `app.tsx` further: extract components when a phase creates a cohesive responsibility, without coupling the work to a wholesale rewrite.

## Phase 5 — Delete finished runs

**What:** A discoverable Delete run action with a concrete preview of what will be removed and what is retained.

**How:** Add one host application use case and HTTP command with actor, expected state/revision and idempotency. Require a terminal, drained run and verify that no live effect or workspace writer owns its resources. Use the existing claimed-worktree cleanup path; never delete the source checkout. Calculate dependencies from checkpoints/forks, shared blobs and retained comparison/evaluation evidence. For this phase, block deletion when retained references require the run and list those references; do not silently cascade deletion into other runs. Delete only exclusively owned artifacts.

Persist cleanup progress so partial filesystem/DB failures can be retried after restart. Present a confirmation naming the run/task and owned worktrees/history to remove. On success close its stream, remove it from the catalog and select a valid remaining run. Report partial failure with a retry route rather than pretending deletion succeeded.

**Acceptance:** Active/racing runs are rejected; checkpoint/shared-artifact references remain valid; the original repository and other runs remain intact; failure midway through cleanup is recoverable; repeating deletion is idempotent; deleting the selected or last run leaves a usable UI.

## Phase 6 — Ordinary comparisons and complete evaluation flows

**What:** Select ordinary runs for comparison; choose experiments/cells explicitly; read actual evidence; recover long-running experiments.

**How:**

- Resolve findings 7–9: durably reconcile pending/reserved/running experiment cells, preserve paused state, and resume observation after restart. Use declared deadlines rather than a ten-second polling loop.
- Materialize or replay comparison evidence at its pinned revision. Offer explicit run selection and explain differences in task, repository/base or workflow; do not present incompatible results as directly equivalent.
- Create/reuse comparisons on explicit intent with stable input identity. Passive catalog refresh must not create records. Allow missing stages without shifting the alignment of other rows.
- Connect experiment selection, minimal creation/configuration, dataset inspection and cell evidence APIs. Replace inert buttons with working interactions or explicit unavailable states. Preserve separate execution success, deterministic acceptance, workflow review and human preference signals.

**Acceptance:** A run lasting beyond ten seconds completes its cell; restart resumes observation without duplicate launch; pause is not reported as failure; a pinned comparison does not change as source runs advance; an idle tab creates no comparison rows; both pairwise branches retain correct attribution; evidence shown matches the selected cell/revision.

## Delivery and verification rules

- Implement in the phase order above; phase 1 includes the immediate pairwise attribution correction even though the larger evaluation UI is phase 6. Keep each change independently reviewable.
- Before analogous runtime edits, inspect relevant v1 behavior and current v2 contracts/tests. The historical UI is a behavior reference; its old APIs are not the implementation target.
- Add targeted regression tests for the audit findings and the new behaviors, then run relevant typechecks and host/web/browser checks. Resolve the existing revision-14-versus-17 test failure by asserting the intended event contract and reload equivalence, not blindly replacing one magic number with another.
- Verify source behavior first, then rebuild/check the bundled CLI/web distribution when preparing a deliverable. Do not treat source-only changes as proof that installed builds contain them.
- Maintain a phase evidence checklist: implemented, deterministic tests, browser verification, real-provider verification, and any intentionally unsupported capability. A phase with an unverified live gate must be reported as such.
- This deliverable is the implementation plan; all phase implementation and verification statuses remain pending.
