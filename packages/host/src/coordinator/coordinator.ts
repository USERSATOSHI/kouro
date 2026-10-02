import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  canonicalize,
  approvalRepairsRemaining,
  CAPABILITY,
  createContextManifest,
  decide,
  isHarness,
  redactSecrets,
  sha256Hex,
  unavailableUsage,
  validateJsonSchema,
} from "@kouro/core";
import type {
  ArtifactRef,
  BoundInput,
  Bundle,
  DecisionIntent,
  ExecutionState,
  ForkNode,
  JoinNode,
  JsonValue,
} from "@kouro/core";
import type { RuntimeHarness } from "@kouro/core";
import { id, json, now, parseJson } from "../id.ts";
import { DelayedScriptedAgent, ScriptedHarnessAdapter } from "../adapters/harness/scripted.ts";
import { TrackingHarnessDecorator } from "../adapters/harness/tracking.ts";
import { activityPreview } from "../adapters/harness/activity-preview";
import {
  CodexAppServerHarness,
  CodexHarnessAdapter,
  inspectCodex,
} from "../adapters/harness/codex.ts";
import { ExternalCliHarnessAdapter, inspectExternalCli } from "../adapters/harness/external-cli.ts";
import {
  ClaudeAgentSdkHarnessAdapter,
  claudeSdkDescriptor,
} from "../adapters/harness/claude-agent-sdk.ts";
import {
  PiSdkHarness,
  PiHarnessAdapter,
  inspectPi,
  resolvePiSelection,
} from "../adapters/harness/pi.ts";
import { createDefaultProcessAdapter } from "../adapters/process/index.ts";
import { Journal, type StoredArtifact } from "../storage/journal.ts";
import {
  GitWorkspaceAdapter,
  type WorkspaceRef,
  type WorkspaceSnapshot,
} from "../adapters/workspace/git.ts";
import type {
  HarnessAdapter,
  ProcessAdapter,
  ProcessResult,
  RunSummary,
  ScriptedAgent,
  DeliveryAction,
} from "../types.ts";
import type { HarnessEvent } from "@kouro/core";
import { ReadySetScheduler } from "../scheduler/scheduler.ts";
import { CollaborationGateway } from "../collaboration/gateway.ts";
import { prepareAgentHandoff } from "../handoff/index.ts";
import { normalizeAdmissionInput } from "../admission.ts";
import { ScoutGateway } from "../scouting/gateway.ts";

export interface CoordinatorOptions {
  dataDir: string;
  agent?: ScriptedAgent;
  harness?: HarnessAdapter;
  executionProfile?:
    | "scripted"
    | "codex-readonly"
    | "codex-workspace-write"
    | "claude-readonly"
    | "claude-workspace-write"
    | "pi-readonly";
  process?: ProcessAdapter;
  scriptedDelayMs?: number;
  commandTimeoutMs?: number;
  agentIdleTimeoutMs?: number;
  agentObservationGraceMs?: number;
  operationTimeoutMs?: number;
  cancelGraceMs?: number;
  workspaceAdapter?: GitWorkspaceAdapter;
}

function toHarness(value: string): RuntimeHarness {
  return isHarness(value) ? value : "scripted";
}

/** Host orchestration around the pure core reducer/decision function. */
export class Coordinator {
  readonly journal: Journal;
  readonly agent: ScriptedAgent;
  readonly harness: HarnessAdapter;
  readonly process: ProcessAdapter;
  readonly ownerEpoch: number;
  readonly scouts: ScoutGateway;
  private readonly dataDir: string;
  private readonly scriptedDelayMs: number;
  private readonly commandTimeoutMs: number;
  private readonly agentIdleTimeoutMs: number;
  private readonly agentObservationGraceMs: number;
  private readonly operationTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly defaultProfile:
    | "scripted"
    | "codex-readonly"
    | "codex-workspace-write"
    | "claude-readonly"
    | "claude-workspace-write"
    | "pi-readonly";
  private readonly workspaceAdapter?: GitWorkspaceAdapter;
  private readonly workspaces = new Map<string, WorkspaceRef>();
  private readonly branchWorkspaces = new Map<string, WorkspaceRef>();
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();
  private codex?: HarnessAdapter;
  private codexDescriptor?: Awaited<ReturnType<typeof inspectCodex>>;
  private pi?: HarnessAdapter;
  private piDescriptor?: Awaited<ReturnType<typeof inspectPi>>;
  private claude?: HarnessAdapter;
  private claudeDescriptor = claudeSdkDescriptor;
  private opencode?: HarnessAdapter;
  private opencodeDescriptor?: Awaited<ReturnType<typeof inspectExternalCli>>;
  private readonly active = new Map<string, Promise<void>>();
  private readonly reschedule = new Set<string>();
  private readonly activeSchedulers = new Map<string, ReadySetScheduler>();
  private readonly runBudgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly aborters = new Map<string, Map<string, AbortController>>();
  private readonly activeAdapters = new Map<string, Map<string, HarnessAdapter>>();
  private readonly activityEvents = new Map<string, import("@kouro/core").JsonValue[]>();
  private closed = false;

  constructor(options: CoordinatorOptions) {
    this.dataDir = options.dataDir;
    this.journal = new Journal({ dataDir: options.dataDir });
    this.scouts = new ScoutGateway(this.journal);
    this.agent = options.agent ?? new DelayedScriptedAgent();
    this.harness = options.harness ?? new ScriptedHarnessAdapter();
    this.process = options.process ?? createDefaultProcessAdapter();
    this.scriptedDelayMs = Math.max(0, options.scriptedDelayMs ?? 5_000);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.agentIdleTimeoutMs = options.agentIdleTimeoutMs ?? 120_000;
    this.agentObservationGraceMs = options.agentObservationGraceMs ?? 120_000;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 15 * 60_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000;
    this.defaultProfile = options.executionProfile ?? "scripted";
    this.workspaceAdapter = options.workspaceAdapter;
    const row = this.journal.db
      .query("SELECT value FROM schema_meta WHERE key = 'owner_epoch'")
      .get() as { value: string } | null;
    this.ownerEpoch = Number(row?.value ?? 0) + 1;
    this.journal.db
      .query("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('owner_epoch', ?1)")
      .run(String(this.ownerEpoch));
  }

  async start(): Promise<void> {
    for (const run of this.journal.listRuns()) {
      this.scouts.reconcile(run.runId);
      const row = this.journal.getRunRow(run.runId);
      const configured = row
        ? parseJson<Record<string, unknown>>(row.input_json).__kouroWorkspace
        : undefined;
      if (configured && this.workspaceAdapter) {
        try {
          this.workspaces.set(
            run.runId,
            await this.workspaceAdapter.load(configured as WorkspaceRef),
          );
        } catch {
          if (["pending", "running"].includes(run.status))
            this.journal.append({
              runId: run.runId,
              type: "recovery.required",
              payload: {
                code: "workspace-claim-missing",
                subjectId: run.runId,
                detail: "registered workspace claim could not be verified",
              },
              actor: "system",
            });
        }
      }
      // Branch worktrees are claims in the adapter, not ephemeral coordinator
      // state. Reload them as well so a restart never allocates a second
      // checkout for an already-created invocation.
      if (this.workspaceAdapter)
        try {
          for (const claim of await this.workspaceAdapter.listClaims(run.runId)) {
            if (claim.workspaceId !== (configured as WorkspaceRef | undefined)?.workspaceId)
              this.branchWorkspaces.set(
                `${run.runId}:${claim.workspaceId}`,
                await this.workspaceAdapter.load(claim),
              );
          }
        } catch (cause) {
          if (["pending", "running"].includes(run.status))
            this.journal.append({
              runId: run.runId,
              type: "recovery.required",
              payload: {
                code: "workspace-claim-missing",
                subjectId: run.runId,
                detail: cause instanceof Error ? cause.message : String(cause),
              },
              actor: "system",
            });
        }
    }
    // Recovery may enqueue reserved effects. Restore every registered and
    // branch workspace before doing that so dispatch cannot fall back to an
    // unregistered per-invocation directory.
    await this.recover();
    for (const run of this.journal.listRuns())
      if (run.status === "pending" || run.status === "running") this.schedule(run.runId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.runBudgetTimers.values()) clearTimeout(timer);
    this.runBudgetTimers.clear();
    await Promise.allSettled(this.active.values());
    this.journal.close();
  }

  async createRun(input: {
    workflowId: string;
    bundle: Bundle;
    input?: Record<string, unknown>;
    idempotencyKey: string;
    actor?: string;
    /** Accepted for durable compatibility; run-wide profiles and opt-ins are ignored. */
    executionProfile?:
      | "scripted"
      | "codex-readonly"
      | "codex-workspace-write"
      | "claude-readonly"
      | "claude-workspace-write"
      | "pi-readonly";
    allowUnrestrictedCommands?: boolean;
    workspace?: { repositoryPath: string; workspaceId?: string };
  }): Promise<{ run: RunSummary; created: boolean }> {
    const normalizedInput = normalizeAdmissionInput(input.bundle, input.input);
    if (input.workspace && !this.workspaceAdapter)
      throw new Error("workspace adapter is not configured");
    const result = this.journal.createRun({
      ...input,
      input: {
        ...normalizedInput,
        ...(input.executionProfile ? { __kouroExecutionProfile: input.executionProfile } : {}),
      },
      ...(input.executionProfile ? { executionProfile: input.executionProfile } : {}),
      workspace: input.workspace,
    });
    if (result.created && input.workspace) {
      try {
        const ref = await this.workspaceAdapter!.create({
          repositoryPath: input.workspace.repositoryPath,
          runId: result.run.runId,
          workspaceId: input.workspace.workspaceId ?? "main",
        });
        this.workspaces.set(result.run.runId, ref);
        const row = this.journal.getRunRow(result.run.runId);
        this.journal.updateRunInput(result.run.runId, {
          ...(row ? parseJson<Record<string, unknown>>(row.input_json) : {}),
          __kouroWorkspace: ref,
        });
      } catch (cause) {
        this.journal.append({
          runId: result.run.runId,
          type: "recovery.required",
          payload: {
            code: "workspace-allocation-failed",
            subjectId: result.run.runId,
            detail: cause instanceof Error ? cause.message : String(cause),
          },
          actor: "system",
        });
        void cause;
      }
    } else if (!result.created) {
      const row = this.journal.getRunRow(result.run.runId);
      const configured = row
        ? parseJson<Record<string, unknown>>(row.input_json).__kouroWorkspace
        : undefined;
      if (configured && this.workspaceAdapter)
        this.workspaces.set(
          result.run.runId,
          await this.workspaceAdapter.load(configured as WorkspaceRef),
        );
    }
    if (result.created) this.schedule(result.run.runId);
    return { run: result.run, created: result.created };
  }

  async workspaceSnapshot(runId: string): Promise<WorkspaceSnapshot | null> {
    const ref = this.workspaces.get(runId);
    if (!ref || !this.workspaceAdapter) return null;
    const snapshot = await this.workspaceAdapter.snapshot(ref);
    this.snapshots.set(runId, snapshot);
    return snapshot;
  }

  workspacePath(runId: string): string | null {
    return this.workspaces.get(runId)?.path ?? null;
  }

  /** M7 uses these read-only host ownership facts while admission is paused. */
  checkpointWorkspace(runId: string): WorkspaceRef | null {
    return this.workspaces.get(runId) ?? null;
  }
  checkpointWriters(runId: string): string[] {
    // The drive promise may still be settling after its last effect commits.
    // It is not itself a workspace writer; only live effect claims count here.
    return [...(this.aborters.get(runId)?.keys() ?? [])];
  }
  async waitForCheckpointDrain(runId: string): Promise<void> {
    const work = this.active.get(runId);
    if (work) await Promise.allSettled([work]);
  }
  scheduleRun(runId: string): void {
    this.schedule(runId);
  }

  async workspaceIntegrate(input: {
    runId: string;
    targetInvocationId?: string;
    sourceInvocationIds: readonly string[];
  }): Promise<WorkspaceSnapshot> {
    if (!this.workspaceAdapter) throw new Error("workspace adapter is not configured");
    const target = input.targetInvocationId
      ? (this.branchWorkspaces.get(`${input.runId}:${input.targetInvocationId}`) ??
        this.workspaces.get(input.runId))
      : this.workspaces.get(input.runId);
    if (!target) throw new Error("integration target workspace is unavailable");
    const sources = input.sourceInvocationIds
      .map((invocationId) => this.branchWorkspaces.get(`${input.runId}:${invocationId}`))
      .filter((ref): ref is WorkspaceRef => Boolean(ref));
    if (sources.length !== input.sourceInvocationIds.length)
      throw new Error("one or more source branch workspaces are unavailable");
    const result = await this.workspaceAdapter.integrate({ target, sources });
    if (result.conflicts.length)
      throw new Error(`workspace integration conflict: ${result.conflicts.join(", ")}`);
    const snapshot = await this.workspaceAdapter.snapshot(target);
    this.snapshots.set(input.runId, snapshot);
    return snapshot;
  }

  async workspaceCommit(input: {
    runId: string;
    expectedTree: string;
    operationKey: string;
    message: string;
    deliveryActionId?: string;
  }): Promise<import("../adapters/workspace/git.ts").PreparedCommit> {
    const ref = this.workspaces.get(input.runId);
    if (!ref || !this.workspaceAdapter) throw new Error("run has no repository workspace");
    const action = input.deliveryActionId
      ? this.journal.getDeliveryAction(input.deliveryActionId)
      : undefined;
    if (input.deliveryActionId && (!action || action.runId !== input.runId))
      throw new Error("delivery action not found for run");
    if (action && action.status !== "approved" && action.status !== "committed")
      throw new Error(`delivery action is ${action.status}`);
    if (action && (input.expectedTree !== action.resultTree || input.message !== action.message))
      throw new Error("delivery action binding changed");
    const prepared = await this.workspaceAdapter.prepareCommit({
      ref,
      expectedTree: action?.resultTree ?? input.expectedTree,
      operationKey: action?.operationKey ?? input.operationKey,
      message: action?.message ?? input.message,
    });
    if (action && action.status !== "committed")
      this.journal.completeDeliveryAction(action.id, prepared);
    return prepared;
  }

  async prepareDelivery(input: {
    runId: string;
    requestKey: string;
    message: string;
    expectedTree?: string;
    expectedPatchDigest?: string;
    invocationId?: string;
    validationEvidence?: readonly string[];
    reviewEvidence?: readonly string[];
  }): Promise<DeliveryAction> {
    const ref = this.workspaces.get(input.runId);
    if (!ref || !this.workspaceAdapter) throw new Error("run has no repository workspace");
    const snapshot = await this.workspaceAdapter.snapshot(ref);
    if (input.expectedTree !== undefined && snapshot.resultTree !== input.expectedTree)
      throw new Error("stale-review: workspace tree changed after the diff was reviewed");
    if (
      input.expectedPatchDigest !== undefined &&
      snapshot.patchDigest !== input.expectedPatchDigest
    )
      throw new Error("stale-review: workspace diff changed after review");
    return this.journal.createDeliveryAction({
      requestKey: input.requestKey,
      runId: input.runId,
      workspaceId: ref.workspaceId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      baseTree: snapshot.baseTree,
      resultTree: snapshot.resultTree,
      patchDigest: snapshot.patchDigest,
      changedPaths: snapshot.changedPaths,
      message: input.message,
      ...(input.validationEvidence ? { validationEvidence: input.validationEvidence } : {}),
      ...(input.reviewEvidence ? { reviewEvidence: input.reviewEvidence } : {}),
    });
  }

