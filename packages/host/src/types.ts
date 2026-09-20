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
}

export type ExecutionProfileId = "scripted" | "codex-readonly" | "pi-readonly";

export interface ExecutionProfileSummary {
  id: ExecutionProfileId;
  name: string;
  description: string;
  available: boolean;
  harness: string;
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
}

export interface HostProjection {
  view: RunView;
  state: ExecutionState;
}
