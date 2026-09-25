import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, createProjectionFrame, createRunView, reduceEvent } from "@kouro/core";
import { canonicalize } from "@kouro/core";
import type { CheckpointCertificate } from "@kouro/core";
import type {
  ArtifactRef,
  Bundle,
  ExecutionState,
  LifecycleEvent,
  LifecycleEventType,
  ProjectionFrame,
  RunView,
} from "@kouro/core/contracts";
import type { EvaluationEvidence } from "@kouro/core";
import type {
  DatasetDefinition,
  ExperimentDefinition,
  ExperimentCellStatus,
  ExperimentSnapshot,
  ExperimentVariant,
} from "@kouro/core";
import type {
  ComparisonAnchor,
  ComparisonRunRef,
  PairwiseAssignment,
  PairwiseChoice,
  PairwiseDecision,
  RunComparisonRecord,
} from "@kouro/core";
import { id, json, now, parseJson } from "../id.ts";
import type { CommandReceipt, DeliveryAction, RunSummary } from "../types.ts";
import { migrate } from "./schema.ts";
import { BlobStore, type StoredBlobRef } from "./blob-store.ts";
import { OwnerLock } from "./lock.ts";

type Listener = (frame: ProjectionFrame) => void;
type StoredArtifact = StoredBlobRef;

type AppendInput = {
  [T in LifecycleEventType]: {
    runId: string;
    type: T;
    payload: Extract<LifecycleEvent, { type: T }>["payload"];
    actor?: string;
    subjectId?: string;
    causationId?: string;
  };
}[LifecycleEventType];

