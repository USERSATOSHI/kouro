# Planner scout tool design

Status: implementation is included in Kouro 2.0.5. Codex, Pi, and Claude Agent
SDK have run-scoped awaited tool bridges. The shipped feature starter declares
repository and test scouts. Full provider-backed acceptance remains dependent
on live runs against each installed harness; the local suite is not that proof.

## Final decision

Implement one awaited `subagent` tool backed by durable subordinate-call
records owned by the requesting agent attempt. Return the validated child
result to the same live agent turn. Do not add a second scheduler or
independently resumable child scopes.

A subagent is not a graph invocation and cannot advance graph transitions. Reuse
the harness registry and shared coordinator execution helpers for selection,
workspace restrictions, deadlines, cancellation, usage, and output validation.
Extract those helpers where necessary rather than copying the execution lifecycle
or recursively starting a whole child workflow.

This preserves v1's one-level, bounded `subagent` interaction. Historical source
locations include `docs/adrs/0031-bounded-workflow-subagents.md`,
`packages/executors/src/agent-executor.ts`, and
`packages/harnesses/src/subagent-tool.ts`. They are historical references, not
paths that must exist in this v2 checkout.

## Authoring and compiler contract

Expose `WorkflowBuilder.subagent(id, options, limits)` and make it return an
owner-checked subagent handle. The options contain the role, prompt, input
schemas, and one typed output schema; the builder creates the restricted child
definition internally. Declared subagents are available to
every agent. An optional `uses: ScoutHandle[]` list narrows one agent's access;
persist that allowlist on the compiled node and reject duplicate or foreign
handles. Names such as `repositoryScout` and `testScout` are illustrative
user-created subagents; the runtime gives them no special behavior.

For this version, a scout definition must contain exactly one agent and one
successful completion node, start at that agent, and connect them with one
unconditional success edge. Its single exported output must be the agent's
typed output. Agent inputs resolve only from declared child inputs or literals.
Reject commands, approvals, forks, loops, calls, failure branches, nested scouts,
and additional nodes or edges. The host can then execute the agent directly
without interpreting a child graph.

Every subagent has positive integer `maxInvocations` and `maxConcurrent` bounds and
a compiled `optional` flag, defaulting to false. Required means at least one
successful call is mandatory before accepting the parent agent output. Additionally,
any failed, unknown, or cancelled accepted call to a required subagent blocks
acceptance for that attempt, even if another call succeeds. Optional scouts need
not run, and their failures do not block acceptance.

Remove `optional` from tool input. The model cannot downgrade compiled policy.
Return typed failures so the planner can explain them, but enforce acceptance in
the host; prose claiming to have handled a failure cannot waive it. A subsequent
planner attempt is subject to the workflow's normal retry policy and run budget.

Add agent `scoutPolicy: { maxRequests, maxConcurrent }`, defaulting to 4 and 2.
These bounds apply alongside per-scout bounds. Reject a request budget smaller
than the number of required authorized scouts.

## Example workflow

This is the public authoring syntax.
`Task` and `Question` are project-owned string artifact types; `ScoutReport` and
`Plan` are object artifact types exported from `schemas/schema.ts`. For the
walkthrough below, ScoutReport has `summary: string` and
`evidence: Array<{ path: string; detail: string }>`.

```ts
import { WorkflowBuilder } from "@kouro/core";
import { Task, Question, ScoutReport, Plan } from "./schemas/schema.ts";

const workflow = new WorkflowBuilder({ id: "feature", version: "1" });
const task = workflow.input("task", Task);
const repositoryScout = workflow.subagent(
  "repositoryScout",
  {
    role: "repository-scout",
    prompt: "Read repository boundaries relevant to the task and question. Return evidence.",
    input: { task: Task, question: Question },
    produces: ScoutReport,
  },
  { maxInvocations: 2, maxConcurrent: 1, optional: false },
);
const testScout = workflow.subagent(
  "testScout",
  {
    role: "test-scout",
    prompt: "Read relevant tests. Report coverage and gaps; do not execute tests.",
    input: { task: Task, question: Question },
    produces: ScoutReport,
  },
  { maxInvocations: 2, maxConcurrent: 1, optional: true },
);
const plan = workflow.agent("plan", {
  role: "planner",
  prompt: `Call repositoryScout before finalizing the plan. You may also call
