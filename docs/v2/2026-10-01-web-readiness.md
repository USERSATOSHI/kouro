# Web readiness audit — 2026-10-01

The priority live-session, subagent-observation, ordinary failure-retry, and bounded review-repair paths are implemented and verified in this checkout. Native Codex browser acceptance now covers split view, steering and cancellation. The October 2 follow-up verifies live local Pi parent/child execution, split view, reload persistence and cancellation. Pi steering responsiveness remains a limitation. This is **not blanket production sign-off**: provider acceptance, broader recovery and several v1 operator journeys remain incomplete.

## Scope and reference

Compared the actual local v1 ref `90b5cc69b6657b7ced21b4bee5d2696cb3781fae`, including `packages/web/src/App.tsx`, with v2 HEAD `a27640617d52375b9ee38dd832d7507737a5268a` plus the existing working-tree changes. Existing changes were preserved. The earlier [audit](2026-09-25-code-and-web-audit.md) and [implementation plan](web-operator-implementation-plan.md) provide the broader journey inventory; their historical verification statements are not current test results.

The reference behaviors were direct access to invocation activity, readable message/tool history, operator steering and Stop, concrete invocation recovery, and access to prior output. The user's additional requirement was simultaneous parent/subagent observation.

## Findings and fixes

| Defect or missing behavior | Result in this checkout |
| --- | --- |
| Live-session access depended on inspector discovery and recent event availability. | An Agent session action opens the selected or active agent directly. Older attempts remain selectable; session links bind the run, invocation and attempt. |
| Tool events were appended as independent cards; parent/child provider IDs collided. | One projection correlates calls and results by attempt, subagent, request and tool ID. Both the session and Tools tab use it, including live frames and historical replay. |
| Tool inputs/results were JSON blobs or absent; the inspector omitted outputs. | Calls show their arguments as readable fields and their output directly. Text/MCP envelopes render as text; errors and waiting states stay attached to their call. Previews are bounded. |
| Thinking events carried only a generic label. | Codex reasoning-summary deltas and Pi thinking deltas carry their text; Claude streamed/retained thinking blocks are normalized without duplicate fallback text. The UI displays provider-exposed thinking; it cannot manufacture content the provider omits. |
| Parent/subagent activity was interleaved in one transcript. | Sessions automatically show a parent pane and a selectable child-request pane. Each pane has independent scrolling and bounded message windows. Narrow screens stack the panes; combined view remains available. Harness/model/state metadata is shown when recorded. |
| The native Codex bridge replaced the declared request ID with an RPC transport ID. | It preserves the tool argument's request ID. A real native parent/child acceptance test reproduced and verified the correction. |
| Codex dynamic-tool results were dropped, and some failed commands appeared completed. | Normalization retains dynamic `contentItems`, MCP results, command output/deltas and nonzero exit errors. Checked against types generated from the installed App Server binary. |
| Identical streamed observations were dropped; unrelated frames repeatedly appended retained history. | Tracking preserves legitimate repeated deltas; replay deduplicates cursor identities and persisted copies. Completion retains activity identity. Recent durable activity is restored on reconnect. |
| A failed initial history request had no working retry; search hid results after the first render window. | Retry recovers initial failures. History is paged from the journal; search and speaker selection can navigate beyond 250 rendered entries. |
| Stale connection failures could overwrite the newly selected run; pairing and requests could remain stuck. | All connection callbacks are guarded by their selection generation. Read-only requests can re-pair once; mutations are not blindly replayed. Reconnect retries are bounded and a manual action is available. Pairing/API requests have timeouts. |
| Invocation Retry was offered but the reducer rejected terminal failed runs. | Eligible failed root effects can reopen their run. Old attempts remain durable; idempotency prevents duplicate retries. The host supplies exact eligible invocation IDs and fences unsafe cases. |
| Sessions only offered whole-run cancellation; cancelled attempts could not be retried. | Interrupt agent targets the selected active attempt. A confirmed, drained failed/cancelled attempt can be retried within the existing safety and budget limits. Durable invocation rows clear old completion/error fields on retry. Cancel run remains available separately. |
| Codex steering was enabled before the native turn was ready. | Eligibility follows the active App Server turn. An explicit readiness event refreshes the browser controls. A native browser test sends steering and verifies the final output changed to the operator's new objective. |
| Pi could silently leave its configured local provider, and its registered subagent tool was inactive. | Explicit node model choices take precedence over profile environment defaults. The adapter refreshes only the selected llama.cpp provider, rejects an unavailable configured model with available choices, includes the custom subagent in the SDK's active-tool allowlist, forwards invocation timeouts and logs the actual selected provider/model. An actual Pi SDK test exercises local discovery, delegation and consumed output against an isolated HTTP fixture. |
| Request changes was missing from the feature gate, and repaired approvals prevented success. | The built-in and packaged feature workflow declare three bounded repair returns. Feedback is persisted as a typed input to the planner. UI shows the remaining budget. Rejection routes and already-consumed feedback edges are handled correctly; approved repaired runs can succeed. A detached coordinator failure no longer terminates the host process after recording recovery. |
| Launch controls did not expose required inputs beyond task or separate child models. | Both launch actions validate every declared root input. Boolean, numeric, enum and object fields preserve their types, including false and zero. Parent and child harness/model controls use definition-qualified node IDs, reject ambiguous overrides and retain child read-only access. |
| Local delivery used a fixed commit message. | The operator can edit a multiline message before preparation. The prepared message is stored with the exact reviewed action; editing requires refreshing/repreparing the diff. |
| Large tool output was truncated without full-result access; large transcript windows could hide the newest call. | Outputs over 64 KiB have a redacted full artifact and a bounded readable preview. Both tool views link to the complete result. Follow windows use the latest entries after history loads. Browser acceptance covers 4,210 journal observations, an old searched marker and full output after reload. |
| Completed structured output showed artifact references rather than content. | Output artifacts have bounded in-app previews and full-artifact links. Other artifact previews load when opened, with error/retry handling. |
| Mobile selection did not open the inspector; hidden-panel modals were unusable. | Selection opens the mobile inspector, and the session dialog is portaled outside that panel. Keyboard focus, Escape and focus restoration are covered. |
| Repository launch could fail on an omitted optional workspace ID. | The HTTP adapter omits the absent property instead of passing an undefined value into canonicalization. |
| Launch validation differed between the header and form; run selection was lost on reload. | Both entry points enforce declared required task input and guard duplicate submission. Selected run/invocation URLs are updated. |
| Large histories rebuilt graph work and created a 10,000-option invocation select. | Stable graph inputs and unchanged scout polling avoid unnecessary graph updates. The timeline paints a viewport-sized SVG over a spacer; invocation selection is searchable and paged. |
| Evaluation comparison lacked an explicit action and could compare two repetitions of the same variant. | Compare completed cells is explicit. Default comparison/review selection prefers distinct variants with the same case and repetition. |

