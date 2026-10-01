# Code audit and v1/v2 web comparison — 2026-09-25

## Scope and evidence

- V2: `main` at `a27640617d52375b9ee38dd832d7507737a5268a`, including the existing uncommitted source changes. Package version: 2.0.8.
- V1: local Git ref `v1` at `90b5cc69b6657b7ced21b4bee5d2696cb3781fae` (0.1.21). Historical references below refer to that ref, not the current contents of the other worktree.
- Reviewed web launch, run selection, graph/timeline projection, controls, pairing/reconnection, inspector, approvals, delivery, evaluation/comparison flows, and their host/storage/workspace implementations. This is not an exhaustive audit of every compiler, scheduler, or native provider path.
- UI/UX conclusions come from component, API, and CSS inspection. No rendered side-by-side browser assessment, accessibility audit, or live provider acceptance run was performed.
- Findings and line references describe the audit snapshot before the implementation follow-up below. Existing dirty source and distribution changes were treated as part of the checkout, not reverted.

## Findings

### 1. P1 — Public delivery action can bypass durable approval

**Locations:** `packages/host/src/http/server.ts:491-508`; `packages/host/src/coordinator/coordinator.ts:334-360`.

The HTTP endpoint accepts `action: "deliver"` with only `expectedTree`. The coordinator checks approval status only when `deliveryActionId` is supplied. An authenticated, CSRF-valid caller can therefore commit a tree while its delivery approval is still pending. Authentication works; the durable approval requirement is bypassed.

**Reproduced:** In a temporary repository, prepared a pending delivery, then POSTed the action without `deliveryActionId`. Response was HTTP 200 with a commit SHA; the delivery action remained `pending`.

**Fix direction:** Require a matching approved delivery action at the public effect boundary. If direct commit is an intentional internal primitive, keep it separate from the operator HTTP route and make the policy distinction explicit. Add a regression asserting that an unapproved direct HTTP commit is rejected.

### 2. P1 — Delivery approval can cover a tree the operator has not reviewed

**Locations:** `packages/web/src/app.tsx:2573-2660`; `packages/host/src/coordinator/coordinator.ts:363-386`.

The diff fetch only depends on `runId`. Keeping the diff tab open while an agent edits leaves the displayed patch unchanged. Prepare sends the old patch digest only inside an opaque request key; the host snapshots the current worktree without comparing it to the reviewed tree. The UI then offers approval of the new action while still displaying the old patch. Commit correctly checks the newly prepared tree, which does not solve the earlier review mismatch.

**Reproduced:** Snapshot A was reviewed, the worktree was edited to B, and preparation with the A-based web request key returned B as a pending delivery. The tree hashes differed.

**Fix direction:** Bind preparation to the reviewed `resultTree`/patch digest and reject drift, or display the immutable prepared action's patch before enabling approval. Refreshing the live diff alone does not close the race.

### 3. P1 — Changing runs temporarily pairs the old view with the new action target

**Locations:** `packages/web/src/app.tsx:609-622,700-713,807-811,838-840`; `packages/web/src/data/syncStore.ts:40-46`.

Selecting B updates `selectedRunId` immediately, but `setStatus("connecting")` preserves A's snapshot until B's fetch completes. The header can identify B while showing A's graph, status, and controls. `controlRun` targets B using A's revision. For run-level actions such as cancel, equal revisions allow the operation to succeed against B; unequal revisions merely return a conflict. If B's fetch fails, the mismatch persists.

**Evidence:** Source trace of selection, retained store snapshot, render, and command construction; not browser-reproduced.

**Fix direction:** Render and enable controls only when `snapshot.runId === selectedRunId`, clear or explicitly label stale views during transitions, and construct the target and revision from the same validated snapshot.

### 4. P1 — Randomized pairwise review associates evidence with the wrong run

**Locations:** `packages/host/src/application/service.ts:239-258`; `packages/core/src/comparison.ts:121-134`; `packages/web/src/app.tsx:577-591`.