testScout. Use `subagent` with a unique requestId and typed input containing
task and question. Use the returned evidence when producing your plan.`,
  input: { task },
  produces: Plan,
  uses: [repositoryScout, testScout],
  scoutPolicy: { maxRequests: 4, maxConcurrent: 2 },
  timeoutMs: 180_000,
});

// New typed binding: successful report envelopes from the accepted plan attempt.
// Results are ordered by request acceptance ordinal. Missing optional reports = [].
const implement = workflow.agent("implement", {
  role: "implementer",
  prompt: "Implement the plan using the supplied structured evidence.",
  input: {
    task,
    plan: plan.output,
    repositoryReports: workflow.subagentResults(plan, repositoryScout),
    testReports: workflow.subagentResults(plan, testScout),
  },
});
const done = workflow.complete("done");
const failed = workflow.complete("failed", { result: "failed" });
workflow.startAt(plan);
plan.on("success").to(implement);
plan.on("failure").to(failed);
workflow.sequence(implement, done);
export default workflow.build();
```

This example omits approval for brevity. Retain the feature starter's existing
approval step when adapting it. Required-scout failure must prevent reaching
approval or implementation as a successful planner outcome.

## Tool contract and runtime example

```ts
type ScoutResult =
  | {
      requestId: string;
      scoutId: string;
      state: "succeeded";
      result: JsonValue;
      resultArtifactId: string;
      resultDigest: string;
    }
  | {
      requestId: string;
      scoutId: string;
      state: "failed" | "unknown" | "cancelled";
      error: { code: string; message: string };
    };

interface ScoutTool {
  invoke(
    input: {
      scoutId: string;
      requestId: string;
      input: Record<string, JsonValue>;
    },
    signal?: AbortSignal,
  ): Promise<ScoutResult>;
}
```

Use the child's typed `input.question`; remove the duplicate top-level question.
The existing question column may remain a derived display value during migration,
but is not a separate authoritative input. Expose each authorized scout's input
schema in the provider tool schema/description so the planner can construct it.

Invalid, unauthorized, conflicting, or over-budget calls return structured tool
errors without accepting a request or spending budget. Accepted calls settle to
a ScoutResult while the caller is alive. Cancellation may terminate the provider
before it consumes that result.

```text
Agent calls subagent:
  { "subagentId": "repositoryScout", "requestId": "repo-1",
    "input": { "task": "Add a retry option",
               "question": "Where are retry settings validated?" } }

Host authenticates the parent agent attempt, validates input, reserves budget,
and persists acceptance. Host runs the repository subagent with read-only tools.
Host validates ScoutReport, persists its artifact and terminal state, then
records the response envelope and returns it to the outstanding `subagent` call:

  { "subagentId": "repositoryScout", "requestId": "repo-1",
    "state": "succeeded", "resultArtifactId": "artifact-123",
    "resultDigest": "<digest>",
    "result": { "summary": "Validation is in the compiler.",
                "evidence": [{ "path": "packages/core/src/compiler.ts",
                               "detail": "Execution bounds are validated here." }] } }

The same agent turn reads the report and produces its typed output.
Host checks required scouts and validates Plan before accepting it.
Implementer receives Plan and repositoryReports containing that report envelope.
```

The report above is illustrative, not a verified finding about retry settings.
An optional test scout can be called in the same way; a failed optional call
returns an error result, and its downstream report array remains empty.

Provider-native tool-call IDs route responses; `requestId` is the explicit
idempotency key. An identical duplicate joins the existing execution promise or
replays its terminal result. It never returns accepted/running as the tool result
and never consumes a second invocation budget.

## Persistence and recovery

