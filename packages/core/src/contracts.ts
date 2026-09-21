/**
 * Browser-safe wire and execution contracts for Kouro's small deterministic
 * kernel.  This module intentionally contains only data and types.  In
 * particular, it does not import a host framework, a provider SDK, SQLite, or
 * a filesystem implementation.
 */

export const PROJECTION_VERSION = 1 as const;
export const BUNDLE_FORMAT_VERSION = 1 as const;
export const HARNESS = ["codex", "pi", "claude", "opencode"] as const;
export type Harness = (typeof HARNESS)[number];
export type RuntimeHarness = Harness | "scripted";

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESS as readonly string[]).includes(value);
}

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type NodeKind =
  | "agent"
  | "command"
  | "complete"
  | "approval"
  | "call"
  | "fork"
  | "join"
  | "loop"
  | "forEach";
export type SupportedNodeKind = "agent" | "command" | "approval" | "complete";
export type NodeStatus =
  | "pending"
  | "reserved"
  | "running"
  | "succeeded"
  | "failed"
  | "recovery-required";
export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "recovery-required";
export type AttemptStatus = "reserved" | "running" | "succeeded" | "failed" | "recovery-required";
export type MissingBinding = "error" | "omit" | "default";

export interface ArtifactType<T = unknown> {
  readonly id: string;
  readonly schema: JsonValue;
  readonly __type?: T;
}

export interface Port {
  readonly name: string;
  readonly schemaDigest: string;
  readonly required: boolean;
  readonly defaultValue?: JsonValue;
  readonly outcomes?: readonly string[];
}

export type BindingSource =
  | { readonly kind: "input"; readonly sourceId: string; readonly port?: string }
  | { readonly kind: "producer"; readonly sourceId: string; readonly port: string }
  | { readonly kind: "literal"; readonly value: JsonValue };

export interface Binding {
  readonly targetPort: string;
  readonly source: BindingSource;
  readonly path?: readonly string[];
  readonly missing: MissingBinding;
}

export interface ControlEdge {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly outcome: string;
  readonly targetNodeId: string;
  readonly kind: "sequential";
  readonly guard?: JsonValue;
  readonly default?: boolean;
  readonly counterIncrement?: string;
  readonly feedbackBindings?: readonly Binding[];
}

export interface AgentNode {
  readonly id: string;
  readonly kind: "agent";
  readonly role: string;
  readonly prompt: string;
  /** Optional per-agent harness override. Defaults to the run execution profile. */
  readonly harness?: Harness;
  readonly modelId?: string;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
  readonly timeoutMs: number;
  readonly scripted?: ScriptedAgentProfile;
  readonly resources?: Readonly<Record<string, number>>;
}

export interface CommandNode {
  readonly id: string;
  readonly kind: "command";
  readonly executable: string;
  readonly args: readonly string[];
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
  readonly timeoutMs: number;
  readonly acceptedExitCodes: readonly number[];
  readonly resources?: Readonly<Record<string, number>>;
}

export interface CompleteNode {
  readonly id: string;
  readonly kind: "complete";
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
  readonly result: "succeeded" | "failed";
}

export interface ApprovalNode {
  readonly id: string;
  readonly kind: "approval";
  readonly action: string;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
}

export interface UnsupportedNode {
  readonly id: string;
  readonly kind: Exclude<NodeKind, SupportedNodeKind>;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
}

export type JoinMode = "all" | "all-settled" | "fail-fast";
export type JoinFailure = "cancel-remaining" | "wait-for-all";

export interface CallNode {
  readonly id: string;
  readonly kind: "call";
  readonly definitionId: string;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
}

export interface ForkNode {
  readonly id: string;
  readonly kind: "fork";
  readonly groupId: string;
  readonly branchIds: readonly string[];
  readonly maxConcurrent?: number;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
}

export interface JoinNode {
  readonly id: string;
  readonly kind: "join";
  readonly groupId: string;
  readonly mode: JoinMode;
  readonly failure: JoinFailure;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
}

export interface LoopNode {
  readonly id: string;
  readonly kind: "loop";
  readonly bodyNodeId: string;
  readonly maxIterations: number;
  readonly carry: readonly Port[];
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
}

