# ADR-0041: Durable invocation wall-clock spans

- Status: Accepted
- Date: 2026-08-14

## Context

The run timeline positions every invocation in an equal-width activation slot.
That makes graph order inspectable, but it hides whether an invocation took a
second or an hour. The durable run state contains a run-level clock observation
but no invocation-level wall-clock span, so the web console cannot derive real
durations without inventing data.

Timeline block selection is also keyed by node definition. Repeated activations
of one node therefore appear selected together even though each block represents
a distinct `NodeInvocation`.

## Decision

Kouro records optional ISO-8601 timestamps on invocation lifecycle events:

- `invocation.activated.activatedAt` starts the span;
- terminal invocation events carry `finishedAt`.

The reducer validates each supplied timestamp and projects it onto the matching
`NodeInvocation`. The coordinator supplies timestamps through its injected
clock. Reducers, schedulers, and the web client never read a hidden clock when
reconstructing durable state.

The timeline uses those projected spans for a wall-clock axis. An unfinished
invocation extends to the web client's current observation time. A small visual
minimum keeps zero-duration and very short invocations selectable without
misrepresenting their duration in the tooltip. Histories without timestamps use
the existing activation-order layout and say so in the legend.

Subagent summaries do not carry independent lifecycle timestamps. They remain
point markers at their parent activation rather than borrowing the parent's
duration and presenting it as child runtime.

Timeline block selection uses the block's durable identity (invocation sequence
for workflow nodes and call identity for child markers), while lane selection
remains node-definition selection. Repeated activations are therefore
independently selectable.

## Invariants

- Ordered event replay produces the same recorded invocation timestamps.
- A supplied finish time cannot precede its activation time.
- Existing events and projections remain valid because all timing fields are
  optional.
- Invocation sequence remains the durable identity; timestamps are presentation
  data and never scheduler inputs.

## Alternatives considered

- **Use browser receipt time.** Rejected because refresh and network latency
  would change completed durations.
- **Timestamp SQLite rows only.** Rejected because timing would disappear behind
  the `RunStore` port and other adapters could not reproduce the same projection.
- **Estimate duration from event sequence.** Rejected because sequence has no
  relationship to elapsed wall-clock time.

## Compatibility

No database migration is required. Events and projections are JSON, and omitted
timing fields preserve the previous behavior for existing histories.
