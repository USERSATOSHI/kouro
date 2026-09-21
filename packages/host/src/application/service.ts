import {
  WorkflowBuilder,
  artifactType,
  compileWorkflow,
  canonicalize,
  sha256Hex,
  renderPromptFixture,
} from "@kouro/core";
import type { Bundle, WorkflowDefinitionSource } from "@kouro/core";
import type { PromptFixture } from "@kouro/core";
import type { CheckpointInput, CheckpointEligibility, CheckpointCertificate } from "@kouro/core";
import { Coordinator, type CoordinatorOptions } from "../coordinator/coordinator.ts";
import { GitWorkspaceAdapter } from "../adapters/workspace/git.ts";
import type { ExecutionProfileId, ExecutionProfileSummary, RunSummary } from "../types.ts";
import type { EvaluationEvidence } from "@kouro/core";
import { ExperimentService } from "../evaluations.ts";
import { CollaborationGateway } from "../collaboration/gateway.ts";
import {
  CheckpointMaterializer,
  CheckpointRetention,
  type CapturedCheckpoint,
  type MaterializedFork,
} from "../checkpoints/index.ts";
import type { WorkspaceRef } from "../adapters/workspace/git.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  blindedDto,
  buildComparisonTimeline,
  type ComparisonAnchor,
  type ComparisonRunRef,
  type PairwiseChoice,
  type BlindedPairwiseDto,
  type PairwiseAssignment,
  type PairwiseDecision,
  type RunComparisonRecord,
  type ComparisonTimelineDto,
  type ComparisonNodeSpan,
} from "@kouro/core";

export interface WorkflowCatalogEntry {
  id: string;
  name: string;
  version: string;
  digest: string;
  graph: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  bundle: Bundle;
  validation: { valid: true };
}

interface FileTemplate {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly bundle: Bundle;
}

export class ApplicationService {
  readonly coordinator: Coordinator;
  readonly experiments: ExperimentService;
  readonly checkpoints?: CheckpointMaterializer;
  private readonly checkpointRetention: CheckpointRetention;
  private readonly bundles = new Map<string, Bundle>();
  private readonly templateRoot: string;
  private tinyPromise?: Promise<Bundle>;
  private featurePromise?: Promise<Bundle>;
  private parallelPromise?: Promise<Bundle>;
  private fileTemplatePromise?: Promise<readonly FileTemplate[]>;

  constructor(
    options: CoordinatorOptions & {
      workspaceAdapter?: GitWorkspaceAdapter | null;
      templateRoot?: string;
    },
  ) {
    this.templateRoot = options.templateRoot ?? resolve(process.cwd(), ".kouro");
    const workspaceAdapter =
      options.workspaceAdapter === null
        ? undefined
        : (options.workspaceAdapter ??
          new GitWorkspaceAdapter({ worktreeRoot: `${options.dataDir}/worktrees` }));
    this.coordinator = new Coordinator({ ...options, workspaceAdapter });
    this.checkpointRetention = new CheckpointRetention(options.dataDir);
    // SQLite certificates are authoritative. A crash after certificate commit
    // but before writing the auxiliary mark file must not make a retained tree
    // appear safe to delete on the next host start.
    const retained = this.coordinator.journal.db
      .query("SELECT certificate_json FROM checkpoints")
      .all() as Array<{ certificate_json: string }>;
    this.checkpointRetention.reconcile(
      retained.map(({ certificate_json }) => {
        const certificate = JSON.parse(certificate_json) as CheckpointCertificate;
        return {
          checkpointId: certificate.checkpointId,
          roots: [...certificate.retainedTreeRoots, ...certificate.retainedArtifactRoots],
        };
      }),
    );
    this.checkpoints = workspaceAdapter
      ? new CheckpointMaterializer({
          journal: this.coordinator.journal,
          workspace: workspaceAdapter,
        })
      : undefined;
    this.experiments = new ExperimentService(this);
  }

  async start(): Promise<void> {
    await this.tiny();
    await this.feature();
    await this.parallel();
    await this.fileTemplates();
    await this.coordinator.start();
  }
  close(): Promise<void> {
    return this.coordinator.close();
  }

  async tiny(): Promise<Bundle> {
    if (!this.tinyPromise) this.tinyPromise = compileTiny();
    const bundle = await this.tinyPromise;
    this.bundles.set("tiny", bundle);
    return bundle;
  }

  async feature(): Promise<Bundle> {
    if (!this.featurePromise) this.featurePromise = compileFeature();
    const bundle = await this.featurePromise;
    this.bundles.set("feature", bundle);
    return bundle;
  }

  async parallel(): Promise<Bundle> {
    if (!this.parallelPromise) this.parallelPromise = compileParallelFixture();
    const bundle = await this.parallelPromise;
    this.bundles.set("parallel", bundle);
    return bundle;
  }

  async fileTemplates(): Promise<readonly FileTemplate[]> {
    if (!this.fileTemplatePromise) this.fileTemplatePromise = loadFileTemplates(this.templateRoot);
    const templates = await this.fileTemplatePromise;
    for (const template of templates) this.bundles.set(template.id, template.bundle);
    return templates;
  }