interface RunRow {
  runId: string;
  workflowId: string;
  status: string;
  revision: number;
  bundle_json: string;
  input_json: string;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryActionRow {
  id: string;
  request_key: string;
  run_id: string;
  workspace_id: string;
  invocation_id: string | null;
  base_tree: string;
  result_tree: string;
  patch_digest: string;
  changed_paths_json: string;
  message: string;
  validation_evidence_json: string;
  review_evidence_json: string;
  action_digest: string;
  operation_key: string;
  status: DeliveryAction["status"];
  actor: string | null;
  commit_json: string | null;
  created_at: string;
  updated_at: string;
}

function toDeliveryAction(row: DeliveryActionRow): DeliveryAction {
  return {
    id: row.id,
    requestKey: row.request_key,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    ...(row.invocation_id === null ? {} : { invocationId: row.invocation_id }),
    baseTree: row.base_tree,
    resultTree: row.result_tree,
    patchDigest: row.patch_digest,
    changedPaths: parseJson<unknown[]>(row.changed_paths_json),
    message: row.message,
    ...(parseJson<string[]>(row.validation_evidence_json).length
      ? { validationEvidence: parseJson<string[]>(row.validation_evidence_json) }
      : {}),
    ...(parseJson<string[]>(row.review_evidence_json).length
      ? { reviewEvidence: parseJson<string[]>(row.review_evidence_json) }
      : {}),
    actionDigest: row.action_digest,
    operationKey: row.operation_key,
    status: row.status,
    ...(row.actor === null ? {} : { actor: row.actor }),
    ...(row.commit_json === null ? {} : { commit: parseJson(row.commit_json) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Durable M1 journal. It stores core lifecycle facts and never implements a second reducer. */
export class Journal {
  readonly db: Database;
  readonly blobs: BlobStore;
  readonly owner: OwnerLock;
  /** Root directory used for a consistent local backup/export. */
  readonly dataDir: string;
  private listeners = new Map<string, Set<Listener>>();
  private frameBatch: ProjectionFrame[] | null = null;

  constructor(options: { dataDir: string; requireOwner?: boolean }) {
    this.dataDir = options.dataDir;
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.owner = new OwnerLock(join(options.dataDir, "owner.lock"));
    if (options.requireOwner !== false) this.owner.acquire();
    try {
      this.db = new Database(join(options.dataDir, "kouro.sqlite"));
      migrate(this.db);
      this.blobs = new BlobStore(options.dataDir);
    } catch (cause) {
      this.owner.release();
      throw cause;
    }
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      this.owner.release();
    }
  }

  private tx<T>(callback: () => T): T {
    if (this.frameBatch) return callback();
    const frames: ProjectionFrame[] = [];
    this.frameBatch = frames;
    let committed = false;
    try {
      const result = this.db.transaction(callback)();
      committed = true;
      return result;
    } finally {
      if (committed) for (const frame of frames) this.notify(frame);
      this.frameBatch = null;
    }
  }

  transaction<T>(callback: () => T): T {
    return this.tx(callback);
  }

  saveDataset(dataset: DatasetDefinition & { digest: string }): void {
    this.tx(() => {
      const existing = this.db
        .query("SELECT version, digest FROM eval_datasets WHERE id = ?1")
        .get(dataset.id) as { version: string; digest: string } | null;
      if (existing && (existing.version !== dataset.version || existing.digest !== dataset.digest))
        throw new Error(`dataset manifest is immutable: ${dataset.id}`);
      this.db
        .query(
          "INSERT OR IGNORE INTO eval_datasets(id, version, digest, cases_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .run(dataset.id, dataset.version, dataset.digest, json(dataset.cases), now());
    });
  }

  listDatasets(): Array<{
    id: string;
    version: string;
    digest: string;
    cases: DatasetDefinition["cases"];
  }> {
    return (
      this.db
        .query("SELECT id, version, digest, cases_json FROM eval_datasets ORDER BY id")
        .all() as Array<{ id: string; version: string; digest: string; cases_json: string }>
    ).map((row) => ({
      id: row.id,
      version: row.version,
      digest: row.digest,
      cases: parseJson<DatasetDefinition["cases"]>(row.cases_json),
    }));
  }

  saveExperiment(input: { definition: ExperimentDefinition; datasetDigest: string }): void {
    const definition = input.definition;
    this.tx(() => {
      const existing = this.db
        .query(
          "SELECT dataset_id, variants_json, repetitions, max_concurrent, repository_path FROM experiments WHERE id = ?1",
        )
        .get(definition.id) as {
        dataset_id: string;
        variants_json: string;
        repetitions: number;
        max_concurrent: number;
        repository_path: string | null;
      } | null;
      if (existing) {
        const dataset = this.db
          .query("SELECT digest FROM eval_datasets WHERE id = ?1")
          .get(existing.dataset_id) as { digest: string } | null;
        if (
          !dataset ||
          existing.dataset_id !== definition.dataset.id ||
          dataset.digest !== input.datasetDigest ||
          existing.variants_json !== json(definition.variants) ||
          existing.repetitions !== definition.repetitions ||
          existing.max_concurrent !== (definition.maxConcurrent ?? 1) ||
          existing.repository_path !== (definition.repositoryPath ?? null)
        )
          throw new Error(`experiment manifest is immutable: ${definition.id}`);
      }
      this.saveDatasetInTransaction({ ...definition.dataset, digest: input.datasetDigest });
      const timestamp = now();
      this.db
        .query(
          "INSERT OR IGNORE INTO experiments(id, dataset_id, status, variants_json, repetitions, max_concurrent, repository_path, created_at, updated_at) VALUES (?1, ?2, 'draft', ?3, ?4, ?5, ?6, ?7, ?7)",
        )
        .run(
          definition.id,
          definition.dataset.id,
          json(definition.variants),
          definition.repetitions,
          definition.maxConcurrent ?? 1,
          definition.repositoryPath ?? null,
          timestamp,
        );
      for (const item of definition.dataset.cases)
        for (const variant of definition.variants)
          for (let repetition = 1; repetition <= definition.repetitions; repetition++) {
            const cellKey = `${item.id}::${variant.id}::${repetition}`;
            this.db
              .query(
                "INSERT OR IGNORE INTO experiment_cells(experiment_id, cell_key, case_id, variant_id, repetition, status, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
              )
              .run(definition.id, cellKey, item.id, variant.id, repetition, timestamp);
          }
    });
  }

  private saveDatasetInTransaction(dataset: DatasetDefinition & { digest: string }): void {
    const existing = this.db
      .query("SELECT version, digest FROM eval_datasets WHERE id = ?1")
      .get(dataset.id) as { version: string; digest: string } | null;
    if (existing && (existing.version !== dataset.version || existing.digest !== dataset.digest))
      throw new Error(`dataset manifest is immutable: ${dataset.id}`);
    this.db
      .query(
        "INSERT OR IGNORE INTO eval_datasets(id, version, digest, cases_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run(dataset.id, dataset.version, dataset.digest, json(dataset.cases), now());
  }

  getExperiment(idValue: string): ExperimentSnapshot | undefined {
    const row = this.db
      .query(
        "SELECT id, status, variants_json, repetitions, max_concurrent, repository_path FROM experiments WHERE id = ?1",
      )
      .get(idValue) as {
      id: string;
      status: string;
      variants_json: string;
      repetitions: number;
      max_concurrent: number;
      repository_path: string | null;
    } | null;
    if (!row) return undefined;
    const dataset = this.db
      .query(
        "SELECT id, version, cases_json FROM eval_datasets WHERE id = (SELECT dataset_id FROM experiments WHERE id = ?1)",
      )
      .get(idValue) as { id: string; version: string; cases_json: string } | null;
    const cells = this.db
      .query(
        "SELECT cell_key as key, case_id as caseId, variant_id as variantId, repetition, status, run_id as runId, error FROM experiment_cells WHERE experiment_id = ?1 ORDER BY case_id, variant_id, repetition",
      )
      .all(idValue) as Array<{
      key: string;
      caseId: string;
      variantId: string;
      repetition: number;
      status: ExperimentCellStatus;
      runId?: string;
      error?: string;
    }>;
    return {
      id: row.id,
      status: row.status as ExperimentSnapshot["status"],
      variants: parseJson<ExperimentVariant[]>(row.variants_json),
      dataset: dataset
        ? {
            id: dataset.id,
            version: dataset.version,
            cases: parseJson<DatasetDefinition["cases"] extends readonly (infer C)[] ? C[] : never>(
              dataset.cases_json,
            ),
          }
        : { id: "", version: "", cases: [] },
      repetitions: row.repetitions,
      maxConcurrent: row.max_concurrent,
      ...(row.repository_path ? { repositoryPath: row.repository_path } : {}),
      cells,
    };
  }

  listExperiments(): ExperimentSnapshot[] {
    return (
      this.db.query("SELECT id FROM experiments ORDER BY created_at DESC").all() as Array<{
        id: string;
      }>
    ).flatMap((row) => {
      const snapshot = this.getExperiment(row.id);
      return snapshot ? [snapshot] : [];
    });
  }

  reserveExperimentCell(experimentId: string, cellKey: string, token: string): any | undefined {
    return this.tx(() => {
      this.db
        .query(
          "UPDATE experiment_cells SET status = 'reserved', reservation_token = ?1, updated_at = ?2 WHERE experiment_id = ?3 AND cell_key = ?4 AND (status = 'pending' OR (status = 'reserved' AND reservation_token = ?1))",
        )
        .run(token, now(), experimentId, cellKey);
      return this.db
        .query(
          "SELECT cell_key as key, case_id as caseId, variant_id as variantId, repetition, status, reservation_token as reservationToken, run_id as runId, error FROM experiment_cells WHERE experiment_id = ?1 AND cell_key = ?2",
        )
        .get(experimentId, cellKey);
    });
  }

  associateExperimentCell(
    experimentId: string,
    cellKey: string,
    token: string,
    runId: string,
    status: ExperimentCellStatus = "running",
  ): void {
    this.tx(() => {
      const result = this.db
        .query(
          "UPDATE experiment_cells SET status = ?1, run_id = COALESCE(run_id, ?2), updated_at = ?3 WHERE experiment_id = ?4 AND cell_key = ?5 AND (reservation_token = ?6 OR run_id = ?2)",
        )
        .run(status, runId, now(), experimentId, cellKey, token);
      if (result.changes === 0)
        throw new Error("experiment cell reservation is not owned by this worker");
    });
  }

  setExperimentCellStatus(
    experimentId: string,
    cellKey: string,
    status: ExperimentCellStatus,
    error?: string,
  ): void {
    this.db
      .query(
        "UPDATE experiment_cells SET status = ?1, error = ?2, updated_at = ?3 WHERE experiment_id = ?4 AND cell_key = ?5",
      )
      .run(status, error ?? null, now(), experimentId, cellKey);
  }

  setExperimentStatus(
    experimentId: string,
    status: "draft" | "running" | "paused" | "cancelled" | "completed",
  ): void {
    this.db
      .query("UPDATE experiments SET status = ?1, updated_at = ?2 WHERE id = ?3")
      .run(status, now(), experimentId);
  }

  saveComparison(input: {
    id: string;
    runs: readonly ComparisonRunRef[];
    anchors: readonly ComparisonAnchor[];
    evidenceRevision: number;
  }): RunComparisonRecord {
    if (input.runs.length < 2) throw new Error("comparison requires at least two runs");
    if (!Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision < 0)
      throw new Error("comparison revision must be non-negative");
    for (const run of input.runs) {
      const row = this.getRunRow(run.runId);
      if (!row) throw new Error(`comparison run not found: ${run.runId}`);
      if (!Number.isSafeInteger(run.revision) || run.revision < 0 || run.revision > row.revision)
        throw new Error(`comparison revision is not retained: ${run.runId}`);
      const bundle = parseJson<Bundle>(row.bundle_json);
      const nodeKeys = new Set(
        Object.values(bundle.definitions).flatMap((definition) =>
          definition.nodes.map((node) => node.id),
        ),
      );
      for (const anchor of input.anchors) {
        if (!nodeKeys.has(anchor.leftNodeKey) && !nodeKeys.has(anchor.rightNodeKey))
          throw new Error(`comparison anchor is incompatible with ${run.runId}: ${anchor.id}`);
      }
    }
    const createdAt = now();
    const persisted = this.tx(() => {
      const prior = this.db
        .query(
          "SELECT id, runs_json, anchors_json, evidence_revision, created_at FROM run_comparisons WHERE id = ?1",
        )
        .get(input.id) as {
        id: string;
        runs_json: string;
        anchors_json: string;
        evidence_revision: number;
        created_at: string;
      } | null;
      if (prior) {
        const existing = {
          id: prior.id,
          runs: parseJson<ComparisonRunRef[]>(prior.runs_json),
          anchors: parseJson<ComparisonAnchor[]>(prior.anchors_json),
          evidenceRevision: prior.evidence_revision,
          createdAt: prior.created_at,
        };
        if (
          canonicalize(existing.runs) !== canonicalize(input.runs) ||
          canonicalize(existing.anchors) !== canonicalize(input.anchors) ||
          existing.evidenceRevision !== input.evidenceRevision
        )
          throw new Error("comparison id is immutable and already bound to different data");
        return existing;
      }
      this.db
        .query(
          "INSERT INTO run_comparisons(id, runs_json, anchors_json, evidence_revision, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .run(input.id, json(input.runs), json(input.anchors), input.evidenceRevision, createdAt);
      return {
        id: input.id,
        runs: input.runs,
        anchors: input.anchors,
        evidenceRevision: input.evidenceRevision,
        createdAt,
      };
    });
    return persisted;
  }

  getComparison(comparisonId: string): RunComparisonRecord | undefined {
    const row = this.db
      .query(
        "SELECT id, runs_json, anchors_json, evidence_revision, created_at FROM run_comparisons WHERE id = ?1",
      )
      .get(comparisonId) as {
      id: string;
      runs_json: string;
      anchors_json: string;
      evidence_revision: number;
      created_at: string;
    } | null;
    return row
      ? {
          id: row.id,
          runs: parseJson<ComparisonRunRef[]>(row.runs_json),
          anchors: parseJson<ComparisonAnchor[]>(row.anchors_json),
          evidenceRevision: row.evidence_revision,
          createdAt: row.created_at,
        }
      : undefined;
  }

  createPairwiseAssignment(input: {
    id: string;
    comparisonId: string;
    runA: ComparisonRunRef;
    runB: ComparisonRunRef;
    sideA: string;
    sideB: string;
    rubric: unknown;
    eligibleActor: string;
    evidenceRevision: number;
    leakageRisk: readonly string[];
    evidenceA?: readonly unknown[];
    evidenceB?: readonly unknown[];
  }): PairwiseAssignment {
    if (input.sideA === input.sideB) throw new Error("pairwise side ids must differ");
    const assignedAt = now();
    this.tx(() =>
      this.db
        .query(
          "INSERT INTO pairwise_assignments(id, comparison_id, run_a_json, run_b_json, side_a, side_b, rubric_json, eligible_actor, evidence_revision, leakage_risk_json, evidence_a_json, evidence_b_json, assigned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )
        .run(
          input.id,
          input.comparisonId,
          json(input.runA),
          json(input.runB),
          input.sideA,
          input.sideB,
          json(input.rubric),
          input.eligibleActor,
          input.evidenceRevision,
          json(input.leakageRisk),
          json(input.evidenceA ?? []),
          json(input.evidenceB ?? []),
          assignedAt,
        ),
    );
    return {
      id: input.id,
      comparisonId: input.comparisonId,
      runA: input.runA,
      runB: input.runB,
      sideA: input.sideA,
      sideB: input.sideB,
      rubric: input.rubric,
      eligibleActor: input.eligibleActor,
      evidenceRevision: input.evidenceRevision,
      artifactLeakageRisk: input.leakageRisk,
      assignedAt,
    };
  }

  getPairwiseAssignment(assignmentId: string): PairwiseAssignment | undefined {
    const row = this.db
      .query("SELECT * FROM pairwise_assignments WHERE id = ?1")
      .get(assignmentId) as any;
    return row
      ? {
          id: row.id,
          comparisonId: row.comparison_id,
          runA: parseJson<ComparisonRunRef>(row.run_a_json),
          runB: parseJson<ComparisonRunRef>(row.run_b_json),
          sideA: row.side_a,
          sideB: row.side_b,
          rubric: parseJson(row.rubric_json),
          eligibleActor: row.eligible_actor,
          evidenceRevision: row.evidence_revision,
          artifactLeakageRisk: parseJson<string[]>(row.leakage_risk_json),
          assignedAt: row.assigned_at,
          ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
        }
      : undefined;
  }

  pairwiseDecision(input: {
    assignmentId: string;
    choice: PairwiseChoice;
    actor: string;
    reason?: string;
    idempotencyKey: string;
    correctionOf?: string;
  }): PairwiseDecision {
    const assignment = this.getPairwiseAssignment(input.assignmentId);
    if (!assignment) throw new Error("pairwise assignment not found");
    if (assignment.eligibleActor !== input.actor)
      throw new Error("actor is not eligible for this pairwise assignment");
    if (!["a", "b", "tie", "abstain"].includes(input.choice))
      throw new Error("invalid pairwise choice");
    return this.tx(() => {
      const requestDigest = canonicalize({
        assignmentId: input.assignmentId,
        actor: input.actor,
        choice: input.choice,
        reason: input.reason ?? null,
        correctionOf: input.correctionOf ?? null,
      });
      const prior = this.db
        .query(
          "SELECT id, assignment_id, choice, actor, reason, recorded_at, correction_of, request_digest FROM pairwise_decisions WHERE idempotency_key = ?1",
        )
        .get(input.idempotencyKey) as any;
      if (prior) {
        if (prior.request_digest && prior.request_digest !== requestDigest)
          throw new Error("pairwise idempotency key payload conflict");
        return {
          id: prior.id,
          assignmentId: prior.assignment_id,
          choice: prior.choice,
          actor: prior.actor,
          ...(prior.reason ? { reason: prior.reason } : {}),
          recordedAt: prior.recorded_at,
          ...(prior.correction_of ? { correctionOf: prior.correction_of } : {}),
        };
      }
      if (input.correctionOf) {
        const correction = this.db
          .query("SELECT id, assignment_id FROM pairwise_decisions WHERE id = ?1")
          .get(input.correctionOf) as { id: string; assignment_id: string } | null;
        if (!correction || correction.assignment_id !== input.assignmentId)
          throw new Error("correction target not found for assignment");
      }
      const decision: PairwiseDecision = {
        id: id("pair"),
        assignmentId: input.assignmentId,
        choice: input.choice,
        actor: input.actor,
        ...(input.reason ? { reason: input.reason } : {}),
        recordedAt: now(),
        ...(input.correctionOf ? { correctionOf: input.correctionOf } : {}),
      };
      this.db
        .query(
          "INSERT INTO pairwise_decisions(id, assignment_id, choice, actor, reason, recorded_at, correction_of, idempotency_key, request_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .run(
          decision.id,
          decision.assignmentId,
          decision.choice,
          decision.actor,
          decision.reason ?? null,
          decision.recordedAt,
          decision.correctionOf ?? null,
          input.idempotencyKey,
          requestDigest,
        );
      this.db
        .query(
          "UPDATE pairwise_assignments SET decided_at = COALESCE(decided_at, ?1) WHERE id = ?2",
        )
        .run(decision.recordedAt, input.assignmentId);
      return decision;
    });
  }

  latestPairwiseDecision(assignmentId: string): PairwiseDecision | undefined {
    const row = this.db
      .query(
        "SELECT id, assignment_id, choice, actor, reason, recorded_at, correction_of FROM pairwise_decisions WHERE assignment_id = ?1 ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
      )
      .get(assignmentId) as any;
    return row
      ? {
          id: row.id,
          assignmentId: row.assignment_id,
          choice: row.choice,
          actor: row.actor,
          ...(row.reason ? { reason: row.reason } : {}),
          recordedAt: row.recorded_at,
          ...(row.correction_of ? { correctionOf: row.correction_of } : {}),
        }
      : undefined;
  }

  pairwiseEvidence(assignmentId: string): { sideA: readonly unknown[]; sideB: readonly unknown[] } {
    const row = this.db
      .query("SELECT evidence_a_json, evidence_b_json FROM pairwise_assignments WHERE id = ?1")
      .get(assignmentId) as { evidence_a_json: string; evidence_b_json: string } | null;
    if (!row) throw new Error("pairwise assignment not found");
    return {
      sideA: parseJson<unknown[]>(row.evidence_a_json),
      sideB: parseJson<unknown[]>(row.evidence_b_json),
    };
  }

  private notify(frame: ProjectionFrame): void {
    const listeners = this.listeners.get(frame.runId);
    if (!listeners) return;
    queueMicrotask(() => {
      for (const listener of listeners) listener(frame);
    });
  }

  /** Execute one operator command exactly once, including its lifecycle facts. */
  command<T>(input: {
    idempotencyKey: string;
    runId: string;
    requestDigest?: string;
    execute: () => T;
  }): {
    result: T;
    duplicate: boolean;
  } {
    if (!input.idempotencyKey.trim()) throw new Error("idempotency key is required");
    return this.tx(() => {
      const prior = this.db
        .query(
          "SELECT run_id, result_json, request_digest FROM command_receipts WHERE idempotency_key = ?1",
        )
        .get(input.idempotencyKey) as {
        run_id: string;
        result_json: string;
        request_digest: string;
      } | null;
      if (prior) {
        if (prior.run_id !== input.runId)
          throw new Error("idempotency key is already bound to another run");
        if (
          input.requestDigest !== undefined &&
          prior.request_digest &&
          prior.request_digest !== input.requestDigest
        )
          throw new Error("idempotency key payload conflict");
        return { result: parseJson<T>(prior.result_json), duplicate: true };
      }
      const result = input.execute();
      this.db
        .query(
          "INSERT INTO command_receipts(idempotency_key, command_id, run_id, result_json, request_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .run(
          input.idempotencyKey,
          id("cmd"),
          input.runId,
          json(result),
          input.requestDigest ?? "",
          now(),
        );
      return { result, duplicate: false };
    });
  }

  createRun(input: {
    workflowId: string;
    bundle: Bundle;
    input?: Record<string, unknown>;
    idempotencyKey: string;
    actor?: string;
    executionProfile?: string;
    workspace?: { repositoryPath: string; workspaceId?: string };
  }): { run: RunSummary; receipt: CommandReceipt; created: boolean } {
    const requestDigest = createHash("sha256")
      .update(
        canonicalize({
          workflowId: input.workflowId,
          bundleDigest: input.bundle.digest,
          input: input.input ?? {},
          executionProfile: input.executionProfile ?? null,
          workspace: input.workspace ?? null,
        }),
      )
      .digest("hex");
    const prior = this.db
      .query("SELECT result_json, request_digest FROM command_receipts WHERE idempotency_key = ?1")
      .get(input.idempotencyKey) as { result_json: string; request_digest: string } | null;
    if (prior) {
      if (prior.request_digest && prior.request_digest !== requestDigest)
        throw new Error("idempotency key payload conflict");
      const receipt = parseJson<CommandReceipt>(prior.result_json);
      const run = this.getRunSummary(receipt.runId);
      if (!run) throw new Error("Command receipt references a missing run");
      return { run, receipt, created: false };
    }
    const runId = id("run");
    const commandId = id("cmd");
    const createdAt = now();
    const state = createInitialState(runId, undefined, input.bundle.rootDefinitionId);
    const receipt: CommandReceipt = {
      commandId,
      idempotencyKey: input.idempotencyKey,
      accepted: true,
      runId,
      revision: state.revision,
      status: state.status,
    };
    this.tx(() => {
      this.db
        .query(
          "INSERT INTO runs(id, workflow_id, status, revision, idempotency_key, bundle_json, input_json, created_at, updated_at) VALUES (?1, ?2, 'pending', 0, ?3, ?4, ?5, ?6, ?6)",
        )
        .run(
          runId,
          input.workflowId,
          input.idempotencyKey,
          json(input.bundle),
          json(input.input ?? {}),
          createdAt,
        );
      this.db
        .query("INSERT INTO run_projections(run_id, revision, view_json) VALUES (?1, 0, ?2)")
        .run(runId, json(createRunView(input.bundle, state, createdAt)));
      this.db
        .query(
          "INSERT INTO command_receipts(idempotency_key, command_id, run_id, result_json, request_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .run(input.idempotencyKey, commandId, runId, json(receipt), requestDigest, createdAt);
    });
    return { run: this.getRunSummary(runId)!, receipt, created: true };
  }

  updateRunInput(runId: string, input: Record<string, unknown>): void {
    this.db
      .query("UPDATE runs SET input_json = ?, updated_at = ? WHERE id = ?")
      .run(json(input), now(), runId);
  }

  createDeliveryAction(input: {
    requestKey: string;
    runId: string;
    workspaceId: string;
    invocationId?: string;
    baseTree: string;
    resultTree: string;
    patchDigest: string;
    changedPaths: readonly unknown[];
    message: string;
    validationEvidence?: readonly string[];
    reviewEvidence?: readonly string[];
  }): DeliveryAction {
    if (!input.requestKey.trim()) throw new Error("delivery request key is required");
    const base = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      baseTree: input.baseTree,
      resultTree: input.resultTree,
      patchDigest: input.patchDigest,
      changedPaths: input.changedPaths,
      message: input.message,
      invocationId: input.invocationId ?? null,
      validationEvidence: input.validationEvidence ?? [],
      reviewEvidence: input.reviewEvidence ?? [],
    };
    const actionDigest = `sha256:${createHash("sha256").update(canonicalize(base)).digest("hex")}`;
    return this.tx(() => {
      const prior = this.db
        .query("SELECT * FROM delivery_actions WHERE request_key=?1")
        .get(input.requestKey) as DeliveryActionRow | null;
      if (prior) {
        if (prior.action_digest !== actionDigest)
          throw new Error("delivery request key payload conflict");
        return toDeliveryAction(prior);
      }
      const timestamp = now();
      const action: DeliveryAction = {
        id: id("delivery"),
        requestKey: input.requestKey,
        runId: input.runId,
        workspaceId: input.workspaceId,
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        baseTree: input.baseTree,
        resultTree: input.resultTree,
        patchDigest: input.patchDigest,
        changedPaths: input.changedPaths,
        message: input.message,
        ...(input.validationEvidence?.length
          ? { validationEvidence: input.validationEvidence }
          : {}),
        ...(input.reviewEvidence?.length ? { reviewEvidence: input.reviewEvidence } : {}),
        actionDigest,
        operationKey: `delivery/${input.runId}/${input.requestKey}`,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.db
        .query(
          "INSERT INTO delivery_actions(id,request_key,run_id,workspace_id,invocation_id,base_tree,result_tree,patch_digest,changed_paths_json,message,validation_evidence_json,review_evidence_json,action_digest,operation_key,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'pending',?15,?15)",
        )
        .run(
          action.id,
          action.requestKey,
          action.runId,
          action.workspaceId,
          action.invocationId ?? null,
          action.baseTree,
          action.resultTree,
          action.patchDigest,
          json(action.changedPaths),
          action.message,
          json(action.validationEvidence ?? []),
          json(action.reviewEvidence ?? []),
          action.actionDigest,
          action.operationKey,
          timestamp,
        );
      return action;
    });
  }

  getDeliveryAction(actionId: string): DeliveryAction | undefined {
    const row = this.db
      .query("SELECT * FROM delivery_actions WHERE id=?1")
      .get(actionId) as DeliveryActionRow | null;
    return row ? toDeliveryAction(row) : undefined;
  }

  decideDeliveryAction(input: {
    actionId: string;
    decision: "approved" | "rejected";
    actor: string;
  }): DeliveryAction {
    if (!input.actor.trim()) throw new Error("delivery approval actor is required");
    return this.tx(() => {
      const action = this.getDeliveryAction(input.actionId);
      if (!action) throw new Error("delivery action not found");
      if (action.status === "committed") throw new Error("delivery action is already committed");
      if (action.status !== "pending" && action.status !== input.decision)
        throw new Error(`delivery action is ${action.status}`);
      this.db
        .query("UPDATE delivery_actions SET status=?1, actor=?2, updated_at=?3 WHERE id=?4")
        .run(input.decision, input.actor, now(), input.actionId);
      return this.getDeliveryAction(input.actionId)!;
    });
  }

  completeDeliveryAction(actionId: string, commit: unknown): DeliveryAction {
    return this.tx(() => {
      const action = this.getDeliveryAction(actionId);
      if (!action) throw new Error("delivery action not found");
      if (action.status === "committed") return action;
      if (action.status !== "approved") throw new Error("delivery action is not approved");
      this.db
        .query(
          "UPDATE delivery_actions SET status='committed', commit_json=?1, updated_at=?2 WHERE id=?3",
        )
        .run(json(commit), now(), actionId);
      return this.getDeliveryAction(actionId)!;
    });
  }

  /** Materialize inherited results as new child facts; parent envelopes are never copied. */
  materializeInheritedPrefix(
    childRunId: string,
    sourceRunId: string,
    sourceInvocationIds: readonly string[],
    pendingInvocationIds: readonly string[] = [],
    carriedCounters: Readonly<Record<string, number>> = {},
  ): void {
    const source = this.getView(sourceRunId);
    if (!source) throw new Error(`Run not found: ${sourceRunId}`);
    const events: AppendInput[] = [
      {
        runId: childRunId,
        type: "run.started",
        payload: {
          rootScopeId: `${childRunId}:root`,
          rootDefinitionId: source.bundle.rootDefinitionId,
        },
        actor: "checkpoint",
      },
    ];
    const sourceRootPrefix = `${source.state.rootScopeId}:`;
    for (const [key, spent] of Object.entries(carriedCounters).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!key.startsWith(sourceRootPrefix))
        throw new Error(`cannot materialize a non-root checkpoint counter: ${key}`);
      if (!Number.isSafeInteger(spent) || spent < 0)
        throw new Error(`invalid checkpoint counter: ${key}`);
      const counterId = key.slice(sourceRootPrefix.length);
      if (!counterId) throw new Error(`invalid checkpoint counter: ${key}`);
      for (let value = 1; value <= spent; value += 1)
        events.push({
          runId: childRunId,
          type: "counter.incremented",
          payload: { scopeId: `${childRunId}:root`, counterId, value },
          actor: "checkpoint",
        });
    }
    for (const sourceId of sourceInvocationIds) {
      const invocation = source.state.invocations[sourceId];
      if (!invocation || invocation.status !== "succeeded")
        throw new Error(`inherited invocation is not succeeded: ${sourceId}`);
      const childId = id("inv");
      events.push({
        runId: childRunId,
        type: "invocation.created",
        payload: {
          invocationId: childId,
          scopeId: `${childRunId}:root`,
          nodeId: invocation.nodeId,
          activationOrdinal: invocation.activationOrdinal,
          repairPass: invocation.repairPass,
          sourceInvocationId: sourceId,
          inputBindings: invocation.inputBindings,
        },
        actor: "checkpoint",
      });
      events.push({
        runId: childRunId,
        type: "invocation.completed",
        payload: {
          invocationId: childId,
          status: "succeeded",
          outcome: "inherited",
          output: invocation.output,
          evidence: invocation.evidence,
          artifacts: invocation.artifacts,
          workspace: invocation.workspace,
          direct: true,
        },
        actor: "checkpoint",
        subjectId: childId,
      });
    }
    for (const sourceId of pendingInvocationIds) {
      const invocation = source.state.invocations[sourceId];
      if (!invocation || !["pending", "reserved"].includes(invocation.status)) continue;
      const childId = id("inv");
      events.push({
        runId: childRunId,
        type: "invocation.created",
        payload: {
          invocationId: childId,
          scopeId: `${childRunId}:root`,
          nodeId: invocation.nodeId,
          activationOrdinal: invocation.activationOrdinal,
          repairPass: invocation.repairPass,
          sourceInvocationId: sourceId,
          inputBindings: invocation.inputBindings,
        },
        actor: "checkpoint",
      });
      // Do not copy an approval request, including its binding, from the parent.
      // The child's coordinator must issue a fresh request against its own tree.
    }
    this.appendMany(events);
  }

  append(input: AppendInput): LifecycleEvent {
    return this.tx(() => this.appendInTransaction(input));
  }

  appendMany(inputs: readonly AppendInput[]): readonly LifecycleEvent[] {
    if (!inputs.length) return [];
    const runId = inputs[0]?.runId;
    if (inputs.some((input) => input.runId !== runId))
      throw new Error("A journal batch must belong to one run");
    return this.tx(() => inputs.map((input) => this.appendInTransaction(input)));
  }

  private appendInTransaction(input: AppendInput): LifecycleEvent {
    const row = this.getRunRow(input.runId);
    if (!row) throw new Error(`Run not found: ${input.runId}`);
    const prior = parseJson<{ state: ExecutionState; bundle: Bundle; serverClock: string }>(
      this.projectionJson(input.runId),
    );
    const event = {
      eventId: id("evt"),
      runId: input.runId,
      sequence: prior.state.revision + 1,
      schemaVersion: 1 as const,
      type: input.type,
      recordedAt: now(),
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.causationId ? { causationId: input.causationId } : {}),
      payload: input.payload,
    } as LifecycleEvent;
    const state = reduceEvent(prior.state, event);
    const view = createRunView(prior.bundle, state, event.recordedAt);
    this.db
      .query(
        "INSERT INTO run_events(run_id, sequence, event_id, schema_version, type, recorded_at, actor, causation_id, command_id, payload_json) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, NULL, ?8)",
      )
      .run(
        input.runId,
        event.sequence,
        event.eventId,
        input.type,
        event.recordedAt,
        input.actor ?? "system",
        input.causationId ?? null,
        json(input.payload),
      );
    this.updateEntityTables(event, prior.bundle);
    this.db
      .query("UPDATE runs SET status = ?1, revision = ?2, updated_at = ?3 WHERE id = ?4")
      .run(state.status, state.revision, event.recordedAt, input.runId);
    this.db
      .query("UPDATE run_projections SET revision = ?1, view_json = ?2 WHERE run_id = ?3")
      .run(state.revision, json(view), input.runId);
    const frame = createProjectionFrame(
      prior.state,
      state,
      event.type === "harness.activity"
        ? { attemptId: event.payload.attemptId, event: event.payload.event }
        : undefined,
    );
    this.db
      .query("INSERT INTO projection_frames(run_id, revision, frame_json) VALUES (?1, ?2, ?3)")
      .run(input.runId, state.revision, json(frame));
    this.frameBatch?.push(frame);
    return event;
  }

  /** Reserve attempts/effects and the attempt.reserved lifecycle fact atomically. */
  reserveEffect(input: {
    runId: string;
    invocationId: string;
    attemptId: string;
    operationKey: string;
    recoveryClass: string;
    payload: Record<string, unknown>;
    ordinal?: number;
  }): { effectId: string; duplicate: boolean } {
    const prior = this.db
      .query("SELECT id FROM effects WHERE operation_key = ?1")
      .get(input.operationKey) as { id: string } | null;
    if (prior) return { effectId: prior.id, duplicate: true };
    const effectId = id("effect");
    this.tx(() => {
      const at = now();
      this.db
        .query(
          "INSERT INTO attempts(id, run_id, invocation_id, operation_key, state, recovery_class) VALUES (?1, ?2, ?3, ?4, 'reserved', ?5)",
        )
        .run(
          input.attemptId,
          input.runId,
          input.invocationId,
          input.operationKey,
          input.recoveryClass,
        );
      this.db
        .query(
          "INSERT INTO effects(id, run_id, attempt_id, operation_key, recovery_class, state, payload_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'reserved', ?6, ?7, ?7)",
        )
        .run(
          effectId,
          input.runId,
          input.attemptId,
          input.operationKey,
          input.recoveryClass,
          json(input.payload),
          at,
        );
      this.db
        .query("INSERT INTO outbox(effect_id, state, created_at) VALUES (?1, 'pending', ?2)")
        .run(effectId, at);
      this.appendInTransaction({
        runId: input.runId,
        type: "attempt.reserved",
        payload: {
          attemptId: input.attemptId,
          invocationId: input.invocationId,
          ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
        },
        actor: "system",
      });
    });
    return { effectId, duplicate: false };
  }

  claimEffect(effectId: string, ownerEpoch: number): boolean {
    const effect = this.getEffect(effectId);
    if (!effect || effect.state !== "reserved") return false;
    return this.tx(() => {
      const changed = this.db
        .query(
          "UPDATE effects SET state = 'claimed', claimed_epoch = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'reserved'",
        )
        .run(ownerEpoch, now(), effectId).changes;
      if (changed !== 1) return false;
      this.db
        .query("UPDATE outbox SET state = 'claimed', claimed_at = ?1 WHERE effect_id = ?2")
        .run(now(), effectId);
      this.appendInTransaction({
        runId: effect.runId,
        type: "attempt.started",
        payload: { attemptId: effect.attemptId },
        actor: "system",
      });
      return true;
    });
  }

  /** Completes one effect and all dependent core lifecycle facts in one transaction. */
  completeEffect(input: {
    effectId: string;
    storedArtifacts: StoredArtifact[];
    artifacts: ArtifactRef[];
    evidence: ArtifactRef[];
    output: ArtifactRef[];
    status: "succeeded" | "failed";
    commandEvidence?: import("@kouro/core/contracts").CommandEvidence;
    error?: string;
    resolvedExecution?: import("@kouro/core/contracts").ResolvedExecution;
    contextManifest?: import("@kouro/core").JsonValue;
    harnessEvents?: readonly import("@kouro/core").JsonValue[];
    usage?: import("@kouro/core").JsonValue;
    diagnostics?: readonly string[];
    sessionReference?: import("@kouro/core").JsonValue;
    retry?: {
      attemptId: string;
      operationKey: string;
      recoveryClass: string;
      payload: Record<string, unknown>;
      ordinal: number;
    };
  }): void {
    const effect = this.getEffect(input.effectId);
    if (!effect) throw new Error(`Unknown effect ${input.effectId}`);
    this.tx(() => {
      for (const artifact of input.storedArtifacts) this.insertArtifact(artifact);
      const storedArtifactRefs = input.storedArtifacts.map(({ id, digest, mediaType }) => ({
        id,
        digest,
        mediaType,
      }));
      const changed = this.db
        .query("UPDATE effects SET state = ?1, updated_at = ?2 WHERE id = ?3 AND state = 'claimed'")
        .run(input.status === "succeeded" ? "succeeded" : "failed", now(), input.effectId).changes;
      if (changed !== 1) throw new Error(`Effect ${input.effectId} is not claimed`);
      this.db
        .query("UPDATE outbox SET state = 'completed' WHERE effect_id = ?1")
        .run(input.effectId);
      this.db
        .query(
          "UPDATE attempts SET state = ?1, ended_at = ?2, artifact_ids_json = ?3, error = ?4 WHERE id = ?5",
        )
        .run(
          input.status,
          now(),
          json(storedArtifactRefs.map((ref) => ref.id)),
          input.error ?? null,
          effect.attemptId,
        );
      this.appendInTransaction({
        runId: effect.runId,
        type: "attempt.completed",
        payload: {
          attemptId: effect.attemptId,
          status: input.status,
          output: input.output,
          evidence: input.evidence,
          artifacts: input.artifacts,
          ...(input.commandEvidence ? { commandEvidence: input.commandEvidence } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.resolvedExecution ? { resolvedExecution: input.resolvedExecution } : {}),
          ...(input.contextManifest ? { contextManifest: input.contextManifest } : {}),
          ...(input.harnessEvents ? { harnessEvents: input.harnessEvents } : {}),
          ...(input.usage ? { usage: input.usage } : {}),
          ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
          ...(input.sessionReference ? { sessionReference: input.sessionReference } : {}),
        },
        actor: "system",
      });
      if (input.retry) {
        this.reserveEffect({
          runId: effect.runId,
          invocationId: String(effect.payload.invocationId ?? ""),
          ...input.retry,
        });
      } else {
        this.appendInTransaction({
          runId: effect.runId,
          type: "invocation.completed",
          payload: {
            invocationId: String(effect.payload.invocationId ?? ""),
            status: input.status,
            output: input.output,
            evidence: input.evidence,
            artifacts: input.artifacts,
            ...(input.error ? { error: input.error } : {}),
          },
          actor: "system",
        });
      }
    });
  }

  markRecoveryRequired(effectId: string, reason: string): void {
    const effect = this.getEffect(effectId);
    if (!effect) return;
    this.tx(() => {
      const changed = this.db
        .query(
          "UPDATE effects SET state = 'unknown', updated_at = ?1 WHERE id = ?2 AND state = 'claimed'",
        )
        .run(now(), effectId).changes;
      if (changed !== 1) return;
      this.db.query("UPDATE outbox SET state = 'unknown' WHERE effect_id = ?1").run(effectId);
      this.appendInTransaction({
        runId: effect.runId,
        type: "recovery.required",
        payload: { code: "effect-ambiguous", subjectId: effectId, detail: reason },
        actor: "system",
        subjectId: effectId,
      });
    });
  }

  insertArtifact(ref: StoredArtifact): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO artifacts(id, run_id, digest, media_type, byte_length, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .run(
        ref.id,
        ref.runId,
        ref.digest ?? "",
        ref.mediaType ?? "application/octet-stream",
        ref.byteLength,
        ref.createdAt,
      );
  }

  getRunSummary(runId: string): RunSummary | null {
    const row = this.db
      .query(
        "SELECT id as runId, workflow_id as workflowId, status, revision, input_json, created_at as createdAt, updated_at as updatedAt FROM runs WHERE id = ?1",
      )
      .get(runId) as (RunSummary & { input_json: string }) | null;
    return row ? this.runSummary(row) : null;
  }
  listRuns(): RunSummary[] {
    const rows = this.db
      .query(
        "SELECT id as runId, workflow_id as workflowId, status, revision, input_json, created_at as createdAt, updated_at as updatedAt FROM runs ORDER BY created_at DESC",
      )
      .all() as Array<RunSummary & { input_json: string }>;
    return rows.map((row) => this.runSummary(row));
  }
  /** Ordinary list reads are bounded; full enumeration is reserved for recovery/diagnostics. */
  listRunsPage(limit = 100, offset = 0): RunSummary[] {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("invalid run page bounds");
    const rows = this.db
      .query(
        "SELECT id as runId, workflow_id as workflowId, status, revision, input_json, created_at as createdAt, updated_at as updatedAt FROM runs ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2",
      )
      .all(limit, offset) as Array<RunSummary & { input_json: string }>;
    return rows.map((row) => this.runSummary(row));
  }
  private runSummary(row: RunSummary & { input_json: string }): RunSummary {
    const input = parseJson<Record<string, unknown>>(row.input_json);
    const profile = input.__kouroExecutionProfile;
    const task = typeof input.task === "string" ? input.task : undefined;
    const workItem = input.workItem;
    const { input_json: _input, ...summary } = row;
    return {
      ...summary,
      ...(profile === "scripted" ||
      profile === "codex-readonly" ||
      profile === "codex-workspace-write" ||
      profile === "claude-readonly" ||
      profile === "claude-workspace-write" ||
      profile === "pi-readonly"
        ? { executionProfile: profile }
        : {}),
      ...(task ? { task } : {}),
      ...(workItem && typeof workItem === "object"
        ? { workItem: workItem as RunSummary["workItem"] }
        : {}),
    };
  }
  getView(runId: string): RunView | null {
    const value = this.db
      .query("SELECT view_json FROM run_projections WHERE run_id = ?1")
      .get(runId) as { view_json: string } | null;
    return value ? parseJson<RunView>(value.view_json) : null;
  }
  getRunRow(runId: string): RunRow | null {
    return this.db
      .query(
        "SELECT id as runId, workflow_id as workflowId, status, revision, bundle_json, input_json, created_at as createdAt, updated_at as updatedAt FROM runs WHERE id = ?1",
      )
      .get(runId) as RunRow | null;
  }

  getRunInput(runId: string): Record<string, unknown> | undefined {
    const row = this.getRunRow(runId);
    return row ? parseJson<Record<string, unknown>>(row.input_json) : undefined;
  }

  /** Persist an immutable checkpoint certificate. Repeating the same id is safe. */
  saveCheckpoint(certificate: CheckpointCertificate): CheckpointCertificate {
    const run = this.getRunRow(certificate.sourceRunId);
    if (!run) throw new Error(`Run not found: ${certificate.sourceRunId}`);
    return this.tx(() => {
      const prior = this.db
        .query("SELECT certificate_json, certificate_digest FROM checkpoints WHERE id = ?1")
        .get(certificate.checkpointId) as {
        certificate_json: string;
        certificate_digest: string;
      } | null;
      if (prior) {
        if (
          prior.certificate_digest !== certificate.certificateDigest ||
          canonicalize(parseJson<CheckpointCertificate>(prior.certificate_json)) !==
            canonicalize(certificate)
        )
          throw new Error("checkpoint id is immutable and already bound to different data");
        return parseJson<CheckpointCertificate>(prior.certificate_json);
      }
      this.db
        .query(
          "INSERT INTO checkpoints(id, source_run_id, source_revision, certificate_json, certificate_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .run(
          certificate.checkpointId,
          certificate.sourceRunId,
          certificate.sourceRevision,
          json(certificate),
          certificate.certificateDigest,
          now(),
        );
      return certificate;
    });
  }

  getCheckpoint(checkpointId: string): CheckpointCertificate | null {
    const row = this.db
      .query("SELECT certificate_json FROM checkpoints WHERE id = ?1")
      .get(checkpointId) as { certificate_json: string } | null;
    return row ? parseJson<CheckpointCertificate>(row.certificate_json) : null;
  }

  /** Record checkpoint capture/fork preparation exactly once by request key. */
  recordCheckpointOperation(input: {
    id: string;
    checkpointId: string;
    kind: "checkpoint.capture" | "fork.preparation";
    requestKey: string;
    record: Record<string, unknown>;
  }): {
    id: string;
    checkpointId: string;
    kind: string;
    requestKey: string;
    record: Record<string, unknown>;
  } {
    if (!this.getCheckpoint(input.checkpointId))
      throw new Error(`Checkpoint not found: ${input.checkpointId}`);
    return this.tx(() => {
      const prior = this.db
        .query(
          "SELECT id, checkpoint_id, kind, request_key, record_json FROM checkpoint_records WHERE request_key = ?1",
        )
        .get(input.requestKey) as {
        id: string;
        checkpoint_id: string;
        kind: string;
        request_key: string;
        record_json: string;
      } | null;
      if (prior) {
        if (
          prior.checkpoint_id !== input.checkpointId ||
          prior.kind !== input.kind ||
          canonicalize(parseJson(prior.record_json)) !== canonicalize(input.record)
        )
          throw new Error("checkpoint operation request key payload conflict");
        return {
          id: prior.id,
          checkpointId: prior.checkpoint_id,
          kind: prior.kind,
          requestKey: prior.request_key,
          record: parseJson<Record<string, unknown>>(prior.record_json),
        };
      }
      this.db
        .query(
          "INSERT INTO checkpoint_records(id, checkpoint_id, kind, request_key, record_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .run(input.id, input.checkpointId, input.kind, input.requestKey, json(input.record), now());
      return {
        id: input.id,
        checkpointId: input.checkpointId,
        kind: input.kind,
        requestKey: input.requestKey,
        record: input.record,
      };
    });
  }

  getCheckpointOperation(requestKey: string): {
    id: string;
    checkpointId: string;
    kind: string;
    requestKey: string;
    record: Record<string, unknown>;
  } | null {
    const row = this.db
      .query(
        "SELECT id, checkpoint_id, kind, request_key, record_json FROM checkpoint_records WHERE request_key = ?1",
      )
      .get(requestKey) as {
      id: string;
      checkpoint_id: string;
      kind: string;
      request_key: string;
      record_json: string;
    } | null;
    return row
      ? {
          id: row.id,
          checkpointId: row.checkpoint_id,
          kind: row.kind,
          requestKey: row.request_key,
          record: parseJson<Record<string, unknown>>(row.record_json),
        }
      : null;
  }

  listCheckpointOperations(
    checkpointId: string,
    kind?: string,
  ): Array<{
    id: string;
    checkpointId: string;
    kind: string;
    requestKey: string;
    record: Record<string, unknown>;
  }> {
    const rows = this.db
      .query(
        "SELECT id, checkpoint_id, kind, request_key, record_json FROM checkpoint_records WHERE checkpoint_id = ?1 ORDER BY created_at, id",
      )
      .all(checkpointId) as Array<{
      id: string;
      checkpoint_id: string;
      kind: string;
      request_key: string;
      record_json: string;
    }>;
    return rows
      .filter((row) => !kind || row.kind === kind)
      .map((row) => ({
        id: row.id,
        checkpointId: row.checkpoint_id,
        kind: row.kind,
        requestKey: row.request_key,
        record: parseJson<Record<string, unknown>>(row.record_json),
      }));
  }
  getBundle(runId: string): Bundle | null {
    const row = this.getRunRow(runId);
    return row ? parseJson<Bundle>(row.bundle_json) : null;
  }
  getEvents(runId: string, after = 0, limit = 500): LifecycleEvent[] {
    const rows = this.db
      .query(
        "SELECT event_id as eventId, run_id as runId, sequence, schema_version as schemaVersion, type, recorded_at as recordedAt, actor, causation_id as causationId, payload_json FROM run_events WHERE run_id = ?1 AND sequence > ?2 ORDER BY sequence LIMIT ?3",
      )
      .all(runId, after, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      schemaVersion: 1,
      payload: parseJson<Record<string, unknown>>(String(row.payload_json)),
    })) as unknown as LifecycleEvent[];
  }
  getFrames(runId: string, after = 0, limit = 500): ProjectionFrame[] {
    const rows = this.db
      .query(
        "SELECT frame_json FROM projection_frames WHERE run_id = ?1 AND revision > ?2 ORDER BY revision LIMIT ?3",
      )
      .all(runId, after, limit) as Array<{ frame_json: string }>;
    return rows.map((row) => parseJson<ProjectionFrame>(row.frame_json));
  }
  getArtifact(refId: string): StoredArtifact | null {
    return this.db
      .query(
        "SELECT id, run_id as runId, digest, media_type as mediaType, byte_length as byteLength, created_at as createdAt FROM artifacts WHERE id = ?1",
      )
      .get(refId) as StoredArtifact | null;
  }
  hasArtifactDigest(digest: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM artifacts WHERE digest = ?1 LIMIT 1").get(digest));
  }

  /** Persist evaluator output separately from the run projection. Repeating an
   * evidence id is idempotent, while a changed payload is a conflict. */
  recordEvaluationEvidence(
    evidence: EvaluationEvidence,
    association?: { experimentId?: string; cellKey?: string },
  ): EvaluationEvidence {
    const run = this.getRunRow(evidence.target.runId);
    if (!run) throw new Error(`Run not found: ${evidence.target.runId}`);
    if (
      !Number.isSafeInteger(evidence.target.revision) ||
      evidence.target.revision < 0 ||
      evidence.target.revision > run.revision
    )
      throw new Error("Evidence target revision is not a retained run revision");
    const payload = json(evidence);
    const prior = this.db
      .query("SELECT payload_json FROM evaluation_evidence WHERE evidence_id = ?1")
      .get(evidence.id) as { payload_json: string } | null;
    if (prior) {
      if (prior.payload_json !== payload)
        throw new Error(`Evidence ${evidence.id} payload conflict`);
      return parseJson<EvaluationEvidence>(prior.payload_json);
    }
    this.tx(() => {
      this.db
        .query(
          "INSERT INTO evaluation_evidence(evidence_id, run_id, revision, tree_digest, evaluator_id, evaluator_version, evidence_class, status, experiment_id, cell_key, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )
        .run(
          evidence.id,
          evidence.target.runId,
          evidence.target.revision,
          evidence.target.treeDigest ?? null,
          evidence.evaluatorId,
          evidence.evaluatorVersion,
          evidence.evidenceClass,
          evidence.status,
          association?.experimentId ?? null,
          association?.cellKey ?? null,
          payload,
          evidence.recordedAt,
        );
    });
    return evidence;
  }

  getEvaluationEvidence(
    runId: string,
    options?: { revision?: number; evaluatorId?: string; experimentId?: string; cellKey?: string },
  ): EvaluationEvidence[] {
    const clauses = ["run_id = ?1"];
    const values: (string | number)[] = [runId];
    if (options?.revision !== undefined) {
      clauses.push(`revision = ?${values.length + 1}`);
      values.push(options.revision);
    }
    if (options?.evaluatorId !== undefined) {
      clauses.push(`evaluator_id = ?${values.length + 1}`);
      values.push(options.evaluatorId);
    }
    if (options?.experimentId !== undefined) {
      clauses.push(`experiment_id = ?${values.length + 1}`);
      values.push(options.experimentId);
    }
    if (options?.cellKey !== undefined) {
      clauses.push(`cell_key = ?${values.length + 1}`);
      values.push(options.cellKey);
    }
    const rows = this.db
      .query(
        `SELECT payload_json FROM evaluation_evidence WHERE ${clauses.join(" AND ")} ORDER BY revision, evidence_id`,
      )
      .all(...values) as Array<{ payload_json: string }>;
    return rows.map((row) => parseJson<EvaluationEvidence>(row.payload_json));
  }
  getEffect(effectId: string): {
    id: string;
    runId: string;
    attemptId: string;
    operationKey: string;
    state: string;
    payload: Record<string, unknown>;
  } | null {
    const row = this.db
      .query(
        "SELECT id, run_id as runId, attempt_id as attemptId, operation_key as operationKey, state, payload_json FROM effects WHERE id = ?1",
      )
      .get(effectId) as {
      id: string;
      runId: string;
      attemptId: string;
      operationKey: string;
      state: string;
      payload_json: string;
    } | null;
    return row
      ? {
          id: row.id,
          runId: row.runId,
          attemptId: row.attemptId,
          operationKey: row.operationKey,
          state: row.state,
          payload: parseJson<Record<string, unknown>>(row.payload_json),
        }
      : null;
  }
  unresolvedEffects(): Array<{ id: string; runId: string; state: string }> {
    return this.db
      .query(
        "SELECT id, run_id as runId, state FROM effects WHERE state IN ('reserved', 'claimed') ORDER BY created_at",
      )
      .all() as Array<{ id: string; runId: string; state: string }>;
  }
  checkpointEffects(runId: string): Array<{ id: string; state: string }> {
    return this.db
      .query("SELECT id, state FROM effects WHERE run_id = ?1 ORDER BY created_at, id")
      .all(runId) as Array<{ id: string; state: string }>;
  }
  checkpointOutbox(runId: string): Array<{ id: string; state: string }> {
    return this.db
      .query(
        "SELECT o.effect_id as id, o.state FROM outbox o JOIN effects e ON e.id = o.effect_id WHERE e.run_id = ?1 ORDER BY o.effect_id",
      )
      .all(runId) as Array<{ id: string; state: string }>;
  }
  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(runId);
    };
  }
  async *stream(
    runId: string,
    after: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ProjectionFrame> {
    let cursor = after;
    while (!signal?.aborted) {
      const frames = this.getFrames(runId, cursor);
      if (frames.length) {
        for (const frame of frames) {
          cursor = frame.revision;
          yield frame;
        }
        continue;
      }
      let wake: (() => void) | undefined;
      const wait = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const unsubscribe = this.subscribe(runId, () => wake?.());
      const reread = this.getFrames(runId, cursor);
      if (reread.length) {
        unsubscribe();
        for (const frame of reread) {
          cursor = frame.revision;
          yield frame;
        }
        continue;
      }
      const abort = () => wake?.();
      signal?.addEventListener("abort", abort, { once: true });
      await Promise.race([wait, Bun.sleep(15_000)]);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (signal?.aborted) break;
      if (!this.getFrames(runId, cursor).length)
        yield {
          projectionVersion: 1,
          runId,
          baseRevision: cursor,
          revision: cursor,
          eventCursor: cursor,
          state: this.getView(runId)?.state ?? createInitialState(runId),
        };
    }
  }

  private updateEntityTables(event: LifecycleEvent, bundle: Bundle): void {
    if (event.type === "invocation.created") {
      const definition = bundle.definitions[bundle.rootDefinitionId];
      const kind =
        definition?.nodes.find((node) => node.id === event.payload.nodeId)?.kind ?? "unknown";
      this.db
        .query(
          "INSERT INTO invocations(id, run_id, node_id, kind, ordinal, state, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, NULL)",
        )
        .run(
          event.payload.invocationId,
          event.runId,
          event.payload.nodeId,
          kind,
          event.payload.activationOrdinal ?? 0,
        );
      return;
    }
    if (event.type === "attempt.started") {
      this.db
        .query("UPDATE attempts SET state = 'running', started_at = ?1 WHERE id = ?2")
        .run(event.recordedAt, event.payload.attemptId);
      const row = this.db
        .query("SELECT invocation_id as invocationId FROM attempts WHERE id = ?1")
        .get(event.payload.attemptId) as { invocationId: string } | null;
      if (row)
        this.db
          .query(
            "UPDATE invocations SET state = 'running', started_at = COALESCE(started_at, ?1) WHERE id = ?2",
          )
          .run(event.recordedAt, row.invocationId);
      return;
    }
    if (event.type === "attempt.completed") {
      this.db
        .query("UPDATE attempts SET state = ?1, ended_at = ?2, error = ?3 WHERE id = ?4")
        .run(
          event.payload.status,
          event.recordedAt,
          event.payload.error ?? null,
          event.payload.attemptId,
        );
      return;
    }
    if (event.type === "invocation.completed") {
      this.db
        .query(
          "UPDATE invocations SET state = ?1, ended_at = ?2, output_artifact_ids_json = ?3, error = ?4 WHERE id = ?5",
        )
        .run(
          event.payload.status,
          event.recordedAt,
          json((event.payload.output ?? []).map((ref) => ref.id)),
          event.payload.error ?? null,
          event.payload.invocationId,
        );
    }
  }

  private projectionJson(runId: string): string {
    const row = this.db
      .query("SELECT view_json FROM run_projections WHERE run_id = ?1")
      .get(runId) as { view_json: string } | null;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return row.view_json;
  }
}

export type { StoredArtifact };