When `flip` is true, `evidenceA` comes from the second run but `runA` remains the first run. The UI later reveals `assignment.sideA` as `assignment.runA`. Thus the displayed evidence and revealed identity disagree in that branch, contaminating interpretation of the recorded preference.

**Reproduced:** Called the real `createPairwise` method with distinguishable evidence and an in-memory journal stub. It returned first-side evidence `["B"]`, while that side's stored run identity was `A`.

**Fix direction:** Shuffle complete run/evidence pairs, then derive side IDs, displayed ordering, decisions, and reveal mapping from that one mapping. Exercise both randomization branches deterministically.

### 5. P2 — Live pause/resume controls retain stale availability

**Locations:** `packages/host/src/http/server.ts:538-561`; `packages/web/src/data/syncStore.ts:67-75`; `packages/web/src/types.ts:506-534`.

GET `/view` sets `m2.capabilities` from the current run state. Stream frames replace runtime state but retain that original `m2` object. A view loaded while running has `resume: false`; after a pause frame, the projection removes Pause but still suppresses Resume. Conversely, a view loaded while paused cannot show Pause after resuming. A view first loaded while pending can retain false active controls.

**Reproduced:** Running snapshot had `{cancel:true,pause:true,detach:true}`. Applied a contiguous paused frame through the real `RunSyncStore`; capabilities became `{cancel:true,detach:true}` with no Resume.

**Fix direction:** Carry authoritative availability in live frames, or keep state-independent host permissions separate from state-derived eligibility. Test transitions, not only initial snapshots.

### 6. P2 — Run graph and inspector use the launch selector's workflow

**Locations:** `packages/web/src/app.tsx:724-725,881-899,1535-1607`.

`workflow` is resolved from `workflowId`, which belongs to the new-run picker and initially equals `tiny`. Selecting a historical run does not update it. That catalog graph is passed into both graph and inspector for the selected run. Opening a feature run while the selector is Tiny shows the wrong nodes; coincident node IDs can also mislabel invocation metadata. Selecting the matching catalog entry would still fail to guarantee the historical run's exact configured bundle.

**Fix direction:** Project the active graph from the bundle pinned in the run view. Keep the launch preview's workflow selection independent. Test runs from different definitions and customized node settings.

### 7. P2 — Experiment orchestration abandons longer runs and cannot resume their cells

**Locations:** `packages/host/src/evaluations.ts:135-150,263-270,370-383`; `packages/host/src/http/server.ts:204-221`.

Each cell is observed for only 2,000 sleeps of 5 ms (roughly ten seconds plus processing). A legitimate longer run causes `launchCell` to throw after associating the cell as `running`. There is no persistent observer completing that cell, and the next `resume` only selects `pending`/`reserved` cells. It cannot reattach to the stranded running cell. A paused run is also treated as terminal failure by the `![pending,running]` condition.

**Evidence:** Source trace. No paid/live model was invoked to reproduce the duration threshold.

**Fix direction:** Reconcile cell state from ordinary runs, include running cells in resume/recovery, distinguish paused from terminal states, and use declared deadlines/cancellation rather than this fixture-sized polling budget.

### 8. P2 — Comparison results ignore their pinned revisions

**Locations:** `packages/host/src/application/service.ts:171-217`; `packages/core/src/comparison.ts:3-8`.

Comparison records retain immutable `(runId, revision)` references, but timeline construction and blinded evidence call `getView(runId)` without replaying that revision. Reopening the same comparison after a run advances can show later status/timing/evidence under the old revision metadata. Pairwise launch in the browser compounds this by hardcoding run revision 0.

**Fix direction:** Resolve comparison inputs at the retained revisions, or materialize immutable evidence at creation. Have the browser request actual observed revisions.

### 9. P2 — Catalog polling continually writes new comparison records

