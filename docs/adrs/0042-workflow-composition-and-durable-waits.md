# ADR-0042: Compile workflow composition and record durable waits

- Status: Accepted
- Date: 2026-08-31

## Context

Coding workflows need reusable nested workflows, isolated parallel writers,
bounded collection fan-out, timers, targeted external events, and portable
tracing. Runtime graph mutation or ambient clocks would violate Kouro's replay
contract, while shared-worktree concurrency would make repository effects
unsafe.

## Decision

Trusted local ADW packages remain the only workflow source. The package
compiler expands calls and branch templates into compiler-reserved,
namespaced nodes in immutable IR 5 bundles. Parent permissions, defaults, and
run limits remain authoritative. Child permissions must be a subset of the
parent and recursive package references are rejected.

Parallel and `forEach` nodes create durable groups. Branch identity is the
declared branch ID or zero-based item index. Branch activations are selected in
canonical identity order and may execute only in deterministic isolated
workspaces. A join waits for every branch, fails when any branch failed, and
reports conflict for overlapping changed paths or Git conflicts. Successful
trees are integrated in canonical order only after the parent HEAD is
verified.

Collection values are resolved from one named prior invocation output and are
recorded canonically before scheduling. Values become immutable invocation
input; duplicate values remain distinct because identity uses the item index.

Sleep and event-wait nodes enter explicit waiting states through durable
events. The coordinator supplies schedule, due, receipt, and timeout
timestamps. The scheduler observes only recorded time. External events target
one invocation; expected event sequence and idempotency decide races, so the
first committed event or timeout wins.

Trace views are derived from the pinned workflow and durable state. Trace and
span IDs are stable hashes of Kouro identities. Optional exporters execute
outside the runtime, and exporter failures never affect scheduling or run
success.

## Invariants

- Composition never increases permissions or run limits.
- Generated `@call`, `@parallel`, and `@forEach` IDs cannot be authored.
- Equal IR and ordered events produce equal groups, inputs, waits, traces, and
  next intents.
- Parallel writers never share a worktree.
- Fan-out is bounded at compile time and again at durable expansion.
- Event delivery has no global correlation bus and cannot wake another
  invocation.
- Existing IR 4 artifacts and histories retain their meaning.

## Compatibility

New package compilations emit compiler 0.5.0 and IR 5. Runtime loading remains
structural and accepts persisted IR 4 artifacts. SQLite event and projection
storage remains additive JSON, so no destructive migration is required.

## Exclusions

Remote workflow installation, mutable workflow registration, signing,
administrator bypasses, and shared-worktree parallelism remain excluded.