  decideDelivery(input: {
    actionId: string;
    decision: "approved" | "rejected";
    actor: string;
  }): DeliveryAction {
    return this.journal.decideDeliveryAction(input);
  }

  deliveryAction(actionId: string): DeliveryAction | undefined {
    return this.journal.getDeliveryAction(actionId);
  }

  workspaceDiff(runId: string): WorkspaceSnapshot | null {
    return this.snapshots.get(runId) ?? null;
  }

  async cleanupWorkspace(runId: string): Promise<void> {
    const ref = this.workspaces.get(runId);
    if (!ref || !this.workspaceAdapter) throw new Error("run has no repository workspace");
    const view = this.journal.getView(runId);
    if (!view) throw new Error(`Run not found: ${runId}`);
    if (
      Object.values(view.state.attempts).some((attempt) =>
        ["reserved", "running"].includes(attempt.status),
      )
    )
      throw new Error("refusing cleanup of active workspace claim");
    await this.workspaceAdapter.cleanup(ref);
    for (const [key, branch] of this.branchWorkspaces) {
      if (!key.startsWith(`${runId}:`)) continue;
      await this.workspaceAdapter.cleanup(branch);
      this.branchWorkspaces.delete(key);
    }
    this.workspaces.delete(runId);
    this.snapshots.delete(runId);
  }

  assertRunDrained(runId: string): void {
    if (this.active.has(runId))
      throw new Error("run deletion is blocked while its coordinator is active");
    if ((this.aborters.get(runId)?.size ?? 0) > 0)
      throw new Error("run deletion is blocked by active invocation controllers");
    const unconfirmedShutdowns = this.journal.db
      .query("SELECT attempt_id FROM unconfirmed_harness_shutdowns WHERE run_id = ?1")
      .all(runId) as Array<{ attempt_id: string }>;
    if (unconfirmedShutdowns.length)
      throw new Error("run deletion is blocked by unconfirmed harness shutdown");
    const activeAttempts = this.journal.db
      .query("SELECT id FROM attempts WHERE run_id = ?1 AND state IN ('reserved', 'running')")
      .all(runId) as Array<{ id: string }>;
    if (activeAttempts.length) throw new Error("run deletion is blocked by active attempts");
  }

  confirmAbandonedHarnessShutdown(input: {
    runId: string;
    shutdownId: string;
    expectedRevision: number;
    actor: string;
  }): void {
    if (this.active.has(input.runId) || (this.aborters.get(input.runId)?.size ?? 0) > 0)
      throw new Error(
        "An execution is still controlled by this host. Stop it before confirming shutdown.",
      );
    this.journal.transaction(() => {
      const view = this.journal.getView(input.runId);
      if (!view || view.revision !== input.expectedRevision)
        throw new Error("Run changed. Refresh the deletion preview before confirming shutdown.");
      if (view.state.status !== "recovery-required")
        throw new Error("Manual shutdown confirmation is only available for recovery runs.");
      if (
        Object.values(view.state.attempts).some((attempt) =>
          ["reserved", "running"].includes(attempt.status),
        )
      )
        throw new Error("Active attempts must finish before confirming an abandoned shutdown.");
      const shutdown = this.journal.db
        .query(
          "SELECT attempt_id FROM unconfirmed_harness_shutdowns WHERE shutdown_id = ?1 AND run_id = ?2",
        )
        .get(input.shutdownId, input.runId) as { attempt_id: string } | null;
      if (!shutdown)
        throw new Error("This shutdown is no longer awaiting confirmation. Refresh the preview.");
      this.journal.append({
        runId: input.runId,
        type: "harness.activity",
        actor: input.actor,
        subjectId: input.shutdownId,
        payload: {
          attemptId: shutdown.attempt_id,
          event: {
            type: "status",
            data: {
              status: "shutdown-confirmed",
              text: "Operator verified the abandoned external agent has stopped.",
              shutdownId: input.shutdownId,
            },
          },
        },
      });
      this.journal.confirmHarnessShutdown(input.shutdownId);
      const remaining = this.journal.db
        .query("SELECT 1 FROM unconfirmed_harness_shutdowns WHERE run_id = ?1 LIMIT 1")
        .get(input.runId);
      if (!remaining) {
        this.assertRunDrained(input.runId);
        this.stopDrainedRecoveryRun(input.runId, input.actor);
      }
    });
  }

  private stopDrainedRecoveryRun(runId: string, actor: string): void {
    this.journal.append({
      runId,
      type: "run.cancel.requested",
      payload: { reason: "Operator confirmed agent shutdown" },
      actor,
    });
    this.cancelUnstartedWork(runId, "Agent shutdown confirmed; recovery run stopped by operator");
    this.journal.append({ runId, type: "run.completed", payload: { status: "cancelled" }, actor });
  }

  async cleanupRunWorkspaces(runId: string): Promise<void> {
    this.assertRunDrained(runId);
    const claims = await this.workspaceClaims(runId);
    for (const claim of claims ?? []) await this.workspaceAdapter!.cleanup(claim);
    this.workspaces.delete(runId);
    this.snapshots.delete(runId);
    for (const [key, claim] of this.branchWorkspaces) {
      if (claim.runId === runId) this.branchWorkspaces.delete(key);
    }
    this.activeAdapters.delete(runId);
    const view = this.journal.getView(runId);
    for (const attemptId of Object.keys(view?.state.attempts ?? {}))
      this.activityEvents.delete(attemptId);
  }

  async workspaceClaims(runId: string) {
    return this.workspaceAdapter?.listClaims(runId) ?? [];
  }

  hasWorkspaceAdapter(): boolean {
    return Boolean(this.workspaceAdapter);
  }

  decideApproval(input: {
    runId: string;
    invocationId: string;
    decision: "approved" | "rejected" | "changes-requested";
    feedback?: string;
    expectedRevision: number;
    actor: string;
    idempotencyKey: string;
    /** Optional client echo of the binding captured in the approval request. */
    bindingDigest?: string;
    subjectRevision?: number;
  }): { revision: number; status: string } {
    if (!input.actor.trim()) throw new Error("approval actor is required");
    return this.journal.command({
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      requestDigest: JSON.stringify({
        invocationId: input.invocationId,
        decision: input.decision,
        feedback: input.feedback?.trim() ?? "",
        bindingDigest: input.bindingDigest ?? null,
        subjectRevision: input.subjectRevision ?? null,
      }),
      execute: () => this.decideApprovalOnce(input),
    }).result;
  }

  private decideApprovalOnce(
    input: Omit<Parameters<Coordinator["decideApproval"]>[0], "idempotencyKey">,
  ): { revision: number; status: string } {
    const view = this.journal.getView(input.runId);
    if (!view) throw new Error(`Run not found: ${input.runId}`);
    if (view.state.control !== "none")
      throw new Error("approval is unavailable while the run is stopping");
    if (view.revision !== input.expectedRevision)
      throw new Error(
        `stale-action: expected revision ${input.expectedRevision}, current revision ${view.revision}`,
      );
    const approval = Object.values(view.state.approvals).find(
      (candidate) =>
        candidate.invocationId === input.invocationId && candidate.status === "pending",
    );
    if (!approval) throw new Error("approval is not pending");
    const feedback = input.feedback?.trim() ?? "";
    if (feedback.length > 20_000) throw new Error("approval feedback exceeds 20000 characters");
    if (input.decision === "changes-requested") {
      if (!feedback) throw new Error("request changes requires feedback");
      if (approvalRepairsRemaining(view.bundle, view.state, input.invocationId) === 0)
        throw new Error(
          "request changes is unavailable: no bounded feedback route or repair budget remains",
        );
    }
    if (input.bindingDigest !== undefined && input.bindingDigest !== approval.bindingDigest)
      throw new Error("stale-action: approval binding changed");
    if (input.subjectRevision !== undefined && input.subjectRevision !== approval.subjectRevision)
      throw new Error("stale-action: approval subject changed");
    const invocation = view.state.invocations[input.invocationId]!;
    const definition =
      view.bundle.definitions[view.state.scopes[invocation.scopeId]!.definitionId]!;
    const port = definition.nodes.find((node) => node.id === invocation.nodeId)?.outputPorts[0];
    const stored = port
      ? this.journal.blobs.put(
          input.runId,
          new TextEncoder().encode(json({ decision: input.decision, feedback })),
          "application/json",
        )
      : undefined;
    if (stored) this.journal.insertArtifact(stored);
    this.journal.append({
      runId: input.runId,
      type: "approval.decided",
      payload: {
        approvalId: approval.id,
        decision: input.decision,
        bindingDigest: approval.bindingDigest,
        subjectRevision: approval.subjectRevision,
        ...(feedback ? { feedback } : {}),
        ...(stored && port
          ? {
              output: [
                {
                  id: stored.id,
                  digest: stored.digest,
                  mediaType: stored.mediaType,
                  schemaDigest: port.schemaDigest,
                },
              ],
            }
          : {}),
      },
      actor: input.actor,
      subjectId: approval.id,
    });
    this.schedule(input.runId);
    const next = this.journal.getView(input.runId)!;
    return { revision: next.revision, status: next.state.status };
  }

  control(input: {
    runId: string;
    action: "pause" | "resume" | "cancel" | "interrupt" | "detach";
    expectedRevision: number;
    actor: string;
    idempotencyKey: string;
  }): { revision: number; status: string } {
    if (!input.actor.trim()) throw new Error("action actor is required");
    const result = this.journal.command({
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      execute: () => this.controlOnce(input),
    }).result;
    if (
      (input.action === "cancel" || input.action === "interrupt") &&
      !this.active.has(input.runId)
    )
      this.schedule(input.runId);
    return result;
  }

  async steer(input: {
    runId: string;
    invocationId: string;
    attemptId: string;
    message: string;
    actor: string;
    idempotencyKey: string;
  }): Promise<{ revision: number; duplicate?: boolean }> {
    const view = this.journal.getView(input.runId);
    if (!view) throw new Error(`Run not found: ${input.runId}`);
    const message = input.message.trim();
    if (!message || message.length > 4000)
      throw new Error("steer message must be 1 to 4000 characters");
    if (!input.idempotencyKey.trim()) throw new Error("idempotency key is required");
    const requestDigest = createHash("sha256")
      .update(
        canonicalize({ invocationId: input.invocationId, attemptId: input.attemptId, message }),
      )
      .digest("hex");
    const prior = this.journal.getSteeringCommand(input.runId, input.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        throw new Error("idempotency key payload conflict");
      if (prior.status === "accepted")
        return {
          revision: prior.revision ?? this.journal.getView(input.runId)?.revision ?? view.revision,
          duplicate: true,
        };
      if (prior.status === "rejected")
        throw new Error(
          `steer-rejected: ${prior.detail ?? "The harness rejected this instruction"}`,
        );
      throw new Error(
        "steer-outcome-unknown: this instruction may have reached the harness; it was not resent",
      );
    }
    // Activity advances the run revision while the assistant streams. Bind steering to the live
    // attempt identity instead of rejecting it on those unrelated cursor updates.
    const invocation = view.state.invocations[input.invocationId];
    if (!invocation || invocation.status !== "running")
      throw new Error("steer-unavailable: invocation is not running");
    const adapter = this.activeAdapters.get(input.runId)?.get(input.invocationId);
    if (!adapter?.steer)
      throw new Error("steer-unavailable: active harness does not support mid-turn steering");
    const attempt = Object.values(view.state.attempts).find(
      (item) =>
        item.id === input.attemptId &&
        item.invocationId === invocation.id &&
        item.status === "running",
    );
    if (!attempt) throw new Error("steer-unavailable: active attempt is missing");
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => value && /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
      .map(([, value]) => value!)
      .filter((value) => value.length >= 6);
    const journalMessage = String(redactSecrets(message, secrets));
    const activity = (status: string, extra: Record<string, string | number> = {}) =>
      this.journal.append({
        runId: input.runId,
        type: "harness.activity",
        payload: {
          attemptId: attempt.id,
          event: {
            type: "log",
            at: new Date().toISOString(),
            data: {
              status,
              idempotencyKey: input.idempotencyKey,
              requestDigest,
              invocationId: input.invocationId,
              ...extra,
            },
          },
        },
        actor: input.actor,
        subjectId: attempt.id,
      });
    const requested = activity("Steering instruction requested", {
      instruction: journalMessage,
      outcome: "requested",
    });
    try {
      await adapter.steer({ invocationId: input.invocationId, message });
    } catch (cause) {
      const detail = String(
        redactSecrets(cause instanceof Error ? cause.message : String(cause), secrets),
      );
      activity("Steering instruction rejected", {
        detail,
        instruction: journalMessage,
        outcome: "rejected",
      });
      throw new Error(`steer-rejected: ${detail}`);
    }
    const current = this.journal.getView(input.runId);
    if (
      !current ||
      ["succeeded", "failed", "cancelled", "interrupted", "recovery-required"].includes(
        current.state.status,
      )
    )
      return { revision: requested.sequence };
    const accepted = activity("Steering instruction accepted", {
      instruction: journalMessage,
      outcome: "accepted",
    });
    return { revision: accepted.sequence };
  }

  canSteer(runId: string, invocationId: string): boolean {
    const adapter = this.activeAdapters.get(runId)?.get(invocationId);
    return Boolean(adapter?.steer && (adapter.canSteer?.({ invocationId }) ?? true));
  }

  canInterrupt(runId: string, invocationId: string): boolean {
    return Boolean(this.aborters.get(runId)?.has(invocationId));
  }

  interruptAttempt(input: {
    runId: string;
    invocationId: string;
    attemptId: string;
    expectedRevision: number;
    actor: string;
    idempotencyKey: string;
  }) {
    if (!input.actor.trim()) throw new Error("action actor is required");
    return this.journal.command({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: JSON.stringify({
        action: "interrupt-attempt",
        invocationId: input.invocationId,
        attemptId: input.attemptId,
      }),
      execute: () => {
        const view = this.journal.getView(input.runId);
        if (!view || view.revision !== input.expectedRevision)
          throw new Error("stale-action: run revision changed");
        const attempt = view.state.attempts[input.attemptId];
        const aborter = this.aborters.get(input.runId)?.get(input.invocationId);
        if (
          !attempt ||
          attempt.invocationId !== input.invocationId ||
          attempt.status !== "running" ||
          !aborter ||
          !["running", "paused"].includes(view.state.status) ||
          (view.state.control ?? "none") !== "none"
        )
          throw new Error("interrupt is unavailable: the selected agent attempt is no longer live");
        const event = this.journal.append({
          runId: input.runId,
          type: "harness.activity",
          actor: input.actor,
          payload: {
            attemptId: input.attemptId,
            event: {
              type: "log",
              at: now(),
              data: {
                status: "Agent interrupt requested",
                outcome: "requested",
                idempotencyKey: input.idempotencyKey,
              },
            },
          },
        });
        aborter.abort("operator interrupted this agent");
        return { revision: event.sequence, status: view.state.status };
      },
    }).result;
  }