## Verification

All commands below were executed against this checkout. Browser hosts used isolated temporary data on port 43281; the native browser host used port 43282.

- `bun run typecheck`, `bun run lint`, `bun run format:check`, and `git diff --check` pass.
- `bun test packages scripts`: **193 passing tests**, zero failures after the October 2 Chore compatibility follow-up. Includes actual Pi SDK local discovery/tool activation/result consumption and stale-default rejection, retry idempotency/restart history, scoped interrupt and cancelled-attempt retry, approval feedback across restart, repair exhaustion and subsequent acceptance, independent child settings, lifecycle/deletion fencing, projection, adapter and repeated-event regressions.
- `KOURO_TEST_PORT=43281 bun run test:browser`: **28 passing tests**, zero failures. Nine dedicated session tests cover typed launch and pinned parent/child settings, scoped interrupt/retry, live parent/child activity, a new child spawned during an open session, readable live tool results/logs, steering, completion/replay, failed-run retry, 390px cancellation/focus, re-pairing, snapshot Retry, late failures after switching runs, required-task launch guards, searching 300 tool calls and more than 4,000 journal observations. Workbench tests include requested changes followed by approval and the durable editable delivery message.
- The large-data fixture uses a pinned 500-node bundle and 10,000 invocation spans. Final measurements: graph 1,611 ms, selection 138.2 ms, 17 rendered bars, scrolling p95 16.8 ms. Selection updates highlighting and breadcrumbs without rebuilding graph edges. Original acceptance budgets remain unchanged. Its synthetic SSE connection stays open; reconnect recovery is tested separately through the real host. These measurements describe this headless Chromium environment.
- `KOURO_LIVE_SUBAGENT_HARNESS=codex KOURO_LIVE_SUBAGENT_MODEL=gpt-6-luna bun test packages/host/test/live-subagent.test.ts`: **2 passing native tests**. One checks the awaited bridge and request ID; the other runs real Codex parent and child models through the coordinator/scout gateway, verifies attributed durable activity, and checks the parent's output against the child's unique report marker.
- `KOURO_TEST_PORT=43282 KOURO_LIVE_BROWSER_MODEL=gpt-6-luna bun run test:browser:native`: **3 passing native browser tests**. Actual Codex parent/child output is visible in split panes and retained after reload. Mid-turn steering changes the final structured output to a new marker; cancellation drains the provider and remains cancelled after reload. Codex requests available reasoning summaries with `summary: "auto"`; the UI displays only content exposed by the provider.
- `KOURO_LIVE_SUBAGENT_HARNESS=claude bun test packages/host/test/live-subagent.test.ts`: native acceptance **failed** because Claude reported `Not logged in · Please run /login`.
- The initial `KOURO_LIVE_SUBAGENT_HARNESS=pi bun test packages/host/test/live-subagent.test.ts` used Pi's implicit model selection and failed with HTTP 403 `Model access is disabled`. This was **not evidence that the user's local model denied access**. A no-inference probe reproduced the old selection path choosing `opencode/kimi-k2.6` instead of its configured local provider. Follow-up read-only discovery confirmed `http://models:8080/v1/models` was reachable and reported `qwen36-35b-a3b-256k-vision-mtp` loaded. Pi's saved llama.cpp endpoint is that server; its saved default model is the different, unloaded `qwen3-8-27b-coding`.
- `KOURO_LIVE_SUBAGENT_HARNESS=pi KOURO_LIVE_SUBAGENT_MODEL=llama.cpp/qwen36-35b-a3b-256k-vision-mtp bun test packages/host/test/live-subagent.test.ts` was attempted. Before the tool-activation correction it failed output validation; later attempts could not complete discovery because the server stopped responding from this runtime. Both HTTP to its resolved IP and Tailscale ping timed out. Live local Pi acceptance remains **unverified**. No credentials were changed, and no model was loaded/unloaded or server restarted.
- `bun test packages/host/test/pi-sdk-session.test.ts`: **1 passing actual SDK integration test** with an isolated local router/completion fixture. It verifies a fresh catalog, active subagent tool, parent consumption of a unique delegated result, selected-model activity and a stale local default failing without another inference request. Stalled response streams and stalled catalog discovery both respect the invocation timeout; timed-out discovery dispatches no inference request. This fixture result is separate from real Qwen acceptance.
- `bun run build:cli` and `bun dist/kouro.js --help` pass. The rebuilt distribution contains the changes. Vite still reports an application chunk larger than 500 kB.

