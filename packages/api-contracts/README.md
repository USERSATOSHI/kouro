# `@kouro/api-contracts` — Transport-Neutral API Contracts

Transport-neutral request and response shapes shared by the Elysia application, Eden client, and React dashboard. The package contains **data contracts only** — pure TypeScript interfaces with zero runtime code, no framework imports, and no dependencies beyond `@kouro/domain`.

## Purpose

This package defines the shared vocabulary between:

```
@kouro/api (Elysia HTTP server)
    ↓ imports from
@kouro/api-contracts (request/response DTOs)
    ↓ types reference
@kouro/domain (domain model types)
```

```
@kouro/web (React dashboard)
    ↓ imports from
@kouro/api-contracts (view models, request shapes)
    ↓ calls
@kouro/eden-client (generated from the Elysia app type)
```

## Contracts

### Error

```typescript
interface ApiErrorResponse {
  readonly error: {
    readonly code: string;    // machine-readable, e.g. "run_not_found"
    readonly message: string; // human-readable description
  };
}
```

### Run Management

```typescript
interface CreateRunRequest {
  readonly adw: string;               // ADW package path or identifier
  readonly repositoryPath: string;    // Git repository to run against
  readonly task?: string;             // Inline work-item text
  readonly ticket?: string;           // Source-qualified provider reference
  readonly harnesses?: readonly string[];  // Default ordered harness policy
  readonly harnessesByNode?: Readonly<Record<string, readonly string[]>>;
  readonly reasoningEffort?: 'low' | 'medium' | 'high'; // Fallback for unpinned agents
  readonly actor: string;             // Who created the run
}

interface CreateRunResponse {
  readonly runId: string;
  readonly status: RunState['status'];
}

interface RunSummary {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowChecksum: string;
  readonly status: RunState['status'];
  readonly startingCommit: string;
  readonly eventCount: number;
  readonly invocationCount: number;
  readonly pendingApprovalCount: number;
}

interface RunDetails extends RunSummary {
  readonly repositoryHead: string;
  readonly state: RunState;
  readonly nodes: readonly WorkflowNodeView[];
  readonly subagents?: readonly WorkflowSubagentView[];
  readonly edges: readonly WorkflowEdgeView[];
}
```

### Graph Views (for React Flow rendering)

```typescript
interface WorkflowNodeView {
  readonly id: string;
  readonly type: CompiledWorkflowBundle['nodes'][number]['type'];
  readonly title: string;
  readonly ordinal: number;
  readonly invocations: readonly number[];
  readonly recoveryPolicy?: CompiledWorkflowBundle['nodes'][number]['recoveryPolicy'];
  readonly skipOutcome?: string;
  readonly latestState?: RunState['invocations'][number]['state'];
}

interface WorkflowEdgeView {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly outcome: string;
}

interface WorkflowSubagentView {
  readonly id: string;
  readonly role: string;
  readonly parentNodeIds: readonly string[];
  readonly harness?: string;
  readonly models?: Readonly<Record<string, string>>;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly maxInvocations: number;
  readonly maxConcurrent: number;
}
```

### Workflow Metadata

```typescript
interface WorkflowSummary {
  readonly checksum: string;
  readonly id: string;
  readonly version: string;
  readonly nodeCount: number;
}

interface WorkflowDetails extends WorkflowSummary {
  readonly bundle: CompiledWorkflowBundle;
}
```

### Lifecycle Operations

```typescript
interface LifecycleRequest {
  readonly actor: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

interface LifecycleResponse {
  readonly runId: string;
  readonly status: RunState['status'];
}

interface AgentSteeringRequest {
  readonly actor: string;
  readonly message: string;
  readonly idempotencyKey: string;
}
```

All state-mutating operations (`createRun`, `pause`, `resume`, `cancel`, `steer`, `interrupt`, `retry`, `skip`, `decideApproval`) require an `idempotencyKey` for at-least-once delivery semantics.

### Approvals

```typescript
interface ApprovalView {
  readonly runId: string;
  readonly nodeId: string;
  readonly invocationSequence: number;
  readonly state: RunState['invocations'][number]['state'];
  readonly binding: ApprovalBinding;
}

interface ApprovalDecisionRequest {
  readonly decision: 'grant' | 'reject';
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

interface ApprovalDecisionResponse {
  readonly runId: string;
  readonly invocationSequence: number;
  readonly status: RunState['status'];
}
```

### Artifacts

```typescript
interface ArtifactView extends ArtifactReference {
  readonly runId: string;
  readonly invocationSequence?: number;
  readonly attemptNumber?: number;
  readonly content?: string;
}

interface ArtifactContent {
  readonly mediaType: string;
  readonly content: string;
}
```

### Repositories

```typescript
interface RepositorySummary {
  readonly id: string;
  readonly path: string;
  readonly startingCommit?: string;
}
```

### Evaluations

Evaluation contracts expose compiled dataset summaries, idempotent terminal-run
evaluation requests, checksum-bound report views, append-only annotation and
pairwise-preference requests, and experiment views. Deterministic reports and
human evidence remain separate fields.

### Server-Sent Events

```typescript
interface EventStreamMessage {
  readonly id: number;
  readonly event: RunEvent['type'];
  readonly data: RunEvent;
}
```

The SSE endpoint delivers one `EventStreamMessage` per event, supporting both `last-event-id` header and `?after=` query parameter for reconnection.

## Design Conventions

- **All interfaces use `readonly`** properties — immutable by convention
- **Arrays are `readonly T[]`** — consistent with functional programming
- **Interface extension** (`extends`) over type intersection — `RunDetails extends RunSummary`
- **No re-export of domain types** — composes domain types into view-specific shapes
- **No classes, functions, or runtime code** — purely TypeScript type definitions

## Exported Interfaces (18 total)

| Interface | Domain | Description |
|-----------|--------|-------------|
| `ApiErrorResponse` | Error | Standard error envelope |
| `RunSummary` | Run | Lightweight run view |
| `RunDetails` | Run | Full run view with graph |
| `CreateRunRequest` | Run | Create run payload |
| `CreateRunResponse` | Run | Create run result |
| `LifecycleRequest` | Run | Lifecycle action payload |
| `LifecycleResponse` | Run | Lifecycle action result |
| `EventStreamMessage` | Run | SSE event message |
| `WorkflowSummary` | Workflow | Workflow metadata |
| `WorkflowDetails` | Workflow | Full workflow with bundle |
| `WorkflowNodeView` | Graph | Node for DAG rendering |
| `WorkflowEdgeView` | Graph | Edge for DAG rendering |
| `RepositorySummary` | Repository | Git repository info |
| `ArtifactView` | Artifact | Artifact with run context |
| `ArtifactContent` | Artifact | Artifact raw content |
| `ApprovalView` | Approval | Pending/historical approval |
| `ApprovalDecisionRequest` | Approval | Grant/reject payload |
| `ApprovalDecisionResponse` | Approval | Decision result |

## Dependencies

- `@kouro/domain` — imports 5 types as `type` imports only: `ApprovalBinding`, `ArtifactReference`, `CompiledWorkflowBundle`, `RunEvent`, `RunState`