**Locations:** `packages/web/src/app.tsx:337-370,403-483,603-607`; `packages/host/src/application/service.ts:154-165`.

Every five seconds the catalog creates fresh experiment objects. The comparison effect depends on the selected experiment object and POSTs a newly generated persistent comparison when two cells have runs, even when the user is viewing the Runs surface. One open tab can generate about 720 records/hour after that condition is met, plus repeated view and timeline reads. Effect cancellation does not cancel those writes.

**Fix direction:** Create comparisons on an explicit action or reuse one keyed by selected run revisions and anchors. Depend on stable IDs/revisions, and avoid background writes for an unopened surface.

### 10. P2 — A failed initial pairing request permanently poisons Retry

**Locations:** `packages/web/src/app.tsx:55-84,603-607,847-852`.

The module caches the first `ensureSession()` promise and never resets it. If the initial session request fails while the host is temporarily unreachable, subsequent catalog polling and the Retry button await the same rejected promise without making a fresh pairing request. A later host restart also invalidates server-side sessions without a corresponding client re-pairing path.

**Fix direction:** Clear rejected session attempts and handle session expiry explicitly. Provide a pairing recovery path that can use a fresh host link; avoid uncontrolled retrying of mutations.

## Validation

### Initial audit baseline

- `bun run typecheck`: passed.
- Focused existing tests: `bun test packages/web/src/data packages/host/test/admission.test.ts packages/host/test/workspace.test.ts packages/host/test/host.test.ts packages/host/test/m5-comparison.test.ts`.
- Result: **33 passed, 1 failed**, 159 assertions across 10 files.
- Failure: `packages/host/test/host.test.ts:276`, “executes and durably reloads the scripted agent -> command -> complete run”: expected revision 14, received 17. Execution itself reached `succeeded`; the test stopped at the revision assertion, so its subsequent reload assertions were not verified by that test execution. The suite is not green.
- Additional isolated probes reproduced findings 1, 2, 4, and 5. The delivery probe used a disposable repository and the real in-process HTTP handler. The pairwise probe used the real service method with a journal stub; the controls probe used the real projection store.
- No full test suite, browser suite, visual rendering comparison, or native provider run was performed. Distribution bundles were not rebuilt or audited for equivalence to source.

### Follow-up implementation checks (2026-09-25)

- `bun run typecheck`: passed after the implementation changes.
- Focused host/web regression checks: **21 passed, 0 failed** across `session.test.ts`, `syncStore.test.ts`, `host.test.ts` and `workspace.test.ts`. This includes the revision-14-versus-17 test correction: the workflow lifecycle assertion now excludes durable activity observations while restart equivalence still checks the complete revision.
- Broader `bun test packages/core packages/host packages/web/src/data packages/web/src/session.test.ts`: **151 passed, 2 failed**. The pre-existing Codex test expected adapter version `sdk` although the current host reports `app-server`; the test expectation was updated. The scout bridge test cannot bind its loopback listener in this sandbox (`EADDRINUSE` at `127.0.0.1:0`), including when run alone. Re-run that test in an environment where local loopback bind is available.
- `bun run format:check` still reports an issue in the untouched `packages/core/src/compiler.ts`; the files changed in this implementation slice were formatted directly.
- The source web app builds successfully to `/tmp/kouro-v2-web-audit-build` with Vite (507 modules transformed). Vite reports the main JS chunk is 666.51 kB and recommends code splitting. This temporary build did not overwrite the pre-existing dirty `dist/` files. No source or distribution build is evidence of real Codex, Pi or Claude live-session acceptance.

## V1 to v2: operator feature comparison

This inventory measures operator journeys, not file sizes or a percentage of lines ported. Four substantial feature areas are absent from the current web journey: the ticket workbench, delivery request-changes loop, PR publication, and run deletion. Many surviving areas have reduced controls or presentation. V2 also adds useful inspection/development surfaces, but those do not complete the lost journeys.

