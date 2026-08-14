# `@kouro/executors` — Application Use Cases and Ports

The **imperative shell** of Kouro's workflow engine. Interprets scheduler intents and executes them against real infrastructure — processes, AI harnesses, and databases. Implements application use cases for run lifecycle management, approval decisions, and artifact publishing.

## Architecture

```
@kouro/runtime (pure scheduler)
    ↓ produces OrchestrationIntent[]
@kouro/executors (imperative shell)
    ├── RunCoordinator — central orchestrator
    ├── AgentExecutor — AI agent execution
    ├── BunCommandRunner — shell command execution
    └── ports.ts — declared port interfaces
    ↓
Infrastructure (persistence-sqlite, harnesses, sandbox-worktree)
```

## RunCoordinator

The `RunCoordinator` is the central class that bridges the pure scheduler with side-effecting infrastructure.

```typescript
import { RunCoordinator, BunCommandRunner, AgentExecutor } from '@kouro/executors';

const coordinator = new RunCoordinator(
  store,              // RunStore implementation
  new BunCommandRunner(cwd),
  agentExecutor,      // Optional AgentExecutor
  cwd,
  clock               // Optional Clock (defaults to system clock)
);
```

### Constructor

| Parameter | Type | Description |
|-----------|------|-------------|
| `store` | `RunStore` | Persistence port (e.g., `SqliteEventStore`) |
| `commandRunner` | `CommandRunner` | Shell execution (e.g., `BunCommandRunner`) |
| `agentExecutor` | `AgentExecutor?` | AI agent execution (optional — needed for agent nodes) |
| `workingDirectory` | `string` | CWD for command execution (default `process.cwd()`) |
| `clock` | `Clock` | Time source (default: `new Date().toISOString()`) |

### Public Methods

#### Run Lifecycle

```typescript
// Create a new run
const result = coordinator.createRun({
  runId: 'run-abc',
  artifact: compiledArtifact,
  startingCommit: 'abc123',
  configuration: { agentHarnesses: ['codex'] },
  idempotencyKey: 'create-v1',
});

// Advance a run (main loop tick) — loads run, calls scheduleRun, dispatches intent
const advanced = await coordinator.advance('run-abc');

// Recovery — interrupts active invocations for restart safety
coordinator.recoverRun('run-abc');
```

#### Lifecycle Operations

| Method | Event Appended |
|--------|---------------|
| `pauseRun(runId, actor, idempotencyKey)` | `run.paused` |
| `resumeRun(runId, actor, idempotencyKey)` | `run.resumed` |
| `cancelRun(runId, actor, reason, idempotencyKey)` | `run.cancelled` |
| `interruptInvocation(runId, invocationSeq, actor, reason, key)` | `attempt.interrupt_requested` |
| `steerInvocation(runId, invocationSeq, actor, message, key)` | `agent.steering_requested` |
| `retryInvocation(runId, invocationSeq, actor, reason, key)` | `invocation.retry_requested` |
| `skipInvocation(runId, invocationSeq, actor, reason, key)` | `invocation.skipped` (with skip binding) |

All lifecycle methods return `Result<RunAggregate, ExecutorError>`.

Agent steering is delivered only to the exact active attempt. The harness
records `agent.steering_applied` or `agent.steering_rejected` after the
provider accepts or rejects it; steering never changes graph structure or
scheduler counters.

#### Approval Decisions

```typescript
const result = coordinator.decideApproval(
  'run-abc',
  approvalBinding,   // Must match the current projected state
  'grant',           // or 'reject'
  'human-operator',
  'looks good',
  'approval-decision-v1'
);
```

#### Artifacts

```typescript
coordinator.publishRunArtifact('run-abc', artifactRef, 'artifact-key');
```

### Advance() Flow

The `advance` method implements the main loop:

1. **Load** the run aggregate from the store
2. **Clock observation** — record time if `maxDurationMs` is set
3. **Schedule** — call `scheduleRun()` from `@kouro/runtime` to get next intent
4. **Dispatch** — execute the first intent:

```
OrchestrationIntent → Dispatch
  ├── attempt.schedule → executeAttempt()
  │   ├── agent node → executeAgent() → AgentExecutor → artifact publishing
  │   └── command node → executeCommand() → BunCommandRunner → completion
  ├── invocation.activate → append event directly
  ├── approval.request → append event directly
  ├── run.complete → append event directly
  ├── session.resume → resumeAgent()
  └── effect.verify / reconciliation.request / recovery.halt → error (not yet supported)
```

## AgentExecutor

Orchestrates AI agent execution through the harness system:

```typescript
const executor = new AgentExecutor(registry, artifactWriter);

const result = await executor.execute({
  runId: 'run-abc',
  invocationSequence: 1,
  attemptNumber: 1,
  harnessId: 'codex',
  model: 'gpt-5.2-codex',
  workingDirectory: '/path/to/worktree',
  role: 'Software Engineer',
  prompt: 'Implement the plan...',
  capabilities: ['read:repo', 'write:repo'],
  outputSchema: { type: 'object', properties: { /* ... */ } },
});
```

On success, it:

1. Resolves the harness from the registry
2. Calls `harness.execute()` or `harness.resume()`
3. Validates the structured output against the schema via `validateStructuredOutput`
4. Writes the harness transcript and agent output as artifacts
5. Returns `AgentAttemptExecution` with output, resume token, and artifacts

