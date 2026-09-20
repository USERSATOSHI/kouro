# M1: local Elysia workbench and explicit execution

Accepted for implementation 2026-09-18 by the user's M1 instruction.

Use ElysiaJS instead of Hono, with Bun SQLite, three workspaces (core, host, web),
React/Vite and React Flow. Core has no host/browser framework dependencies. M1
implements agent/command/complete only, with a scripted harness and a real contained
fixture command. Future node kinds fail compilation until implemented.

Structured output is optional dataflow. An agent with no declared schema has no
typed output handle. Runtime evidence, immutable artifacts and workspace resources
remain distinct. Commands expose standard results automatically, including nullable
exit status and termination/spawn failure evidence. Custom parsed output never erases
that result. Agent/harness observations may be unavailable; no fabricated evidence.

Repair authoring (M3) uses `.repair(target, { maxRepairs, feedback, exhausted })`,
lowered to a bounded counter/guard/increment/edges. Three repairs means three extra
passes, not three total attempts. Low-level counters remain available. UI distinguishes
repair passes from execution attempts. No repair runtime primitive is introduced.

Durable run events, projected execution state and outbox reservations commit in one
transaction. The host owns effects; graph and timeline share one execution view.
SSE replays after the snapshot revision then stays open for committed updates.
Unknown claimed effects require reconciliation after restart; no blind re-execution.
Active bars interpolate elapsed display time, without inventing execution events.

M1 may send whole small execution-state replacements in revisioned frames; this is
an explicit transport simplification only. It does not replay history for normal
reads and can evolve to entity patches without changing execution meaning. Browser
does not duplicate workflow transition logic.

Required command containment fails closed. No automatic unrestricted fallback.
M1 is not production hosting, a real model integration, Git worktree execution or
the later parallel/collaboration/evaluation milestones.
