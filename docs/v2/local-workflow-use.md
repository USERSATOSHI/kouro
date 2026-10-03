# Local workflow use

The editable `feature` starter takes a task, asks for plan approval, runs the
implementer with workspace write access, then runs `bun run typecheck` and
`bun test`. Edit these command nodes for a project's scripts.

Run it with `codex-workspace-write` or `claude-workspace-write` to allow writes
only for roles that declare `repository.write`; the planner declares only
`repository.read`. The run profile selects the default harness; explicit node
capabilities control each agent's permissions.
Claude runs through the Claude Agent SDK and uses the SDK's supported local
authentication; Kouro does not require an API-key-only setup.

The starter's Bun validation commands declare `terminal.execute`. This is an
explicit workflow-author grant for those command nodes and avoids a second
launch-time opt-in. It runs the command outside OS containment, matching the
v1 command-node behavior. Use this only for workflows and workspaces whose
commands you trust. Older workflows using
`executionMode: "trusted-unrestricted"` can still require the CLI
`--allow-unrestricted-commands` or web “Allow unrestricted commands” option.

The feature starter declares a required `repositoryScout` and an optional
`testScout`. The planner invokes them as bounded `subagent` tool calls and gets
each typed result in the same turn. The implementer receives the reports from
the accepted planner attempt. Child agents use read-only tools and cannot run
commands, edit files, or start nested subagents.

Codex uses a run-scoped MCP server, Pi loads a run-scoped extension, and Claude
uses an in-process MCP server from the Claude Agent SDK. Real provider use still
requires the corresponding harness to be installed and authenticated. The local
test suite exercises the MCP and extension bridges; it does not make a live
provider call.

## Fusion planning

The `feature-fusion` and `refactor-fusion` starters draft plans with two models
in parallel, then run one cross-review/revision cycle before synthesis. Edit
`reviewRounds` in the generated `kouro.ts` to choose 0–10 cycles. Zero combines
the initial drafts directly. Each stage waits for both models to finish.

Declare every model with `workflow.agent`, and declare its optional subagents
with `workflow.subagent`. Fusion composes the agent handles:

```ts
const repositoryScout = workflow.subagent("repositoryScout", {
  prompt: scoutPrompt,
  produces: Summary,
});
const plannerA = workflow.agent("planner-a", {
  modelId: "model-a", prompt: firstPrompt, produces: Summary,
  uses: [repositoryScout],
});
const plannerB = workflow.agent("planner-b", {
  modelId: "model-b", prompt: secondPrompt, produces: Summary,
});
const synthesizer = workflow.agent("synthesis", {
  modelId: "model-fusion", prompt: fusionPrompt, produces: Summary,
});
const fusion = workflow.fusion("planning", {
  task, rounds: 1, reviewProduces: Summary, notesTransport: "auto",
  reviewPrompt, revisionPrompt, synthesis: synthesizer,
}).use(plannerA, plannerB);
workflow.startAt(fusion);
fusion.on("success").to(workflow.complete("done", { output: fusion.output }));
```

Supply unwired agents; composition moves their declarations into a child workflow.
Use `fusion.output` for the synthesized result. Model choices, permissions and
subagents follow each member through its reviews and revisions. In the web
launch form, choose each member's model once; that choice applies to every round.

Each member retains its draft workspace through review and revision. Claude and
Codex continue that member's native session, including after a host restart;
synthesis starts its own session. Pi currently retains the workspace but uses
an ephemeral conversation for each stage. Session continuation rejects changes
to the harness, model, workspace or native permissions.
If a resumable harness has no saved session for the preceding stage, fusion fails
with an explicit continuation error instead of starting the research again.

Reviewers receive their own previous report and every peer's previous report.
Revisions receive the previous report and all reviews; synthesis receives the
final reports and last reviews. `notesTransport: "auto"` passes reports over
16 KiB as JSON files with a short summary, digest and read instructions in the
context. Use `"files"` to pass every report as a file, or `"inline"` to embed
them in the prompt. These copies live in Kouro's run data, outside repository
worktrees, and survive restart. Agents must read relevant sections and preserve
citations; reading an entire file still consumes tokens. Canonical reports remain
durable output artifacts.

New fusion templates use one review/revision round. If every reviewer explicitly
returns `needsRevision: false`, Kouro carries the reports forward and skips
remaining revisions and reviews without a model call; synthesis still runs.
Missing or disagreeing verdicts keep all configured rounds. Use
`stopWhenUnanimous: false` to require every round. Review schemas must allow the
boolean verdict. A member only receives scouts explicitly listed in its `uses`;
synthesis does not inherit the other members' scouts.