export interface ForEachNode {
  readonly id: string;
  readonly kind: "forEach";
  readonly templateDefinitionId: string;
  readonly collection: Binding;
  readonly itemPort: Port;
  readonly maxItems: number;
  readonly maxConcurrent: number;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly bindings: readonly Binding[];
}

export type Node =
  | AgentNode
  | CommandNode
  | ApprovalNode
  | CompleteNode
  | CallNode
  | ForkNode
  | JoinNode
  | LoopNode
  | ForEachNode
  | UnsupportedNode;

export interface CounterDefinition {
  readonly id: string;
  /** Maximum number of graph repair/loop transitions in the owning scope. */
  readonly max: number;
}

export interface Definition {
  readonly id: string;
  readonly inputPorts: readonly Port[];
  readonly outputPorts: readonly Port[];
  readonly nodes: readonly Node[];
  readonly controlEdges: readonly ControlEdge[];
  readonly dataBindings: readonly Binding[];
  readonly entry: string;
  readonly exits: readonly string[];
  readonly counters: readonly CounterDefinition[];
  readonly sourceId?: string;
}

export interface ExecutionLimits {
  readonly maxScopes: number;
  readonly maxInvocations: number;
  readonly maxAttempts: number;
  readonly maxTurns: number;
  readonly maxMessages: number;
  readonly maxConcurrentEffects: number;
  readonly maxRunDurationMs: number;
  readonly resourceCaps?: Readonly<Record<string, number>>;
}

export const DEFAULT_LIMITS: ExecutionLimits = Object.freeze({
  maxScopes: 16,
  maxInvocations: 128,
  maxAttempts: 256,
  maxTurns: 256,
  maxMessages: 1024,
  maxConcurrentEffects: 4,
  maxRunDurationMs: 30 * 60 * 1000,
  resourceCaps: {},
});

export interface BoundSummary {
  readonly scopes: number;
  readonly invocations: number;
  readonly attempts: number;
  readonly saturated: boolean;
}

export interface Bundle {
  readonly formatVersion: typeof BUNDLE_FORMAT_VERSION;
  readonly semanticVersions: {
    readonly compiler: string;
    readonly expressions: string;
    readonly schemas: string;
  };
  readonly rootDefinitionId: string;
  readonly definitions: Readonly<Record<string, Definition>>;
  readonly schemas: Readonly<Record<string, JsonValue>>;
  readonly limits: ExecutionLimits;
  readonly sourceMap: Readonly<Record<string, SourceLocation>>;
  readonly boundSummary: BoundSummary;
  readonly digest: string;
  /** Canonical executable bytes represented as UTF-8 JSON for diagnostics/cache keys. */
  readonly canonicalJson: string;
}

export interface SourceLocation {
  readonly sourceId: string;
  readonly line?: number;
  readonly column?: number;
}

export interface ScriptedAgentProfile {
  readonly delayMs?: number;
  readonly output?: JsonValue;
  readonly outcome?: "success" | "failure";
}

export interface CommandEvidence {
  readonly kind: "command.evidence";
  readonly executable: string;
  readonly args: readonly string[];
  /** Null means the process did not provide an exit code. */
  readonly exitCode: number | null;
  /** Null means no terminating signal was observed. */
  readonly signal: string | null;
  /** Null means timeout state is not known; true/false are observed outcomes. */
  readonly timeout: boolean | null;
  /** Null means no spawn error was observed. */
  readonly spawnError: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly durationMs?: number | null;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly workspaceId?: string;
}

/** The host's automatic process outcome, kept separate from parsed workflow output. */
export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timeout: boolean | null;
  readonly spawnError: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

export interface ArtifactRef {
  readonly id: string;
  readonly digest?: string;
  readonly mediaType?: string;
  readonly schemaDigest?: string;
}

export interface WorkspaceRef {
  readonly id: string;
  readonly treeDigest?: string;
}

export interface AttemptState {
  readonly id: string;
  readonly invocationId: string;
  readonly ordinal: number;
  readonly status: AttemptStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly output: readonly ArtifactRef[];
  readonly evidence: readonly ArtifactRef[];
  readonly artifacts: readonly ArtifactRef[];
  readonly workspace: WorkspaceRef | null;
  readonly commandEvidence?: CommandEvidence;
  readonly error?: string;
  readonly resolvedExecution?: ResolvedExecution;
  readonly contextManifest?: JsonValue;
  readonly harnessEvents?: readonly JsonValue[];
  readonly usage?: JsonValue;
  readonly diagnostics?: readonly string[];
  readonly sessionReference?: JsonValue;
}