Extend `scout_requests` as the subordinate-call record; do not introduce another
competing source of truth. Identity is `(runId, parentAttemptId, requestId)` in
all APIs and tables, including delivery foreign keys. Migrate the current
`(runId, requestId)` key. Persist a canonical payload digest; different payloads
under the same identity conflict. Authenticate the caller before duplicate lookup.

Record parent invocation/attempt, scout ID, compiled child definition and agent
identity, effective harness/model, workspace identity, input digest, ordinal,
deadline, dispatch identity, timestamps, usage, terminal error, and result
artifact ID/digest. This lineage does not manufacture a graph invocation.

| State     | Meaning and allowed next states                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| accepted  | Validated and budget reserved; may become running, failed, or cancelled.                                   |
| running   | Dispatch intent committed before calling the harness; may become succeeded, failed, unknown, or cancelled. |
| succeeded | Output validated and durable artifact reference committed; terminal.                                       |
| failed    | Known failure, including timeout or invalid output; terminal.                                              |
| unknown   | Dispatch may have occurred but outcome cannot be established; terminal.                                    |
| cancelled | Parent or caller cancellation; terminal.                                                                   |

Acceptance, invocation-budget consumption, and concurrency reservation are
atomic. Dispatch requires a compare-and-set claim by the owning controller.
Terminal transitions also use compare-and-set: late success cannot overwrite
timeout or cancellation. Persist the artifact before exposing success; an
unreferenced artifact left by a crash does not constitute a successful request.

Response recording means **available for replay**, not proof the provider
consumed it. Record the exact response envelope before returning it. If reusing
the delivery manifest, document this meaning explicitly. Exactly-once provider
delivery is not promised.

On host recovery, do not resume old provider turns or automatically rerun scouts:

- Accepted requests of interrupted attempts become cancelled.
- Running requests become unknown unless an existing supported recovery path
  establishes their outcome without redispatch.
- Terminal results remain immutable and inspectable, including results committed
  before response recording. An authorized replay reconstructs the same envelope.
- The interrupted parent follows normal attempt recovery policy. A permitted new
  parent attempt gets new identities and fresh evidence, never silently adopting
  reports from the interrupted attempt.

An inactive old attempt cannot dispatch or regain tool authority. Inspection of
historical responses uses the authenticated inspection path, not an expired tool
grant. Replay within a live authorized attempt is permitted.

Parent finalization closes admission, cancels unfinished children, and awaits
bounded cleanup before accepting output. Unfinished accepted requests cause
planner failure; fire-and-forget calls cannot produce an accepted plan.

## Limits, permissions, and selection

Invocation budgets count all accepted requests, including failed/cancelled ones,
per scout and per parent attempt. Parent retries reset attempt budgets, but each
accepted scout also consumes the run's cumulative invocation budget. Extend its
accounting to subordinate calls without creating graph invocations. Include scout
usage/cost in run totals and enforce any supported run cost limits.

Concurrency counts accepted/running requests separately per scout and per parent.
Reserve actual child execution capacity through shared host effect/resource
admission, extending it to subordinate effects as needed. The waiting planner
retains its effect slot because its provider process remains live. If a child
slot cannot be reserved immediately, reject before acceptance with a capacity
tool error; never queue a child behind its parent's slot. A run concurrency limit
of one cannot support required scouting and must fail admission. Capacity errors
do not spend invocation budget or count as failed accepted scout calls.

Child deadline = minimum of the parent's remaining deadline and the child's
configured timeout, defaulting to 60 seconds. The deadline includes bounded
termination. Parent cancellation propagates to children. Cleanup must terminate
or otherwise fence child execution before releasing workspace ownership.

Resolve child harness/model overrides through normal selection rules, inheriting
the parent's effective selection where absent. Preserve mixed harnesses: Pi
planners may use Codex scouts and vice versa when both roles support their
required capabilities. Persist the resolved selection.

Children use the parent workspace under an enforced repository read/search tool
envelope: no shell execution, writes, network tools, delivery/publish tools,
collaboration grants, or scout tool. Provider inference transport is distinct
from a child-accessible network tool. Prompts are not enforcement. Reject child
profiles that cannot enforce this envelope, even if their native sandbox permits
read-only shell commands. Parent privileges cannot broaden child permissions.
The host persists result artifacts; this is not a child publish capability.

