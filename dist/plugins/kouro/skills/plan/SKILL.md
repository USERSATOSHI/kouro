---
name: plan
description: Produce a detailed canonical specification and plan with Kouro fusion when the user requests planning.
---

Read [CLI commands](../implement/references/commands.md) before execution.
Default to the invoking session's current project when no project is specified.

# Produce the canonical spec with fusion

Use an existing user-selected fusion planner when one is supplied. If the spec
is already supplied, consume it and skip this planning phase. Fusion planning
can come from another tool; it does not have to be a Kouro run.

When authoring a Kouro planner, the `feature-fusion` starter is a planning-only
workflow in this version. Create it from the target project:

```sh
kouro create template spec-planning --template feature-fusion
```

Inspect the generated package before running it. Replace `model-a`, `model-b`
and `model-fusion` with verified selections; declare the corresponding harness
on each agent. Configure the requested review rounds (the starter uses two).
Grant repository-read access to planning agents when repository context is
needed, especially for ports. Planning should not implement application code.
Execution requires a Git repository with a committed HEAD. For a greenfield
project, initialize Git and commit the planning configuration and required
inputs first, without including unrelated changes.

Agents, including synthesis, are declared with `workflow.agent`. Subagents use
`workflow.subagent`. Compose the existing agent handles with:

```ts
const fusion = workflow
  .fusion("planners", {
    task,
    rounds: reviewRounds,
    reviewProduces: Summary,
    reviewPrompt,
    revisionPrompt,
    synthesis: synthesizer,
  })
  .use(plannerA, plannerB);
```

Do not replace handles with ad hoc member objects. Keep model identity and
ownership attached to the declared agents. Reviews and revisions retain the
member's selected model; synthesis combines the latest revised outputs.

Adapt the draft, review, revision and synthesis prompts to produce the user's
requested detailed spec and implementation plan. Capture:

- Goals, scope and explicit exclusions.
- Requirements and concrete acceptance criteria.
- Architecture, interfaces, data formats and operational constraints.
- Milestone dependencies and validation for each phase.
- Decisions resolved by synthesis, assumptions and unresolved questions.
- Migration behavior and parity criteria when porting an existing codebase.

The starter's output is JSON with a `summary` string. That string can contain
the canonical Markdown spec and plan; do not reduce a detailed spec to a short
summary just because of the field name. If using another output schema, inspect
that schema and retrieve its actual canonical fields.

Execute a configured planner with:

```sh
kouro run spec-planning --task "Produce the detailed specification and implementation plan for THE USER'S REQUEST; do not implement the application."
```

Retain the run ID and inspect its final output. `kouro inspect RUN_ID` contains
artifact references; it does not automatically print their contents. Use the
available artifact reader or Kouro's UI to retrieve the completed canonical
output. For CLI-only access, the packaged [output reader](../implement/scripts/read-output.ts)
reads a saved inspection view and verifies immutable blob checksums:

```sh
kouro inspect RUN_ID > /tmp/kouro-planning-view.json
bun /path/to/plugin/skills/implement/scripts/read-output.ts \
  /tmp/kouro-planning-view.json /absolute/path/to/project/.kouro-data
```

It prints output JSON and does not write project files. Extract and preserve
the canonical spec and plan in the project as appropriate, then submit the
implementation task described by the skill. Keep the same state directory
for inspection. Resolve pending planning gates before claiming a final spec.