  saveComparison(input: {
    id?: string;
    runs: readonly ComparisonRunRef[];
    anchors: readonly ComparisonAnchor[];
    evidenceRevision: number;
  }): RunComparisonRecord {
    return this.coordinator.journal.saveComparison({
      ...input,
      id: input.id ?? `cmp_${randomUUID().replaceAll("-", "")}`,
    });
  }

  comparison(id: string): RunComparisonRecord | undefined {
    return this.coordinator.journal.getComparison(id);
  }

  comparisonTimeline(id: string): ComparisonTimelineDto {
    const comparison = this.comparison(id);
    if (!comparison) throw new Error("comparison not found");
    const spans: ComparisonNodeSpan[] = [];
    for (const run of comparison.runs) {
      const view = this.getView(run.runId);
      if (!view) throw new Error(`comparison run not found: ${run.runId}`);
      for (const invocation of Object.values(view.state.invocations)) {
        if (invocation.startedAt || invocation.completedAt)
          spans.push({
            runId: run.runId,
            nodeKey: invocation.nodeId,
            label: invocation.nodeId,
            startAt: invocation.startedAt,
            endAt: invocation.completedAt,
            status: invocation.status,
          });
        for (const attempt of Object.values(view.state.attempts).filter(
          (candidate) => candidate.invocationId === invocation.id,
        )) {
          if (attempt.startedAt || attempt.finishedAt)
            spans.push({
              runId: run.runId,
              nodeKey: `${invocation.nodeId}#attempt:${attempt.ordinal}`,
              label: `${invocation.nodeId} attempt ${attempt.ordinal + 1}`,
              startAt: attempt.startedAt,
              endAt: attempt.finishedAt,
              status: attempt.status,
              attempt: attempt.ordinal,
            });
        }
      }
    }
    return buildComparisonTimeline(comparison, spans);
  }

  private blindedEvidence(run: ComparisonRunRef): {
    evidence: readonly unknown[];
    risks: readonly string[];
  } {
    const view = this.getView(run.runId);
    if (!view) throw new Error(`comparison run not found: ${run.runId}`);
    const evidence = Object.values(view.state.invocations).map((invocation) => ({
      kind: "execution",
      node: invocation.nodeId,
      status: invocation.status,
      outcome: invocation.outcome,
    }));
    const risks = [
      "artifact names and source paths are omitted",
      "model, harness, provider, workflow, and run identity are omitted",
      "diff content may still contain self-identifying text",
    ];
    return { evidence, risks };
  }

  createPairwise(input: {
    comparisonId: string;
    eligibleActor: string;
    rubric: unknown;
    evidenceRevision: number;
    evidenceA?: readonly unknown[];
    evidenceB?: readonly unknown[];
    leakageRisk?: readonly string[];
  }): BlindedPairwiseDto {
    const comparison = this.comparison(input.comparisonId);
    if (!comparison || comparison.runs.length !== 2)
      throw new Error("pairwise review requires a two-run comparison");
    const [first, second] = comparison.runs;
    if (!first || !second) throw new Error("pairwise runs missing");
    const flip = randomBytes(1)[0]! % 2 === 1;
    const sanitizedA = this.blindedEvidence(first);
    const sanitizedB = this.blindedEvidence(second);
    const assignment = this.coordinator.journal.createPairwiseAssignment({
      id: `pair_${randomUUID().replaceAll("-", "")}`,
      comparisonId: input.comparisonId,
      runA: first,
      runB: second,
      sideA: flip ? "side-redacted-1" : "side-redacted-2",
      sideB: flip ? "side-redacted-2" : "side-redacted-1",
      rubric: input.rubric,
      eligibleActor: input.eligibleActor,
      evidenceRevision: input.evidenceRevision,
      evidenceA: flip ? sanitizedB.evidence : sanitizedA.evidence,
      evidenceB: flip ? sanitizedA.evidence : sanitizedB.evidence,
      leakageRisk: [...new Set([...sanitizedA.risks, ...sanitizedB.risks])],
    });
    return blindedDto(assignment, this.coordinator.journal.pairwiseEvidence(assignment.id), false);
  }

  pairwise(
    id: string,
    actor: string,
  ): BlindedPairwiseDto | { assignment: PairwiseAssignment; decision: PairwiseDecision } {
    const assignment = this.coordinator.journal.getPairwiseAssignment(id);
    if (!assignment) throw new Error("pairwise assignment not found");
    if (assignment.eligibleActor !== actor)
      throw new Error("actor is not eligible for this pairwise assignment");
    const decision = this.coordinator.journal.latestPairwiseDecision(id);
    if (!decision)
      return blindedDto(assignment, this.coordinator.journal.pairwiseEvidence(id), false);
    return { assignment, decision };
  }

  decidePairwise(input: {
    assignmentId: string;
    actor: string;
    choice: PairwiseChoice;
    reason?: string;
    idempotencyKey: string;
    correctionOf?: string;
  }): PairwiseDecision {
    return this.coordinator.journal.pairwiseDecision(input);
  }