The initial full browser run had 12 passes and 7 failures. Failures included the omitted workspace ID and hidden mobile inspector, plus outdated execution-profile controls, an unpinned performance fixture, and ambiguous selectors. Tests were corrected to exercise current supported contracts; performance thresholds were not relaxed. Additional fault tests then found the duplicate inspector tool path.

Follow-up regressions found cancelled-attempt reservation, old failed approval decisions blocking successful repair, a detached coordinator rejection terminating the host and a stale message-window offset hiding large tool output. The final suite verifies those corrections. A later selection measurement exceeded the unchanged 250 ms budget; separating selection from topology projection resolved it. The added launch fixture uses the real template loader and preserves existing checkout templates in its isolated catalog.

## Live Pi follow-up — 2026-10-02

The server became reachable again. Fresh discovery at `http://models:8080/v1/models` reported `qwen36-35b-a3b-256k-vision-mtp` loaded. All following native runs explicitly selected `llama.cpp/qwen36-35b-a3b-256k-vision-mtp`; no credentials or server settings were changed.

- `KOURO_LIVE_SUBAGENT_HARNESS=pi KOURO_LIVE_SUBAGENT_MODEL=llama.cpp/qwen36-35b-a3b-256k-vision-mtp bun test packages/host/test/live-subagent.test.ts`: **2 passing tests**, zero failures, 25.71 seconds. These cover a native tool call and real parent/child models through the coordinator, attributed durable activity and exact consumption of the child's unique result.
- `KOURO_TEST_PORT=43283 KOURO_LIVE_BROWSER_HARNESS=pi KOURO_LIVE_BROWSER_MODEL=llama.cpp/qwen36-35b-a3b-256k-vision-mtp bun run test:browser:native`: initial run **2 passes, 1 failure**. Live split view, consumed output, reload persistence and cancellation passed. The 2,000-step steering stress test accepted the instruction but remained running beyond the unchanged 90-second assertion deadline.
- A diagnostic rerun reduced the initial planning task to 20 steps while retaining all assertion deadlines. It also had **2 passes, 1 steering timeout**; the model continued producing the initial plan. The committed fixture retains the original stress prompt. This diagnostic did not establish successful queued-instruction consumption.
- Installed Pi SDK 0.82.1 queues steering until the current assistant response and its tool calls finish, before the next model call. It does not interrupt the current generation. An accepted instruction therefore does not establish that the changed objective has already been applied. Immediate mid-response Pi steering remains unverified; cancellation is verified separately.
- Native host and browser fixtures now accept Pi explicitly while preserving Codex as their default. Typecheck, lint, formatting and `git diff --check` pass.