Validate inputs before effects and output before success. Limit each serialized
request and result to 64 KiB and request IDs to 128 UTF-8 bytes. Preserve validation
evidence without exposing credentials or private provider context downstream.

## Provider implementation boundary

The coordinator checks `awaited-subagent-tool` and
`child-read-only-envelope` before provider execution. Codex gets an MCP stdio
server backed by a per-turn authenticated loopback bridge; Pi gets a Kouro
extension with the same bridge; Claude gets an in-process SDK MCP server. Each
bridge carries the declared input schema and waits for the host's validated
child result. Child calls use the selected harness and enforce read-only tools.
OpenCode does not advertise or accept this capability.

The bridge tests exercise actual MCP tool discovery/call and the Pi extension
loader. They do not establish same-turn model behavior for every provider;
record live parent and child evidence before claiming that acceptance gate is
closed. Per-scout, per-parent, and run-wide limits remain authoritative.

## Downstream context

Implement `workflow.scoutResults(plan, scout)` as a typed binding source, returning
an array of successful report envelopes. Both handles must belong to this
workflow, and the scout must be authorized on that planner. Preserve the child
output schema in the binding's array-item result schema.

Resolve reports against the exact accepted producer attempt selected for
`plan.output`, respecting scope/iteration lineage. Never use the latest report
by scout ID or aggregate across retries. Each envelope contains request ID,
scout ID, artifact ID, digest, and typed result. Return all successful calls in
acceptance-ordinal order. An uncalled/failed optional scout yields an empty array;
failure details remain inspectable in the journal.

Apply the normal context byte budget. Fail context construction explicitly when
required structured evidence cannot fit; never silently truncate JSON. Do not
forward raw tool transcripts or private child context. Replace the proposal's
ambiguous `withContextFrom` shorthand with these explicit input bindings.

## Implementation order and acceptance evidence

1. Extend core contracts/builder/compiler with scout handles, planner authorization,
   restricted child shape, policies, and typed result bindings; adapt the starter.
2. Migrate journal identity and implement atomic acceptance, claims, terminal
   transitions, replay records, cumulative budgets, and recovery reconciliation.
3. Extract shared execution helpers and implement the parent-owned controller,
   child restrictions, acceptance gate, deadlines, and cleanup.
4. Wire scripted execution, then native Codex and Pi paths with truthful capability
   admission. Keep other profiles explicitly unsupported.
5. Resolve downstream bindings using accepted producer lineage and expose child
   status/result evidence in the existing inspection surface.

Required tests and live evidence:

- Compiler rejects foreign/unauthorized handles, invalid child graphs, and
  impossible required-scout request budgets.
- The same live planner receives and uses a schema-valid report; downstream
  agents receive only reports associated with the accepted planner attempt.
- Concurrent identical duplicates dispatch once, payload conflicts fail, and
  different attempts can reuse a request ID without collisions.
- Required missing/failed scouts block acceptance; optional failure does not;
  tool arguments cannot downgrade compiled policy.
- Per-scout, per-parent, and run-wide limits hold during concurrency and retries;
  capacity exhaustion and run concurrency one cannot deadlock.
- Crash injection covers acceptance, dispatch intent, result commit, and response
  recording. Recovery never silently redispatches a child.
- Timeout/cancellation races preserve terminal state and prevent leaked children;
  invalid/oversized output cannot become a successful report.
- Children cannot execute commands, write, publish, or delegate regardless of
  parent privileges. Unsupported profiles fail admission clearly.
- Native Codex and Pi each demonstrate same-turn awaited results. Demonstrate at
  least one mixed-harness parent/child pair, recording profile/model and durable
  evidence. Scripted success alone does not establish native support.

Do not mark the feature complete while only acceptance rows exist. Completion
requires child execution, same-turn consumption, enforced policy, recovery
evidence, and the declared downstream bindings.
