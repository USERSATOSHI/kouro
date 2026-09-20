# M8.2 storage and recovery hardening

The host keeps the SQLite journal and content-addressed blobs under one data
directory. `exportBackup()` uses SQLite `VACUUM INTO`, so the exported database
is a consistent snapshot even when the live database has a WAL. The export
contains `manifest.json`, the SQLite SHA-256/length, and the immutable blobs
referenced by the SQLite snapshot (not blobs committed after that snapshot).
`verifyBackup()` is read-only and rejects missing, unexpected,
or corrupted bytes; `restoreBackup()` verifies before copying and verifies the
new directory again after copying. The snapshot boundary is tested by committing
another artifact immediately after `VACUUM INTO`; it is absent from the restored
database and manifest while the earlier artifact remains readable. This is a local backup primitive, not an
external publishing mechanism.

Recovery boundaries are represented by `crashMatrix` in
`packages/host/src/storage/diagnostics.ts`. Reserved effects can resume;
claimed effects, approvals, workspace integration, and uncertain provider
operations require reconciliation or a fresh authority decision. Experiment
cells and checkpoint request keys are idempotent identities, so restart may
reuse the existing reservation/request rather than launch a duplicate.

## Projection query discipline

The following event reads are bounded/indexed and do not load full event
history: `Journal.getEvents(runId, after, limit)`, `Journal.getFrames(runId, after,
limit)`, `Journal.unresolvedEffects()`, and `Journal.getExperiment(id)` (cell
status index). Full lifecycle replay is reserved for explicit diagnostics.
The ordinary `/api/runs` endpoint uses `Journal.listRunsPage()` with a maximum
of 100 rows and an explicit offset. Internal recovery/genealogy enumeration can
still call `Journal.listRuns()` deliberately. An end-user "load older runs"
control now pages through the same endpoint in the sidebar; ordinary catalog
polling keeps previously loaded older rows visible.

## Recorded 500-node and 10,000-event fixture

Run `bun run scripts/benchmark-m8.ts` to compile a 500-node workflow ten times,
append 10,000 no-op lifecycle events to a tiny ordinary run, page its frames 100
times, and calculate the virtual timeline row window. On 2026-09-19, Linux x64,
Bun 1.3.14, Intel i5-1135G7, this recorded compile median/p95 35.68/46.86 ms,
100-frame read median/p95 0.29/0.36 ms, and a 26-row window at a 380px
viewport. The ordinary run-list page bound also has a regression test.

This backend fixture does **not** measure ReactFlow interactivity or browser
frame time. The separate browser fixture below covers those client-side paths.

## Browser large-data acceptance fixture

`bun run test:browser tests/browser/m8-performance.spec.ts` drives the production
Kouro app with a test-only wire fixture: `GraphPanel`/ReactFlow renders 500
compiled nodes and `Timeline` projects 10,000 invocations through its existing
virtual row window. The test records initial graph mount, graph-node selection
response, and 90 `requestAnimationFrame` intervals while scrolling the timeline.
It asserts 500 rendered graph nodes, 10,000 source invocations, selection under
250 ms, at least 80 sampled frames, and a p95 frame interval under 50 ms.

The reference environment is Linux x64, Chromium headless, Intel i5-1135G7,
2026-09-20. The 4,000 ms initial-mount budget and frame/selection budgets are
generous shared-CI acceptance signals, not universal device guarantees. The
fixture is test-only and does not alter production app behavior or claim backend
paging performance.

The first real-component run exposed a layout containment bug: the timeline
viewport grew with its SVG, rendering 4,311 bars and reaching an 83.3 ms p95
frame interval. Constraining the main-column grid item fixed that production
layout path. On the same reference machine, the focused Playwright rerun passed:
1,794 ms initial mount, 80.7 ms graph selection, 17 rendered timeline bars from
10,000 source invocations, and 16.8 ms p95 across 90 scrolling frames. These
are production-component measurements in a test-only data fixture, not a claim
about universal hardware or backend paging performance.