  canRetry(runId: string, invocationId: string): boolean {
    const view = this.journal.getView(runId);
    if (
      !view ||
      !["failed", "interrupted"].includes(view.state.status) ||
      ((view.state.control ?? "none") !== "none" &&
        !(view.state.status === "interrupted" && view.state.control === "interrupt-requested"))
    )
      return false;
    if (view.state.status === "interrupted" && view.state.control !== "interrupt-requested")
      return false;
    const invocation = view.state.invocations[invocationId];
    const node = view.bundle.definitions[view.bundle.rootDefinitionId]?.nodes.find(
      (item) => item.id === invocation?.nodeId,
    );
    // Retrying a nested/consumed result requires invalidating its dependants.
    // Admit only failed root effects whose result has not been consumed.
    if (
      !invocation ||
      invocation.status !== "failed" ||
      invocation.scopeId !== view.state.rootScopeId ||
      !node ||
      !["agent", "command"].includes(node.kind) ||
      Object.values(view.state.invocations).some(
        (item) => item.sourceInvocationId === invocationId,
      ) ||
      view.bundle.definitions[view.bundle.rootDefinitionId]?.nodes.some(
        (item) => item.kind === "fork" && (item as ForkNode).branchIds.includes(invocation.nodeId),
      )
    )
      return false;
    const latest = Object.values(view.state.attempts)
      .filter((item) => item.invocationId === invocationId)
      .sort((a, b) => b.ordinal - a.ordinal)[0];
    if (
      !latest ||
      !["failed", "cancelled"].includes(latest.status) ||
      Object.keys(view.state.attempts).length >= view.bundle.limits.maxAttempts
    )
      return false;
    return !this.journal.db
      .query("SELECT 1 FROM unconfirmed_harness_shutdowns WHERE run_id = ?1 LIMIT 1")
      .get(runId);
  }

  private normalizeActivity(runId: string, event: HarnessEvent): HarnessEvent {
    if (
      event.type !== "tool" ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data) ||
      event.data.output === undefined
    )
      return event;
    const output = redactSecrets(
      event.data.output,
      Object.entries(process.env)
        .filter(([key, value]) => value && /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
        .map(([, value]) => value!)
        .filter((value) => value.length >= 6),
    ) as JsonValue;
    const bytes = new TextEncoder().encode(json(output));
    if (bytes.byteLength <= 65536) return event;
    const artifact = this.journal.blobs.put(runId, bytes, "application/json");
    this.journal.insertArtifact(artifact);
    return {
      ...event,
      data: {
        ...event.data,
        output: activityPreview(output),
        outputArtifactId: artifact.id,
        outputBytes: bytes.byteLength,
      },
    };
  }

  private recordHarnessActivity(
    runId: string,
    invocationId: string,
    attemptId: string,
    event: import("@kouro/core").HarnessEvent,
  ): void {
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => value && /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
      .map(([, value]) => value!)
      .filter((value) => value.length >= 6);
    const safe = redactSecrets(event, secrets) as import("@kouro/core").JsonValue;
    const recorded = this.activityEvents.get(attemptId) ?? [];
    recorded.push(safe);
    if (recorded.length > 4000) recorded.splice(0, recorded.length - 4000);
    this.activityEvents.set(attemptId, recorded);
    this.journal.append({
      runId,
      type: "harness.activity",
      payload: { attemptId, event: safe },
      actor: "harness",
      subjectId: attemptId,
      causationId: invocationId,
    });
  }

  private async superviseHarness(
    adapter: HarnessAdapter,
    input: Parameters<HarnessAdapter["run"]>[0],
    controller: AbortController,
    timeoutMs: number | undefined,
    runDeadlineAt: number | undefined,
    recoveryAttemptId = input.attemptId ?? input.invocationId,
    recordSupervisionEvent?: (event: HarnessEvent) => void,
  ): Promise<Awaited<ReturnType<HarnessAdapter["run"]>> | undefined> {
    const startedAt = Date.now();
    const supervisionId = id("supervision");
    let lastProgressAt = startedAt;
    let observationUntil: number | undefined;
    let reconnectAttempts = 0;
    const runningTools = new Map<string, number>();
    let stopReason:
      | "cancelled"
      | "budget-exhausted"
      | "run-budget-exhausted"
      | "possibly-stalled"
      | "operation-timeout"
      | undefined;
    const signal = input.signal;
    const attemptId = input.attemptId ?? input.invocationId;
    const record = input.onEvent;
    const log = (status: string, detail: string) => {
      const event: HarnessEvent = {
        type: "log",
        at: new Date().toISOString(),
        data: { status, detail },
      };
      record?.(event);
      recordSupervisionEvent?.(event);
    };
    const operation = adapter.run({
      ...input,
      // `timeoutMs` is supervised as a host attempt budget. Adapter deadlines are
      // reserved for bounded protocol operations so output can keep an attempt alive.
      timeoutMs: undefined,
      onEvent: (event) => {
        record?.(event);
        if (event.type === "text") {
          lastProgressAt = Date.now();
          observationUntil = undefined;
        }
        if (event.type !== "tool" || !event.data || typeof event.data !== "object") return;
        const tool = event.data as Record<string, unknown>;
        const id = String(tool.id ?? tool.name ?? "tool");
        const status = String(tool.status ?? "").toLowerCase();
        const terminal = /complete|finish|end|fail|error|result|cancel/.test(status);
        if (terminal) runningTools.delete(id);
        else if (/start|running|update/.test(status)) {
          runningTools.set(id, runningTools.get(id) ?? Date.now() + this.operationTimeoutMs);
        }
        lastProgressAt = Date.now();
        observationUntil = undefined;
      },
    });
    type Settled =
      | { ok: true; result: Awaited<ReturnType<HarnessAdapter["run"]>> }
      | { ok: false; error: unknown };
    const settled = operation.then(
      (result): Settled => ({ ok: true, result }),
      (error: unknown): Settled => ({ ok: false, error }),
    );
    const sleep = (ms: number) => Bun.sleep(Math.max(1, ms));
    const settleAfterStop = async (
      reason: NonNullable<typeof stopReason>,
    ): Promise<Awaited<ReturnType<HarnessAdapter["run"]>> | undefined> => {
      stopReason = reason;
      if (!signal?.aborted) controller.abort(reason);
      log("Cancellation requested", reason);
      const final = await Promise.race([settled, sleep(this.cancelGraceMs).then(() => null)]);
      if (final === null) {
        let terminated = false;
        if (adapter.terminate) {
          try {
            terminated = await Promise.race([
              adapter.terminate({ attemptId, reason }),
              sleep(5_000).then(() => false),
            ]);
          } catch {
            terminated = false;
          }
        }
        if (terminated) {
          log("Owned process termination confirmed", reason);
          if (reason === "cancelled")
            return {
              status: "cancelled",
              error: "cancelled",
              events: [],
              usage: unavailableUsage() as unknown as import("@kouro/core").JsonValue,
            };
          return {
            status: "failed",
            error: reason,
            events: [],
            usage: unavailableUsage() as unknown as import("@kouro/core").JsonValue,
          };
        }
        const detail = `provider did not confirm termination within ${this.cancelGraceMs}ms after ${reason}`;
        log("Cancellation unconfirmed; recovery required", detail);
        const effect = this.journal.db
          .query("SELECT id FROM effects WHERE attempt_id = ?1")
          .get(recoveryAttemptId) as { id: string } | null;
        if (effect) {
          this.journal.markRecoveryRequired(effect.id, detail, supervisionId);
          // A provider may finish after the cancellation grace window. Keep
          // deletion fenced until that late settlement confirms shutdown.
          void settled
            .then(() => this.journal.confirmHarnessShutdown(supervisionId))
            .catch(() => undefined);
        }
        return undefined;
      }
      if (!final.ok) {
        if (reason === "cancelled")
          return {
            status: "cancelled",
            error: "cancelled",
            events: [],
            usage: unavailableUsage() as unknown as import("@kouro/core").JsonValue,
          };
        return {
          status: "failed",
          error: `${reason}: ${final.error instanceof Error ? final.error.message : String(final.error)}`,
          events: [],
          usage: unavailableUsage() as unknown as import("@kouro/core").JsonValue,
        };
      }
      if (reason === "cancelled") {
        if (final.result.status === "succeeded") return final.result;
        return { ...final.result, status: "cancelled", error: "cancelled" };
      }
      return { ...final.result, status: "failed", error: reason };
    };

    for (;;) {
      const now = Date.now();
      const first = await Promise.race([settled, sleep(250).then(() => null)]);
      if (first !== null) {
        if (!first.ok) {
          if (signal?.aborted) {
            const reason =
              signal.reason === "budget-exhausted" || signal.reason === "run-budget-exhausted"
                ? signal.reason
                : "cancelled";
            return settleAfterStop(reason);
          }
          return {
            status: "failed",
            error: `transport: ${first.error instanceof Error ? first.error.message : String(first.error)}`,
            events: [],
            usage: unavailableUsage() as unknown as import("@kouro/core").JsonValue,
          };
        }
        return first.result;
      }
      if (signal?.aborted) {
        const reason =
          signal.reason === "budget-exhausted" || signal.reason === "run-budget-exhausted"
            ? signal.reason
            : "cancelled";
        return settleAfterStop(reason);
      }
      if (timeoutMs !== undefined && now - startedAt >= timeoutMs) {
        log("Attempt budget exhausted", `maximum attempt duration ${timeoutMs}ms reached`);
        return settleAfterStop("budget-exhausted");
      }
      if (runDeadlineAt !== undefined && now >= runDeadlineAt) {
        log("Run budget exhausted", "maximum run duration reached");
        return settleAfterStop("run-budget-exhausted");
      }
      const expiredTool = [...runningTools].find(([, deadline]) => deadline <= now)?.[0];
      if (expiredTool) {
        log("Tool operation timed out", `${expiredTool} exceeded ${this.operationTimeoutMs}ms`);
        return settleAfterStop("operation-timeout");
      }
      const view = this.journal.getView(input.runId);
      const suspended =
        view?.state.status === "paused" ||
        Object.values(view?.state.approvals ?? {}).some(
          (approval) => approval.status === "pending",
        );
      if (suspended || runningTools.size > 0) {
        lastProgressAt = now;
        observationUntil = undefined;
        continue;
      }
      if (now - lastProgressAt < this.agentIdleTimeoutMs) continue;
      if (observationUntil === undefined || now >= observationUntil) {
        let probe: "working" | "disconnected" | "unknown" = "unknown";
        if (adapter.probe) {
          try {
            probe = await Promise.race([
              adapter.probe({ attemptId }),
              sleep(Math.min(5_000, this.agentObservationGraceMs)).then(() => "unknown" as const),
            ]);
          } catch {
            probe = "unknown";
          }
        }
        if (probe === "disconnected" && adapter.reconnect && reconnectAttempts < 1) {
          reconnectAttempts += 1;
          let reconnected = false;
          try {
            reconnected = await Promise.race([
              adapter.reconnect({ attemptId }),
              sleep(Math.min(5_000, this.agentObservationGraceMs)).then(() => false),
            ]);
          } catch {
            reconnected = false;
          }
          log(
            reconnected ? "Provider reconnected; observing" : "Provider reconnection failed",
            `status probe reported disconnected for attempt ${attemptId}`,
          );
          observationUntil = Date.now() + this.agentObservationGraceMs;
          continue;
        }
        if (probe === "working") {
          log("Provider reports working; observing", `no progress for attempt ${attemptId}`);
          observationUntil = Date.now() + this.agentObservationGraceMs;
          continue;
        }
        if (observationUntil === undefined) {
          log(
            "Possibly stalled; provider status unknown",
            `no text or tool progress for ${this.agentIdleTimeoutMs}ms; observing for ${this.agentObservationGraceMs}ms`,
          );
          observationUntil = Date.now() + this.agentObservationGraceMs;
          continue;
        }
        log("Agent remained silent after observation grace", `attempt ${attemptId}`);
        return settleAfterStop("possibly-stalled");
      }
    }
  }

  private controlOnce(input: Omit<Parameters<Coordinator["control"]>[0], "idempotencyKey">): {
    revision: number;
    status: string;
  } {
    const view = this.journal.getView(input.runId);
    if (!view) throw new Error(`Run not found: ${input.runId}`);
    if (view.revision !== input.expectedRevision)
      throw new Error(
        `stale-action: expected revision ${input.expectedRevision}, current revision ${view.revision}`,
      );
    if (view.state.status === "recovery-required") {
      if (input.action !== "cancel")
        throw new Error("Resolve or stop the recovery run before taking this action.");
      this.assertRunDrained(input.runId);
      this.journal.transaction(() => this.stopDrainedRecoveryRun(input.runId, input.actor));
      const stopped = this.journal.getView(input.runId)!;
      return { revision: stopped.revision, status: stopped.state.status };
    }
    const active = Object.values(view.state.attempts).some(
      (attempt) => attempt.status === "running",
    );
    const hasWork = Object.values(view.state.invocations).some((invocation) =>
      ["pending", "reserved", "running"].includes(invocation.status),
    );
    if (!hasWork && input.action !== "detach")
      throw new Error(`${input.action} is unavailable without an active run`);
    if (input.action === "interrupt" && !active)
      throw new Error("interrupt is unavailable without an active attempt");
    // Persist the stop request even when the provider cannot cancel directly.
    // The coordinator then applies the bounded grace/termination sequence and
    // fences the effect as recovery-required if it cannot confirm shutdown.
    const type =
      input.action === "pause"
        ? "run.paused"
        : input.action === "resume"
          ? "run.resumed"
          : input.action === "cancel"
            ? "run.cancel.requested"
            : input.action === "interrupt"
              ? "run.interrupt.requested"
              : "run.detached";
    this.journal.append({ runId: input.runId, type, payload: {}, actor: input.actor });
    if (input.action === "cancel" || input.action === "interrupt") {
      this.activeSchedulers.get(input.runId)?.cancel(input.action);
      this.cancelUnstartedWork(input.runId, input.action);
      for (const aborter of this.aborters.get(input.runId)?.values() ?? [])
        aborter.abort(input.action);
    }
    if (input.action === "resume") {
      if (this.active.has(input.runId)) this.reschedule.add(input.runId);
      else this.schedule(input.runId);
    }
    const next = this.journal.getView(input.runId)!;
    return { revision: next.revision, status: next.state.status };
  }

  retry(input: {
    runId: string;
    invocationId: string;
    expectedRevision: number;
    actor: string;
    idempotencyKey: string;
  }): { revision: number; status: string } {
    if (!input.actor.trim()) throw new Error("action actor is required");
    return this.journal.command({
      idempotencyKey: input.idempotencyKey,
      runId: input.runId,
      execute: () => this.retryOnce(input),
    }).result;
  }

  private retryOnce(input: Omit<Parameters<Coordinator["retry"]>[0], "idempotencyKey">): {
    revision: number;
    status: string;
  } {
    const view = this.journal.getView(input.runId);
    if (!view) throw new Error(`Run not found: ${input.runId}`);
    if (!this.canRetry(input.runId, input.invocationId))
      throw new Error(
        "retry is unavailable: the failed effect must be drained, unconsumed, and within the attempt budget",
      );
    if (view.revision !== input.expectedRevision)
      throw new Error(
        `stale-action: expected revision ${input.expectedRevision}, current revision ${view.revision}`,
      );
    const invocation = view.state.invocations[input.invocationId];
    const attempts = Object.values(view.state.attempts)
      .filter((attempt) => attempt.invocationId === input.invocationId)
      .sort((a, b) => b.ordinal - a.ordinal);
    const source = attempts[0];
    if (
      !invocation ||
      invocation.status !== "failed" ||
      !source ||
      !["failed", "cancelled"].includes(source.status)
    )
      throw new Error("retry is only available for a failed terminal invocation");
    const attemptId = id("attempt");
    this.journal.transaction(() => {
      this.journal.append({
        runId: input.runId,
        type: "run.retried",
        payload: { invocationId: input.invocationId, sourceAttemptId: source.id, attemptId },
        actor: input.actor,
        subjectId: input.invocationId,
      });
      this.reserve(
        input.runId,
        this.journal.getView(input.runId)!.state,
        input.invocationId,
        attemptId,
      );
    });
    this.schedule(input.runId);
    const next = this.journal.getView(input.runId)!;
    return { revision: next.revision, status: next.state.status };
  }