Native prompts contain role instructions once and omit journal accounting and
duplicate tool schemas. Resumed fusion turns omit unchanged inline inputs already
in that conversation; new peer notes remain available. Other workflow inputs over
4 KiB (except `task`) use immutable JSON files too. Reading a whole file still
consumes tokens. Repository scout evidence can be reused within one fusion member
when its exact question, model and owned Git workspace tree match. Workspace edits
invalidate the cache; unsupported workspaces are researched normally.

Claude agents and scouts have **no default native turn or spend cap**. Authors
can opt in with `maxNativeTurns` or `maxBudgetUsd` on an agent or subagent. An
explicit limit pauses the run with its native session saved. These options
currently require Claude and apply per query, including resumed queries. Dollar
estimates do not represent the remaining five-hour subscription allowance. Usage
details show fresh input, cache reads and cache writes separately when Claude
reports them. Model and reasoning effort remain explicit author selections.

## Automatic workflow tasks

Open **Workflow task** in the sidebar, enter one task, and choose the workflows
Kouro may use. Choose a planning model and an execution model, then select
**Start workflow task**. The execution selection fills agents without an explicit
model; models already chosen by a workflow stay pinned. Each run retains the
selected workflow versions and bundle digests.

The planner generates up to 12 milestones with workflow assignments and
dependencies. Kouro validates the entire plan before starting any milestone,
runs ready milestones up to the chosen parallel limit, and starts dependents
only after every prerequisite succeeds. A failed prerequisite blocks its
dependents. Approval gates remain ordinary durable waits: open **Milestones**,
select **Review approval**, and decide in the invocation inspector. Pending
approvals and milestone assignments survive a host restart.

Eligible workflows accept a string `task` and need no other required inputs.
Workflows that schedule another milestone plan or run commands in the source
checkout are excluded. Workflows
that write or execute commands require a repository path. Each milestone gets
an isolated worktree shared by its workflow steps. Dependents receive completed
prerequisites' results and merged file changes. Successful execution combines
the milestone trees in the private run worktree, visible in **Delivery**. Merge
conflicts fail execution and retain the individual worktrees for inspection.

The builder exposes the same scheduler for authored composition. Declare the
planner with `.agent` (or compose planning with `.fusion`) and supply its plan
output. Pass workflow builders to `.use`:

```ts
import { MilestonePlanType } from "@kouro/core";

const planner = workflow.agent("decompose", {
  prompt: "Generate milestones with id, title, task, workflowId and dependsOn.",
  input: { task },
  produces: MilestonePlanType,
});
const execute = workflow.milestones("milestones", {
  plan: planner.output, maxMilestones: 8, maxConcurrent: 2,
}).use(featureWorkflow, bugfixWorkflow);
workflow.startAt(planner);
planner.on("success").to(execute);
execute.on("success").to(workflow.complete("done", { output: execute.output }));
execute.on("failure").to(workflow.complete("failed", { result: "failed" }));
```

Plan shape: `{ milestones: [{ id, title, task, workflowId, dependsOn: [] }] }`.
`workflowId` is a supplied workflow builder's ID. Output is a durable report of
milestones and their result artifact references. HTTP clients can discover
eligibility at `GET /api/task-workflows`, create a run with `POST /api/tasks`, and
read progress at `GET /api/runs/:id/milestones`. Task creation takes `task`,
`workflowIds`, `planner` and `executor` (`{ harness, modelId }`), `idempotencyKey`,
and optional `maxMilestones`, `maxConcurrent`, and `workspace.repositoryPath`.
Automatic task creation defaults to at most three milestones. For one clear task,
launch its workflow directly to avoid an extra decomposition agent.

The same flow is available as `kouro task run`. [CLI workflow tasks and agent
plugins](./agent-plugins.md) covers headless execution, greenfield setup, approval
decisions and installation in Codex or Claude Code.

## Agent swarm

Open **Agent swarm** in the sidebar, list 1–8 models with their harnesses, then
enter a shared task and select **Start swarm**. No workflow template is needed.
Model IDs must be available through the selected, authenticated harness.

The models work on the task in parallel. The first listed model combines their
completed answers; a single-model swarm returns its answer directly. An optional
repository path provides read-only context. The swarm view shows each model's
progress, contributions and final answer. Select a member and **Open agent
activity** to inspect its session. Runs, results and cancellation use the same
durable host runtime as workflows. Acceptance tests use a local provider fixture;
they do not establish live multi-provider readiness.

## Opening the workbench over SSH

`kouro serve` listens on the remote machine's loopback interface. When the
server starts inside an SSH session, it prints a forwarding command. Run that
command in a terminal on your own computer, replacing `<same-SSH-target>` with
the host or SSH config alias you used to connect. Keep it running, then open
the printed `http://127.0.0.1:...` workbench URL in your local browser. The
browser connects through the tunnel while Kouro stays bound to loopback on the
remote machine.