  async workflows(): Promise<WorkflowCatalogEntry[]> {
    const entries = [
      { id: "tiny", name: "Tiny walking skeleton", version: "2", bundle: await this.tiny() },
      {
        id: "feature",
        name: "Feature development loop",
        version: "2",
        bundle: await this.feature(),
      },
      {
        id: "parallel",
        name: "Nested parallel fixture",
        version: "2",
        bundle: await this.parallel(),
      },
      ...(await this.fileTemplates()).map((template) => ({
        id: template.id,
        name: template.name,
        version: template.version,
        bundle: template.bundle,
      })),
    ];
    return entries.map(({ id, name, version, bundle }) => {
      const definition = bundle.definitions[bundle.rootDefinitionId];
      const ranks = new Map<string, number>([[definition.entry, 0]]);
      const queue = [definition.entry];
      while (queue.length) {
        const source = queue.shift()!;
        const nextRank = (ranks.get(source) ?? 0) + 1;
        for (const edge of definition.controlEdges.filter(
          (candidate) => candidate.sourceNodeId === source,
        )) {
          // The catalog is a projection, not a critical-path calculation.  Keep
          // the first deterministic rank so bounded repair back-edges cannot
          // make this traversal diverge forever.
          if (!ranks.has(edge.targetNodeId)) {
            ranks.set(edge.targetNodeId, nextRank);
            queue.push(edge.targetNodeId);
          }
        }
      }
      return {
        id,
        name,
        version,
        digest: bundle.digest,
        graph: {
          nodes: Object.values(bundle.definitions).flatMap((childDefinition) =>
            childDefinition.nodes.map((node) => ({
              id: node.id,
              kind: node.kind,
              label: node.id,
              role: node.kind === "agent" ? node.role : undefined,
              harness: node.kind === "agent" ? node.harness : undefined,
              modelId: node.kind === "agent" ? node.modelId : undefined,
              definitionId: childDefinition.id,
              scopeId:
                childDefinition.id === bundle.rootDefinitionId ? undefined : childDefinition.id,
              position: { x: 60 + (ranks.get(node.id) ?? 0) * 250, y: 80 },
            })),
          ),
          edges: Object.values(bundle.definitions).flatMap((childDefinition) =>
            childDefinition.controlEdges.map((edge) => ({
              id: `${childDefinition.id}:${edge.id}`,
              source: edge.sourceNodeId,
              target: edge.targetNodeId,
              definitionId: childDefinition.id,
              outcome: edge.outcome,
              label: edge.id.endsWith(":repair")
                ? `${edge.outcome} · repair`
                : edge.id.endsWith(":repair-exhausted")
                  ? `${edge.outcome} · exhausted`
                  : edge.outcome,
            })),
          ),
          groups: Object.values(bundle.definitions).map((childDefinition) => ({
            id: childDefinition.id,
            label: childDefinition.id,
            definitionId: childDefinition.id,
          })),
        },
        bundle,
        validation: { valid: true },
      };
    });
  }

  /** Profiles are policy presets; they never alter the compiled workflow bundle. */
  executionProfiles(): ExecutionProfileSummary[] {
    const scripted = this.coordinator.harness.capabilities();
    const profileHost = this.coordinator as unknown as {
      availableProfiles?: string[];
      profileCapabilities?: (id: string) => ExecutionProfileSummary["capabilities"];
    };
    const codexAvailable =
      profileHost.availableProfiles?.includes("codex-readonly") ?? Boolean(Bun.which("codex"));
    const codexCapabilities =
      profileHost.profileCapabilities?.("codex-readonly") ??
      ({
        "structured-output": codexAvailable ? "supported" : "unsupported",
        cancel: codexAvailable ? "supported" : "unsupported",
        reattach: "unsupported",
        tools: "conditional",
        usage: codexAvailable ? "supported" : "unsupported",
        "cost-cap": "unsupported",
      } as const);
    const piAvailable =
      profileHost.availableProfiles?.includes("pi-readonly") ?? Boolean(Bun.which("pi"));
    return [
      {
        id: "scripted",
        name: "Scripted fixture",
        description: "Deterministic local harness for development and tests.",
        available: true,
        harness: "scripted",
        capabilities: scripted as ExecutionProfileSummary["capabilities"],
      },
      {
        id: "codex-readonly",
        name: "Codex · read-only",
        description: "Run the agent through the local Codex CLI without workspace writes.",
        available: codexAvailable,
        harness: "codex",
        capabilities: codexCapabilities,
        unavailableReason: codexAvailable ? undefined : "codex CLI is not available on this host",
      },
      {
        id: "pi-readonly",
        name: "Pi · read-only RPC",
        description:
          "Run the installed Pi CLI through its native RPC protocol with read-only tools.",
        available: piAvailable,
        harness: "pi",
        capabilities: piAvailable
          ? {
              "structured-output": "supported",
              cancel: "supported",
              resume: "unsupported",
              reattach: "unsupported",
              tools: "conditional",
              usage: "supported",
              "cost-cap": "unsupported",
            }
          : {
              "structured-output": "unsupported",
              cancel: "unsupported",
              resume: "unsupported",
              reattach: "unsupported",
              tools: "unsupported",
              usage: "unsupported",
              "cost-cap": "unsupported",
            },
        unavailableReason: piAvailable ? undefined : "pi CLI is not available on this host",
      },
    ];
  }