  private schedule(runId: string): void {
    if (this.closed) return;
    if (this.active.has(runId)) {
      this.reschedule.add(runId);
      return;
    }
    const work = this.drive(runId)
      .catch((cause) => {
        const view = this.journal.getView(runId);
        if (view && (view.state.status === "pending" || view.state.status === "running")) {
          const invocations = Object.values(view.state.invocations);
          const allSettled =
            invocations.length > 0 &&
            invocations.every((invocation) =>
              ["succeeded", "failed", "recovery-required"].includes(invocation.status),
            );
          if (allSettled) {
            this.journal.append({
              runId,
              type: "run.completed",
              payload: {
                status:
                  view.state.control === "cancel-requested"
                    ? "cancelled"
                    : view.state.control === "interrupt-requested"
                      ? "interrupted"
                      : "failed",
              },
              actor: "system",
            });
          } else {
            this.journal.append({
              runId,
              type: "recovery.required",
              payload: {
                code: "coordinator-drive-failed",
                detail: cause instanceof Error ? cause.message : String(cause),
              },
              actor: "system",
            });
          }
        }
      })
      .finally(() => {
        this.active.delete(runId);
        const view = this.journal.getView(runId);
        if (
          !view ||
          ["succeeded", "failed", "cancelled", "interrupted", "recovery-required"].includes(
            view.state.status,
          )
        ) {
          const timer = this.runBudgetTimers.get(runId);
          if (timer) clearTimeout(timer);
          this.runBudgetTimers.delete(runId);
        }
        if (!this.closed && this.reschedule.delete(runId)) this.schedule(runId);
      });
    this.active.set(runId, work);
  }

  private cancelUnstartedWork(runId: string, reason: string): void {
    const view = this.journal.getView(runId);
    if (!view) return;
    for (const invocation of Object.values(view.state.invocations)) {
      const attempts = Object.values(view.state.attempts).filter(
        (attempt) => attempt.invocationId === invocation.id,
      );
      const reserved = attempts
        .filter((attempt) => attempt.status === "reserved")
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      const hasRunningAttempt = attempts.some((attempt) => attempt.status === "running");
      if (
        !["pending", "reserved"].includes(invocation.status) &&
        !(invocation.status === "running" && !hasRunningAttempt)
      )
        continue;
      if (reserved) this.journal.cancelReservedEffect(reserved.id, reason);
      this.journal.append({
        runId,
        type: "invocation.cancelled",
        payload: { invocationId: invocation.id, reason },
        actor: "system",
        subjectId: invocation.id,
      });
    }
  }

  private armRunBudget(runId: string, view: import("@kouro/core").RunView): void {
    if (this.runBudgetTimers.has(runId)) return;
    const startedAt = view.state.startedAt ? Date.parse(view.state.startedAt) : Date.now();
    const deadline = startedAt + view.bundle.limits.maxRunDurationMs;
    const timer = setTimeout(() => this.expireRunBudget(runId), Math.max(1, deadline - Date.now()));
    this.runBudgetTimers.set(runId, timer);
  }

  private expireRunBudget(runId: string): void {
    this.runBudgetTimers.delete(runId);
    const view = this.journal.getView(runId);
    if (!view || !["running", "paused"].includes(view.state.status)) return;
    const attemptId = Object.values(view.state.attempts).find(
      (attempt) => attempt.status === "running",
    )?.id;
    this.journal.append({
      runId,
      type: "harness.activity",
      payload: {
        attemptId: attemptId ?? `${runId}:budget`,
        event: {
          type: "log",
          at: new Date().toISOString(),
          data: { status: "Run budget exhausted", detail: "maximum run duration reached" },
        },
      },
      actor: "system",
      ...(attemptId ? { subjectId: attemptId } : {}),
    });
    if (view.state.control === "none")
      this.journal.append({
        runId,
        type: "run.cancel.requested",
        payload: {},
        actor: "system",
      });
    this.activeSchedulers.get(runId)?.cancel("run-budget-exhausted");
    this.cancelUnstartedWork(runId, "run budget exhausted");
    for (const aborter of this.aborters.get(runId)?.values() ?? [])
      aborter.abort("run-budget-exhausted");
    if (!this.active.has(runId)) this.schedule(runId);
  }

  private async drive(runId: string): Promise<void> {
    for (;;) {
      const view = this.journal.getView(runId);
      if (
        !view ||
        view.state.status === "succeeded" ||
        view.state.status === "failed" ||
        view.state.status === "recovery-required"
      )
        return;
      if (view.state.status === "running") this.armRunBudget(runId, view);
      if (view.state.control !== "none") {
        const active = Object.values(view.state.invocations).some((item) =>
          ["pending", "reserved", "running"].includes(item.status),
        );
        if (
          !active &&
          (view.state.control === "cancel-requested" ||
            view.state.control === "interrupt-requested")
        ) {
          this.journal.append({
            runId,
            type: "run.completed",
            payload: {
              status: view.state.control === "cancel-requested" ? "cancelled" : "interrupted",
            },
            actor: "system",
          });
        }
        return;
      }
      if (view.state.status === "pending") {
        this.journal.append({
          runId,
          type: "run.started",
          payload: {
            rootScopeId: view.state.rootScopeId,
            rootDefinitionId: view.bundle.rootDefinitionId,
          },
          actor: "system",
        });
        continue;
      }
      const intents = decide(view.bundle, view.state);
      // Structural activation and reservation are committed in one pass so a
      // ready set can become runnable together.  This is important for fork
      // branches: reserving only intents[0] would accidentally serialize the
      // graph even though the journal already describes independent work.
      const activations = intents.filter((candidate) => candidate.kind === "activate");
      if (activations.length) {
        for (const intent of activations)
          this.activate(runId, this.journal.getView(runId)!.state, intent);
        continue;
      }
      const calls = intents.filter((candidate) => candidate.kind === "call");
      if (calls.length) {
        for (const intent of calls) {
          const parent = this.journal.getView(runId)?.state.invocations[intent.invocationId];
          const child = view.bundle.definitions[intent.definitionId];
          if (!parent || !child)
            throw new Error(`Call definition ${intent.definitionId} is unavailable`);
          const scopeId = `${parent.id}:scope`;
          const entry = child.nodes.find((candidate) => candidate.id === child.entry);
          this.journal.appendMany([
            {
              runId,
              type: "scope.created",
              payload: {
                scope: {
                  id: scopeId,
                  parentScopeId: parent.scopeId,
                  definitionId: intent.definitionId,
                  status: "running",
                  activationOrdinal: parent.activationOrdinal,
                },
              },
              actor: "system",
              subjectId: scopeId,
            },
            {
              runId,
              type: "invocation.created",
              payload: {
                invocationId: id("inv"),
                scopeId,
                nodeId: child.entry,
                activationOrdinal: 0,
                sourceInvocationId: parent.id,
                sourceEdgeId: `${parent.nodeId}:call`,
                inputBindings: entry?.bindings.reduce(
                  (result, binding) => {
                    result[binding.targetPort] = parent.inputBindings[binding.targetPort] ?? {
                      source: binding.source,
                      missing: binding.missing,
                    };
                    return result;
                  },
                  {} as Record<string, import("@kouro/core").BoundInput>,
                ),
              },
              actor: "system",
            },
          ]);
        }
        continue;
      }
      const loops = intents.filter((candidate) => candidate.kind === "loop");
      if (loops.length) {
        for (const intent of loops) {
          const parent = this.journal.getView(runId)?.state.invocations[intent.invocationId];
          if (!parent) throw new Error(`Loop invocation ${intent.invocationId} is unavailable`);
          const scopeId = `${parent.id}:iteration:${intent.iteration}`;
          const definitionId =
            this.journal.getView(runId)?.state.scopes[parent.scopeId]?.definitionId ??
            view.bundle.rootDefinitionId;
          const definition = view.bundle.definitions[definitionId];
          const body = definition?.nodes.find((candidate) => candidate.id === intent.bodyNodeId);
          if (!definition || !body)
            throw new Error(`Loop body ${intent.bodyNodeId} is unavailable`);
          const priorIteration = Object.values(this.journal.getView(runId)!.state.scopes).find(
            (scope) =>
              scope.parentScopeId === parent.scopeId &&
              scope.id === `${parent.id}:iteration:${intent.iteration - 1}`,
          );
          const priorBody = priorIteration
            ? Object.values(this.journal.getView(runId)!.state.invocations).find(
                (candidate) => candidate.scopeId === priorIteration.id,
              )
            : undefined;
          const inputBindings = Object.fromEntries(
            body.inputPorts.map((port) => {
              const artifactId = priorBody?.output[0]?.id;
              return [
                port.name,
                artifactId
                  ? {
                      source: {
                        kind: "producer" as const,
                        sourceId: priorBody.nodeId,
                        port: "output",
                      },
                      artifactId,
                      missing: "omit" as const,
                    }
                  : (parent.inputBindings[port.name] ?? {
                      source: { kind: "literal" as const, value: null },
                      value: null,
                      missing: "default" as const,
                    }),
              ];
            }),
          );
          this.journal.appendMany([
            {
              runId,
              type: "scope.created",
              payload: {
                scope: {
                  id: scopeId,
                  parentScopeId: parent.scopeId,
                  definitionId,
                  status: "running",
                  activationOrdinal: intent.iteration,
                },
              },
              actor: "system",
              subjectId: scopeId,
            },
            {
              runId,
              type: "invocation.created",
              payload: {
                invocationId: id("inv"),
                scopeId,
                nodeId: intent.bodyNodeId,
                activationOrdinal: 0,
                sourceInvocationId: parent.id,
                sourceEdgeId: `${parent.nodeId}:iteration:${intent.iteration}`,
                inputBindings,
              },
              actor: "system",
            },
          ]);
        }
        continue;
      }
      const maps = intents.filter((candidate) => candidate.kind === "forEach");
      if (maps.length) {
        for (const intent of maps) {
          const parent = this.journal.getView(runId)?.state.invocations[intent.invocationId];
          const definition = view.bundle.definitions[intent.definitionId];
          if (!parent || !definition)
            throw new Error(`forEach definition ${intent.definitionId} is unavailable`);
          const scopeId = `${parent.id}:item:${intent.itemIndex}`;
          const entry = definition.nodes.find((candidate) => candidate.id === definition.entry);
          const inputBindings = Object.fromEntries(
            (entry?.inputPorts ?? []).map((port) => [
              port.name,
              {
                source: { kind: "literal" as const, value: intent.item },
                value: intent.item,
                missing: "default" as const,
              },
            ]),
          );
          this.journal.appendMany([
            {
              runId,
              type: "scope.created",
              payload: {
                scope: {
                  id: scopeId,
                  parentScopeId: parent.scopeId,
                  definitionId: intent.definitionId,
                  status: "running",
                  activationOrdinal: intent.itemIndex,
                },
              },
              actor: "system",
              subjectId: scopeId,
            },
            {
              runId,
              type: "invocation.created",
              payload: {
                invocationId: id("inv"),
                scopeId,
                nodeId: definition.entry,
                activationOrdinal: intent.itemIndex,
                sourceInvocationId: parent.id,
                sourceEdgeId: `${parent.nodeId}:item:${intent.itemIndex}`,
                inputBindings,
              },
              actor: "system",
            },
          ]);
        }
        continue;
      }
      const reservations = intents.filter((candidate) => candidate.kind === "reserve");
      if (reservations.length) {
        for (const intent of reservations) {
          const current = this.journal.getView(runId)?.state;
          if (current) this.reserve(runId, current, intent.invocationId);
        }
        continue;
      }
      const executions = intents.filter((candidate) => candidate.kind === "execute");
      if (executions.length > 1) {
        const groups = Object.values(view.state.scopes).flatMap((scope) => {
          const definition = view.bundle.definitions[scope.definitionId];
          return (definition?.nodes ?? [])
            .filter((candidate): candidate is ForkNode => candidate.kind === "fork")
            .map((fork) => {
              const join = definition!.nodes.find(
                (candidate) =>
                  candidate.kind === "join" && (candidate as JoinNode).groupId === fork.groupId,
              ) as JoinNode | undefined;
              return {
                id: `${scope.id}:${fork.groupId}`,
                expectedBranchIds: executions
                  .filter((intent) => {
                    const invocation = view.state.invocations[intent.invocationId];
                    return (
                      invocation?.scopeId === scope.id && fork.branchIds.includes(invocation.nodeId)
                    );
                  })
                  .map((intent) => intent.invocationId),
                mode:
                  join?.mode === "fail-fast" ? ("fail-fast" as const) : ("all-settled" as const),
              };
            })
            .filter((group) => group.expectedBranchIds.length > 0);
        });
        const scheduler = new ReadySetScheduler({
          maxConcurrency: Math.max(
            1,
            Math.min(
              4,
              view.bundle.limits.maxConcurrentEffects,
              ...executions.map((intent) => {
                const invocation = view.state.invocations[intent.invocationId];
                const parent = invocation?.sourceInvocationId
                  ? view.state.invocations[invocation.sourceInvocationId]
                  : undefined;
                const parentNode = parent
                  ? view.bundle.definitions[
                      view.state.scopes[parent.scopeId]?.definitionId ??
                        view.bundle.rootDefinitionId
                    ]?.nodes.find((candidate) => candidate.id === parent.nodeId)
                  : undefined;
                return parentNode?.kind === "forEach"
                  ? (parentNode as import("@kouro/core").ForEachNode).maxConcurrent
                  : 4;
              }),
            ),
          ),
          resourceCaps: view.bundle.limits.resourceCaps,
        });
        this.activeSchedulers.set(runId, scheduler);
        try {
          await scheduler.run(
            executions.map((intent) => ({
              id: intent.attemptId,
              branchId: intent.invocationId,
              ordinal: view.state.invocations[intent.invocationId]?.activationOrdinal ?? 0,
              scope: {
                scopeId:
                  view.state.invocations[intent.invocationId]?.scopeId ?? view.state.rootScopeId,
                parentScopeId: null,
                definitionId: view.bundle.rootDefinitionId,
                activationOrdinal:
                  view.state.invocations[intent.invocationId]?.activationOrdinal ?? 0,
                controlLineage: [],
              },
              resources: (() => {
                const invocation = view.state.invocations[intent.invocationId];
                const scope = invocation ? view.state.scopes[invocation.scopeId] : undefined;
                const node = scope
                  ? view.bundle.definitions[scope.definitionId]?.nodes.find(
                      (candidate) => candidate.id === invocation?.nodeId,
                    )
                  : undefined;
                return node && (node.kind === "agent" || node.kind === "command")
                  ? node.resources
                  : undefined;
              })(),
              run: async () => {
                await this.execute(
                  runId,
                  view.bundle,
                  this.journal.getView(runId)!.state,
                  intent.invocationId,
                  intent.attemptId,
                );
                const current = this.journal.getView(runId)?.state.invocations[intent.invocationId];
                if (current?.status === "failed") {
                  const currentView = this.journal.getView(runId);
                  const owningGroup = groups.find((group) =>
                    group.expectedBranchIds.includes(intent.invocationId),
                  );
                  if (owningGroup?.mode === "fail-fast") {
                    for (const sibling of Object.values(
                      currentView?.state.invocations ?? {},
                    ).filter(
                      (candidate) =>
                        candidate.id !== intent.invocationId &&
                        owningGroup.expectedBranchIds.includes(candidate.id) &&
                        ["pending", "reserved", "running"].includes(candidate.status),
                    ))
                      this.journal.append({
                        runId,
                        type: "invocation.cancelled",
                        payload: { invocationId: sibling.id, reason: "fail-fast branch failure" },
                        actor: "system",
                        subjectId: sibling.id,
                      });
                    for (const aborter of this.aborters.get(runId)?.values() ?? [])
                      aborter.abort("fail-fast branch failure");
                  }
                  if (owningGroup)
                    throw new Error(
                      current.outcome === "cancelled" ||
                        currentView?.state.control === "cancel-requested" ||
                        currentView?.state.control === "interrupt-requested"
                        ? "cancelled"
                        : (current.error ?? "branch failed"),
                    );
                }
              },
            })),
            groups,
          );
        } finally {
          if (this.activeSchedulers.get(runId) === scheduler) this.activeSchedulers.delete(runId);
        }
        continue;
      }
      const intent = intents[0];
      if (!intent) return;
      if (intent.kind === "activate") {
        this.activate(runId, view.state, intent);
        continue;
      }
      if (intent.kind === "request-approval") {
        const workspace = this.workspaces.get(runId);
        const workspaceSnapshot =
          workspace && this.workspaceAdapter
            ? await this.workspaceAdapter.snapshot(workspace)
            : undefined;
        if (workspaceSnapshot) this.snapshots.set(runId, workspaceSnapshot);
        this.journal.append({
          runId,
          type: "approval.requested",
          payload: {
            approvalId: id("approval"),
            invocationId: intent.invocationId,
            action: intent.action,
            bindingDigest: workspaceSnapshot ? workspaceSnapshot.patchDigest : intent.bindingDigest,
            subjectRevision: intent.subjectRevision,
          },
          actor: "system",
        });
        continue;
      }
      if (intent.kind === "reserve") {
        this.reserve(runId, view.state, intent.invocationId);
        continue;
      }
      if (intent.kind === "execute") {
        await this.execute(runId, view.bundle, view.state, intent.invocationId, intent.attemptId);
        continue;
      }
      if (intent.kind === "finish") {
        if (intent.status === "succeeded" && !this.collaborationTerminationAllowed(runId)) {
          this.journal.append({
            runId,
            type: "run.completed",
            payload: { status: "failed" },
            actor: "system",
          });
          return;
        }
        this.journal.append({
          runId,
          type: "run.completed",
          payload: { status: intent.status },
          actor: "system",
        });
        return;
      }
      if (intent.kind === "complete") {
        const completion = view.state.invocations[intent.invocationId];
        const definition =
          view.bundle.definitions[
            view.state.scopes[completion?.scopeId ?? ""]?.definitionId ??
              view.bundle.rootDefinitionId
          ];
        const node = definition?.nodes.find(
          (candidate) => candidate.id === view.state.invocations[intent.invocationId]?.nodeId,
        );
        if (node?.kind === "join" && (node as JoinNode).mode === "fail-fast") {
          const fork = definition?.nodes.find(
            (candidate) =>
              candidate.kind === "fork" &&
              (candidate as ForkNode).groupId === (node as import("@kouro/core").JoinNode).groupId,
          );
          const activeBranch =
            fork?.kind === "fork" &&
            Object.values(view.state.invocations).some(
              (candidate) =>
                (fork as ForkNode).branchIds.includes(candidate.nodeId) &&
                candidate.scopeId === completion?.scopeId &&
                ["reserved", "running"].includes(candidate.status),
            );
          if (activeBranch) {
            await Bun.sleep(2);
            continue;
          }
        }
        if (node?.kind === "join") {
          const fork = definition?.nodes.find(
            (candidate) =>
              candidate.kind === "fork" &&
              (candidate as ForkNode).groupId === (node as JoinNode).groupId,
          );
          this.journal.append({
            runId,
            type: "join.completed",
            payload: {
              groupId: (node as JoinNode).groupId,
              scopeId:
                view.state.invocations[intent.invocationId]?.scopeId ?? view.state.rootScopeId,
              status: intent.outcome === "succeeded" ? "succeeded" : "failed",
              branchIds: fork?.kind === "fork" ? (fork as ForkNode).branchIds : [],
              branchStatuses: Object.fromEntries(
                (fork?.kind === "fork" ? (fork as ForkNode).branchIds : []).map((branchId) => {
                  const branch = Object.values(view.state.invocations).find(
                    (candidate) =>
                      candidate.scopeId === completion?.scopeId && candidate.nodeId === branchId,
                  );
                  return [
                    branchId,
                    branch?.outcome === "cancelled"
                      ? "cancelled"
                      : branch?.status === "succeeded"
                        ? "succeeded"
                        : branch?.status === "failed"
                          ? "failed"
                          : "pending",
                  ];
                }),
              ),
            },
            actor: "system",
            subjectId: intent.invocationId,
          });
          if (
            intent.outcome === "failed" &&
            (node as import("@kouro/core").JoinNode).mode === "fail-fast" &&
            fork?.kind === "fork"
          ) {
            for (const aborter of this.aborters.get(runId)?.values() ?? [])
              aborter.abort("fail-fast join");
            const branchIds = (fork as ForkNode).branchIds;
            for (const sibling of Object.values(view.state.invocations).filter(
              (candidate) =>
                branchIds.includes(candidate.nodeId) &&
                candidate.scopeId ===
                  (view.state.invocations[intent.invocationId]?.scopeId ??
                    view.state.rootScopeId) &&
                ["pending", "reserved", "running"].includes(candidate.status),
            ))
              this.journal.append({
                runId,
                type: "invocation.cancelled",
                payload: { invocationId: sibling.id, reason: "fail-fast branch failure" },
                actor: "system",
                subjectId: sibling.id,
              });
          }
        }
        this.journal.append({
          runId,
          type: "invocation.completed",
          payload: {
            invocationId: intent.invocationId,
            status: intent.outcome,
            direct: true,
            ...(intent.output ? { output: intent.output } : {}),
            ...(intent.evidence ? { evidence: intent.evidence } : {}),
            ...(intent.artifacts ? { artifacts: intent.artifacts } : {}),
          },
          actor: "system",
        });
        continue;
      }
      return;
    }
  }