| Area                             | V1 evidence (`packages/web/src/App.tsx` unless stated)                                                                                                                            | V2 evidence                                                                                                                                        | Assessment                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket workbench                 | `TicketConsole`, `TicketBoard`, `TicketInspector`, lines 2786-3360: projects, lifecycle columns, relationships, history, provider information, linked runs                        | `app.tsx:261-279` surface union has no tickets; admission accepts supplied immutable snapshots but is not a ticket browser/resolver                | **Absent web feature.** Task text is not equivalent to the planning/history workflow.                                                                                                                       |
| Launch from a work item          | `TicketRunFields`/`TicketRunDialog`, 3008-3190: ticket snapshot, registered repository selector, base branch, routing and reasoning effort                                        | `Preview`, 1350-1533: task, free-text workspace path, per-root-node harness/model/capabilities                                                     | **Changed and reduced.** Per-node configuration improves control; ticket context, repository discovery, base choice and effort selector are missing.                                                        |
| Delivery review                  | `ApprovalControl`, 1691-1923: bound file-by-file diff, metadata form, notes                                                                                                       | `ApprovalPanel`, 2517-2571 and `DiffPanel`, 2573-2812: generic gate buttons and a separate raw patch with prepare/approve/commit                   | **Reduced.** No commit/PR metadata editor, review reason field, or file-by-file code viewer. Findings 1-2 affect correctness too.                                                                           |
| Request changes                  | `ApprovalControl`, approximately 1892: request changes with reason and bounded repair-return count                                                                                | Gate decisions only approve/reject; delivery decisions only approved/rejected                                                                      | **Absent operator journey.** Automatic workflow repair edges exist, but are not a human delivery-review return.                                                                                             |
| Publish PR                       | Execution inspector, approximately 2636-2673: Publish PR, failure handling and published PR link                                                                                  | Delivery ends at local prepared commit; no web publish action or equivalent host publication route found                                           | **Absent operator journey.** Local commit is not delivery to the forge.                                                                                                                                     |
| Compare ordinary runs            | `RunList` 699-766, `RunComparisonModal` 893-910: select multiple runs, compatibility check, overview and per-execution breakdown                                                  | Experiments select the first two cells with run IDs for timeline/pairwise; no ordinary-run multiselect                                             | **Reduced.** Backend comparisons exist, but the old operator entry point is gone.                                                                                                                           |
| Artifact and transcript reading  | `TranscriptViewer`, `ArtifactContent`, `ArtifactModal`, 1235-1689; `code-viewer.tsx`: structured roles, grouped tool results, child sessions, Markdown and code/diff presentation | `OutputPanel` 2814-2917 uses raw JSON/text; `ArtifactPanel` 2967-3005 opens attachment URLs; server forces attachment disposition                  | **Reduced.** There is a live/captured session modal, but artifact-specific rich inspection was not recovered.                                                                                               |
| Invocation recovery              | `OperatorConsole` 912-1055: target invocation, reason, interrupt attempt, retry invocation, eligible skip                                                                         | `RunControlBar` 1312-1348 is run-level; inspector exposes steering/session stop but no retry or skip controls                                      | **Reduced.** Backend retry exists; UI access is missing. Run cancellation is broader than attempt interruption.                                                                                             |
| Delete finished runs             | `deleteSelectedRun`, approximately 2309-2325, confirmation and API deletion                                                                                                       | No delete control or public run-delete route found; internal workspace cleanup is a different operation                                            | **Absent web feature.** History/worktree cleanup becomes less accessible.                                                                                                                                   |
| Usage and cost visibility        | `RunCostStat`, `AttemptUsage`, graph/timeline labels and comparison breakdowns                                                                                                    | `UsagePanel` 2456-2480 shows declared attempt usage/cost                                                                                           | **Reduced discoverability.** Usage is retained, but run totals and pervasive model/token/cost context are lost. Avoid fabricating unavailable pricing when restoring totals.                                |
| Work-item and repository context | `NodeDetails` around 1109 and run header around 2408: title, repository path, work-item content/checksum                                                                          | Sidebar shows task truncated to 48 characters; top bar emphasizes run ID                                                                           | **Reduced.** Full task and repository identity should be visible while reviewing a run.                                                                                                                     |
| Graph and layout preferences     | `storedDiagramMode`, `storedDiagramDirection`, `storedInspectorHeight`, 1954-2000; TB/LR control around 2518                                                                      | Split/graph/timeline and nested scopes remain; sidebar/inspector widths persist, but view mode defaults to split and no orientation control exists | **Mixed.** Better nested scope inspection; lost orientation and view-mode persistence. Width controls are already present in this dirty checkout and should not be counted missing.                         |
| Small-screen navigation          | V1 CSS around 2849-3208 adapts run list, workspace and modal layouts                                                                                                              | `styles.css:1595-1623` hides the sidebar below 800px, with no alternate run picker in Topbar                                                       | **Reduced and functionally incomplete.** Existing-run selection disappears on narrow screens. A 260px inspector also consumes much of the available width. This is source-derived, not screenshot-verified. |
| Error recovery                   | V1 `api.ts` parses server error messages                                                                                                                                          | V2 `api` at 76-85 discards response bodies and exposes only HTTP status text                                                                       | **Reduced.** Operators lose reasons for admission rejection, unavailable workspace, stale review and other failures. Pairing Retry also has finding 10.                                                     |
| Live agent session               | V1 `ActivityModal`, 1519-1636; transcript parsing and steering                                                                                                                    | V2 `AgentSessionModal`, 2289-2361: auto-follow, tool input/output, steering, Stop run                                                              | **Retained in simpler form**, including current uncommitted work. Missing structured transcript rendering, tool-result grouping and equivalent attempt-level recovery.                                      |
| Approval discovery               | V1 header “Review N approvals” and an inspector listing approvals                                                                                                                 | V2 approval card follows the selected invocation                                                                                                   | **Reduced.** Multiple pending approvals need a visible inbox/count and direct navigation rather than relying on invocation selection.                                                                       |
| Event history                    | V1 `EventLog`, 1202-1215 and Events inspector tab                                                                                                                                 | V2 has diagnostic/log panels and backend event API, but no equivalent general durable-event inspector tab                                          | **Reduced web access.** API availability does not replace an operator history surface.                                                                                                                      |