export interface ResolvedExecution {
  readonly role: string;
  readonly harness: RuntimeHarness;
  readonly adapterVersion: string;
  readonly modelId?: string;
  readonly nativeConfigDigest?: string;
}

export interface InvocationState {
  readonly id: string;
  readonly scopeId: string;
  readonly nodeId: string;
  readonly activationOrdinal: number;
  /** Zero for the initial graph activation; one-based for bounded repairs. */
  readonly repairPass?: number;
  readonly sourceInvocationId?: string;
  readonly sourceEdgeId?: string;
  readonly status: NodeStatus;
  readonly inputBindings: Readonly<Record<string, BoundInput>>;
  readonly output: readonly ArtifactRef[];
  readonly evidence: readonly ArtifactRef[];
  readonly artifacts: readonly ArtifactRef[];
  readonly workspace: WorkspaceRef | null;
  readonly createdAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly outcome: string | null;
  readonly error?: string;
}

export interface BoundInput {
  readonly source: BindingSource;
  readonly artifactId?: string;
  readonly value?: JsonValue;
  readonly path?: readonly string[];
  readonly missing: MissingBinding;
}

export interface ScopeState {
  readonly id: string;
  readonly parentScopeId: string | null;
  readonly definitionId: string;
  readonly status: RunStatus;
  readonly activationOrdinal: number;
}

export interface ExecutionState {
  readonly runId: string;
  readonly revision: number;
  readonly eventCursor: number;
  readonly status: RunStatus;
  readonly rootScopeId: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly scopes: Readonly<Record<string, ScopeState>>;
  readonly forkGroups?: Readonly<Record<string, ForkGroupState>>;
  readonly invocations: Readonly<Record<string, InvocationState>>;
  readonly attempts: Readonly<Record<string, AttemptState>>;
  readonly recovery: RecoveryState | null;
  /** Scope-local monotonic graph counters; operational attempts are separate. */
  readonly counters: Readonly<Record<string, number>>;
  readonly approvals: Readonly<Record<string, ApprovalState>>;
  readonly control?: "none" | "cancel-requested" | "interrupt-requested";
}
export interface ForkGroupState {
  readonly id: string;
  readonly scopeId: string;
  readonly branchIds: readonly string[];
  readonly status: "running" | "succeeded" | "failed" | "cancelled";
  readonly joined: boolean;
  readonly branchStatuses: Readonly<
    Record<string, "pending" | "succeeded" | "failed" | "cancelled" | "skipped">
  >;
}

export type ApprovalDecision = "approved" | "rejected";
export interface ApprovalState {
  readonly id: string;
  readonly invocationId: string;
  readonly action: string;
  readonly status: "pending" | ApprovalDecision;
  readonly bindingDigest: string;
  readonly subjectRevision: number;
  readonly actor?: string;
  readonly decidedAt?: string;
}

export interface RecoveryState {
  readonly code: string;
  readonly subjectId: string | null;
  readonly detail?: string;
}

export interface RunView {
  readonly projectionVersion: typeof PROJECTION_VERSION;
  readonly runId: string;
  readonly revision: number;
  readonly eventCursor: number;
  readonly bundle: Bundle;
  readonly state: ExecutionState;
  readonly serverClock: string;
}

export interface ProjectionFrame {
  readonly projectionVersion: typeof PROJECTION_VERSION;
  readonly runId: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly eventCursor: number;
  readonly state: ExecutionState;
}

export type LifecycleEventType =
  | "run.started"
  | "scope.created"
  | "fork.created"
  | "join.completed"
  | "invocation.cancelled"
  | "invocation.created"
  | "attempt.reserved"
  | "attempt.started"
  | "attempt.completed"
  | "invocation.completed"
  | "run.completed"
  | "approval.requested"
  | "approval.decided"
  | "counter.incremented"
  | "recovery.required"
  | "run.paused"
  | "run.resumed"
  | "run.cancel.requested"
  | "run.interrupt.requested"
  | "run.detached"
  | "run.retried";