  async createRun(input: {
    workflowId: string;
    idempotencyKey: string;
    actor?: string;
    input?: Record<string, unknown>;
    executionProfile?: ExecutionProfileId;
    workspace?: { repositoryPath: string; workspaceId?: string };
  }): Promise<RunSummary> {
    const bundle = this.bundles.get(input.workflowId);
    if (!bundle) throw new Error(`Unknown workflow ${input.workflowId}`);
    return (await this.coordinator.createRun({ ...input, bundle })).run;
  }
  /** A playground execution is an ordinary journaled run of a tiny compiled workflow. */
  async runPromptFixture(input: {
    fixture: PromptFixture;
    idempotencyKey: string;
    executionProfile?: ExecutionProfileId;
  }): Promise<RunSummary> {
    const rendered = await renderPromptFixture(input.fixture);
    if (!rendered.valid || !rendered.rendered)
      throw new Error(rendered.errors.join("; ") || "invalid prompt fixture");
    const workflowId = `prompt-fixture-${rendered.digest.slice(7, 19)}`;
    const builder = new WorkflowBuilder({ id: workflowId, version: "1" });
    const agent = builder.agent("prompt", { role: "prompt-fixture", prompt: rendered.rendered });
    const done = builder.complete("done");
    builder.startAt(agent);
    builder.sequence(agent, done);
    const bundle = await compileWorkflow(builder.build());
    return (
      await this.coordinator.createRun({
        workflowId,
        bundle,
        idempotencyKey: input.idempotencyKey,
        executionProfile: input.executionProfile ?? "scripted",
        input: {
          __kouroPromptFixture: {
            id: input.fixture.id,
            version: input.fixture.version ?? null,
            digest: rendered.digest,
          },
        },
      })
    ).run;
  }
  async bundle(workflowId: string): Promise<Bundle> {
    if (workflowId === "tiny") return this.tiny();
    if (workflowId === "feature") return this.feature();
    if (workflowId === "parallel") return this.parallel();
    const template = (await this.fileTemplates()).find((entry) => entry.id === workflowId);
    if (template) return template.bundle;
    throw new Error(`Unknown workflow ${workflowId}`);
  }
  decideApproval(input: {
    runId: string;
    invocationId: string;
    decision: "approved" | "rejected";
    expectedRevision: number;
    actor: string;
    idempotencyKey: string;
    bindingDigest?: string;
    subjectRevision?: number;
  }) {
    return this.coordinator.decideApproval(input);
  }
  control(input: {
    runId: string;
    action: "pause" | "resume" | "cancel" | "interrupt" | "detach";
    expectedRevision: number;
    actor: string;
    idempotencyKey: string;
  }) {
    return this.coordinator.control(input);
  }
  retry(input: {
    runId: string;
    invocationId: string;
    expectedRevision: number;
    actor: string;
    idempotencyKey: string;
  }) {
    return this.coordinator.retry(input);
  }
  listRuns(): RunSummary[] {
    return this.coordinator.journal.listRuns();
  }
  listRunsPage(limit = 100, offset = 0): RunSummary[] {
    return this.coordinator.journal.listRunsPage(limit, offset);
  }
  collaboration(runId: string): Record<string, unknown> {
    return new CollaborationGateway(this.coordinator.journal).snapshot(runId);
  }
  scouts(runId: string) {
    return this.coordinator.scouts.requests(runId);
  }
  getView(runId: string) {
    return this.coordinator.journal.getView(runId);
  }
  getEvents(runId: string, after?: number) {
    return this.coordinator.journal.getEvents(runId, after);
  }
  recordEvaluationEvidence(
    evidence: EvaluationEvidence,
    association?: { experimentId?: string; cellKey?: string },
  ) {
    return this.coordinator.journal.recordEvaluationEvidence(evidence, association);
  }
  getEvaluationEvidence(
    runId: string,
    options?: { revision?: number; evaluatorId?: string; experimentId?: string; cellKey?: string },
  ) {
    return this.coordinator.journal.getEvaluationEvidence(runId, options);
  }
  stream(runId: string, after: number, signal?: AbortSignal) {
    return this.coordinator.journal.stream(runId, after, signal);
  }
  artifact(refId: string) {
    return this.coordinator.journal.getArtifact(refId);
  }
  readArtifact(refId: string): Uint8Array {
    const ref = this.artifact(refId);
    if (!ref?.digest) throw new Error("Artifact not found");
    return this.coordinator.journal.blobs.read(ref);
  }
  workspaceSnapshot(runId: string) {
    return this.coordinator.workspaceSnapshot(runId);
  }
  workspacePath(runId: string) {
    return this.coordinator.workspacePath(runId);
  }

