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
in parallel, then run two cross-review/revision cycles before synthesis. Edit
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
  task, rounds: 2, reviewProduces: Summary,
  reviewPrompt, revisionPrompt, synthesis: synthesizer,
}).use(plannerA, plannerB);
workflow.startAt(fusion);
fusion.on("success").to(workflow.complete("done", { output: fusion.output }));
```

Supply unwired agents; composition moves their declarations into a child workflow.
Use `fusion.output` for the synthesized result. Model choices, permissions and
subagents follow each member through its reviews and revisions. In the web
launch form, choose each member's model once; that choice applies to every round.

Open the run's **Session** tab and select **Fusion split** to compare model
sessions side by side. **Planning stage** follows the latest stage or replays
initial drafts and individual review/revision rounds. The combined plan appears
below the sessions. On narrow screens, sessions stack vertically. Steering and
interrupt controls target the agent shown in that panel; cancellation stops the
whole run.

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