export interface EventEnvelope<T extends LifecycleEventType = LifecycleEventType, P = JsonObject> {
  readonly eventId: string;
  readonly runId: string;
  /** The host's committed per-run journal sequence. */
  readonly sequence: number;
  readonly schemaVersion: 1;
  readonly type: T;
  /** The caller supplies this timestamp; the reducer never reads a clock. */
  readonly recordedAt: string;
  readonly subjectId?: string;
  readonly actor?: string;
  readonly causationId?: string;
  readonly payload: P;
}

export interface RunStartedPayload {
  readonly rootScopeId?: string;
  readonly rootDefinitionId?: string;
}
export interface ScopeCreatedPayload {
  readonly scope: ScopeState;
}
export interface ForkCreatedPayload {
  readonly groupId: string;
  readonly scopeId: string;
  readonly branchIds: readonly string[];
}
export interface JoinCompletedPayload {
  readonly groupId: string;
  readonly scopeId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly branchIds: readonly string[];
  readonly branchStatuses?: Readonly<
    Record<string, "pending" | "succeeded" | "failed" | "cancelled" | "skipped">
  >;
}

export interface InvocationCreatedPayload {
  readonly invocationId: string;
  readonly scopeId?: string;
  readonly nodeId: string;
  readonly activationOrdinal?: number;
  readonly repairPass?: number;
  readonly sourceInvocationId?: string;
  readonly sourceEdgeId?: string;
  readonly inputBindings?: Readonly<Record<string, BoundInput>>;
}
export interface InvocationCancelledPayload {
  readonly invocationId: string;
  readonly reason: string;
}

export interface AttemptReservedPayload {
  readonly attemptId: string;
  readonly invocationId: string;
  readonly ordinal?: number;
}

export interface AttemptStartedPayload {
  readonly attemptId: string;
}

