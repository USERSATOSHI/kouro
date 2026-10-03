import { compileTask, taskModel, taskWorkflowEligibility } from "./tasks";
import * as coreAuthoring from "@kouro/core";
import {
  WorkflowBuilder,
  artifactType,
  compileWorkflow,
  canonicalize,
  sha256Hex,
  renderPromptFixture,
  isHarness,
  CAPABILITY,
  validateReasoningEffort,
} from "@kouro/core";
import type { Bundle, WorkflowDefinitionSource, NodeRuntimeSettings } from "@kouro/core";
import type { PromptFixture } from "@kouro/core";
import type { CheckpointInput, CheckpointEligibility, CheckpointCertificate } from "@kouro/core";
import { Coordinator, type CoordinatorOptions } from "../coordinator/coordinator.ts";
import { GitWorkspaceAdapter } from "../adapters/workspace/git.ts";
import type { ExecutionProfileId, ExecutionProfileSummary, RunSummary } from "../types.ts";
import type { EvaluationEvidence } from "@kouro/core";
import { ExperimentService } from "../evaluations.ts";
import { CollaborationGateway } from "../collaboration/gateway.ts";
import { compileSwarm, normalizeSwarmModels } from "./swarm.ts";
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

interface RunDeletionPreview {
  runId: string;
  revision: number;
  canDelete: boolean;
  workspaceAdapterMissing?: boolean;
  blockers?: Array<{ message: string }>;
  [key: string]: unknown;
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

  steer(input: Parameters<Coordinator["steer"]>[0]) {
    return this.coordinator.steer(input);
  }
  canSteer(runId: string, invocationId: string): boolean {
    return this.coordinator.canSteer(runId, invocationId);
  }
  interruptAttempt(input: Parameters<Coordinator["interruptAttempt"]>[0]) {
    return this.coordinator.interruptAttempt(input);
  }