  workspaceIntegrate(input: {
    runId: string;
    targetInvocationId?: string;
    sourceInvocationIds: readonly string[];
  }) {
    return this.coordinator.workspaceIntegrate(input);
  }
  workspaceDiff(runId: string) {
    return this.coordinator.workspaceDiff(runId);
  }
  workspaceCommit(input: {
    runId: string;
    expectedTree: string;
    operationKey: string;
    message: string;
    deliveryActionId?: string;
  }) {
    return this.coordinator.workspaceCommit(input);
  }
  prepareDelivery(input: {
    runId: string;
    requestKey: string;
    message: string;
    invocationId?: string;
    validationEvidence?: readonly string[];
    reviewEvidence?: readonly string[];
  }) {
    return this.coordinator.prepareDelivery(input);
  }
  decideDelivery(input: { actionId: string; decision: "approved" | "rejected"; actor: string }) {
    return this.coordinator.decideDelivery(input);
  }
  deliveryAction(actionId: string) {
    return this.coordinator.deliveryAction(actionId);
  }
  async cleanupWorkspace(runId: string): Promise<void> {
    // Checkpoint roots are immutable retention claims. Cleanup must consult the
    // same mark set used by capture/fork, otherwise an operator could delete
    // the only retained tree and leave a certificate that cannot be forked.
    const captures = this.coordinator.journal.listRuns().some((run) => run.runId === runId)
      ? (this.coordinator.journal.db
          .query("SELECT certificate_json FROM checkpoints WHERE source_run_id = ?1")
          .all(runId) as Array<{ certificate_json: string }>)
      : [];
    const roots = captures.flatMap((row) => {
      const certificate = JSON.parse(row.certificate_json) as {
        retainedTreeRoots?: string[];
        retainedArtifactRoots?: string[];
      };
      return [
        ...(certificate.retainedTreeRoots ?? []),
        ...(certificate.retainedArtifactRoots ?? []),
      ];
    });
    this.checkpointRetention.assertCleanupAllowed(roots);
    await this.coordinator.cleanupWorkspace(runId);
  }

  private async checkpointInput(
    runId: string,
  ): Promise<{ input: CheckpointInput; workspace: WorkspaceRef | null }> {
    const view = this.getView(runId);
    const row = this.coordinator.journal.getRunRow(runId);
    if (!view || !row) throw new Error(`Run not found: ${runId}`);
    const workspace = this.coordinator.checkpointWorkspace(runId);
    const snapshot = workspace ? await this.coordinator.workspaceSnapshot(runId) : null;
    const runInput = this.coordinator.journal.getRunInput(runId) ?? {};
    const configDependencyDigest = `sha256:${await sha256Hex(canonicalize({ input: runInput, profile: runInput.__kouroExecutionProfile ?? "scripted" }))}`;
    const artifacts = [
      ...Object.values(view.state.invocations).flatMap((item) => [
        ...item.output,
        ...item.evidence,
        ...item.artifacts,
      ]),
      ...Object.values(view.state.attempts).flatMap((item) => [
        ...item.output,
        ...item.evidence,
        ...item.artifacts,
      ]),
    ];
    const roots = [
      ...new Set(
        artifacts.map((item) => item.digest).filter((item): item is string => Boolean(item)),
      ),
    ].sort();
    const completedInvocationIds = Object.values(view.state.invocations)
      .filter((item) => item.status === "succeeded")
      .map((item) => item.id);
    const pendingFrontier = Object.values(view.state.invocations)
      .filter((item) => ["pending", "reserved"].includes(item.status))
      .map((item) => ({ invocationId: item.id, nodeId: item.nodeId }));
    const input: CheckpointInput = {
      runId,
      revision: view.revision,
      eventCursor: view.revision,
      status: view.state.status as CheckpointInput["status"],
      admissionPaused: view.state.status === "paused",
      bundleDigest: row
        ? (this.coordinator.journal.getBundle(runId)?.digest ?? row.bundle_json)
        : "",
      configDependencyDigest,
      effects: this.coordinator.journal.checkpointEffects(runId) as CheckpointInput["effects"],
      outbox: this.coordinator.journal.checkpointOutbox(runId) as CheckpointInput["outbox"],
      writers: this.coordinator.checkpointWriters(runId),
      unsupportedNestedInvocationIds: Object.values(view.state.invocations)
        .filter((invocation) => invocation.scopeId !== view.state.rootScopeId)
        .map((invocation) => invocation.id),
      artifacts: {
        verified: roots.every((root) => this.coordinator.journal.hasArtifactDigest(root)),
        roots,
      },
      workspace: {
        verified: Boolean(snapshot),
        treeDigest: snapshot?.resultTree ?? "",
        roots: snapshot ? [snapshot.resultTree] : [],
      },
      completedInvocationIds,
      counters: view.state.counters,
      attemptsSpent: Object.keys(view.state.attempts).length,
      pendingFrontier,
      approvals: Object.values(view.state.approvals),
    };
    return { input, workspace };
  }

