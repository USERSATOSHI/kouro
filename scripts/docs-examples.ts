export const docsExamples = [
  {
    id: "first-workflow",
    title: "Your first workflow",
    category: "basics",
    description:
      "A small, complete example of inputs, a structured agent output, and a terminal result.",
    task: "Plan an endpoint that exports a user's saved items as JSON.",
    flow: ["Task", "Plan", "Result"],
    notes: "Start here to learn the builder. It plans only; it does not implement the task.",
    files: [],
  },
  {
    id: "feature-fusion",
    title: "Feature development with fusion",
    category: "development",
    description:
      "Two models scout and plan a feature, cross-review twice, and synthesize an approval-ready implementation plan.",
    task: "Add cursor pagination to GET /items. Preserve filters and ordering, reject malformed cursors, and test page boundaries.",
    flow: [
      "Parallel plans",
      "2 review / revision cycles",
      "Synthesis",
      "Approval",
      "Implement",
      "Install + typecheck + tests",
    ],
    notes:
      "Targets an existing Bun/TypeScript project. Configure both model IDs. Every member stage must await its declared repository scout. Synthesis is a distinct agent and session, even when using model A. A changes-requested decision ends this example's run; revise the task and launch a new plan. Each failing check allows two repairs. Dependency installation failures stop execution.",
    files: ["support.ts"],
  },
  {
    id: "chore",
    title: "Repository maintenance",
    category: "development",
    description:
      "A required repository scout maps the change, its accepted report reaches the worker, and deterministic checks validate the result.",
    task: "Remove the deprecated legacy cache adapter, update imports and docs, and preserve the active adapter's public behavior.",
    flow: ["Scout + plan", "Change", "Install", "Typecheck", "Tests"],
    notes:
      "Targets a Bun/TypeScript repository with a typecheck script. Edit the commands to match the task: a docs-only chore may need link validation instead of the full test suite. There is no approval gate in this example. Each failed check allows one repair. The agent's change report is a claim; successful commands provide the validation evidence.",
    files: ["support.ts"],
  },
  {
    id: "bugfix",
    title: "Reproduce, fix, and prove a bug",
    category: "development",
    description:
      "Write a regression test, require it to fail, confirm it demonstrates the reported bug, then fix and run the full suite.",
    task: "Repeated POST /items requests with the same idempotency key create duplicate records. Add a regression test and preserve response compatibility.",
    flow: [
      "Diagnose",
      "Write regression",
      "Require failing test",
      "Confirm reproduction",
      "Fix",
      "Suite + typecheck",
    ],
    notes:
      "The example writes tests/regression/bug.test.ts; choose a unique path for your project. Exit code 1 alone cannot distinguish a real reproduction from a test setup error, so an operator reviews the command evidence before the fix. Reproduction feedback allows one retry; each subsequent check allows two repairs. Bun must report success with exit code 0 after the fix.",
    files: ["support.ts"],
  },
  {
    id: "deep-research-fusion",
    title: "Deep research with fusion",
    category: "research",
    description:
      "Independent researchers search primary sources, challenge each other's evidence twice, and produce a cited report with unresolved questions.",
    task: "Compare PostgreSQL and SQLite for a local-first application with concurrent workers. Investigate durability, contention, operational cost, and migration constraints using current primary sources.",
    flow: ["Independent research", "Evidence reviews", "Revised reports", "Cited synthesis"],
    notes:
      "Configure authenticated Codex and Claude models. repository.read provides supplied material; network.access enables Codex live search and Claude WebSearch/WebFetch in this checkout. Provider availability and authentication still determine whether a tool succeeds. Each stage is a fresh invocation; citations and open questions travel in structured outputs. The example extends the run deadline to one hour. Pi's base toolset has no dedicated search tool.",
    files: ["support.ts"],
  },
  {
    id: "spec-implementation",
    title: "Implement a detailed specification",
    category: "orchestration",
    description:
      "An orchestrator supplies an approved spec as task. A planner assigns a dependency graph to complete Bun or Rust implementation workflows.",
    task: "Implement the approved inventory API specification. Bootstrap the project and shared contracts first; then build independent catalog and stock modules; integrate after both. Preserve the specified errors and persistence behavior, and add acceptance tests.",
    flow: [
      "Detailed spec",
      "Validated milestone plan",
      "Ready workers in parallel",
      "Dependency joins",
      "Private delivery",
    ],
    notes:
      "Supply the full spec text, not a path workers may not see. Each worker plans, waits for approval, implements, and checks its private worktree. Task text must retain relevant requirements; completed prerequisite results are appended by the scheduler. Bun workers require a lockfile and typecheck/test scripts; Rust workers require Cargo metadata and a lockfile. The implementer has explicit terminal/network grants for setup. Milestones are capped at six, concurrency at two, and the run deadline at two hours. Dependencies determine order; maxConcurrent: 1 only limits admission. Final file changes remain in private delivery until explicitly integrated. Configure deadlines and limits for your project.",
    files: ["support.ts"],
  },
  {
    id: "agent-swarm",
    title: "One task, several models",
    category: "orchestration",
    description:
      "Declare the model list, give every member the same task, run them concurrently, and have a separate agent combine their findings.",
    task: "Inspect the queue implementation and identify plausible causes of duplicate job execution, citing file paths and evidence.",
    flow: ["One shared task", "Parallel members", "Wait for all", "Synthesis"],
    notes:
      "This authored swarm is a read-only repository investigation. Configure the model IDs. It uses one parallel pass and synthesis, without fusion review rounds. Use a separate synthesis handle; reusing a model does not reuse its session. To use the built-in swarm instead, open Agent swarm, select 1–8 model/harness pairs, enter the task, and start. The first selected model synthesizes; a single-model swarm returns its answer directly. There is currently no dedicated swarm CLI command; a custom swarm workflow can run through kouro run.",
    files: ["support.ts"],
  },
] as const;