export interface AttemptCompletedPayload {
  readonly attemptId: string;
  readonly status: Exclude<AttemptStatus, "reserved" | "running">;
  readonly output?: readonly ArtifactRef[];
  readonly evidence?: readonly ArtifactRef[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly workspace?: WorkspaceRef | null;
  readonly commandEvidence?: CommandEvidence;
  readonly error?: string;
  readonly resolvedExecution?: ResolvedExecution;
  readonly contextManifest?: JsonValue;
  readonly harnessEvents?: readonly JsonValue[];
  readonly usage?: JsonValue;
  readonly diagnostics?: readonly string[];
  readonly sessionReference?: JsonValue;
}

export interface InvocationCompletedPayload {
  readonly invocationId: string;
  readonly status: Extract<NodeStatus, "succeeded" | "failed" | "recovery-required">;
  readonly outcome?: string;
  readonly output?: readonly ArtifactRef[];
  readonly evidence?: readonly ArtifactRef[];
  readonly artifacts?: readonly ArtifactRef[];
  readonly workspace?: WorkspaceRef | null;
  readonly error?: string;
  /** Complete nodes have no effect attempt and may complete directly. */
  readonly direct?: boolean;
}

export interface RunCompletedPayload {
  readonly status: Extract<
    RunStatus,
    "succeeded" | "failed" | "cancelled" | "interrupted" | "recovery-required"
  >;
}

export interface ApprovalRequestedPayload {
  readonly approvalId: string;
  readonly invocationId: string;
  readonly action: string;
  readonly bindingDigest: string;
  readonly subjectRevision: number;
}
export interface ApprovalDecidedPayload {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly bindingDigest: string;
  readonly subjectRevision: number;
}
export interface CounterIncrementedPayload {
  readonly counterId: string;
  readonly scopeId: string;
  readonly value: number;
}

export interface RecoveryRequiredPayload {
  readonly code: string;
  readonly subjectId?: string;
  readonly detail?: string;
}

export interface RunControlPayload {
  readonly reason?: string;
  readonly invocationId?: string;
}
export interface RunRetryPayload {
  readonly invocationId: string;
  readonly sourceAttemptId: string;
  readonly attemptId: string;
}

export type LifecycleEvent =
  | EventEnvelope<"run.started", RunStartedPayload>
  | EventEnvelope<"scope.created", ScopeCreatedPayload>
  | EventEnvelope<"fork.created", ForkCreatedPayload>
  | EventEnvelope<"join.completed", JoinCompletedPayload>
  | EventEnvelope<"invocation.created", InvocationCreatedPayload>
  | EventEnvelope<"invocation.cancelled", InvocationCancelledPayload>
  | EventEnvelope<"attempt.reserved", AttemptReservedPayload>
  | EventEnvelope<"attempt.started", AttemptStartedPayload>
  | EventEnvelope<"attempt.completed", AttemptCompletedPayload>
  | EventEnvelope<"invocation.completed", InvocationCompletedPayload>
  | EventEnvelope<"run.completed", RunCompletedPayload>
  | EventEnvelope<"approval.requested", ApprovalRequestedPayload>
  | EventEnvelope<"approval.decided", ApprovalDecidedPayload>
  | EventEnvelope<"counter.incremented", CounterIncrementedPayload>
  | EventEnvelope<"recovery.required", RecoveryRequiredPayload>
  | EventEnvelope<"run.paused", RunControlPayload>
  | EventEnvelope<"run.resumed", RunControlPayload>
  | EventEnvelope<"run.cancel.requested", RunControlPayload>
  | EventEnvelope<"run.interrupt.requested", RunControlPayload>
  | EventEnvelope<"run.detached", RunControlPayload>
  | EventEnvelope<"run.retried", RunRetryPayload>;

export interface ActivateIntent {
  readonly kind: "activate";
  readonly scopeId: string;
  readonly nodeId: string;
  readonly bindings: Readonly<Record<string, BoundInput>>;
  readonly edgeId?: string;
  readonly sourceEdgeId?: string;
  readonly sourceInvocationId?: string;
  readonly counterId?: string;
  readonly repairPass?: number;
}
export interface CallIntent {
  readonly kind: "call";
  readonly invocationId: string;
  readonly definitionId: string;
  readonly scopeId: string;
}
export interface LoopIntent {
  readonly kind: "loop";
  readonly invocationId: string;
  readonly scopeId: string;
  readonly bodyNodeId: string;
  readonly iteration: number;
}
export interface ForEachIntent {
  readonly kind: "forEach";
  readonly invocationId: string;
  readonly scopeId: string;
  readonly definitionId: string;
  readonly itemIndex: number;
  readonly item: JsonValue;
}

export interface RequestApprovalIntent {
  readonly kind: "request-approval";
  readonly invocationId: string;
  readonly action: string;
  readonly bindingDigest: string;
  readonly subjectRevision: number;
}

export interface ReserveIntent {
  readonly kind: "reserve";
  readonly invocationId: string;
  readonly attemptOrdinal: number;
}

export interface ExecuteIntent {
  readonly kind: "execute";
  readonly invocationId: string;
  readonly attemptId: string;
}

export interface CompleteIntent {
  readonly kind: "complete";
  readonly invocationId: string;
  readonly outcome: "succeeded" | "failed";
  readonly output?: readonly ArtifactRef[];
  readonly evidence?: readonly ArtifactRef[];
  readonly artifacts?: readonly ArtifactRef[];
}

export interface FinishIntent {
  readonly kind: "finish";
  readonly status: Extract<RunStatus, "succeeded" | "failed">;
}

export type DecisionIntent =
  | ActivateIntent
  | CallIntent
  | LoopIntent
  | ForEachIntent
  | RequestApprovalIntent
  | ReserveIntent
  | ExecuteIntent
  | CompleteIntent
  | FinishIntent;

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly severity: "error" | "warning";
}

export class CompileError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
    this.name = "CompileError";
    this.diagnostics = diagnostics;
  }
}

export interface WorkflowDefinitionSource {
  readonly id: string;
  readonly version?: string;
  readonly limits?: Partial<ExecutionLimits>;
  readonly nodes: readonly Node[];
  readonly controlEdges: readonly ControlEdge[];
  readonly inputPorts?: readonly Port[];
  readonly outputPorts?: readonly Port[];
  readonly entry?: string;
  /** Authoring-only schema source; compiler replaces labels with content digests. */
  readonly schemaCatalog?: Readonly<Record<string, JsonValue>>;
  readonly counters?: readonly CounterDefinition[];
  /** Child definitions are retained as definitions; they are never flattened into the root. */
  readonly definitions?: Readonly<Record<string, WorkflowDefinitionSource>>;
  readonly sourceMap?: Readonly<Record<string, SourceLocation>>;
}
