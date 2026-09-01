# Kouro Runtime Invariants

These invariants are the acceptance boundary for the deterministic simulator.

## Deterministic replay

1. A compiled bundle is immutable and identified by the checksum of its
   canonical bytes.
2. Projection is a pure function of the compiled bundle and ordered durable
   events.
3. Scheduling is a pure function of the compiled bundle and projected state.
4. Equal canonical inputs produce byte-identical projected states and ordered
   orchestration intents.
5. Reducers and schedulers do not read clocks, randomness, environment
   variables, filesystems, databases, networks, or process-global state.
6. Orchestration intents do not contain infrastructure-assigned IDs,
   timestamps, event sequences, or leases.

## Execution identity

7. A node definition is not an execution record.
8. Every node invocation references exactly one definition and has a durable
   invocation sequence.
9. Every node attempt references exactly one invocation and has a positive,
   invocation-local attempt number.
10. A graph transition creates an invocation; an operational retry or harness
    fallback creates an attempt.
11. A succeeded invocation cannot receive another attempt.

## Transitions

12. A completed sequential invocation selects exactly one outgoing transition.
13. Multiple matching transitions are a typed `ambiguous_transition` failure.
14. No matching transition without an explicit default is a typed
    `missing_transition` failure.
15. Transition declaration order does not affect selection.
16. A default is considered only when no non-default transition matches.
17. Parallel fan-out is explicit, bounded, isolated, and joined in canonical
    branch-identity order.
18. Conditions use a versioned restricted expression language.

## Counters and limits

19. A loop counter changes only when a selected transition declares an
    increment for that counter.
20. Attempts do not change graph loop counters.
21. Counters are part of projected state and never inferred from logs or live
    effects.
22. A transition whose bound is exhausted cannot be selected.
23. Every compiled graph cycle names at least one bounded counter incremented by
    a transition in that cycle.

## Recovery

24. Recovery decisions use only recorded attempt state and the operation's
    snapshotted recovery policy.
25. `replay_safe` may create a new attempt.
26. `verify_then_replay` emits a verification intent before any replay.
27. `resume_supported` emits a resume intent only when a durable resume token
    exists; otherwise it requires reconciliation.
28. `manual_reconciliation` never schedules automatic execution.
29. `never_automatically_retry` never schedules automatic execution.
30. Recovery policies describe deterministic decisions, not exactly-once
    external effects.

## Durable boundaries

31. All event payloads and expected failures are serializable.
32. Decision-affecting configuration is snapshotted into the run.
33. The starting repository commit is pinned before execution.
34. Approval identity includes the workflow checksum, invocation, relevant
    artifact checksums, resolved action, and repository HEAD.
35. Historical execution never reopens mutable source prompts, schemas,
    manifests, or subworkflows.
36. Run-duration decisions use durable observed timestamps, never scheduler
    clock reads.
37. Node-invocation limits count graph activations, not attempts.
38. Approval bindings include every artifact checksum published before the
    approval request.
39. Pause prevents new scheduling without implying attempt interruption.
40. Interrupt, retry, cancellation, and skip are durable actor-attributed
    events.
41. Retry is accepted only when the declared recovery policy permits it.
42. Skip requires a declared node outcome and binds the workflow checksum,
    invocation, artifacts, selected outcome, and repository HEAD.
43. A local run snapshots its ADW, harness order, permissions, repository,
    worktree, delivery branch, and operator before execution.
44. Agent steering binds to one active invocation and attempt, is recorded
    before delivery, and never changes graph structure, permissions, limits, or
    scheduler counters.
45. Nested calls and branch templates are compiler-expanded and cannot increase
    parent permissions, defaults, or run limits.
46. Collection expansion, timer scheduling, observed time, and external event
    receipt are durable facts before they influence scheduling.
47. Parallel writers use distinct workspaces and auto-join only disjoint paths.
48. External events target one waiting invocation; expected sequence and
    idempotency make the first durable timeout or receipt win.
49. Trace identifiers and parent relationships are derived only from durable
    Kouro identities.