These native results supersede the earlier connectivity blocker for the verified Pi paths. They do not close the broader production gates below.

## Chore compatibility follow-up — 2026-10-02

The local `.kouro/chore` definition and bundled Chore starter now use the current
plan → change → validate lifecycle, required repository scout, optional test
scout, explicit capabilities and typed summaries. Worker and validator receive
the planner's reports and explicitly declare no additional scouts. No fixed
agent timeouts were added. The local definition retains its existing Codex
`gpt-6-luna` main agents and Pi/llama.cpp Qwen scouts; the portable starter inherits
the run's execution profile instead of hardcoding machine-specific models.

Execution exposed a shared authoring bug: `subagentResults` declared arrays of
plain report payloads while the coordinator supplies report envelopes. Strict
input validation rejected the worker before execution. The generated schema and
public TypeScript report type now match the existing envelope, including nested
payload validation and request/artifact identity. An integration test scaffolds
the actual starter, runs its coordinator with an isolated scripted harness,
checks report delivery through both later phases, and verifies that skipping
the required scout blocks work. This is workflow execution evidence with a
scripted harness, not a new live documentation-writing run.

The edited local definition loads and compiles as version 2. Its manifest now
matches that version. The bundled starter replaces its old placeholder printf
validation with a read-only validation agent. All 193 unit/integration tests,
typecheck, lint, formatting, CLI build and help pass. `.kouro` remains Git-ignored;
the corresponding portable source and distribution updates are tracked. A
running host caches its template catalog and must restart to load these edits;
already-created runs retain their pinned bundles.

## Activity and usage regression follow-up — 2026-10-02

A real Chore session exposed repeated empty `Thinking` rows and missing Codex
token counts despite completed parent/child execution. Pi's event normalizer
was turning SDK bookkeeping and tool-argument notifications into generic thinking
logs. It now publishes actual thinking text and meaningful lifecycle events only.
The session, output and log projections also filter old empty thinking records
without removing recorded thinking content or error details.

The Codex App Server adapter read a nonexistent `turn.tokens` field. It now captures
the installed protocol's `thread/tokenUsage/updated` counters, scoped to the active
thread/turn, and retains observed usage on success or failure. Thread totals include
tool continuations. The browser projects usage while the attempt is running and
does not substitute attributed child usage for the parent's counters. Cost remains
unavailable when the provider does not report it. Counts never recorded by an older
host cannot be backfilled from these changes.

Verification for this follow-up:

- `bun test packages scripts`: **198 passing tests**, zero failures. Includes Pi
  bookkeeping filtering, retained-history thinking content, reported Codex totals,
  and live/reconnected parent usage isolation. Two localhost fixtures initially
  failed under the restricted sandbox; the complete rerun with localhost access passed.