  async checkpointEligibility(runId: string): Promise<{
    eligibility: CheckpointEligibility;
    predicates: Array<{ id: string; label: string; satisfied: boolean; detail: string }>;
  }> {
    const { input } = await this.checkpointInput(runId);
    const { evaluateCheckpointEligibility } = await import("@kouro/core");
    const eligibility = evaluateCheckpointEligibility(input);
    const blocked = new Set(eligibility.reasons);
    const labels: Record<string, string> = {
      "admission-not-paused": "Admission is paused",
      "run-not-paused": "Run is paused",
      "active-effect": "No effect is active",
      "reserved-effect": "No effect is reserved",
      "claimed-effect": "No effect is claimed",
      "active-outbox": "Outbox is drained",
      "effect-writer": "No effect writer is active",
      "live-session-lease": "No live provider session lease remains",
      "unverified-artifacts": "Artifact closure is verified",
      "unverified-workspace": "Workspace is verified",
      "missing-workspace-tree": "Workspace tree is retained",
      "recovery-required": "Run does not require recovery",
      "unresolved-reconciliation": "External effects are reconciled",
      "invalid-revision": "Revision is valid",
      "unsupported-nested-scope": "Nested invocation reuse is supported",
      "unknown-effect": "Effect state is known",
      "unknown-outbox": "Outbox state is known",
    };
    const predicates = Object.keys(labels).map((id) => ({
      id,
      label: labels[id]!,
      satisfied: !blocked.has(id as never),
      detail: blocked.has(id as never) ? `Blocked by ${id}` : "Satisfied",
    }));
    return { eligibility, predicates };
  }

  async captureCheckpoint(
    runId: string,
    request?: {
      checkpointId?: string;
      expectedRevision?: number;
      actor?: string;
      idempotencyKey?: string;
    },
  ): Promise<CapturedCheckpoint> {
    if (!this.checkpoints) throw new Error("checkpoint workspace adapter is not configured");
    const view = this.getView(runId);
    if (!view) throw new Error(`Run not found: ${runId}`);
    if (view.state.status !== "paused")
      this.control({
        runId,
        action: "pause",
        expectedRevision: request?.expectedRevision ?? view.revision,
        actor: request?.actor ?? "local-operator",
        idempotencyKey: request?.idempotencyKey ?? `checkpoint-pause:${runId}:${view.revision}`,
      });
    await this.coordinator.waitForCheckpointDrain(runId);
    const { input, workspace } = await this.checkpointInput(runId);
    if (!workspace) throw new Error("checkpoint workspace is unavailable");
    // A caller's request key must determine the certificate identity even if
    // capture stops after saving the certificate but before recording the
    // operation. The materializer derives that stable ID when none is pinned.
    const requestKey = request?.idempotencyKey ?? `checkpoint:${randomUUID()}`;
    const captured = await this.checkpoints.capture({
      checkpoint: input,
      ...(request?.checkpointId ? { checkpointId: request.checkpointId } : {}),
      requestKey,
      workspace,
    });
    this.checkpointRetention.retain(captured.certificate.checkpointId, [
      ...captured.certificate.retainedTreeRoots,
      ...captured.certificate.retainedArtifactRoots,
    ]);
    return captured;
  }

  async forkCheckpoint(
    input: Parameters<CheckpointMaterializer["fork"]>[0],
  ): Promise<readonly MaterializedFork[]> {
    if (!this.checkpoints) throw new Error("checkpoint workspace adapter is not configured");
    const certificate = this.coordinator.journal.getCheckpoint(input.checkpointId);
    if (!certificate) throw new Error(`Checkpoint not found: ${input.checkpointId}`);
    const current = await this.checkpointInput(certificate.sourceRunId);
    const bundle = this.coordinator.journal.getBundle(certificate.sourceRunId);
    if (!bundle) throw new Error("checkpoint source bundle not found");
    const forks = await this.checkpoints.fork({ ...input, bundle, config: current.input });
    for (const fork of forks) this.coordinator.scheduleRun(fork.runId);
    return forks;
  }

