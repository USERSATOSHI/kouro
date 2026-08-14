# `@kouro/domain` — Immutable Domain Contracts

The **foundational type system** of Kouro. Zero runtime code — pure TypeScript type definitions that serve as the shared vocabulary across the compiler, runtime, executors, persistence, API, and UI layers.

## Purpose

`@kouro/domain` defines:

- **Workflow structure** — source and compiled forms of workflow definitions
- **Event stream format** — 20 event variants for the append-only event log
- **Runtime state model** — runs, invocations, and attempts with their state machines
- **Orchestration language** — 8 intent variants the scheduler produces
- **Expression language** — restricted DSL for transition conditions (6 operators)
- **Supporting types** — artifacts, bindings, recovery policies, failures

## Workflow Definition Types

### Source (authored) vs Compiled

```typescript
// As authored by the user (from @kouro/adw)
interface SourceNodeDefinition {
  id: string;
  type: 'agent' | 'approval' | 'command' | 'complete';
  role?: string;
  prompt?: string;
  capabilities?: readonly string[];
  recoveryPolicy?: RecoveryPolicy;
  // ...
}

// After compilation (fully resolved)
interface NodeDefinition extends SourceNodeDefinition {
  ordinal: number;      // Deterministic ordering
  priority: number;     // Resolved from optional field
}
```

### Bundle Types

```typescript
interface WorkflowSourceBundle {
  manifest: { id: string; version: string; metadata?: Record<string, JsonValue> };
  semanticVersions: { compiler: string; ir: string; expressions: string };
  entryNodeId: string;
  nodes: readonly SourceNodeDefinition[];
  subagents?: readonly SourceSubagentDefinition[];
  transitions: readonly SourceTransition[];
  counterLimits: Record<string, number>;
  runLimits?: { maxDurationMs?: number; maxNodeInvocations?: number };
  prompts?: Record<string, string>;
  schemas?: Record<string, JsonValue>;
  permissions?: readonly string[];
  subworkflows?: Record<string, { checksum: string; bundle: CompiledWorkflowBundle }>;
}

interface CompiledWorkflowBundle extends Omit<WorkflowSourceBundle, 'nodes' | 'transitions'> {
  nodes: readonly NodeDefinition[];         // Resolved ordinals
  transitions: readonly CompiledTransition[];
}

interface CompiledWorkflowArtifact {
  bundle: CompiledWorkflowBundle;
  canonical: string;          // Deterministic JSON
  checksum: `sha256:${string}`;  // Content-addressable identifier
}
```

Agent source nodes may set `clearContext: true` to opt out of reusing their
latest successful harness session across graph invocations.
They may also set a non-empty `harness` ID to pin that node to one compiled
harness choice; omitted pins are resolved from durable run configuration.
An optional non-empty `models` map selects a model by resolved harness ID. The
resolved value is recorded on the attempt, and a missing entry preserves the
harness's configured default.
An optional `reasoningEffort` pins `low`, `medium`, or `high` for that agent and
takes precedence over the durable run-level fallback.

Agent source nodes may authorize `allowedSubagents`. Each referenced
`SourceSubagentDefinition` is a bounded reusable child role, not a graph node:
it has no ordinal or transitions and cannot become the workflow entry.
Compiler IR version 2 adds these optional declarations while retaining the
ability to read previously compiled IR version 1 bundles.

`WorkItemSnapshot` is the immutable requested change bound at run creation. It
records normalized inline or provider-backed ticket content, its external
revision when available, and a `sha256:` checksum. The snapshot lives in
durable run configuration so replay and resume never refetch a mutable ticket.
Optional `agentReasoningEffort` is likewise snapshotted as `low`, `medium`, or
`high`; it is the fallback for agent and subagent definitions that do not pin
their own effort and influences harness inference without changing
orchestration replay.

## State Machine Types

### Three-Level Hierarchy

```
Run (top-level lifecycle)
  └── NodeInvocation (one activation of a node)
       └── NodeAttempt (one retry/fallback within an invocation)
```

### Run Status

```typescript
type RunStatus =
  | 'created'
  | 'running'
  | 'waiting_for_approval'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
```

### Invocation State

```typescript
type InvocationState =
  | 'pending'     // Not yet started
  | 'active'      // Currently executing
  | 'waiting_for_approval'  // Waiting for human decision
  | 'interrupted' // Stopped mid-execution
  | 'succeeded'   // Completed successfully
  | 'failed'      // Finished with error
  | 'cancelled';  // Explicitly cancelled
```

### Attempt State

```typescript
type AttemptState = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
```

### RunState (Complete Snapshot)

```typescript
interface RunState {
  workflowChecksum: string;
  startingCommit: string;
  repositoryHead: string;
  configuration: Record<string, JsonValue>;
  startedAt?: string;
  observedAt?: string;
  status: RunStatus;
  nextInvocationSequence: number;
  counters: Record<string, number>;
  invocations: readonly NodeInvocation[];
  artifacts?: readonly ArtifactReference[];
}
```