  operatorState(runId: string) {
    const view = this.getView(runId);
    if (!view) return undefined;
    const invocations = Object.values(view.state.invocations);
    const retryableInvocationIds = ["paused", "failed", "interrupted"].includes(view.state.status)
      ? invocations
          .filter((item) => item.status === "failed" && this.coordinator.canRetry(runId, item.id))
          .map((item) => item.id)
      : [];
    const steerableInvocationIds = invocations
      .filter((item) => item.status === "running" && this.canSteer(runId, item.id))
      .map((item) => item.id);
    const interruptibleInvocationIds = invocations
      .filter((item) => item.status === "running" && this.coordinator.canInterrupt(runId, item.id))
      .map((item) => item.id);
    return {
      capabilities: {
        pause: view.state.status === "running",
        resume: this.coordinator.canResume(runId),
        cancel: view.state.status === "running" || view.state.status === "paused",
        detach: view.state.status === "running" || view.state.status === "paused",
        steer: steerableInvocationIds.length > 0,
        retry: retryableInvocationIds.length > 0,
      },
      retryableInvocationIds,
      steerableInvocationIds,
      interruptibleInvocationIds,
    };
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
      const view = this.coordinator.journal.getViewAtRevision(run.runId, run.revision);
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
    const view = this.coordinator.journal.getViewAtRevision(run.runId, run.revision);
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
    const runA = flip ? second : first;
    const runB = flip ? first : second;
    const assignment = this.coordinator.journal.createPairwiseAssignment({
      id: `pair_${randomUUID().replaceAll("-", "")}`,
      comparisonId: input.comparisonId,
      runA,
      runB,
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
          edges: [
            ...Object.values(bundle.definitions).flatMap((childDefinition) =>
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
            ...Object.values(bundle.definitions).flatMap((definition) =>
              (definition.scouts ?? []).flatMap((scout) => {
                const child = bundle.definitions[scout.definitionId];
                const childAgent = child?.nodes.find((node) => node.kind === "agent");
                if (!child || !childAgent) return [];
                return definition.nodes
                  .filter(
                    (node) =>
                      node.kind === "agent" &&
                      (node.uses === undefined || node.uses.includes(scout.id)),
                  )
                  .map((parent) => ({
                    id: `${definition.id}:subagent:${parent.id}:${scout.id}`,
                    source: parent.id,
                    target: childAgent.id,
                    definitionId: definition.id,
                    targetDefinitionId: child.id,
                    relation: "subagent",
                    label: scout.id,
                  }));
              }),
            ),
          ],
          groups: Object.values(bundle.definitions).map((childDefinition) => ({
            id: childDefinition.id,
            label: childDefinition.id,
            definitionId: childDefinition.id,
            ...(childDefinition.id === bundle.rootDefinitionId
              ? {}
              : { parentId: bundle.rootDefinitionId }),
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
    const codexAvailable = profileHost.availableProfiles?.includes("codex-readonly") ?? true;
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
    const piAvailable = profileHost.availableProfiles?.includes("pi-readonly") ?? true;
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
        description: "Run the agent through the Codex SDK without workspace writes.",
        available: codexAvailable,
        harness: "codex",
        capabilities: codexCapabilities,
        unavailableReason: codexAvailable
          ? undefined
          : "Codex SDK runtime is not available on this host",
      },
      {
        id: "codex-workspace-write",
        name: "Codex · workspace write",
        description: "Codex can write inside the workspace for explicitly writable roles.",
        available: codexAvailable,
        harness: "codex",
        capabilities: codexCapabilities,
        unavailableReason: codexAvailable
          ? undefined
          : "Codex SDK runtime is not available on this host",
      },
      {
        id: "claude-readonly",
        name: "Claude Agent SDK · read-only",
        description:
          "Use the Claude Agent SDK with built-in file tools restricted to the workspace.",
        available: true,
        harness: "claude",
        capabilities: {
          "structured-output": "supported",
          cancel: "supported",
          resume: "supported",
          reattach: "unsupported",
          tools: "conditional",
          usage: "supported",
          "cost-cap": "unsupported",
        },
      },
      {
        id: "claude-workspace-write",
        name: "Claude Agent SDK · workspace write",
        description: "Claude may edit workspace files for roles declaring workspace-write access.",
        available: true,
        harness: "claude",
        capabilities: {
          "structured-output": "supported",
          cancel: "supported",
          resume: "supported",
          reattach: "unsupported",
          tools: "conditional",
          usage: "supported",
          "cost-cap": "unsupported",
        },
      },
      {
        id: "pi-readonly",
        name: "Pi SDK · read-only",
        description: "Run Pi in-process through its SDK with read-only tools.",
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

  async taskWorkflows() {
    return (await this.workflows()).map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      version: workflow.version,
      digest: workflow.digest,
      ...taskWorkflowEligibility(workflow),
    }));
  }

  async createTask(input: {
    task: string;
    workflowIds: unknown;
    planner: unknown;
    executor: unknown;
    maxMilestones?: number;
    maxConcurrent?: number;
    idempotencyKey: string;
    workspace?: { repositoryPath: string };
  }): Promise<RunSummary> {
    if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 20000)
      throw new Error("Enter a task of at most 20000 characters");
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim())
      throw new Error("idempotencyKey is required");
    if (
      !Array.isArray(input.workflowIds) ||
      !input.workflowIds.length ||
      input.workflowIds.some((id) => typeof id !== "string") ||
      new Set(input.workflowIds).size !== input.workflowIds.length
    )
      throw new Error("Choose unique available workflow IDs");
    const catalog = await this.workflows();
    const selected = input.workflowIds.map((id) => {
      const workflow = catalog.find((item) => item.id === id);
      if (!workflow) throw new Error(`Unknown workflow ${id}`);
      const eligibility = taskWorkflowEligibility(workflow);
      if (!eligibility.eligible) throw new Error(`${workflow.name}: ${eligibility.reason}`);
      if (eligibility.requiresWorkspace && !input.workspace)
        throw new Error(`${workflow.name} needs a repository path`);
      return workflow;
    });
    const bundle = await compileTask(
      selected,
      taskModel(input.planner),
      taskModel(input.executor),
      input.maxMilestones,
      input.maxConcurrent,
    );
    return (
      await this.coordinator.createRun({
        workflowId: "automatic-task",
        bundle,
        input: {
          task: input.task.trim(),
          __taskWorkflows: selected.map((workflow) => ({
            id: workflow.id,
            name: workflow.name,
            version: workflow.version,
            digest: workflow.digest,
          })),
        },
        idempotencyKey: input.idempotencyKey,
        actor: "operator",
        ...(input.workspace ? { workspace: input.workspace } : {}),
      })
    ).run;
  }

  async createSwarm(input: {
    models: unknown;
    task: string;
    idempotencyKey: string;
    workspace?: { repositoryPath: string };
  }): Promise<RunSummary> {
    const models = normalizeSwarmModels(input.models);
    if (typeof input.task !== "string" || !input.task.trim())
      throw new Error("Enter a task for the swarm");
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim())
      throw new Error("idempotencyKey is required");
    const bundle = await compileSwarm(models);
    return (
      await this.coordinator.createRun({
        workflowId: bundle.rootDefinitionId,
        bundle,
        input: { task: input.task.trim() },
        idempotencyKey: input.idempotencyKey,
        actor: "operator",
        ...(input.workspace ? { workspace: input.workspace } : {}),
      })
    ).run;
  }

  async createRun(input: {
    workflowId: string;
    idempotencyKey: string;
    actor?: string;
    input?: Record<string, unknown>;
    nodeSettings?: Record<string, NodeRuntimeSettings>;
    /** Legacy callers may still send this; new run settings belong to workflow nodes. */
    executionProfile?: ExecutionProfileId;
    allowUnrestrictedCommands?: boolean;
    workspace?: { repositoryPath: string; workspaceId?: string };
  }): Promise<RunSummary> {
    const source = this.bundles.get(input.workflowId);
    if (!source) throw new Error(`Unknown workflow ${input.workflowId}`);
    const bundle = input.nodeSettings ? await configureBundle(source, input.nodeSettings) : source;
    const { nodeSettings: _nodeSettings, ...runInput } = input;
    const needsSourceRepository = Object.values(bundle.definitions).some((definition) =>
      definition.nodes.some(
        (node) => node.kind === "command" && node.workspaceAccess === "source-repository",
      ),
    );
    const workspace =
      input.workspace ??
      (needsSourceRepository
        ? { repositoryPath: resolve(process.cwd()), workspaceId: "source" }
        : undefined);
    return (
      await this.coordinator.createRun({
        ...runInput,
        ...(workspace ? { workspace } : {}),
        bundle,
      })
    ).run;
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
    decision: "approved" | "rejected" | "changes-requested";
    feedback?: string;
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
  pendingApprovals() {
    return this.coordinator.journal.listRuns().flatMap((run) => {
      const view = this.getView(run.runId);
      if (!view) return [];
      return Object.values(view.state.approvals)
        .filter((approval) => approval.status === "pending")
        .map((approval) => ({
          runId: run.runId,
          workflowId: run.workflowId,
          task: run.task,
          revision: view.revision,
          invocationId: approval.invocationId,
          approvalId: approval.id,
          action: approval.action,
          bindingDigest: approval.bindingDigest,
          subjectRevision: approval.subjectRevision,
          requestedAt: view.state.invocations[approval.invocationId]?.startedAt,
        }));
    });
  }
  collaboration(runId: string): Record<string, unknown> {
    const view = this.getView(runId);
    if (view?.bundle.rootDefinitionId.startsWith("agent-swarm-")) {
      const nodes = view.bundle.definitions[view.bundle.rootDefinitionId]!.nodes.filter(
        (node) => node.kind === "agent",
      );
      const invocations = Object.values(view.state.invocations);
      const attempts = Object.values(view.state.attempts);
      const invocationFor = (nodeId: string) =>
        invocations.filter((item) => item.nodeId === nodeId).at(-1);
      const attemptFor = (nodeId: string) =>
        attempts.filter((item) => item.invocationId === invocationFor(nodeId)?.id).at(-1);
      const members = nodes.filter((node) => node.id !== "synthesis");
      const synthesis = invocationFor("synthesis");
      const results = nodes.flatMap((node) => {
        const attempt = attemptFor(node.id);
        if (attempt?.status !== "succeeded") return [];
        return attempt.output.map((artifact) => {
          const report = JSON.parse(new TextDecoder().decode(this.readArtifact(artifact.id))) as {
            summary: string;
          };
          return {
            id: artifact.id,
            participantId: node.id === "synthesis" ? members[0]!.role : node.role,
            title: node.id === "synthesis" ? "Combined answer" : node.modelId,
            body: report.summary,
            artifactId: artifact.id,
            final: node.id === "synthesis" || members.length === 1,
          };
        });
      });
      return {
        runId,
        objective: this.coordinator.journal.getRunSummary(runId)?.task,
        participants: members.map((node, index) => {
          const invocation = invocationFor(node.id);
          const attempt = attemptFor(node.id);
          const synthesisAttempt = index === 0 ? attemptFor("synthesis") : undefined;
          const combining = index === 0 && synthesis?.status === "running";
          return {
            id: node.role,
            name: node.modelId,
            role: `Member ${index + 1}`,
            harness: attempt?.resolvedExecution?.harness ?? node.harness,
            model: attempt?.resolvedExecution?.modelId ?? node.modelId,
            state: synthesisAttempt?.status ?? attempt?.status ?? invocation?.status ?? "pending",
            activity: combining
              ? "Combining answers"
              : synthesisAttempt?.status === "failed"
                ? "Combining answers failed"
                : undefined,
          };
        }),
        channels: [],
        messages: [],
        blackboard: [],
        budgets: {},
        results,
        artifacts: results.map((result) => ({
          id: result.artifactId,
          name: result.title,
          producerId: result.participantId,
        })),
        timeline: nodes.flatMap((node) => {
          const invocation = invocationFor(node.id);
          if (!invocation) return [];
          return [
            ...(invocation.startedAt
              ? [
                  {
                    id: `${invocation.id}:start`,
                    participantId: node.id === "synthesis" ? members[0]!.role : node.role,
                    type: "running",
                    label:
                      node.id === "synthesis" ? "Combining answers" : `${node.modelId} started`,
                    at: invocation.startedAt,
                  },
                ]
              : []),
            ...(invocation.completedAt
              ? [
                  {
                    id: `${invocation.id}:end`,
                    participantId: node.id === "synthesis" ? members[0]!.role : node.role,
                    type: invocation.status,
                    label: `${node.id === "synthesis" ? "Combined answer" : node.modelId}: ${invocation.status}`,
                    at: invocation.completedAt,
                  },
                ]
              : []),
          ];
        }),
      };
    }
    return new CollaborationGateway(this.coordinator.journal).snapshot(runId);
  }
  scouts(runId: string) {
    return this.coordinator.scouts.requests(runId);
  }
  getView(runId: string) {
    return this.coordinator.journal.getView(runId);
  }
  getEvents(runId: string, after?: number, limit?: number) {
    return this.coordinator.journal.getEvents(runId, after, limit);
  }
  getHarnessActivity(
    runId: string,
    after: number,
    limit: number,
    attemptId?: string,
    tail = false,
  ) {
    return this.coordinator.journal.getHarnessActivity(runId, after, limit, attemptId, tail);
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
  workspaceSnapshot(runId: string, invocationId?: string) {
    return this.coordinator.workspaceSnapshot(runId, invocationId);
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
    expectedTree?: string;
    expectedPatchDigest?: string;
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

  async previewRunDeletion(runId: string): Promise<RunDeletionPreview> {
    const journal = this.coordinator.journal;
    const run = journal.getRunRow(runId);
    if (!run) {
      const deletion = journal.getRunDeletion(runId);
      if (!deletion) throw new Error(`Run not found: ${runId}`);
      return {
        ...deletion.preview,
        runId,
        revision: deletion.expectedRevision,
        deletionStatus: deletion.status,
        deletionError: deletion.error,
        deletionRequestKey: deletion.idempotencyKey,
        canDelete: false,
      };
    }
    const view = journal.getView(runId);
    const input = journal.getRunInput(runId) ?? {};
    const repository = input.__kouroWorkspace as Record<string, unknown> | undefined;
    const claims = await this.coordinator.workspaceClaims(runId);
    const blockers = journal.runDeletionBlockers(runId);
    const status = journal.getRunDeletion(runId)?.status;
    const deletion = journal.getRunDeletion(runId);
    const attemptCount = this.countRows("attempts", runId);
    const artifactCount = this.countRows("artifacts", runId);
    const eventCount = this.countRows("run_events", runId);
    const checkpointCount = this.countRows("checkpoints", runId, "source_run_id");
    let drainReason: string | undefined;
    const active = (() => {
      try {
        this.coordinator.assertRunDrained(runId);
        return false;
      } catch (cause) {
        drainReason = cause instanceof Error ? cause.message : String(cause);
        return true;
      }
    })();
    const workspaceAdapterMissing =
      Boolean(repository?.repositoryPath) &&
      !this.coordinator.hasWorkspaceAdapter() &&
      !["workspace-cleaned", "purge-failed"].includes(deletion?.status ?? "");
    const preview = {
      runId,
      workflowId: run.workflowId,
      status: run.status,
      revision: run.revision,
      task: typeof input.task === "string" ? input.task : "",
      repositoryPath:
        typeof repository?.repositoryPath === "string" ? repository.repositoryPath : undefined,
      terminal: ["succeeded", "failed", "cancelled", "interrupted", "recovery-required"].includes(
        run.status,
      ),
      drained: !active,
      drainReason,
      workspaceAdapterMissing,
      workspaces: claims.map((claim) => ({ workspaceId: claim.workspaceId, path: claim.path })),
      removes: {
        historyEvents: eventCount,
        attempts: attemptCount,
        artifacts: artifactCount,
        workspaces: claims.length,
      },
      retained: { checkpoints: checkpointCount, blockers },
      blockers,
      deletionStatus: status,
      deletionError: deletion?.error,
      deletionRequestKey: deletion?.idempotencyKey,
      canDelete:
        !active &&
        !workspaceAdapterMissing &&
        blockers.length === 0 &&
        ["succeeded", "failed", "cancelled", "interrupted", "recovery-required"].includes(
          run.status,
        ),
    };
    return { ...preview, viewStatus: view?.state.status };
  }

  async confirmAbandonedHarnessShutdown(input: {
    runId: string;
    shutdownId: string;
    expectedRevision: number;
    actor: string;
    verifiedStopped: boolean;
  }): Promise<RunDeletionPreview> {
    if (input.verifiedStopped !== true)
      throw new Error("Verify the external agent has stopped before confirming shutdown.");
    this.coordinator.confirmAbandonedHarnessShutdown(input);
    return this.previewRunDeletion(input.runId);
  }

  incompleteRunDeletions() {
    return this.coordinator.journal.listIncompleteRunDeletions().map((deletion) => ({
      runId: deletion.runId,
      status: deletion.status,
      task: deletion.preview.task,
      workflowId: deletion.preview.workflowId,
      error: deletion.error,
    }));
  }

  async deleteRun(input: {
    runId: string;
    expectedRevision: number;
    idempotencyKey: string;
    actor: string;
  }) {
    const journal = this.coordinator.journal;
    let deletion = journal.getRunDeletion(input.runId);
    if (deletion?.status === "completed") return deletion;
    if (deletion && ["database-purged", "blob-cleanup-failed"].includes(deletion.status)) {
      try {
        this.coordinator.journal.blobs.removeDigests(deletion.blobDigests);
      } catch (cause) {
        return journal.advanceRunDeletion(input.runId, "blob-cleanup-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      return journal.advanceRunDeletion(input.runId, "completed");
    }

    this.coordinator.assertRunDrained(input.runId);
    const preview = await this.previewRunDeletion(input.runId);
    if (!preview.canDelete)
      throw new Error(
        preview.workspaceAdapterMissing
          ? "run deletion is blocked because its workspace adapter is unavailable"
          : preview.blockers?.length
            ? `run deletion blocked: ${preview.blockers.map((item) => item.message).join(" ")}`
            : "run deletion requires a terminal, drained run",
      );
    if (preview.revision !== input.expectedRevision)
      throw new Error("stale-action: run revision changed");

    deletion = journal.beginRunDeletion({ ...input, preview });
    if (deletion.status === "requested" || deletion.status === "workspace-cleanup-failed") {
      try {
        await this.coordinator.cleanupRunWorkspaces(input.runId);
        deletion = journal.advanceRunDeletion(input.runId, "workspace-cleaned");
      } catch (cause) {
        return journal.advanceRunDeletion(input.runId, "workspace-cleanup-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (deletion.status === "workspace-cleaned" || deletion.status === "purge-failed") {
      try {
        const exclusive = journal.runArtifactDigests(input.runId);
        this.checkpointRetention.assertCleanupAllowed(exclusive);
        journal.purgeRunData(input.runId);
      } catch (cause) {
        return journal.advanceRunDeletion(input.runId, "purge-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      deletion = journal.getRunDeletion(input.runId)!;
    }
    try {
      this.coordinator.journal.blobs.removeDigests(deletion.blobDigests);
    } catch (cause) {
      return journal.advanceRunDeletion(input.runId, "blob-cleanup-failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return journal.advanceRunDeletion(input.runId, "completed");
  }

  private countRows(table: string, runId: string, key = "run_id"): number {
    // Table and column names are selected only by this module.
    const row = this.coordinator.journal.db
      .query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?1`)
      .get(runId) as { count: number };
    return row.count;
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

export async function configureBundle(
  source: Bundle,
  settings: Record<string, NodeRuntimeSettings>,
): Promise<Bundle> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("nodeSettings must be an object keyed by workflow node ID");
  const targets = Object.entries(source.definitions).flatMap(([definitionId, definition]) =>
    definition.nodes.map((node) => ({ definitionId, node, key: `${definitionId}/${node.id}` })),
  );
  const resolved = new Map<(typeof targets)[number]["node"], (typeof settings)[string]>();
  for (const [key, setting] of Object.entries(settings)) {
    const matches = targets.filter((target) => target.key === key || target.node.id === key);
    if (!matches.length) throw new Error(`Unknown workflow node ${key}`);
    if (matches.length !== 1)
      throw new Error(`Ambiguous workflow node ${key}; use the definition and node ID`);
    if (resolved.has(matches[0]!.node))
      throw new Error(`Duplicate settings for workflow node ${key}`);
    resolved.set(matches[0]!.node, setting);
  }
  // A model is chosen once on its draft; reviews and revisions keep that selection.
  for (const [node, setting] of resolved) {
    if (node.kind !== "agent" || node.fusion?.stage !== "draft") continue;
    const definitionId = targets.find((target) => target.node === node)!.definitionId;
    for (const target of targets) {
      const peer = target.node;
      if (
        target.definitionId === definitionId &&
        peer.kind === "agent" &&
        peer.fusion?.groupId === node.fusion.groupId &&
        peer.fusion?.memberId === node.fusion.memberId &&
        !resolved.has(peer)
      )
        resolved.set(peer, setting);
    }
  }
  const childDefinitions = new Set(
    Object.values(source.definitions).flatMap((definition) =>
      (definition.scouts ?? []).map((scout) => scout.definitionId),
    ),
  );
  const definitions = Object.fromEntries(
    Object.entries(source.definitions).map(([definitionId, definition]) => [
      definitionId,
      {
        ...definition,
        nodes: definition.nodes.map((node) => {
          if (!resolved.has(node)) return node;
          const setting = resolved.get(node)!;
          if (!setting || typeof setting !== "object" || Array.isArray(setting))
            throw new Error(`Invalid settings for node ${node.id}`);
          if (node.kind !== "agent" && node.kind !== "command")
            throw new Error(`Node ${node.id} cannot have runtime settings`);
          if (
            setting.harness !== undefined &&
            (node.kind !== "agent" || !isHarness(setting.harness))
          )
            throw new Error(`Invalid harness for node ${node.id}`);
          if (
            setting.modelId !== undefined &&
            (typeof setting.modelId !== "string" || setting.modelId.length > 200)
          )
            throw new Error(`Invalid model for node ${node.id}`);
          if (setting.effort !== undefined && node.kind !== "agent")
            throw new Error(`Only agent nodes can set reasoning effort: ${node.id}`);
          if (node.kind === "agent") {
            const effort = setting.effort === null ? undefined : (setting.effort ?? node.effort);
            const effortError = validateReasoningEffort(
              effort,
              (setting.harness ?? node.harness) as typeof node.harness,
            );
            if (effortError) throw new Error(`${effortError} for node ${node.id}`);
          }
          const allowed = Object.values(CAPABILITY) as string[];
          if (
            setting.capabilities !== undefined &&
            (!Array.isArray(setting.capabilities) ||
              setting.capabilities.some(
                (capability) => typeof capability !== "string" || !allowed.includes(capability),
              ))
          )
            throw new Error(`Invalid capability for node ${node.id}`);
          if (
            childDefinitions.has(definitionId) &&
            setting.capabilities?.some((capability) => capability !== CAPABILITY.REPOSITORY_READ)
          )
            throw new Error(`Subagent ${definitionId} must remain read-only`);
          const configured = {
            ...node,
            ...(setting.harness === undefined ? {} : { harness: setting.harness }),
            ...(setting.modelId === undefined ? {} : { modelId: setting.modelId }),
            ...(setting.effort === undefined ? {} : { effort: setting.effort }),
            ...(setting.capabilities === undefined
              ? {}
              : { capabilities: [...new Set(setting.capabilities)].sort() }),
          };
          if (configured.effort === null) delete configured.effort;
          return configured;
        }),
      },
    ]),
  );
  const executable = {
    formatVersion: source.formatVersion,
    semanticVersions: source.semanticVersions,
    rootDefinitionId: source.rootDefinitionId,
    definitions,
    schemas: source.schemas,
    limits: source.limits,
    sourceMap: source.sourceMap,
    boundSummary: source.boundSummary,
  };
  const canonicalJson = canonicalize(executable);
  const digest = `sha256:${await sha256Hex(canonicalJson)}`;
  return Object.freeze({ ...JSON.parse(canonicalJson), digest, canonicalJson }) as Bundle;
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
  const repositoryScout = builder.subagent("repositoryScout", {
    role: "repository-scout",
    prompt: "Inspect the read-only repository view and return a structured repository report.",
    input: { task: taskSchema, question: ScoutQuestion },
    produces: ScoutReport,
    scripted: { output: { summary: "Repository scout fixture", findings: [] } },
  });
  const testScout = builder.subagent("testScout", {
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
    uses: [repositoryScout, testScout],
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
  approval.on("changes-requested").repair(plan, {
    maxRepairs: 3,
    feedback: approval.output,
    exhausted: failed,
  });
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

let authoringPluginRegistered = false;
function registerAuthoringRuntime() {
  if (authoringPluginRegistered) return;
  // Project templates may live outside this checkout or a globally installed CLI.
  // Bind their builder imports to the same core version the host compiles and executes.
  Bun.plugin({
    name: "kouro-workflow-authoring",
    setup(build) {
      build.module("@kouro/core", () => ({
        loader: "object",
        exports: coreAuthoring,
      }));
    },
  });
  authoringPluginRegistered = true;
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
    registerAuthoringRuntime();
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