  genealogy(_runId: string): { rootRunId?: string; nodes: Array<Record<string, unknown>> } {
    const runs = this.listRuns();
    const nodes = runs.map((run) => {
      const fork = this.coordinator.journal.getRunInput(run.runId)?.__kouroFork as
        | Record<string, unknown>
        | undefined;
      const projection = fork?.projection as Record<string, unknown> | undefined;
      const inherited = Array.isArray(projection?.inherited)
        ? projection.inherited
            .map((item) =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as Record<string, unknown>).sourceInvocationId === "string"
                ? ((item as Record<string, unknown>).sourceInvocationId as string)
                : undefined,
            )
            .filter((item): item is string => Boolean(item))
        : [];
      return {
        runId: run.runId,
        label:
          typeof fork?.name === "string"
            ? `${fork.name}${typeof fork.branch === "number" ? ` #${fork.branch}` : ""}`
            : run.runId,
        parentRunId: typeof fork?.sourceRunId === "string" ? fork.sourceRunId : undefined,
        checkpointId: typeof fork?.checkpointId === "string" ? fork.checkpointId : undefined,
        status: run.status,
        createdAt: run.createdAt,
        children: [],
        inheritedInvocationIds: inherited,
      };
    });
    for (const node of nodes) {
      const parent = nodes.find((candidate) => candidate.runId === node.parentRunId);
      if (parent) (parent.children as string[]).push(node.runId as string);
    }
    return {
      rootRunId: nodes.find((node) => !node.parentRunId)?.runId as string | undefined,
      nodes,
    };
  }

  checkpoint(runId: string): CheckpointCertificate | undefined {
    const row = this.coordinator.journal.db
      .query(
        "SELECT id FROM checkpoints WHERE source_run_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(runId) as { id: string } | null;
    return row ? (this.coordinator.journal.getCheckpoint(row.id) ?? undefined) : undefined;
  }

  checkpointComparison(runId: string): {
    inheritedCount: number;
    newCount: number;
    missingCount: number;
    unknownCount: number;
    entries: Array<Record<string, unknown>>;
  } {
    const view = this.getView(runId);
    if (!view) throw new Error(`Run not found: ${runId}`);
    const input = this.coordinator.journal.getRunInput(runId)?.__kouroFork as
      | Record<string, unknown>
      | undefined;
    const projection = input?.projection as Record<string, unknown> | undefined;
    const inherited = new Set(
      Array.isArray(projection?.inherited)
        ? projection.inherited
            .map((item) =>
              typeof item === "object" && item !== null
                ? (item as Record<string, unknown>).sourceInvocationId
                : undefined,
            )
            .filter((item): item is string => typeof item === "string")
        : [],
    );
    const sourceRunId = typeof input?.sourceRunId === "string" ? input.sourceRunId : undefined;
    const source = sourceRunId ? this.getView(sourceRunId) : undefined;
    const represented = new Set<string>();
    const entries: Array<Record<string, unknown>> = Object.values(view.state.invocations).map(
      (item) => {
        const sourceId =
          item.sourceInvocationId && inherited.has(item.sourceInvocationId)
            ? item.sourceInvocationId
            : undefined;
        if (sourceId) represented.add(sourceId);
        const original = sourceId ? source?.state.invocations[sourceId] : undefined;
        const timed = original ?? item;
        const start = timed.startedAt ? Date.parse(timed.startedAt) : NaN;
        const end = timed.completedAt
          ? Date.parse(timed.completedAt)
          : timed.status === "running"
            ? Date.now()
            : NaN;
        const durationKnown = Number.isFinite(start) && Number.isFinite(end) && end >= start;
        return {
          invocationId: item.id,
          label: item.nodeId,
          status: sourceId ? (original ? "inherited" : "unknown") : "new",
          ...(sourceId ? { sourceInvocationId: sourceId } : {}),
          ...(durationKnown ? { durationMs: end - start } : {}),
          durationKnown,
          costKnown: false,
          detail: sourceId
            ? "Original duration is lineage evidence, not new child spend"
            : "Duration spent in this run",
        };
      },
    );
    for (const sourceId of inherited)
      if (!represented.has(sourceId))
        entries.push({
          invocationId: sourceId,
          label: source?.state.invocations[sourceId]?.nodeId ?? sourceId,
          status: "missing",
          sourceInvocationId: sourceId,
          durationKnown: false,
          costKnown: false,
          detail: "Expected inherited invocation is absent from the child projection",
        });
    return {
      inheritedCount: entries.filter((item) => item.status === "inherited").length,
      newCount: entries.filter((item) => item.status === "new").length,
      missingCount: entries.filter((item) => item.status === "missing").length,
      unknownCount: entries.filter((item) => item.status === "unknown").length,
      entries,
    };
  }
}

const AgentSummary = artifactType<{ summary: string }>("kouro.agent-summary.v1", {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string", minLength: 1 } },
});
const WorkItem = artifactType<{
  version: 1;
  task: string;
  title?: string;
  description?: string;
  source?: string;
  ticket?: { reference: string; snapshot: Record<string, unknown> };
}>("kouro.work-item.v1", {
  type: "object",
  additionalProperties: false,
  required: ["version", "task"],
  properties: {
    version: { const: 1 },
    task: { type: "string", minLength: 1 },
    title: { type: "string" },
    description: { type: "string" },
    source: { type: "string" },
    ticket: { type: "object" },
  },
});
const ScoutQuestion = artifactType<string>("kouro.scout-question.v1", {
  type: "string",
  minLength: 1,
});
const ScoutReport = artifactType<{ summary: string; findings: string[] }>("kouro.scout-report.v1", {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string", minLength: 1 },
    findings: { type: "array", items: { type: "string" } },
  },
});