## Useful v2 additions to preserve

- Nested scope and repeated invocation graph projection, collapse/expand, breadcrumbs, and outline (`data/hierarchicalProjection.ts`, `GraphPanel`).
- Shared graph/timeline/inspector selection and virtualized timeline rows (`data/syncStore.ts`, `data/virtualRows.ts`, `Timeline`). Transition correctness still needs findings 3, 5, and 6 fixed.
- Collaboration inspection (`swarm.tsx`): participants, messages and related durable state. This is UI availability, not proof of live multi-provider success.
- Checkpoint/fork/genealogy inspection (`m7.tsx`).
- Development previews for schema, prompt and workflow compilation (`DevelopmentWorkbench`).
- Evaluation matrix, timeline and pairwise surfaces (`m5.tsx`). These remain partial: no experiment picker/creation flow in App; Dataset button has no handler; normalized cells do not load evidence from the evidence endpoint. The presence of these screens should not be counted as full evaluation usability.
- Per-node harness/model/access configuration, task launch, older-run pagination, resizable panels, and live/captured agent modal.

## Recommended recovery order

The user's follow-up sets the implementation scope: **proper live agent sessions are the main UX priority; run deletion should be restored; ticket integration and PR publication are deferred.** The historical comparison above records what v1 had and does not make every absent feature a current requirement.