## Event Types (23 Variants)

The `RunEvent` discriminated union covers the full run lifecycle:

| Category | Events |
|----------|--------|
| Run lifecycle | `run.created`, `run.time_observed`, `run.paused`, `run.resumed`, `run.cancelled`, `run.completed` |
| Invocation lifecycle | `invocation.activated`, `invocation.completed`, `invocation.skipped`, `invocation.retry_requested` |
| Attempt lifecycle | `attempt.started`, `attempt.resumed`, `attempt.resume_token_recorded`, `attempt.artifact_published`, `attempt.failed`, `attempt.interrupted`, `attempt.interrupt_requested` |
| Agent control | `agent.steering_requested`, `agent.steering_applied`, `agent.steering_rejected` |
| Run artifacts | `run.artifact_published` |
| Approval | `approval.requested`, `approval.granted`, `approval.rejected` |

Utility type `RunEventInput` is the same union minus the `sequence` field — used when writing events before sequence assignment.

## Orchestration Intent Types (8 Variants)

```typescript
type OrchestrationIntent =
  | { type: 'invocation.activate'; nodeId: string; invocationSequence: number; ... }
  | { type: 'attempt.schedule'; invocationSequence: number; attemptNumber: number }
  | { type: 'approval.request'; invocationSequence: number; binding: ApprovalBinding }
  | { type: 'effect.verify'; invocationSequence: number; attemptNumber: number }
  | { type: 'session.resume'; invocationSequence: number; token: string }
  | { type: 'reconciliation.request'; invocationSequence: number }
  | { type: 'recovery.halt'; invocationSequence: number }
  | { type: 'run.complete'; result: 'succeeded' | 'failed' };
```

## Expression Language (Restricted DSL)

Six operators for transition conditions — no arbitrary code execution:

```typescript
type Expression =
  | { op: 'eq'; left: ValueReference; right: JsonPrimitive }     // Equality
  | { op: 'gte'; left: ValueReference; right: JsonPrimitive }    // Greater-or-equal
  | { op: 'lt'; left: ValueReference; right: JsonPrimitive }     // Less-than
  | { op: 'and'; expressions: readonly Expression[] }             // Logical AND
  | { op: 'or'; expressions: readonly Expression[] }              // Logical OR
  | { op: 'not'; expression: Expression };                        // Logical NOT

type ValueReference =
  | { scope: 'counter'; name: string }         // Read from counters
  | { scope: 'output'; path: readonly string[] };  // Read from node output
```

## Supporting Types

### Subordinate Execution Summaries

Completed bounded subagent calls may be retained on their parent `NodeAttempt`
as ordered `SubagentExecutionSummary` values. They carry stable call identity,
harness/model selection, result state, and best-effort token usage for audit and
operator projections. Successful summaries may retain validated structured
output when another agent declares that subagent as a context source. They are
not workflow nodes, attempts, or scheduler inputs; monetary cost remains
derived at presentation boundaries.

An agent node may declare provider-neutral `contextSources`. Each reference
names another agent or a workflow subagent whose prior durable structured
output is eligible for prompt injection. The compiled declarations are part of
the workflow checksum; raw transcripts, hidden reasoning, and provider session
state are not shared.

### Recovery Policies

```typescript
type RecoveryPolicy =
  | 'replay_safe'             // Safe to re-run from scratch
  | 'verify_then_replay'      // Verify side effect, then retry
  | 'resume_supported'        // Harness supports resume tokens
  | 'manual_reconciliation'   // Requires human intervention
  | 'never_automatically_retry';  // Never retry
```

### Approval and Skip Bindings

```typescript
interface ApprovalBinding {
  workflowChecksum: string;
  invocationSequence: number;
  artifactChecksums: readonly string[];
  resolvedAction: string;
  repositoryHead: string;
}

interface SkipBinding {
  workflowChecksum: string;
  invocationSequence: number;
  artifactChecksums: readonly string[];
  selectedOutcome: string;
  repositoryHead: string;
}
```

### Artifacts

```typescript
interface ArtifactReference {
  id: string;
  kind: 'agent_output' | 'harness_transcript' | 'command_output' | 'git_diff' | 'git_status';
  mediaType: string;
  checksum: `sha256:${string}`;
  size: number;
}
```

## Design Conventions

- **All properties are `readonly`** — immutability at the type level
- **Arrays are `readonly T[]`** — no mutable array types
- **Discriminated unions with literal `type` fields** — enables exhaustive pattern matching
- **No runtime code** — pure TypeScript `type` and `interface` declarations
- **No dependencies** — zero npm dependencies

## Dependencies

None. This is a zero-dependency, type-only package.
