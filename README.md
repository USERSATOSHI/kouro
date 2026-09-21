# Kouro v2

A local workbench for declarative agent workflows. Agents perform work; Kouro owns
orchestration; deterministic tools establish evidence.

This checkout is the from-scratch v2 implementation. It compiles declarative
workflows, runs them through a durable local coordinator, and exposes the same
execution state through a live graph, timeline, inspector, CLI and API. A scripted
harness lets you explore and test it without model credentials.

## Run locally

Requirements: Bun 1.3.14 or newer, Linux, and Bubblewrap (`bwrap`) with usable user
and network namespaces. Real command execution fails closed if containment is
unavailable. Git is required for workspace-backed runs and forks, but not for
pure workflow runs. No model credentials are needed for the scripted harness.

```sh
bun install
bun run dev
```

## Install the CLI

Install directly from GitHub, without cloning the repository:

```sh
npm install --global github:usersatoshi/kouro
```

Or with Bun:

```sh
bun add --global github:usersatoshi/kouro
```

Confirm the command:

```sh
kouro --help
```

The root GitHub package contains a bundled CLI distribution, including the
runtime code, starter templates, and web UI. It has no workspace or `file:`
dependency requirement. The CLI requires Bun at runtime.

For a one-off invocation without a global install:

```sh
bunx --package github:usersatoshi/kouro kouro --help
```

The host serves the built web application and API through ElysiaJS. Use the local
URL printed by the host. Keep the pairing token private. The server binds to
loopback; this is a local workbench, not a hosted service.

```sh
bun run kouro --help
bun run typecheck
bun run lint
bun test packages scripts
bun run build
bun run test:browser

# Scaffold an editable workflow package from a CLI-bundled starter
bun run kouro create template my-feature --template feature
```

Browser tests require Playwright Chromium (`bunx playwright install chromium`), or
set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing compatible Chromium executable.
Browser integration starts a real host with an isolated temporary data directory.

## Structure

- `packages/core`: browser-safe builder, compiler, plain workflow IR and reducer.
- `packages/host`: SQLite journal, scheduler/effect execution, harness adapters,
  workspace isolation, Elysia API and CLI.
- `packages/web`: shared run projection, graph, timeline, inspectors, experiments,
  collaboration and checkpoint surfaces.

Agent structured output is optional. Commands supply their standard result without
an author-provided schema. Runtime evidence, typed output, persisted artifacts and
workspace resources remain separate concepts.

Harnesses can be mixed per agent. `harnessId` overrides the run's execution profile;
when omitted, the run profile selects the harness:

```ts
workflow.agent("planner", {
  harnessId: "codex",
  modelId: "gpt-5",
  prompt: "Plan the change.",
});
workflow.agent("implementer", {
  harnessId: "pi",
  modelId: "llama.cpp/my-model",
  prompt: "Implement the plan.",
});
```

The supported native IDs are `codex`, `pi`, `opencode`, and `claude`. The configured
scripted adapter remains the default fallback. Each attempt records its resolved
harness and model in `resolvedExecution`. Availability is probed at runtime; a
missing CLI is reported as unavailable rather than silently falling back.

The current workbench includes approvals, bounded repair loops, parallel branches,
subworkflows, Git worktrees, normal-run evaluations, explicit bounded collaboration,
and checkpoint/fork primitives. Provider features are capability-gated: a scripted
collaboration test is not evidence that a real provider supports live messaging.
Workflow starters are distributed with the CLI and copied into `.kouro/<name>`;
their `kouro.ts`, `prompts/`, and `schemas/schema.ts` remain project-owned source.
The Pi RPC adapter has contract tests and a verified local-model tiny workflow run;
collaboration is still tested with scripted participants, not a live Pi swarm.
M7 fork acceptance and M8 hardening are complete for the documented local
reference fixture. Do not use checkpoints as magical rewind of external side
effects; nested/arbitrary historical rewind and live provider authority remain
outside the supported scope. See the milestone document for exact verified scope.

## Design and progress

Read [the architecture plan](plan.md), [milestone status and acceptance criteria](docs/v2/milestones.md),
[operator/recovery guide](docs/v2/operator-guide.md), [protocol contracts](docs/v2/contracts.md),
and [the v1 review](docs/v2/v1-review.md).
The implementation is reviewed against these documents; unsupported behavior must
be rejected or labeled unavailable rather than simulated as real capability.