1. Fix approval/tree binding, run target/view consistency, live controls, pairing recovery and pairwise identity.
2. Build proper live and historical agent sessions with readable messages, correlated tools, subagent activity, reliable steering and explicit invocation controls.
3. Improve local review and delivery: discover pending approvals, inspect bound files/evidence, enter reasons and commit metadata, request changes through declared repair routes, approve and commit.
4. Restore readable artifacts, task/repository context, usage summaries, run deletion, mobile run selection and saved preferences.
5. Finish ordinary-run comparison and evaluation orchestration, revision correctness, selection and evidence loading.

The concrete what/how plan, code ownership and acceptance gates are in [Web operator implementation plan](web-operator-implementation-plan.md). Ticket management, remote push and PR publication are outside this plan's completion criteria.

## Implementation follow-up — 2026-09-25

The findings above record the checkout during the audit. The following changes were made afterward in this working tree:

- Findings 1–6: reviewed delivery actions are required at the effect boundary; preparation checks reviewed tree/diff identity; run-target state and pinned bundle graph handling were corrected; state-derived control capabilities update with live frames; retryable pairing and server error details are exposed; pairwise evidence and run identity remain paired.
- Finding 7: experiment resume now observes existing `running` cells, has no fixed ten-second cutoff, and waits through paused states until terminal run status. Restart recovery is operator-triggered through Resume; no live long-run/restart test was executed in the final implementation pass.
- Finding 8: comparison timeline and blinded evidence replay the exact stored run revisions. The browser sends observed revisions.
- Finding 9: comparison creation is explicit, limited to two selected runs, and reuses a stable ID for identical run/revision/anchor inputs.
- Finding 10: a failed session request can retry; a tab-scoped pairing token permits re-pairing after host session state resets.
- Previously missing operator paths now include finished-run deletion with a durable retry inbox, retained-reference blockers and a confirmation preview; pending-approval discovery; ordinary run selection for comparison; pageable event history; invocation retry; dataset-case inspection; task context; persisted view mode; and narrow-screen run/inspector selection.
- Evaluation flows now include experiment selection/creation and durable per-cell evidence loading. The create form currently creates one scripted baseline variant; it is not a full multi-variant experiment designer.
- Agent sessions now include journal paging, search, copy controls, bounded rendered rows and tool previews, safe basic Markdown, a shareable run/invocation/attempt URL, live steering status, and focus-aware modal behavior. This does not establish that a native Codex, Pi or Claude session streams and steers successfully.

Completion checks for this final implementation pass: `bun run typecheck`, `bun run lint`, `git diff --check`, and `bun run build:cli` passed; `bun dist/kouro.js --help` ran from the rebuilt bundle. No test or browser suite was run in this pass. No live provider was invoked. The generated CLI/web distribution was rebuilt. The initial audit-baseline and earlier follow-up test results above remain historical evidence and do not verify the newly implemented deletion, evaluator-recovery, event-history, mobile or comparison paths.

The current code intentionally leaves “request changes” unavailable on workflow approvals that do not declare a bounded repair route. The built-in feature workflow has automatic validation repair but no human reviewer-return path. Ticket management and PR publication remain intentionally deferred per user scope.

### Functional coverage summary

The comparison table covers 17 operator journeys, rather than treating every button as an equal unit. At the audit baseline, 4 journeys were absent (ticket workbench, human request-changes return, PR publication and run deletion), 11 were reduced, 1 was mixed and 1 was retained in a simpler form. After this implementation, run deletion, explicit ordinary-run comparison, approval discovery, event history, dataset inspection and narrow-screen run selection have operator entry points. Ticket management, PR publication and human request-changes remain absent by scope/declared workflow capability. Session UX is materially improved in source, but should still be counted as unverified for native live-provider behavior and target viewport accessibility.

This is a journey count, not “X percent of v1 functionality”: a single journey can contain several controls, and the v2 graph/journal model changes some workflows by design. The detailed row-by-row table describes the quality loss and the features to preserve.