  private activate(
    runId: string,
    state: ExecutionState,
    intent: Extract<DecisionIntent, { kind: "activate" }>,
  ): void {
    const duplicate = intent.sourceInvocationId
      ? Object.values(state.invocations).some(
          (candidate) =>
            candidate.sourceInvocationId === intent.sourceInvocationId &&
            candidate.sourceEdgeId === (intent.sourceEdgeId ?? intent.edgeId),
        )
      : Object.values(state.invocations).some(
          (candidate) =>
            candidate.scopeId === intent.scopeId &&
            candidate.nodeId === intent.nodeId &&
            candidate.sourceInvocationId === undefined,
        );
    if (duplicate) return;
    const row = this.journal.getRunRow(runId);
    const runInput = row ? parseJson<Record<string, unknown>>(row.input_json) : {};
    const parentCall = Object.values(state.invocations).find(
      (candidate) => `${candidate.id}:scope` === intent.scopeId,
    );
    const inputBindings = Object.fromEntries(
      Object.entries(intent.bindings).map(([name, binding]) => {
        if (binding.source.kind !== "input") return [name, binding];
        const inherited = parentCall?.inputBindings[binding.source.sourceId];
        if (inherited)
          return [
            name,
            {
              ...binding,
              ...(inherited.value === undefined ? {} : { value: inherited.value }),
              ...(inherited.artifactId ? { artifactId: inherited.artifactId } : {}),
            },
          ];
        const value = runInput[binding.source.sourceId];
        if (value === undefined && binding.missing === "error")
          throw new Error(`Missing required workflow input ${binding.source.sourceId}`);
        return [
          name,
          value === undefined
            ? binding
            : { ...binding, value: value as import("@kouro/core").JsonValue },
        ];
      }),
    );
    const invocation = {
      runId,
      type: "invocation.created" as const,
      payload: {
        invocationId: id("inv"),
        scopeId: intent.scopeId,
        nodeId: intent.nodeId,
        activationOrdinal: Object.keys(state.invocations).length,
        ...(intent.repairPass === undefined ? {} : { repairPass: intent.repairPass }),
        inputBindings,
        ...(intent.sourceInvocationId ? { sourceInvocationId: intent.sourceInvocationId } : {}),
        ...((intent.sourceEdgeId ?? intent.edgeId)
          ? { sourceEdgeId: intent.sourceEdgeId ?? intent.edgeId }
          : {}),
      },
      actor: "system",
    };
    if (intent.counterId) {
      const key = `${intent.scopeId}:${intent.counterId}`;
      const definition =
        this.journal.getView(runId)?.bundle.definitions[
          this.journal.getView(runId)?.bundle.rootDefinitionId ?? ""
        ];
      const max = definition?.counters.find((counter) => counter.id === intent.counterId)?.max;
      const current = state.counters[key] ?? 0;
      if (max === undefined || current >= max) return;
      this.journal.appendMany([
        {
          runId,
          type: "counter.incremented",
          payload: {
            counterId: intent.counterId,
            scopeId: intent.scopeId,
            value: current + 1,
          },
          actor: "system",
        },
        invocation,
      ]);
    } else this.journal.append(invocation);
    const node = this.journal
      .getView(runId)
      ?.bundle.definitions[this.journal.getView(runId)?.bundle.rootDefinitionId ?? ""]?.nodes.find(
        (candidate) => candidate.id === intent.nodeId,
      );
    if (node?.kind === "fork") {
      const forkNode = node as ForkNode;
      this.journal.append({
        runId,
        type: "fork.created",
        payload: {
          groupId: forkNode.groupId,
          scopeId: intent.scopeId,
          branchIds: forkNode.branchIds,
        },
        actor: "system",
        subjectId: intent.nodeId,
      });
    }
  }

  private reserve(
    runId: string,
    state: ExecutionState,
    invocationId: string,
    forcedAttemptId?: string,
  ): void {
    const invocation = state.invocations[invocationId];
    if (!invocation) throw new Error(`Unknown invocation ${invocationId}`);
    const view = this.journal.getView(runId);
    const currentState = view?.state ?? state;
    const scope = currentState.scopes[invocation.scopeId];
    const node = view?.bundle.definitions[
      scope?.definitionId ?? view.bundle.rootDefinitionId
    ]?.nodes.find((candidate) => candidate.id === invocation.nodeId);
    try {
      if (node?.kind === "command") this.validateCommandForRun(runId, node);
      if (node?.kind === "agent")
        this.resolveAgentInputs(view!.bundle, currentState, node, invocationId);
    } catch (cause) {
      this.journal.append({
        runId,
        type: "invocation.completed",
        payload: {
          invocationId,
          status: "failed",
          outcome: "failure",
          error: cause instanceof Error ? cause.message : String(cause),
          direct: true,
        },
        actor: "system",
        subjectId: invocationId,
      });
      return;
    }
    const attemptId = forcedAttemptId ?? id("attempt");
    const operationKey = `${runId}/${invocationId}/${Object.values(state.attempts).filter((item) => item.invocationId === invocationId).length + 1}`;
    this.journal.reserveEffect({
      runId,
      invocationId,
      attemptId,
      operationKey,
      recoveryClass: "verify-then-replay",
      ordinal: Object.values(state.attempts).filter((item) => item.invocationId === invocationId)
        .length,
      payload: {
        invocationId,
        nodeId: invocation.nodeId,
        kind: this.kindFor(state, invocation.nodeId, invocation.id),
        operationKey,
      },
    });
  }

