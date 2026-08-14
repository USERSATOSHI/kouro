# ADR-0037: Project subordinate executions into operator diagrams

- Status: Accepted
- Date: 2026-08-14

## Context

ADR-0031 deliberately models bounded subagents as subordinate effects of a
parent agent attempt rather than independently scheduled graph invocations.
Their completed transcripts are durable, and ADR-0035 makes their in-progress
activity observable, but the run flow and timeline currently omit them. The
operator therefore cannot see where delegation occurred or attribute reported
token usage and estimated cost to an individual child execution.

Promoting subagents to `NodeInvocation` or `NodeAttempt` would give them
recovery and scheduling semantics they do not have. Reading every transcript
artifact to reconstruct basic execution metadata would also make ordinary run
presentation depend on large artifact I/O.

## Decision

Each parent `NodeAttempt` may retain an ordered list of subordinate execution
summaries. A summary contains the stable child call ID, declared subagent ID,
delegated task, harness and model selection, result state, and best-effort token
usage reported by the child harness. Cost remains derived presentation data
and is never persisted.

The summaries are recorded by one append-only event while the parent attempt
is active. They are audit and projection metadata only:

- they are not workflow nodes, node invocations, node attempts, or scheduler
  inputs;
- they do not receive transitions, retries, approvals, recovery, or independent
  lifecycle controls;
- reducer validation binds them to the active parent attempt and rejects
  malformed or duplicate call IDs;
- a missing summary or missing usage remains valid because harness telemetry is
  best-effort.

The API also exposes declared subagent definitions and their authorized parent
node IDs. Operator diagrams may render these declarations as visually distinct
child roles connected to their parents. The timeline projects each recorded
child call at its parent's durable invocation tick and labels it as subordinate
rather than assigning it an invented workflow activation sequence.

Top-level workflow blocks and subordinate child blocks display reported token
usage and derived cost directly. An unpriced model is shown as unpriced; Kouro
does not present a partial monetary subtotal as complete.

## Consequences

- Operators can see declared child roles in flow and graph views.
- Each completed child call appears in the timeline beneath its parent role
  with its own usage and cost estimate when available.
- Run replay reconstructs the same subordinate summaries without reading
  transcript artifacts.
- Existing event histories remain valid because the new attempt field and event
  are additive.
- Subagent summaries increase event and projection size in proportion to the
  already bounded `maxInvocations` declarations, but transcripts remain outside
  the event stream.
- Durable, independently recoverable child agents still require a separate ADR.

## Alternatives considered

### Promote subagents to workflow nodes

Rejected because it would contradict their parent-owned lifecycle and imply
independent scheduling and recovery.

### Parse transcript artifacts in the browser

Rejected because basic diagram rendering would require eagerly downloading and
parsing potentially large transcripts, and live and completed runs would use
different authorities.

### Show usage only in the transcript drawer

Rejected because it does not solve execution-shape or per-child cost
inspectability in the primary flow and timeline views.