async function compileTiny(): Promise<Bundle> {
  const builder = new WorkflowBuilder({ id: "tiny", version: "1" });
  const agent = builder.agent("scripted-agent", {
    role: "scripted",
    prompt: "Return JSON with one non-empty string field named summary. Do not use tools.",
    produces: AgentSummary,
    // The scripted delay is five seconds, but native local models may need
    // longer to load and answer. Keep the fixture bound without timing them
    // out at the scripted harness's demonstration duration.
    timeoutMs: 120_000,
    scripted: { delayMs: 5_000, output: { summary: "Scripted Kouro harness completed." } },
  });
  const command = builder.command("safe-command", {
    executable: "/usr/bin/printf",
    args: ["Kouro M1 command\\n"],
    timeoutMs: 30_000,
  });
  const complete = builder.complete("complete", { result: "succeeded" });
  builder.startAt(agent);
  builder.sequence(agent, command, complete);
  return compileWorkflow(builder.build());
}

async function compileFeature(): Promise<Bundle> {
  const taskSchema = artifactType<string>("kouro.workflow-task.v1", {
    type: "string",
    minLength: 1,
  });
  const builder = new WorkflowBuilder({ id: "feature", version: "2" });
  const task = builder.input("task", taskSchema, { required: false });
  const workItem = builder.input("workItem", WorkItem, { required: false });
  builder.subagent("repositoryScout", {
    role: "repository-scout",
    prompt: "Inspect the read-only repository view and return a structured repository report.",
    input: { task: taskSchema, question: ScoutQuestion },
    produces: ScoutReport,
    scripted: { output: { summary: "Repository scout fixture", findings: [] } },
  });
  builder.subagent("testScout", {
    role: "test-scout",
    prompt: "Inspect the read-only repository view and return a structured test/build report.",
    input: { task: taskSchema, question: ScoutQuestion },
    produces: ScoutReport,
    scripted: { output: { summary: "Test scout fixture", findings: [] } },
  });
  const plan = builder.agent("plan", {
    role: "planner",
    prompt: "Return JSON with one non-empty string field named summary. Do not use tools.",
    input: { task, workItem },
    produces: AgentSummary,
  });
  const approval = builder.approval("approve-plan", {
    action: "accept-plan",
    input: { task, workItem, plan: plan.output },
  });
  const implement = builder.agent("implement", {
    role: "implementer",
    prompt: "Inspect the supplied plan and perform the authorized implementation.",
    input: { task, workItem, plan: plan.output },
  });
  const validate = builder.command("validate", {
    executable: "/usr/bin/printf",
    args: ["Kouro M1 command\\n"],
  });
  const done = builder.complete("done");
  const failed = builder.complete("failed", { result: "failed" });
  builder.startAt(plan);
  plan.on("success").to(approval);
  approval.on("approved").to(implement);
  approval.on("rejected").to(failed);
  implement.on("success").to(validate);
  validate.on("success").to(done);
  validate.on("failure").repair(implement, {
    maxRepairs: 3,
    feedback: validate.output,
    exhausted: failed,
  });
  return compileWorkflow(builder.build());
}

async function compileParallelFixture(): Promise<Bundle> {
  const child = new WorkflowBuilder({ id: "parallel-child", version: "1" });
  const work = child.agent("work", {
    role: "fixture-worker",
    prompt: "Return JSON with one non-empty string field named summary. Do not use tools.",
    produces: AgentSummary,
    scripted: { delayMs: 12_000, output: { summary: "Nested worker completed." } },
  });
  const childDone = child.complete("done");
  child.startAt(work);
  child.sequence(work, childDone);
  child.output(work.output);

  const root = new WorkflowBuilder({ id: "parallel", version: "2" });
  const branchA = root.call("branch-a", child);
  const branchB = root.call("branch-b", child);
  const fork = root.parallel("reviewers", { branches: [branchA, branchB], maxConcurrent: 2 });
  const join = root.join("join-reviewers", {
    groupId: "reviewers",
    mode: "all-settled",
    failure: "wait-for-all",
  });
  const done = root.complete("done");
  root.startAt(fork);
  fork.on("success").to(join);
  branchA.on("success").to(join);
  branchB.on("success").to(join);
  join.on("success").to(done);
  return compileWorkflow(root.build());
}
interface FileTemplateManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly entrypoint: string;
}

async function loadFileTemplates(root: string): Promise<readonly FileTemplate[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  const templates: FileTemplate[] = [];
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = resolve(root, entry.name);
    let manifest: FileTemplateManifest;
    try {
      manifest = JSON.parse(
        await readFile(resolve(directory, "manifest.json"), "utf8"),
      ) as FileTemplateManifest;
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id))
      throw new Error(`Invalid file template id: ${manifest.id}`);
    if (!manifest.name || !manifest.version || !manifest.entrypoint)
      throw new Error(`Invalid file template manifest: ${directory}`);
    const module = (await import(pathToFileURL(resolve(directory, manifest.entrypoint)).href)) as {
      default?:
        | WorkflowDefinitionSource
        | (() => WorkflowDefinitionSource | Promise<WorkflowDefinitionSource>);
    };
    const exported = module.default;
    if (!exported) throw new Error(`Template entrypoint has no default export: ${directory}`);
    const source = typeof exported === "function" ? await exported() : exported;
    const bundle = await compileWorkflow(source);
    templates.push({ id: manifest.id, name: manifest.name, version: manifest.version, bundle });
  }
  return templates;
}
