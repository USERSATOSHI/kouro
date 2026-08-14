# ADR-0038: Agents may consume declared durable context sources

- Status: Accepted
- Date: 2026-08-14

## Context

Kouro preserves one agent's provider session across repeated invocations and
forwards the immediate transition source output as workflow feedback. That does
not let a different agent consume useful findings produced elsewhere. For
example, an implementer cannot receive the structured findings of scouts used
by a planner, and a reviewer cannot receive outputs produced by other model
roles unless the workflow manually copies them through every transition.

Ambient access to every transcript would leak undeclared information, couple
workflows to provider-specific reasoning formats, and make prompt construction
difficult to audit. A dynamic shared mutable memory would also violate the
determinism contract unless every write and read became durable orchestration
state.

## Decision

An agent handle exposes `withContextFrom(...sources)`. A source is another
agent handle or a declared subagent handle owned by the same
`WorkflowBuilder`. The builder stores normalized context-source references on
the consuming agent node, and compilation includes them in the workflow
checksum.

Only structured durable outputs are shared:

- an agent source contributes the latest prior successful invocation output;
- a subagent source contributes successful child outputs recorded by prior
  parent attempts;
- raw transcripts, hidden reasoning, tool logs, resume tokens, failures, and
  provider session state are never shared through this contract.

Context is rendered in canonical source order and child activation order. A
consumer sees only outputs recorded before its current invocation. When a
provider session is resumed, Kouro sends only context produced after that
agent's latest successful invocation, preserving the existing feedback-delta
behavior instead of repeating old context.

Subagent execution summaries therefore retain their validated structured
output in addition to operator metadata. These summaries remain subordinate
records, not scheduler inputs or independently recoverable attempts.

Missing context is valid. A declared source may not have run on the selected
path, may have failed, or may have produced no output. Kouro injects a shared
context section only when at least one eligible durable value exists.

## Consequences

- Workflow authors can explicitly connect scout, planner, implementer, and
  reviewer knowledge without provider-specific tools.
- Context authority is visible in the compiled workflow rather than inferred
  from graph adjacency or ambient transcripts.
- Cross-model sharing works because the boundary is provider-neutral JSON.
- Large reports should continue to use artifacts; this first version shares
  structured agent outputs of the same class already stored in invocation
  events.
- Changing context-source declarations changes the compiled checksum. Existing
  bundles and event histories remain readable because the new node and summary
  fields are optional.

## Alternatives considered

### Share all previous agent transcripts automatically

Rejected because it leaks undeclared reasoning and tool data, increases prompt
cost unpredictably, and makes provider behavior part of the workflow contract.

### Add a mutable shared-memory tool

Deferred. A tool would support on-demand reads but requires durable write/read
semantics, authorization, size limits, recovery rules, and equivalent support
across every harness.

### Forward context only through transitions

Rejected because it forces unrelated nodes and approval stages to become data
plumbing and cannot naturally address subagent calls nested under another
agent.