- `KOURO_TEST_PORT=43284 bun run test:browser tests/browser/sessions.spec.ts`:
  **9 passing browser tests**, including empty-row filtering, meaningful thinking,
  readable tools, split panes, scoped interruption/retry and durable reload.
- `KOURO_LIVE_SUBAGENT_HARNESS=codex KOURO_LIVE_SUBAGENT_MODEL=gpt-6-luna bun test packages/host/test/live-subagent.test.ts`:
  **2 passing native tests**, including observed positive token counters in the
  returned result and durable coordinator attempt.
- `KOURO_TEST_PORT=43285 KOURO_LIVE_BROWSER_MODEL=gpt-6-luna bun run test:browser:native --grep 'parent and child are visible'`:
  **1 passing native browser test**. Actual parent/child results and observed token
  counts are rendered, and counts remain visible after reload.
- Typecheck, lint, formatting, `git diff --check` and the CLI build pass. The rebuilt
  distribution contains these fixes. The existing web chunk-size warning remains.

These checks cover the reported regressions, not a new complete v1 parity or
production sign-off. The active operator host was not restarted.

## Live messages, fullscreen and Pi usage follow-up — 2026-10-02

Agent sessions can toggle between a window and the full viewport while retaining
the transcript, split panes and controls. Native message/block identities now keep
separate assistant messages and reasoning blocks distinct across intervening tool
and status events. Completed snapshots repair missing text without duplicating the
stream. Codex retains exposed reasoning content separately from its summaries;
summary-only output is labeled accordingly. Kouro cannot recover thinking that a
provider does not expose. Claude now explicitly requests partial messages and uses
one normalizer for streaming and retained history. Pi retains streamed and completed
text/thinking blocks through the same projection.

The coordinator no longer nests a child's structured text inside another text field,
which had hidden actual child messages even when their tool results were visible.
The session projection also reads that shape from older recorded runs. Structured
assistant deltas retain their message identities while being coalesced before
journaling. Diagnostics now show recorded provider warnings/errors, failed tools,
and invocation/attempt failures live and after reload. Successful nodes without
warnings retain an explicit empty state.

The installed Pi SDK 0.82.1 llama.cpp provider disables streamed usage by default.
Kouro now enables `supportsUsageInStreaming` on the selected invocation's model
copy, causing requests to include `stream_options: { include_usage: true }`.
Saved provider settings and the shared catalog are unchanged. The existing local
server returned positive token counters; no server-side setting needed changing.
SDK default zero counters remain unavailable instead of being presented as observed
usage. Positive SDK pricing calculations are estimates; absent local-model pricing
remains unavailable rather than reporting a fabricated zero-dollar cost. Older runs
without recorded counters cannot be backfilled.

Verification for this follow-up:

- `bun test packages scripts`: **204 passing tests**, zero failures. Coverage includes
  live/retained Codex, Claude and Pi text/thinking, incomplete-snapshot repair, child
  attribution, older nested child records, diagnostics, streamed usage requests and
  unavailable default counters. An initial failure expected an unchanged resolved
  model; the assertion now verifies the invocation-only usage override and confirms
  that the catalog model was not mutated.
- `KOURO_TEST_PORT=43284 bun run test:browser tests/browser/sessions.spec.ts`:
  **9 passing tests**, including separate summary/content blocks, one assembled
  assistant message, fullscreen toggling, diagnostics, narrow-screen controls and
  replay. The fullscreen screenshot was visually inspected.
- `KOURO_TEST_PORT=43284 bun run test:browser --output /tmp/kouro-session-browser-final-results`:
  **28 passing tests**, zero failures, including the session cases above and existing
  workbench, review/repair, checkpoint, evaluation and collaboration journeys. The
  unchanged large-data budgets pass with 500 graph nodes and 10,000 timeline spans:
  graph 1,575 ms, selection 131.8 ms, 17 rendered bars and scrolling p95 16.8 ms.
- `KOURO_TEST_PORT=43285 KOURO_LIVE_BROWSER_MODEL=gpt-6-luna bun run test:browser:native --output /tmp/kouro-session-native-codex-results`:
  **3 passing native Codex browser tests**. Actual assistant messages appear in both
  parent and child panes; token counts survive reload; steering and cancellation
  pass. The initial child-message assertion exposed the nested attribution defect
  described above; this final run verifies its correction.