  private kindFor(
    state: ExecutionState,
    nodeId: string,
    invocationId?: string,
  ): "agent" | "command" | "complete" {
    const view = this.journal.getView(state.runId);
    const scope =
      view?.state.scopes[state.invocations[invocationId ?? ""]?.scopeId ?? state.rootScopeId];
    const node = view?.bundle.definitions[
      scope?.definitionId ?? view.bundle.rootDefinitionId
    ]?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || (node.kind !== "agent" && node.kind !== "command" && node.kind !== "complete"))
      throw new Error(`Unsupported M1 node ${nodeId}`);
    if (node.kind === "command") this.validateCommandForRun(state.runId, node);
    return node.kind;
  }

  private validateCommandForRun(
    runId: string,
    node: Extract<Bundle["definitions"][string]["nodes"][number], { kind: "command" }>,
  ): void {
    validateCommandNode(node);
    if (node.capabilities?.includes(CAPABILITY.TERMINAL_EXECUTE)) return;
    if (node.executionMode === "trusted-unrestricted")
      throw new Error(
        `Command node ${node.id} uses removed unrestricted mode; add terminal.execute to that node`,
      );
  }

  private async execute(
    runId: string,
    bundle: Bundle,
    state: ExecutionState,
    invocationId: string,
    attemptId: string,
  ): Promise<void> {
    const attempt = state.attempts[attemptId];
    if (!attempt) return;
    const effect = this.journal.db
      .query("SELECT id FROM effects WHERE attempt_id = ?1")
      .get(attemptId) as { id: string } | null;
    if (!effect) return;
    const detail = this.journal.getEffect(effect.id);
    if (!detail) return;
    const scope = state.scopes[state.invocations[invocationId]?.scopeId ?? state.rootScopeId];
    const node = bundle.definitions[scope?.definitionId ?? bundle.rootDefinitionId]?.nodes.find(
      (candidate) => candidate.id === state.invocations[invocationId]?.nodeId,
    );
    if (!node) throw new Error(`Node missing from pinned bundle: ${invocationId}`);
    // Validate all host-side inputs before claiming the effect. A malformed
    // artifact or schema mismatch must remain a retryable admission failure,
    // not an ambiguous external execution.
    const resolvedInputs =
      node.kind === "agent"
        ? this.resolveAgentInputs(bundle, state, node, invocationId)
        : undefined;
    if (node.kind === "command") this.validateCommandForRun(runId, node);
    if (detail.state === "reserved") this.journal.claimEffect(detail.id, this.ownerEpoch);
    if (detail.state !== "claimed" && this.journal.getEffect(detail.id)?.state !== "claimed")
      return;
    let result: ProcessResult | undefined;
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let commandEvidence: import("@kouro/core/contracts").CommandEvidence | undefined;
    let error: string | undefined;
    const row = this.journal.getRunRow(runId);
    const runInput = row ? parseJson<Record<string, unknown>>(row.input_json) : {};
    const collaborationConfig =
      runInput.__collaboration && typeof runInput.__collaboration === "object"
        ? (runInput.__collaboration as Record<string, unknown>)
        : undefined;
    const profile =
      runInput.__kouroExecutionProfile === "codex-readonly" ||
      runInput.__kouroExecutionProfile === "codex-workspace-write" ||
      runInput.__kouroExecutionProfile === "claude-readonly" ||
      runInput.__kouroExecutionProfile === "claude-workspace-write" ||
      runInput.__kouroExecutionProfile === "pi-readonly"
        ? runInput.__kouroExecutionProfile
        : "scripted";
    const workspaceDir = join(this.dataDir, "workspaces", runId, invocationId);
    const registeredWorkspace = this.workspaces.get(runId);
    let invocationWorkspace = registeredWorkspace;
    const sourceInvocationId = state.invocations[invocationId]?.sourceInvocationId;
    if (registeredWorkspace && sourceInvocationId && this.workspaceAdapter) {
      const key = `${runId}:${invocationId}`;
      invocationWorkspace = this.branchWorkspaces.get(key);
      if (!invocationWorkspace) {
        try {
          invocationWorkspace = await this.workspaceAdapter.loadByIdentity(runId, invocationId);
        } catch {
          invocationWorkspace = await this.workspaceAdapter.create({
            repositoryPath: registeredWorkspace.repositoryPath,
            runId,
            workspaceId: invocationId,
            baseCommit: registeredWorkspace.baseCommit,
          });
        }
        this.branchWorkspaces.set(key, invocationWorkspace);
      }
    }
    let invocationWorkspaceDir = invocationWorkspace?.path ?? workspaceDir;
    if (node.kind === "command" && node.workspaceAccess === "source-repository") {
      if (!registeredWorkspace)
        throw new Error(`Command ${node.id} requires a repository workspace`);
      invocationWorkspaceDir = registeredWorkspace.repositoryPath;
    }
    if (node.kind === "agent") {
      const config = collaborationConfig;
      const definition = bundle.definitions[scope?.definitionId ?? bundle.rootDefinitionId];
      const subagentIds = node.uses ?? (definition?.scouts ?? []).map((scout) => scout.id);
      const hasSubagents = subagentIds.length > 0;
      const collaborationGateway =
        config || hasSubagents ? new CollaborationGateway(this.journal) : undefined;
      let collaborationGrant: import("@kouro/core").CollaborationGrant | undefined;
      let collaborationBatch: import("@kouro/core").CollaborationManifest | null = null;
      if (collaborationGateway) {
        const configured = Array.isArray(config?.participants)
          ? config.participants.filter((item): item is string => typeof item === "string")
          : [];
        for (const participant of new Set([...configured, node.role])) {
          const prior = this.journal.db
            .query(
              "SELECT status FROM collaboration_participants WHERE run_id=?1 AND participant_id=?2",
            )
            .get(runId, participant) as { status: string } | null;
          if (prior?.status !== "completed")
            collaborationGateway.configureParticipant(runId, participant);
        }
        if (Array.isArray(config?.channels))
          for (const channel of config.channels) {
            if (!channel || typeof channel !== "object") continue;
            const value = channel as Record<string, unknown>;
            if (typeof value.name === "string" && Array.isArray(value.participants))
              collaborationGateway.configureChannel(runId, {
                name: value.name,
                participants: value.participants.filter(
                  (item): item is string => typeof item === "string",
                ),
                ...(typeof value.maxBodyBytes === "number"
                  ? { maxBodyBytes: value.maxBodyBytes }
                  : {}),
              });
          }
        const participantStatus = this.journal.db
          .query(
            "SELECT status FROM collaboration_participants WHERE run_id=?1 AND participant_id=?2",
          )
          .get(runId, node.role) as { status: string } | null;
        if (participantStatus?.status === "completed") {
          // A queued message never creates a new turn for a completed role.
          this.journal.completeEffect({
            effectId: detail.id,
            storedArtifacts: [],
            artifacts: [],
            evidence: [],
            output: [],
            status: "succeeded",
            diagnostics: ["collaboration idle/no-progress: participant completed"],
            resolvedExecution: {
              role: node.role,
              harness: toHarness(this.harness.id),
              adapterVersion: this.harness.adapterVersion,
            },
          });
          return;
        }
        collaborationGrant = collaborationGateway.issueGrant({
          runId,
          attemptId,
          participantId: node.role,
          expiresAt: new Date(
            Date.now() + (Number(config?.maxRunDurationMs) || 60_000),
          ).toISOString(),
        });
        collaborationBatch = collaborationGateway.wait({
          grantId: collaborationGrant.grantId,
          waitId: `${attemptId}:initial`,
          participantId: node.role,
          attemptId,
          maxMessages: Number(config?.maxMessagesPerTurn) || 8,
          idleDeadline: new Date(Date.now() - 1).toISOString(),
        });
      }
      const promptBytes = new TextEncoder().encode(node.prompt).byteLength;
      const inputSegments = Object.entries(resolvedInputs ?? {}).map(([name, value]) => {
        const content = JSON.stringify(value);
        return {
          id: `${attemptId}:input:${name}`,
          source: "artifact-input",
          content,
          supplied: true,
          reason: `resolved workflow input binding ${name}`,
          bytes: new TextEncoder().encode(content).byteLength,
          tokenCount: null,
          tokenQuality: "unavailable" as const,
        };
      });
      let contextManifest = await createContextManifest({
        attemptId,
        segments: [
          {
            id: `${attemptId}:role-prompt`,
            source: "role-prompt",
            content: node.prompt,
            supplied: true,
            reason: `declared by workflow role ${node.role}`,
            bytes: promptBytes,
            tokenCount: null,
            tokenQuality: "unavailable",
          },
          ...inputSegments,
          ...this.scouts.deliveries(runId, attemptId).flatMap((delivery) => {
            const content = JSON.stringify(delivery.result);
            return [
              {
                id: `${attemptId}:scout:${delivery.requestId}`,
                source: "scout-result",
                content,
                supplied: true,
                reason: `durably delivered scout result ${delivery.requestId}`,
                bytes: new TextEncoder().encode(content).byteLength,
                tokenCount: null,
                tokenQuality: "unavailable" as const,
              },
            ];
          }),
          ...(collaborationBatch?.visible.map((message) => ({
            id: `${attemptId}:message:${message.id}`,
            source: "collaboration-message",
            content: JSON.stringify(message.body),
            supplied: true,
            reason: `selected delivery batch ${collaborationBatch?.batchId}`,
            bytes: new TextEncoder().encode(JSON.stringify(message.body)).byteLength,
            tokenCount: null,
            tokenQuality: "unavailable" as const,
          })) ?? []),
        ],
        tools: collaborationGrant
          ? [
              {
                name: "send_message",
                description: "Send one bounded direct message",
                inputSchema: { type: "object" },
                enabled: true,
              },
              {
                name: "publish-blackboard",
                description: "Publish one typed blackboard entry",
                inputSchema: { type: "object" },
                enabled: true,
              },
              ...(subagentIds.length
                ? [
                    {
                      name: "subagent",
                      description:
                        "Run one awaited bounded subagent. The input object must match the selected subagent's declared child inputs.",
                      inputSchema: subagentToolSchema(
                        bundle,
                        scope?.definitionId ?? bundle.rootDefinitionId,
                        subagentIds,
                      ),
                      enabled: true,
                    },
                  ]
                : []),
            ]
          : [],
        hiddenNativeContext: "unavailable",
      });
      // Retries/fallbacks are explicitly fresh sessions. Carry only a bounded,
      // host-labelled handoff; never imply native provider continuation.
      if (attempt.ordinal > 0) {
        const prepared = await prepareAgentHandoff({
          context: contextManifest,
          handoff: {
            handoffId: id("handoff"),
            sourceAttemptId: attemptId,
            objective: { text: node.prompt, source: "host", verified: false },
            completed: [],
            decisions: [],
            files: [],
            unresolved: [
              { text: "Retry requires fresh-session validation", source: "host", verified: false },
            ],
            evidence: [],
            nextSteps: [
              { text: "Reproduce and validate deterministically", source: "host", verified: false },
            ],
            contextManifest: {
              version: contextManifest.version,
              attemptId,
              digest: contextManifest.digest,
            },
            provenance: {
              sourceHarness: toHarness(this.harness.id),
              createdBy: "host",
              createdAt: now(),
            },
          },
          sourceBudget: { turns: 1, invocations: 1 },
          targetBudget: { turns: 1, invocations: 1 },
          sourcePermissions: [],
          targetPermissions: [],
          continuation: {
            nativeResume: "unsupported",
            sameHarness: false,
            sameModel: false,
            permissionEnvelopeUnchanged: true,
          },
        });
        contextManifest = await createContextManifest({
          ...contextManifest,
          segments: [
            ...contextManifest.segments,
            {
              id: `${attemptId}:handoff`,
              source: "agent-handoff",
              content: JSON.stringify(prepared.handoff),
              supplied: true,
              reason: `fresh-session handoff: ${prepared.session.reason}`,
              bytes: new TextEncoder().encode(JSON.stringify(prepared.handoff)).byteLength,
              tokenCount: null,
              tokenQuality: "unavailable",
            },
          ],
        });
      }
      const outputSchema = node.outputPorts[0]
        ? bundle.schemas[node.outputPorts[0].schemaDigest]
        : undefined;
      let selected: HarnessAdapter = this.harness;
      let resolvedHarness: RuntimeHarness = toHarness(this.harness.id);
      let resolvedVersion = this.harness.adapterVersion;
      let resolvedModelId: string | undefined;
      let nativeConfig: import("@kouro/core").JsonObject | undefined;
      const requestedHarness =
        node.harness ??
        (profile === "codex-readonly" || profile === "codex-workspace-write"
          ? "codex"
          : profile === "claude-readonly" || profile === "claude-workspace-write"
            ? "claude"
            : profile === "pi-readonly"
              ? "pi"
              : toHarness(this.harness.id));
      if (
        requestedHarness === "scripted" &&
        node.harness !== "codex" &&
        node.harness !== "pi" &&
        profile !== "codex-readonly" &&
        profile !== "codex-workspace-write" &&
        profile !== "claude-readonly" &&
        profile !== "claude-workspace-write" &&
        profile !== "pi-readonly"
      ) {
        // The injected/default harness is the run's scripted (or test) adapter.
      } else if (requestedHarness === "codex") {
        this.codexDescriptor ??= await inspectCodex();
        if (this.codexDescriptor.availability !== "available") {
          this.journal.completeEffect({
            effectId: detail.id,
            storedArtifacts: [],
            artifacts: [],
            evidence: [],
            output: [],
            status: "failed",
            error: `harness-unavailable: ${this.codexDescriptor.detail ?? "codex unavailable"}`,
            diagnostics: ["execution rejected before workspace side effects"],
            resolvedExecution: {
              role: node.role,
              harness: this.codexDescriptor.id,
              adapterVersion: this.codexDescriptor.adapterVersion,
            },
            contextManifest: JSON.parse(JSON.stringify(contextManifest)),
          });
          return;
        }
        const codex = (this.codex ??= new CodexHarnessAdapter(
          new CodexAppServerHarness(this.codexDescriptor),
        ));
        selected = codex;
        resolvedHarness = toHarness(codex.id);
        resolvedVersion = codex.adapterVersion;
        nativeConfig = {
          sandbox: (
            node.capabilities
              ? node.capabilities.includes(CAPABILITY.REPOSITORY_WRITE)
              : profile === "codex-workspace-write" && node.workspaceAccess === "workspace-write"
          )
            ? "workspace-write"
            : "read-only",
        };
      } else if (requestedHarness === "pi") {
        this.piDescriptor ??= await inspectPi();
        if (this.piDescriptor.availability !== "available") {
          this.journal.completeEffect({
            effectId: detail.id,
            storedArtifacts: [],
            artifacts: [],
            evidence: [],
            output: [],
            status: "failed",
            error: `harness-unavailable: ${this.piDescriptor.detail ?? "Pi SDK unavailable"}`,
            diagnostics: ["execution rejected before workspace side effects"],
            resolvedExecution: {
              role: node.role,
              harness: this.piDescriptor.id,
              adapterVersion: this.piDescriptor.adapterVersion,
            },
            contextManifest: JSON.parse(JSON.stringify(contextManifest)),
          });
          return;
        }
        const pi = (this.pi ??= new PiHarnessAdapter(new PiSdkHarness(this.piDescriptor)));
        selected = pi;
        resolvedHarness = toHarness(pi.id);
        resolvedVersion = pi.adapterVersion;
        const piSelection = resolvePiSelection(
          { harness: "pi", model: { id: node.modelId ?? "" } },
          node.modelId ? { model: node.modelId } : {},
        );
        resolvedModelId = piSelection.model;
        nativeConfig = {
          ...(piSelection.provider ? { provider: piSelection.provider } : {}),
          ...(piSelection.model ? { model: piSelection.model } : {}),
        };
      } else if (requestedHarness === "claude" || requestedHarness === "opencode") {
        if (requestedHarness === "claude") {
          const claude = this.claude ?? new ClaudeAgentSdkHarnessAdapter();
          this.claude = claude;
          selected = claude;
          nativeConfig = {
            ...(node.modelId ? { model: node.modelId } : {}),
            permissionMode: (
              node.capabilities
                ? node.capabilities.includes(CAPABILITY.REPOSITORY_WRITE)
                : profile === "claude-workspace-write" && node.workspaceAccess === "workspace-write"
            )
              ? "acceptEdits"
              : "dontAsk",
          };
        } else {
          this.opencodeDescriptor ??= await inspectExternalCli("opencode");
          if (this.opencodeDescriptor.availability !== "available") {
            this.journal.completeEffect({
              effectId: detail.id,
              storedArtifacts: [],
              artifacts: [],
              evidence: [],
              output: [],
              status: "failed",
              error: `harness-unavailable: ${this.opencodeDescriptor.detail ?? "opencode unavailable"}`,
              diagnostics: ["execution rejected before workspace side effects"],
              resolvedExecution: {
                role: node.role,
                harness: "opencode",
                adapterVersion: this.opencodeDescriptor.adapterVersion,
              },
              contextManifest: JSON.parse(JSON.stringify(contextManifest)),
            });
            return;
          }
          const opencode =
            this.opencode ?? new ExternalCliHarnessAdapter("opencode", this.opencodeDescriptor);
          this.opencode = opencode;
          selected = opencode;
        }
        resolvedHarness = toHarness(selected.id);
        resolvedVersion = selected.adapterVersion;
        if (requestedHarness !== "claude")
          nativeConfig = node.modelId ? { model: node.modelId } : {};
      } else {
        this.journal.completeEffect({
          effectId: detail.id,
          storedArtifacts: [],
          artifacts: [],
          evidence: [],
          output: [],
          status: "failed",
          error: `harness-unavailable: unknown harness ${requestedHarness}`,
          diagnostics: ["execution rejected before workspace side effects"],
          resolvedExecution: {
            role: node.role,
            harness: requestedHarness,
            adapterVersion: "unknown",
          },
          contextManifest: JSON.parse(JSON.stringify(contextManifest)),
        });
        return;
      }
      if (subagentIds.length) {
        const capabilities = selected.capabilities();
        if (
          capabilities["awaited-subagent-tool"] !== "supported" ||
          capabilities["child-read-only-envelope"] !== "supported"
        ) {
          this.journal.completeEffect({
            effectId: detail.id,
            storedArtifacts: [],
            artifacts: [],
            evidence: [],
            output: [],
            status: "failed",
            error:
              "harness-unavailable: awaited subagent tool or child read-only envelope is unsupported",
            diagnostics: ["subagent admission rejected before provider execution"],
            resolvedExecution: {
              role: node.role,
              harness: resolvedHarness,
              adapterVersion: resolvedVersion,
            },
            contextManifest: JSON.parse(JSON.stringify(contextManifest)),
          });
          return;
        }
      }
      const currentControl = this.journal.getView(runId)?.state.control;
      if (currentControl === "cancel-requested" || currentControl === "interrupt-requested") {
        this.journal.completeEffect({
          effectId: detail.id,
          storedArtifacts: [],
          artifacts: [],
          evidence: [],
          output: [],
          status: "cancelled",
          error: currentControl === "cancel-requested" ? "cancelled" : "interrupted",
          resolvedExecution: {
            role: node.role,
            harness: resolvedHarness,
            adapterVersion: resolvedVersion,
            ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
          },
          contextManifest: JSON.parse(JSON.stringify(contextManifest)),
        });
        return;
      }
      mkdirSync(invocationWorkspaceDir, { recursive: true, mode: 0o700 });
      let harnessResult: Awaited<ReturnType<HarnessAdapter["run"]>> | undefined;
      const aborter = new AbortController();
      const runAborters = this.aborters.get(runId) ?? new Map<string, AbortController>();
      runAborters.set(invocationId, aborter);
      this.aborters.set(runId, runAborters);
      const trackingAdapter = new TrackingHarnessDecorator(
        selected,
        (event) => this.recordHarnessActivity(runId, invocationId, attemptId, event),
        (event) => this.normalizeActivity(runId, event),
      );
      const activeAdapters = this.activeAdapters.get(runId) ?? new Map<string, HarnessAdapter>();
      activeAdapters.set(invocationId, trackingAdapter);
      this.activeAdapters.set(runId, activeAdapters);
      const attemptStartedAtText =
        this.journal.getView(runId)?.state.attempts[attemptId]?.startedAt ?? attempt.startedAt;
      const attemptStartedAt = attemptStartedAtText ? Date.parse(attemptStartedAtText) : Date.now();
      const attemptBudgetRemaining =
        node.timeoutMs === undefined
          ? undefined
          : Math.max(1, node.timeoutMs - Math.max(0, Date.now() - attemptStartedAt));
      const runStartedAt = this.journal.getView(runId)?.state.startedAt;
      const runDeadlineAt =
        runStartedAt && Number.isFinite(Date.parse(runStartedAt))
          ? Date.parse(runStartedAt) + bundle.limits.maxRunDurationMs
          : Date.now() + bundle.limits.maxRunDurationMs;
      try {
        harnessResult = await this.superviseHarness(
          trackingAdapter,
          {
            attemptId,
            runId,
            invocationId,
            role: node.role,
            prompt: node.prompt,
            ...(node.modelId ? { modelId: node.modelId } : {}),
            outputSchema,
            delayMs: this.scriptedDelayMs,
            cwd: invocationWorkspaceDir,
            nativeConfig,
            context: contextManifest,
            ...(collaborationGateway && collaborationGrant
              ? {
                  collaboration: {
                    ...collaborationGateway.tools(
                      collaborationGrant,
                      subagentIds.length ? this.scouts : undefined,
                      subagentIds.length
                        ? (subagentInput) =>
                            this.invokeScout({
                              runId,
                              parentInvocationId: invocationId,
                              parentAttemptId: attemptId,
                              requestId: subagentInput.requestId,
                              scoutId: subagentInput.subagentId,
                              input: subagentInput.input,
                              adapter: selected,
                              cwd: invocationWorkspaceDir,
                              parentModelId: resolvedModelId ?? node.modelId,
                              signal: aborter.signal,
                            })
                        : undefined,
                    ),
                    // The host freezes the selected delivery batch into context;
                    // expose that same batch to the scripted/provider tool view.
                    wait: () => collaborationBatch,
                  },
                }
              : {}),
            signal: aborter.signal,
          },
          aborter,
          attemptBudgetRemaining,
          runDeadlineAt,
          undefined,
          (event) => this.recordHarnessActivity(runId, invocationId, attemptId, event),
        );
      } catch (cause) {
        harnessResult = {
          status: "failed",
          error: `transport: ${cause instanceof Error ? cause.message : String(cause)}`,
          events: [],
          usage: unavailableUsage() as unknown as import("@kouro/core").JsonValue,
        };
      } finally {
        this.activeAdapters.get(runId)?.delete(invocationId);
        if (this.activeAdapters.get(runId)?.size === 0) this.activeAdapters.delete(runId);
      }
      if (collaborationGateway && collaborationBatch)
        collaborationGateway.releaseDelivery(collaborationBatch.batchId);
      if (collaborationGateway) {
        const outstanding = this.journal.db
          .query(
            "SELECT b.id FROM collaboration_batches b JOIN collaboration_waits w ON w.id=b.wait_id WHERE w.run_id=?1 AND w.attempt_id=?2 AND b.state='reserved'",
          )
          .all(runId, attemptId) as Array<{ id: string }>;
        for (const batch of outstanding) collaborationGateway.releaseDelivery(batch.id);
      }
      if (!harnessResult) {
        const aborters = this.aborters.get(runId);
        aborters?.delete(invocationId);
        if (aborters?.size === 0) this.aborters.delete(runId);
        this.activityEvents.delete(attemptId);
        return;
      }
      const collaborationSent = Boolean(
        harnessResult.output &&
        typeof harnessResult.output === "object" &&
        !Array.isArray(harnessResult.output) &&
        "collaboration" in harnessResult.output &&
        typeof harnessResult.output.collaboration === "object" &&
        harnessResult.output.collaboration !== null &&
        "sent" in harnessResult.output.collaboration,
      );
      if (
        collaborationGateway &&
        collaborationConfig &&
        collaborationConfig.respondLoop &&
        collaborationBatch?.visible.length === 0 &&
        (!collaborationSent || node.role.toLowerCase().includes("receiver"))
      )
        collaborationGateway.setParticipantStatus(runId, node.role, "completed");
      const runAbortersAfter = this.aborters.get(runId);
      runAbortersAfter?.delete(invocationId);
      if (runAbortersAfter?.size === 0) this.aborters.delete(runId);
      if (harnessResult.status !== "succeeded") {
        status = harnessResult.status === "cancelled" ? "cancelled" : "failed";
        error = harnessResult.error ?? harnessResult.status;
      }
      if (status === "succeeded" && outputSchema) {
        const validation = validateJsonSchema(harnessResult.output, outputSchema);
        if (!validation.valid) {
          status = "failed";
          error = `invalid-output: ${validation.error}`;
        }
      }
      if (status === "succeeded" && subagentIds.length) {
        const scoutError = this.scouts.acceptanceError(
          runId,
          attemptId,
          subagentIds.map((id) => {
            const scout = definition?.scouts?.find((item) => item.id === id);
            if (!scout) throw new Error(`Declared subagent ${id} is missing`);
            return { id: scout.id, optional: scout.optional === true };
          }),
        );
        if (scoutError) {
          status = "failed";
          error = `scout-acceptance: ${scoutError}`;
        }
      }
      const secretValues = Object.entries(process.env)
        .filter(([key, value]) => value && /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
        .map(([, value]) => value!)
        .filter((value) => value.length >= 6);
      const safeError = error ? String(redactSecrets(error, secretValues)) : undefined;
      const storedArtifacts: StoredArtifact[] = [];
      const outputRefs: import("@kouro/core").ArtifactRef[] = [];
      const evidenceRefs: import("@kouro/core").ArtifactRef[] = [];
      if (status === "succeeded" && harnessResult.output !== undefined) {
        const outputArtifact = this.journal.blobs.put(
          runId,
          new TextEncoder().encode(json(harnessResult.output)),
          "application/json",
        ) as StoredArtifact;
        storedArtifacts.push(outputArtifact);
        outputRefs.push({
          id: outputArtifact.id,
          digest: outputArtifact.digest,
          mediaType: outputArtifact.mediaType,
          ...(node.outputPorts[0] ? { schemaDigest: node.outputPorts[0].schemaDigest } : {}),
        });
      }
      if (harnessResult.rawOutput !== undefined || status === "failed" || status === "cancelled") {
        const raw = harnessResult.rawOutput ?? json(harnessResult.output ?? { error });
        const redacted = String(redactSecrets(raw, secretValues));
        const evidenceArtifact = this.journal.blobs.put(
          runId,
          new TextEncoder().encode(redacted),
          "text/plain; charset=utf-8",
        ) as StoredArtifact;
        storedArtifacts.push(evidenceArtifact);
        evidenceRefs.push({
          id: evidenceArtifact.id,
          digest: evidenceArtifact.digest,
          mediaType: evidenceArtifact.mediaType,
        });
      }
      if (harnessResult.stderr) {
        const stderr = String(redactSecrets(harnessResult.stderr, secretValues));
        const stderrArtifact = this.journal.blobs.put(
          runId,
          new TextEncoder().encode(stderr),
          "application/vnd.kouro.harness-stderr+text",
        ) as StoredArtifact;
        storedArtifacts.push(stderrArtifact);
        evidenceRefs.push({
          id: stderrArtifact.id,
          digest: stderrArtifact.digest,
          mediaType: stderrArtifact.mediaType,
        });
      }
      const retryable =
        status === "failed" &&
        this.journal.getView(runId)?.state.control === "none" &&
        (harnessResult.status === "unavailable" ||
          error?.startsWith("invalid-output:") ||
          error?.startsWith("transport:"));
      const ordinal = attempt.ordinal + 1;
      const retry =
        retryable && ordinal < 2
          ? {
              attemptId: id("attempt"),
              operationKey: `${runId}/${invocationId}/${ordinal + 1}`,
              recoveryClass: "verify-then-replay",
              ordinal,
              payload: {
                invocationId,
                nodeId: node.id,
                kind: "agent",
                operationKey: `${runId}/${invocationId}/${ordinal + 1}`,
              },
            }
          : undefined;
      const nativeConfigDigest = nativeConfig
        ? `sha256:${await sha256Hex(canonicalize(nativeConfig))}`
        : undefined;
      const allEvents = [...harnessResult.events, ...(this.activityEvents.get(attemptId) ?? [])];
      const uniqueEvents = [...new Map(allEvents.map((event) => [json(event), event])).values()];
      const durableEvents = redactSecrets(
        uniqueEvents,
        secretValues,
      ) as readonly import("@kouro/core").JsonValue[];
      if (status === "succeeded" && registeredWorkspace && this.workspaceAdapter)
        this.snapshots.set(runId, await this.workspaceAdapter.snapshot(registeredWorkspace));
      this.journal.completeEffect({
        effectId: detail.id,
        storedArtifacts,
        artifacts: [],
        evidence: evidenceRefs,
        output: outputRefs,
        status,
        ...(safeError ? { error: safeError } : {}),
        diagnostics: [
          harnessResult.error
            ? String(redactSecrets(harnessResult.error, secretValues))
            : undefined,
        ].filter((item): item is string => Boolean(item)),
        resolvedExecution: {
          role: node.role,
          harness: resolvedHarness,
          adapterVersion: resolvedVersion,
          ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
          ...(nativeConfigDigest ? { nativeConfigDigest } : {}),
        },
        harnessEvents: durableEvents,
        usage: harnessResult.usage,
        contextManifest: JSON.parse(JSON.stringify(contextManifest)),
        sessionReference: {
          continuation: "fresh-session",
          handoff: "fresh",
          nativeContinuation: "unavailable",
          ...(profile === "codex-readonly" || profile === "codex-workspace-write"
            ? { reason: "codex-native-resume-unsupported" }
            : {}),
          capabilities: selected.capabilities(),
        },
        ...(retry ? { retry } : {}),
      });
      this.activityEvents.delete(attemptId);
      return;
    }
    if (node.kind !== "command") {
      status = "failed";
      error = "complete node cannot be dispatched as an effect";
    } else {
      this.validateCommandForRun(runId, node);
      const startedAt = now();
      try {
        if (node.workspaceAccess === "source-repository") {
          if (!registeredWorkspace || !this.workspaceAdapter)
            throw new Error(`Command ${node.id} requires a repository workspace`);
          if (
            node.executable !== "git" ||
            node.args.length !== 4 ||
            node.args[0] !== "diff" ||
            node.args[1] !== "--no-ext-diff" ||
            node.args[2] !== "--no-textconv"
          )
            throw new Error("source-repository commands must be the declared read-only git diff");
          const stdout = await this.workspaceAdapter.diffRepository(
            registeredWorkspace.repositoryPath,
            node.args[3]!,
          );
          result = {
            operationKey: detail.operationKey,
            evidence: {
              argv: [node.executable, ...node.args],
              cwd: registeredWorkspace.repositoryPath,
              exitCode: 0,
              signal: null,
              timedOut: false,
              spawnError: null,
              stdout: new TextEncoder().encode(stdout),
              stderr: new Uint8Array(),
              enforcementMode: "trusted-unrestricted",
            },
          };
        } else {
          result = await this.process.executeCommand({
            runId,
            operationKey: detail.operationKey,
            workspaceDir: invocationWorkspaceDir,
            executable: node.executable,
            args: node.args,
            timeoutMs: node.timeoutMs || this.commandTimeoutMs,
            executionMode: node.capabilities?.includes(CAPABILITY.TERMINAL_EXECUTE)
              ? "trusted-unrestricted"
              : node.executionMode,
          });
        }
      } catch (cause) {
        status = "failed";
        error = cause instanceof Error ? cause.message : String(cause);
        result = {
          operationKey: detail.operationKey,
          evidence: {
            argv: [node.executable, ...node.args],
            cwd: invocationWorkspaceDir,
            exitCode: null,
            signal: null,
            timedOut: null,
            spawnError: error,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            enforcementMode:
              node.executionMode === "trusted-unrestricted" ||
              node.capabilities?.includes(CAPABILITY.TERMINAL_EXECUTE)
                ? "trusted-unrestricted"
                : "enforced",
          },
        };
      }
      const finishedAt = now();
      if (
        result.evidence.spawnError ||
        result.evidence.timedOut ||
        result.evidence.exitCode === null ||
        !node.acceptedExitCodes.includes(result.evidence.exitCode)
      ) {
        status = "failed";
        error ??=
          result.evidence.spawnError ??
          (result.evidence.timedOut
            ? "Command timed out"
            : `Command exited ${result.evidence.exitCode ?? "without status"}`);
      }
      commandEvidence = {
        kind: "command.evidence",
        executable: node.executable,
        args: [...node.args],
        executionMode: result.evidence.enforcementMode,
        exitCode: result.evidence.exitCode,
        signal: result.evidence.signal,
        timeout: result.evidence.timedOut,
        spawnError: result.evidence.spawnError,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        workspaceId: registeredWorkspace?.workspaceId ?? invocationWorkspaceDir,
      };
    }
    const storedArtifacts: StoredArtifact[] = [];
    const evidenceRefs: import("@kouro/core").ArtifactRef[] = [];
    if (result?.evidence.stdout.byteLength) {
      const artifact = this.journal.blobs.put(
        runId,
        result.evidence.stdout,
        "text/plain; charset=utf-8",
      ) as StoredArtifact;
      storedArtifacts.push(artifact);
      evidenceRefs.push({
        id: artifact.id,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
      });
      if (commandEvidence) commandEvidence = { ...commandEvidence, stdoutArtifactId: artifact.id };
    }
    if (result?.evidence.stderr.byteLength) {
      const artifact = this.journal.blobs.put(
        runId,
        result.evidence.stderr,
        "text/plain; charset=utf-8",
      ) as StoredArtifact;
      storedArtifacts.push(artifact);
      evidenceRefs.push({
        id: artifact.id,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
      });
      if (commandEvidence) commandEvidence = { ...commandEvidence, stderrArtifactId: artifact.id };
    }
    const outputRefs: import("@kouro/core").ArtifactRef[] = [];
    if (commandEvidence) {
      const resultArtifact = this.journal.blobs.put(
        runId,
        new TextEncoder().encode(
          json({
            exitCode: commandEvidence.exitCode,
            stdout: new TextDecoder().decode(result?.evidence.stdout ?? new Uint8Array()),
            executionMode: commandEvidence.executionMode,
            signal: commandEvidence.signal,
            timeout: commandEvidence.timeout,
            spawnError: commandEvidence.spawnError,
            startedAt: commandEvidence.startedAt,
            finishedAt: commandEvidence.finishedAt,
            durationMs: commandEvidence.durationMs,
          }),
        ),
        "application/vnd.kouro.command-result+json",
      ) as StoredArtifact;
      storedArtifacts.push(resultArtifact);
      outputRefs.push({
        id: resultArtifact.id,
        digest: resultArtifact.digest,
        mediaType: resultArtifact.mediaType,
      });
      const evidenceArtifact = this.journal.blobs.put(
        runId,
        new TextEncoder().encode(json(commandEvidence)),
        "application/vnd.kouro.command-evidence+json",
      ) as StoredArtifact;
      storedArtifacts.push(evidenceArtifact);
      evidenceRefs.push({
        id: evidenceArtifact.id,
        digest: evidenceArtifact.digest,
        mediaType: evidenceArtifact.mediaType,
      });
    }
    this.journal.completeEffect({
      effectId: detail.id,
      storedArtifacts,
      artifacts: [],
      evidence: evidenceRefs,
      output: outputRefs,
      status,
      commandEvidence,
      error,
    });
    void result;
  }

  private resolveAgentInputs(
    bundle: Bundle,
    state: ExecutionState,
    node: Extract<Bundle["definitions"][string]["nodes"][number], { kind: "agent" }>,
    invocationId: string,
  ): Readonly<Record<string, JsonValue>> {
    const invocation = state.invocations[invocationId];
    if (!invocation) throw new Error(`Invocation missing from pinned state: ${invocationId}`);
    const resolved: Record<string, JsonValue> = {};
    const ports = new Map(node.inputPorts.map((port) => [port.name, port]));
    for (const name of Object.keys(invocation.inputBindings))
      if (!ports.has(name))
        throw new Error(`Input binding targets unknown port ${node.id}.${name}`);

    for (const port of node.inputPorts) {
      const binding = invocation.inputBindings[port.name];
      let value = binding ? this.resolveBoundInput(binding, state, invocationId) : undefined;
      if (value !== undefined && binding?.path?.length) value = selectJsonPath(value, binding.path);
      if (value === undefined) {
        const missing =
          binding?.missing ??
          (port.defaultValue !== undefined ? "default" : port.required ? "error" : "omit");
        if (missing === "default" && port.defaultValue !== undefined) value = port.defaultValue;
        else if (missing === "omit" && !port.required) continue;
        else
          throw new Error(
            `Missing required input binding ${node.id}.${port.name}${binding?.artifactId ? ` (${binding.artifactId})` : ""}`,
          );
      }
      const schema = bundle.schemas[port.schemaDigest];
      if (!schema)
        throw new Error(`Missing input schema ${port.schemaDigest} for ${node.id}.${port.name}`);
      const validation = validateJsonSchema(value, schema);
      if (!validation.valid)
        throw new Error(`Invalid input ${node.id}.${port.name}: ${validation.error}`);
      resolved[port.name] = value;
    }
    return resolved;
  }

  private async invokeScout(input: {
    runId: string;
    parentInvocationId: string;
    parentAttemptId: string;
    requestId: string;
    scoutId: string;
    input: Record<string, unknown>;
    adapter: HarnessAdapter;
    cwd: string;
    parentModelId?: string;
    signal?: AbortSignal;
  }): Promise<import("../types.ts").ScoutResult> {
    const view = this.journal.getView(input.runId);
    if (!view) throw new Error(`Run not found: ${input.runId}`);
    const parent = view.state.invocations[input.parentInvocationId];
    const scope = parent ? view.state.scopes[parent.scopeId] : undefined;
    const definition = scope
      ? view.bundle.definitions[scope.definitionId]
      : view.bundle.definitions[view.bundle.rootDefinitionId];
    const scout = definition?.scouts?.find((candidate) => candidate.id === input.scoutId);
    const child = scout ? view.bundle.definitions[scout.definitionId] : undefined;
    const childAgent = child?.nodes.find((node) => node.kind === "agent");
    if (!child || !scout || childAgent?.kind !== "agent")
      throw new Error(`subagent ${input.scoutId} is unavailable`);
    let childAdapter = input.adapter;
    if (childAgent.harness && childAgent.harness !== input.adapter.id) {
      if (childAgent.harness === "claude")
        childAdapter = this.claude ?? (this.claude = new ClaudeAgentSdkHarnessAdapter());
      else if (childAgent.harness === "codex") {
        this.codexDescriptor ??= await inspectCodex();
        if (this.codexDescriptor.availability !== "available")
          throw new Error(`subagent Codex unavailable: ${this.codexDescriptor.detail}`);
        childAdapter =
          this.codex ??
          (this.codex = new CodexHarnessAdapter(new CodexAppServerHarness(this.codexDescriptor)));
      } else if (childAgent.harness === "pi") {
        this.piDescriptor ??= await inspectPi();
        if (this.piDescriptor.availability !== "available")
          throw new Error(`subagent Pi unavailable: ${this.piDescriptor.detail}`);
        childAdapter =
          this.pi ?? (this.pi = new PiHarnessAdapter(new PiSdkHarness(this.piDescriptor)));
      } else throw new Error(`subagent harness ${childAgent.harness} is unavailable in this host`);
    }
    const outputSchema = childAgent.outputPorts[0]
      ? view.bundle.schemas[childAgent.outputPorts[0].schemaDigest]
      : undefined;
    const childInvocationId = `${input.parentAttemptId}:scout:${input.requestId}`;
    return this.scouts.invoke({
      ...input,
      runner: async (request, signal) => {
        const segments = Object.entries(request.input).map(([name, value]) => {
          const content = JSON.stringify(value);
          return {
            id: `${childInvocationId}:input:${name}`,
            source: "artifact-input",
            content,
            supplied: true,
            reason: `resolved scout input ${name}`,
            bytes: new TextEncoder().encode(content).byteLength,
            tokenCount: null,
            tokenQuality: "unavailable" as const,
          };
        });
        const context = await createContextManifest({
          attemptId: childInvocationId,
          segments: [
            {
              id: `${childInvocationId}:role-prompt`,
              source: "role-prompt",
              content: childAgent.prompt,
              supplied: true,
              reason: `declared by scout role ${childAgent.role}`,
              bytes: new TextEncoder().encode(childAgent.prompt).byteLength,
              tokenCount: null,
              tokenQuality: "unavailable",
            },
            ...segments,
          ],
          tools: [],
          hiddenNativeContext: "unavailable",
        });
        const childAborter = new AbortController();
        const abort = () => childAborter.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timeoutMs =
          childAgent.timeoutMs === undefined ? undefined : Math.min(childAgent.timeoutMs, 60_000);
        let scoutReplyStarted = false;
        const trackedChild = new TrackingHarnessDecorator(
          childAdapter,
          (event) => {
            const data =
              event.data && typeof event.data === "object" && !Array.isArray(event.data)
                ? event.data
                : { detail: event.data };
            this.recordHarnessActivity(
              input.runId,
              input.parentInvocationId,
              input.parentAttemptId,
              {
                ...event,
                data:
                  event.type === "text"
                    ? {
                        ...(event.data &&
                        typeof event.data === "object" &&
                        !Array.isArray(event.data)
                          ? event.data
                          : { text: event.data }),
                        scoutId: input.scoutId,
                        requestId: input.requestId,
                        label: !scoutReplyStarted,
                      }
                    : { ...data, scoutId: input.scoutId, requestId: input.requestId },
              },
            );
            if (event.type === "text") scoutReplyStarted = true;
          },
          (event) => this.normalizeActivity(input.runId, event),
        );
        try {
          const childRunDeadline =
            view.state.startedAt && Number.isFinite(Date.parse(view.state.startedAt))
              ? Date.parse(view.state.startedAt) + view.bundle.limits.maxRunDurationMs
              : Date.now() + view.bundle.limits.maxRunDurationMs;
          const result = await this.superviseHarness(
            trackedChild,
            {
              attemptId: childInvocationId,
              runId: input.runId,
              invocationId: childInvocationId,
              role: childAgent.role,
              prompt: childAgent.prompt,
              ...(outputSchema ? { outputSchema } : {}),
              delayMs: this.scriptedDelayMs,
              cwd: input.cwd,
              ...(childAgent.modelId
                ? { modelId: childAgent.modelId }
                : childAdapter.id === input.adapter.id && input.parentModelId
                  ? { modelId: input.parentModelId }
                  : {}),
              nativeConfig:
                childAdapter.id === "claude"
                  ? { permissionMode: "dontAsk" }
                  : childAdapter.id === "codex"
                    ? { sandbox: "read-only" }
                    : {},
              context,
              signal: childAborter.signal,
              onEvent: () => undefined,
            },
            childAborter,
            timeoutMs,
            childRunDeadline,
            input.parentAttemptId,
            (event) => {
              const data =
                event.data && typeof event.data === "object" && !Array.isArray(event.data)
                  ? event.data
                  : { detail: event.data };
              this.recordHarnessActivity(
                input.runId,
                input.parentInvocationId,
                input.parentAttemptId,
                {
                  ...event,
                  data: { ...data, scoutId: input.scoutId, requestId: input.requestId },
                },
              );
            },
          );
          if (!result)
            throw new Error("subagent cancellation was not confirmed; parent requires recovery");
          if (result.status !== "succeeded" || result.output === undefined)
            throw new Error(result.error ?? `scout harness ${result.status}`);
          return result.output;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
    });
  }

  private resolveBoundInput(
    binding: BoundInput,
    state: ExecutionState,
    consumerInvocationId?: string,
  ): JsonValue | undefined {
    if (binding.value !== undefined) return binding.value;
    if (binding.source.kind === "scout-results") {
      const source = binding.source;
      if (!consumerInvocationId) return undefined;
      const consumer = state.invocations[consumerInvocationId];
      const planner = Object.values(state.invocations)
        .filter(
          (candidate) =>
            candidate.scopeId === consumer?.scopeId &&
            candidate.nodeId === source.sourceId &&
            candidate.status === "succeeded",
        )
        .sort((a, b) => b.activationOrdinal - a.activationOrdinal)[0];
      if (!planner) return [];
      const attempt = Object.values(state.attempts)
        .filter(
          (candidate) => candidate.invocationId === planner.id && candidate.status === "succeeded",
        )
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      if (!attempt) return [];
      return this.scouts
        .deliveries(state.runId, attempt.id)
        .filter((delivery) => delivery.manifest.scoutId === source.scoutId)
        .map((delivery) => ({
          requestId: delivery.requestId,
          scoutId: delivery.manifest.scoutId,
          resultArtifactId: delivery.manifest.artifactId ?? null,
          resultDigest: delivery.manifest.resultDigest ?? null,
          result: delivery.result,
        })) as unknown as JsonValue;
    }
    if (!binding.artifactId) return undefined;
    const ref = allArtifactRefs(state).find((candidate) => candidate.id === binding.artifactId);
    if (!ref) throw new Error(`Bound artifact ${binding.artifactId} is unavailable`);
    const text = new TextDecoder().decode(this.journal.blobs.read(ref));
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }

  private collaborationTerminationAllowed(runId: string): boolean {
    const row = this.journal.getRunRow(runId);
    if (!row) return false;
    const input = parseJson<Record<string, unknown>>(row.input_json);
    const collaboration = input.__collaboration;
    if (!collaboration || typeof collaboration !== "object") return true;
    const gate = (collaboration as Record<string, unknown>).deterministicReproductionGate;
    if (!gate || typeof gate !== "object") return true;
    const command = (gate as Record<string, unknown>).command;
    if (typeof command !== "string" || !command) return false;
    return this.journal
      .getEvaluationEvidence(runId)
      .some(
        (evidence) =>
          evidence.evidenceClass === "deterministic" &&
          evidence.status === "passed" &&
          ((evidence as unknown as { command?: string }).command === command ||
            evidence.name === command),
      );
  }

  private async recover(): Promise<void> {
    for (const effect of this.journal.unresolvedEffects()) {
      if (effect.state === "claimed")
        this.journal.markRecoveryRequired(
          effect.id,
          "host restarted after dispatch claim; external process outcome is ambiguous",
        );
      // Reserved effects are left for core decide/drive. They have no external
      // side effect and are dispatched once using their existing operation key.
      else this.schedule(effect.runId);
    }
  }
}

function subagentToolSchema(
  bundle: Bundle,
  definitionId: string,
  subagentIds: readonly string[] | undefined,
): JsonValue {
  const definition = bundle.definitions[definitionId];
  const choices = (subagentIds ?? []).flatMap((subagentId) => {
    const scout = definition?.scouts?.find((candidate) => candidate.id === subagentId);
    const child = scout ? bundle.definitions[scout.definitionId] : undefined;
    if (!child) return [];
    const properties: Record<string, JsonValue> = {};
    const required: string[] = [];
    for (const port of child.inputPorts) {
      const schema = bundle.schemas[port.schemaDigest] ?? {};
      properties[port.name] = schema;
      if (port.required && port.defaultValue === undefined) required.push(port.name);
    }
    return [
      {
        type: "object",
        additionalProperties: false,
        required: ["subagentId", "requestId", "input"],
        properties: {
          subagentId: { const: subagentId },
          requestId: { type: "string", maxLength: 128 },
          input: {
            type: "object",
            additionalProperties: false,
            ...(required.length ? { required } : {}),
            properties,
          },
        },
      } as JsonValue,
    ];
  });
  return {
    type: "object",
    oneOf: choices,
    properties: {
      subagentId: { type: "string", enum: Array.from(subagentIds ?? []) },
      requestId: { type: "string", maxLength: 128 },
      input: { type: "object" },
    },
    required: ["subagentId", "requestId", "input"],
  };
}

function selectJsonPath(value: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (current && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return current as JsonValue | undefined;
}

function allArtifactRefs(state: ExecutionState): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const invocation of Object.values(state.invocations))
    refs.push(...invocation.output, ...invocation.evidence, ...invocation.artifacts);
  for (const attempt of Object.values(state.attempts))
    refs.push(...attempt.output, ...attempt.evidence, ...attempt.artifacts);
  return refs;
}

function validateCommandNode(
  node: Extract<Bundle["definitions"][string]["nodes"][number], { kind: "command" }>,
): void {
  if (
    !node.executable.trim() ||
    node.executable.includes("\0") ||
    node.args.some((arg) => arg.includes("\0"))
  )
    throw new Error("Command executable and arguments must be non-empty and contain no NUL bytes");
}
