---
name: implement
description: Use Kouro workflows to implement a task or a fusion-produced spec and plan, including greenfield projects and language ports, with dependency scheduling and preserved approval gates.
---

The intended handoff is: fusion produces one canonical specification and plan;
you, the orchestrating AI, submit those requirements as a Kouro task; Kouro
assigns milestones to workflows and executes them. You may be Claude, Codex or
another caller. Keep these responsibilities separate when selecting commands.

Read [CLI commands](references/commands.md) before invoking Kouro. Resolve the
actual CLI, target project, provider choices and state directory. Default to the
session's current project when the user does not specify another; do not ask
them to repeat its path. Preserve the user's workflow, model and approval
decisions. Use a supplied specification directly; do not rerun fusion or rewrite
its requirements merely to launch work.

## Specification handoff

If the user wants fusion to produce the spec, follow the [planning skill](../plan/SKILL.md).
Use the final synthesis output after the requested review rounds, not an
individual draft or a mixture of competing drafts. Retrieve its actual content;
an artifact ID or run ID is not the specification. Preserve unresolved questions
and any planning approval gates.

Treat the resulting spec and plan as authoritative implementation input. Retain
the requirements, interfaces, constraints, exclusions, dependencies and
acceptance criteria. Kouro's task planner maps this input into executable
milestone assignments; it should not redesign the product or silently expand
the approved scope. Give every milestone enough context to satisfy the spec.

A task string is limited to 20,000 characters. For a detailed specification,
save the canonical content in project files, following existing conventions
(for example `docs/spec.md` and `docs/plan.md`). Commit those specific files so
Kouro's isolated worktrees can read them; do not include unrelated changes.
Use a short task referring explicitly to both documents and their authority.
Files only in your chat or outside the repository are not automatically visible
to Kouro's agents. An inline task can contain the full spec when it fits the
limit; do not truncate a spec to make it fit.

```sh
kouro task run \
  --task "Implement docs/spec.md following docs/plan.md. Preserve the specified scope, dependencies and acceptance criteria; use planning only to assign executable milestones." \
  --workflow develop \
  --harness claude --model USER_SELECTED_MODEL \
  --max-milestones 8 --max-concurrent 1 --idempotency-key REQUEST_KEY
```

The workflow, harness and model in this example must match the real
project and the user's choices. Fusion completion does not currently launch a
task automatically. The caller performs this handoff. There is no CLI flag for
importing an already-written milestone DAG; do not invent one.

## Greenfield setup

For a new project, create the requested directory, ignore `.kouro-data/`, and
initialize Git with a committed HEAD containing the spec and plan. Prepare the
workflow configuration and validation commands, leaving application
implementation to the assigned workflows. Include minimal project scaffolding
in the first milestone when it is part of the spec. Do not commit unrelated
existing work. Files needed by worktrees must be committed.

Discover project workflows with `kouro task workflows --workspace PROJECT`.
Create an editable starter when needed with
`kouro create template develop --template feature` from the project directory.
Adapt its prompts and validation commands to the target language before launch;
the feature starter's Bun commands are not suitable for every project. Use
`workflow.agent` for agents, `workflow.subagent` for subagents and `.use` for
composition. Keep existing workflow approval gates. Avoid the built-in
walking-skeleton workflows for real implementation.

## Sequential and parallel work

Dependencies determine which milestones may start. A foundation, schema or
interface needed by later work must be an explicit prerequisite. For a required
sequence, describe the chain in the canonical plan and in the submitted task;
`--max-concurrent 1` limits concurrency but does not create missing dependency
edges. Start sequentially for tightly coupled work unless the user specifies
otherwise. Use parallel execution for independent work after its shared
prerequisites, within the user's chosen concurrency limit.

Even with `--max-concurrent 1`, a selected workflow may contain its own parallel
agents or fusion rounds. If the user requires all execution to be sequential,
choose or author sequential implementation workflows; preserve requested
parallel fusion planning as a separate phase.

Kouro supports at most 12 milestones per task. For a larger detailed plan,
retain the complete plan and choose a bounded phase with the user-authorized
scope. Deliver or otherwise explicitly provide completed prerequisites before
launching another phase; unrelated runs do not share private worktrees
automatically. Never drop requirements to fit the milestone limit.

For a language port, preserve observed source behavior and explicitly identify
intentional compatibility changes. Capture source tests and representative
fixtures before rewriting; compare old and new behavior rather than treating a
successful target build as parity. Establish shared interfaces before parallel
module ports, adapt validation to the target language, and retain the source
implementation through review unless the migration plan authorizes replacement.
Required source context must be available inside the milestone worktrees.

## Run, approvals and delivery

Let Kouro own scheduling, dependencies and worktrees. Retain the started run ID
and a stable creation key. Keep long-running commands in the caller's managed
job mechanism and await their result. Inspect the existing run after an
uncertain response instead of creating duplicate work.

When task output includes `dashboardUrl`, share that link in the first progress
update so the user can open the live task. Keep it in the final task report too.

Report pending gates and their current revision, binding digest and invocation
ID. Use the user's decision for that specific gate, including decisions already
authorized in the session. A broad implementation request does not implicitly
accept every future gate. Stale decisions require fresh inspection. `resume`
does not accept undecided gates. The CLI reference covers decision commands,
state ownership and exit codes.

Completed code is in the reported private run workspace. Inspect it and run
the spec's acceptance checks before delivery through Kouro's existing Delivery
flow. Report the run ID, milestone results, checks actually performed, pending
decisions and result location. Distinguish fixture acceptance from live provider
execution and private-worktree success from changes integrated into the source
checkout.