- `KOURO_LIVE_SUBAGENT_HARNESS=pi KOURO_LIVE_SUBAGENT_MODEL=llama.cpp/qwen36-35b-a3b-256k-vision-mtp bun test packages/host/test/live-subagent.test.ts`:
  **2 passing native Pi tests** for direct and coordinator-owned parent/child execution.
- `KOURO_TEST_PORT=43286 KOURO_LIVE_BROWSER_HARNESS=pi KOURO_LIVE_BROWSER_MODEL=llama.cpp/qwen36-35b-a3b-256k-vision-mtp bun run test:browser:native --grep 'parent and child|cancellation' --output /tmp/kouro-session-native-pi-results`:
  **2 passing native Pi browser tests**. Actual assistant messages appear in both
  panes, positive token counts remain visible after reload, and cancellation drains
  the provider. The earlier run passed message checks but exposed false zero usage;
  enabling the streamed usage request fixed the final run. Pi's previously documented
  queued-steering limitation remains open; this follow-up does not retest steering.
- A current read-only `claude auth status` check using the installed SDK binary
  reports `loggedIn: false`, `authMethod: none`. Claude normalization has adapter
  coverage; native acceptance remains blocked by login. No authentication was changed.
- Typecheck, lint, formatting, `git diff --check`, CLI build and bundled CLI help pass.
  The existing web chunk-size warning remains.

The active operator host was not restarted. A host restart after active work finishes
is required to use the rebuilt adapters and client. These results verify the repaired
paths, not complete v1 parity or blanket production readiness.

## Remaining release gates and v1 gaps

1. **Provider configuration:** this machine's configured Codex default `gpt-6.1-sol` was rejected by its ChatGPT account. Explicit `gpt-6-luna` parent/child settings completed native tests. Parent and child model controls are now exposed separately. For Pi on the user's local server, select `llama.cpp/qwen36-35b-a3b-256k-vision-mtp` on each intended node while that model is loaded; the saved Pi default names an unloaded model. Claude needs login. No account/configuration file was changed and no silent model fallback was added. A client model catalog alone does not prove successful inference.
2. **Native acceptance breadth:** Codex split view, steering and cancellation pass through the rendered browser. Pi's real Qwen parent/child execution, browser split view, reload persistence and cancellation pass in the October 2 follow-up. Its long-response steering test exceeded the acceptance deadline; prompt steering responsiveness remains open. Claude acceptance is blocked by login. Pi/Claude thinking normalization retains source/fixture coverage. Target-machine multi-provider testing and sustained native runs remain open.
3. **Recovery scope:** retry remains restricted to failed/cancelled attempts on unconsumed root agent/command effects, with budget remaining and no unconfirmed shutdown. Nested/consumed results require dependency-safe invalidation. Provider reattachment after host restart and eligible skip remain unavailable. Scoped Interrupt agent and whole-run Cancel run are separate supported controls.
4. **Review workflow:** human request-changes requires a declared bounded route. The built-in and packaged feature gates now have one; previously pinned/custom gates without such a route retain approve/reject. A richer file-by-file review viewer remains v1 parity work.
5. **Other inputs and integrations:** ordinary typed root inputs are supported; complex/array schemas use a JSON input editor where simple fields cannot represent the schema. Ticket management and remote push/PR publication remain deferred.
6. **Retention/large outputs:** journal paging, more-than-4,000-observation browser acceptance and full artifact-backed large-tool output are verified. Sustained native-provider soak and retention policies remain open. Historical observations that were never recorded cannot be reconstructed.

No running deployment was restarted or release published. This evidence supports the repaired paths and rebuilt checkout, not deployment truth or complete v1 parity.

## External protocol references

Normalization was checked against the installed Codex-generated `ThreadItem`, dynamic-tool-output, and reasoning-summary notification types, and [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server). The [official account-flow guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) distinguishes a model catalog from successful inference. Pi service/model/tool behavior was checked against installed SDK 0.82.1 and the [official SDK documentation](https://pi.dev/docs/latest/sdk). Connection cleanup follows [React's effect guidance](https://react.dev/reference/react/useEffect); browser verification uses [Playwright's isolated web-server workflow](https://playwright.dev/docs/test-webserver).
