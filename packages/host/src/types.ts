import type {
  ArtifactRef,
  Bundle,
  CommandEvidence,
  EventEnvelope,
  ExecutionState,
  LifecycleEvent,
  ProjectionFrame,
  RunStatus,
  RunView,
  RuntimeHarness,
} from "@kouro/core/contracts";

export type {
  ArtifactRef,
  Bundle,
  CommandEvidence,
  EventEnvelope,
  ExecutionState,
  LifecycleEvent,
  ProjectionFrame,
  RunStatus,
  RunView,
};

export interface RunSummary {
  runId: string;
  workflowId: string;
  status: RunStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  executionProfile?: ExecutionProfileId;
  task?: string;
  workItem?: WorkItemInput;
}

export interface ResolvedTicketSnapshot {
  readonly version: 1;
  readonly provider: string;
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly revision?: string;
  readonly capturedAt?: string;
}

export interface WorkItemInput {
  readonly version: 1;
  readonly task: string;
  readonly ticket?: { readonly reference: string; readonly snapshot: ResolvedTicketSnapshot };
  readonly title?: string;
  readonly description?: string;
  readonly source?: string;
}

export type ExecutionProfileId =
  | "scripted"
  | "codex-readonly"
  | "codex-workspace-write"
  | "claude-readonly"
  | "claude-workspace-write"
  | "pi-readonly";

export interface ExecutionProfileSummary {
  id: ExecutionProfileId;
  name: string;
  description: string;
  available: boolean;
  harness: RuntimeHarness;
  model?: string;
  capabilities: Record<string, "supported" | "unsupported" | "conditional">;
  unavailableReason?: string;
}

export interface CreateRunInput {
  workflowId: string;
  bundle: Bundle;
  input?: Record<string, unknown>;
  idempotencyKey: string;
  actor?: string;
  executionProfile?: ExecutionProfileId;
  workspace?: { repositoryPath: string; workspaceId?: string };
  allowUnrestrictedCommands?: boolean;
}

export interface CommandReceipt {
  commandId: string;
  idempotencyKey: string;
  accepted: boolean;
  runId: string;
  revision: number;
  status: RunStatus;
}

export interface ProcessEvidence {
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean | null;
  spawnError: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  enforcementMode: "enforced" | "trusted-unrestricted";
}

export interface ProcessResult {
  evidence: ProcessEvidence;
  operationKey: string;
}

export interface ProcessAdapter {
  readonly enforcementMode: "enforced" | "trusted-unrestricted";
  probe(): Promise<{ available: boolean; detail: string }>;
  executeFixedFixture(input: {
    runId: string;
    operationKey: string;
    workspaceDir: string;
    timeoutMs: number;
  }): Promise<ProcessResult>;
  executeCommand(input: {
    runId: string;
    operationKey: string;
    workspaceDir: string;
    executable: string;
    args: readonly string[];
    timeoutMs: number;
    executionMode?: "enforced" | "trusted-unrestricted";
  }): Promise<ProcessResult>;
}

export interface ScriptedAgent {
  run(input: {
    runId: string;
    invocationId: string;
    delayMs: number;
    signal?: AbortSignal;
  }): Promise<{
    output: Record<string, unknown>;
  }>;
}

export interface HarnessAdapter {
  /** Internal adapter identity; workflow-facing harness values are validated separately. */
  readonly id: string;
  readonly adapterVersion: string;
  capabilities(): Record<string, "supported" | "unsupported" | "conditional">;
  run(input: {
    runId: string;
    invocationId: string;
    role: string;
    prompt: string;
    outputSchema?: import("@kouro/core").JsonValue;
    delayMs: number;
    timeoutMs?: number;
    cwd?: string;
    modelId?: string;
    nativeConfig?: import("@kouro/core").JsonObject;
    context?: import("@kouro/core").ContextManifest;
    /** Host-owned, optional collaboration tools. The harness never supplies sender identity. */
    collaboration?: CollaborationTools;
    signal?: AbortSignal;
  }): Promise<{
    output?: import("@kouro/core").JsonValue;
    rawOutput?: string;
    stderr?: string;
    status: "succeeded" | "failed" | "cancelled" | "unavailable";
    error?: string;
    events: readonly import("@kouro/core").JsonValue[];
    usage: import("@kouro/core").JsonValue;
  }>;
}

export interface CollaborationTools {
  readonly participantId: string;
  send_message(input: {
    readonly to: string;
    readonly body: import("@kouro/core").JsonValue;
    readonly idempotencyKey: string;
    readonly replyTo?: string;
  }): import("@kouro/core").CollaborationMessage;
  publish_blackboard(input: {
    readonly type: "decision" | "finding" | "risk" | "todo" | "question" | "evidence";
    readonly body: import("@kouro/core").JsonValue;
    readonly idempotencyKey: string;
    readonly supersedes?: string;
  }): import("@kouro/core").CollaborationMessage;
  wait(input: {
    readonly waitId?: string;
    readonly maxMessages?: number;
    readonly idleDeadline?: string;
  }): import("@kouro/core").CollaborationManifest | null;
  subagent?: (input: {
    readonly requestId: string;
    readonly subagentId: string;
    readonly input: Record<string, unknown>;
  }) => Promise<ScoutResult>;
}

export type ScoutRequestState =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ScoutRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly parentInvocationId: string;
  readonly parentAttemptId: string;
  readonly scoutId: string;
  readonly question: string;
  readonly input: Record<string, unknown>;
  readonly ordinal: number;
  readonly optional: boolean;
  readonly state: ScoutRequestState;
  readonly result?: unknown;
  readonly resultArtifactId?: string;
  readonly resultDigest?: string;
  readonly childDefinitionId?: string;
  readonly childAgentId?: string;
  readonly effectiveHarness?: string;
  readonly modelId?: string;
  readonly workspaceId?: string;
  readonly deadlineAt?: string;
  readonly dispatchId?: string;
  readonly usage?: unknown;
  readonly error?: string;
}

export type ScoutResult =
  | {
      readonly requestId: string;
      readonly scoutId: string;
      readonly state: "succeeded";
      readonly result: unknown;
      readonly resultArtifactId: string;
      readonly resultDigest: string;
    }
  | {
      readonly requestId: string;
      readonly scoutId: string;
      readonly state: "failed" | "unknown" | "cancelled";
      readonly error: { readonly code: string; readonly message: string };
    };

export interface ScoutDelivery {
  readonly requestId: string;
  readonly plannerAttemptId: string;
  readonly manifest: {
    readonly requestId: string;
    readonly scoutId: string;
    readonly artifactId?: string;
    readonly resultDigest?: string;
    readonly bytes: number;
    readonly source: "scout-result";
  };
  readonly result?: unknown;
}

export type DeliveryActionStatus = "pending" | "approved" | "rejected" | "committed";

export interface DeliveryAction {
  readonly id: string;
  readonly requestKey: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly invocationId?: string;
  readonly baseTree: string;
  readonly resultTree: string;
  readonly patchDigest: string;
  readonly changedPaths: readonly unknown[];
  readonly message: string;
  readonly validationEvidence?: readonly string[];
  readonly reviewEvidence?: readonly string[];
  readonly actionDigest: string;
  readonly operationKey: string;
  readonly status: DeliveryActionStatus;
  readonly actor?: string;
  readonly commit?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HostProjection {
  view: RunView;
  state: ExecutionState;
}