An agent node may authorize several compiled subagent definitions. The
executor gives the parent harness one normalized `subagent` tool, enforces
per-definition invocation and concurrency limits, and executes each child
through the same harness registry. Child output is schema-validated and its
stable call ID, harness/model selection, status, and transcript are appended to
the parent transcript artifact. Children are subordinate read-only effects of
the parent attempt, not independently scheduled graph attempts, and do not
receive a nested subagent controller.
The executor also returns bounded child execution summaries with best-effort
usage so the coordinator can record operator metadata on the parent attempt;
these summaries never participate in scheduling or recovery.
While a child is active, its start, provider transcript chunks, and completion
are also copied into the parent's best-effort activity stream. Parallel child
updates carry stable call IDs so presentation can keep their sessions separate.

When a graph activates the same agent node again, `RunCoordinator` resumes its
latest successful session for the selected harness unless the node declares
`clearContext: true`. Durable output from the source invocation is appended to
the base prompt, so validation and review loops carry their failure details
back to the same engineering agent.

Agents may additionally declare `contextSources` through the SDK's
`withContextFrom(...)` method. Before execution, the coordinator appends the
latest successful output from each declared agent and successful prior outputs
from each declared subagent. Sources are rendered in compiled canonical order.
Resumed provider sessions receive only values produced since that agent's last
successful invocation, avoiding repeated prompt context. Missing source output
is valid, and transcripts, reasoning, tool logs, and resume tokens are never
included.

Harness selection is a durable run policy. `agentHarnessesByNode` may assign an
ordered harness list to a compiled agent node ID; otherwise the coordinator
uses the default `agentHarnesses` list. Attempt number selects within that list,
so node-specific routing and fallback use the same durable attempt semantics.
A compiled agent `harness` pin takes precedence and selects a one-item policy.
After choosing the harness, the coordinator resolves the model from the
compiled node's `models` map. It records that selection on `attempt.started`,
passes it to the harness, and reuses the recorded model when resuming.
The coordinator resolves reasoning effort from the compiled agent first and
then the durable run fallback. A bounded subagent resolves its own compiled
effort first and otherwise inherits the parent's effective effort.

When run configuration contains a `workItem`, the coordinator serializes that
immutable snapshot into every agent prompt before adding transition feedback.
`TicketProvider` is the provider-neutral resolution port used at run creation;
provider credentials and APIs remain in infrastructure adapters.

## BunCommandRunner

Executes shell commands via `Bun.spawn`:

```typescript
const runner = new BunCommandRunner('/path/to/working/directory');
const result = await runner.execute('npm run build');
// Returns { outcome, output: { exitCode, stdout, stderr } }
```

## Structured Output Validation

The `validateStructuredOutput` function validates agent output against a JSON Schema-like declaration:

```typescript
import { validateStructuredOutput } from '@kouro/executors';

const result = validateStructuredOutput(value, schema);
// Returns { output?: JsonValue, issue?: StructuredOutputIssue }
```

Supports: `type`, `const`, `enum`, `required`, `properties`, `additionalProperties`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `allOf`, `anyOf`, `oneOf`, `$` (true/false).

## Port Interfaces

The `ports.ts` file declares the contracts that infrastructure must implement:

| Port | Required Methods | Implemented By |
|------|-----------------|----------------|
| `RunStore` | `createRun`, `loadRun`, `appendEvent` | `@kouro/persistence-sqlite` |
| `CommandRunner` | `execute(command)` | `BunCommandRunner` (same package) |
| `Clock` | `now()` | System clock (default) |
| `AgentHarness` | `execute`, `resume` | `@kouro/harnesses` |
| `AgentHarnessRegistry` | `get(harnessId)` | `@kouro/harnesses` |
| `ArtifactWriter` | `write(request)` | `@kouro/harnesses` |

## Error Handling

| Error Kind | Code | Meaning |
|------------|------|---------|
| `RunStore` | 0 | Persistence error |
| `Runtime` | 1 | Pure runtime error (from `@kouro/runtime`) |
| `UnknownNode` | 2 | Node not in compiled bundle |
| `UnsupportedNode` | 3 | Node type not supported by this executor |
| `Command` | 4 | Shell command execution failure |
| `InvalidInput` | 5 | Invalid arguments |
| `Agent` | 6 | AI agent execution failure |

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `RunCoordinator` | class | `run-coordinator.ts` |
| `AgentExecutor` | class | `agent-executor.ts` |
| `BunCommandRunner` | class | `bun-command-runner.ts` |
| `validateStructuredOutput` | function | `structured-output.ts` |
| `ExecutorError`, `ExecutorErrorKind` | types | `errors.ts` |
| `RunStore`, `RunAggregate`, `RunStoreError` | types | `ports.ts` |
| `AgentHarness`, `AgentHarnessRegistry`, `HarnessError` | types | `ports.ts` |
| `ArtifactWriter`, `ArtifactWriterError` | types | `ports.ts` |
| `CommandRunner`, `CommandRunnerError` | types | `ports.ts` |
| `Clock` | type | `ports.ts` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@kouro/domain` | Domain types |
| `@kouro/runtime` | `scheduleRun` — pure scheduler |
| `@usersatoshi/results` | `Result<T, E>` type |
