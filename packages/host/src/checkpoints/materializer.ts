import {
  canonicalize,
  createCheckpointCut,
  invalidateCheckpoint,
  prepareForkProjection,
  sha256Hex,
} from "@kouro/core";
import type { CheckpointCertificate, CheckpointInput, Bundle, RunView } from "@kouro/core";
import { createHash } from "node:crypto";
import { id } from "../id.ts";
import { Journal } from "../storage/journal.ts";
import { GitWorkspaceAdapter, type WorkspaceRef } from "../adapters/workspace/git.ts";

export interface CheckpointMaterializerOptions {
  readonly journal: Journal;
  readonly workspace: GitWorkspaceAdapter;
}

export interface CapturedCheckpoint {
  readonly certificate: CheckpointCertificate;
  readonly workspace: WorkspaceRef;
}

export interface MaterializedFork {
  readonly runId: string;
  readonly workspace: WorkspaceRef;
  readonly inheritedInvocationIds: readonly string[];
  readonly pendingInvocationIds: readonly string[];
}

type ExecutionProfile = "scripted" | "codex-readonly" | "pi-readonly";

/** Host-side M7.2 capture and fork materialization. */
export class CheckpointMaterializer {
  constructor(private readonly options: CheckpointMaterializerOptions) {}

  async capture(input: {
    checkpoint: CheckpointInput;
    checkpointId?: string;
    requestKey: string;
    workspace: WorkspaceRef;
  }): Promise<CapturedCheckpoint> {
    const stableId = input.checkpointId ?? stableCheckpointId(input.requestKey);
    const prior = this.options.journal.getCheckpointOperation(input.requestKey);
    if (prior) {
      const certificate = this.options.journal.getCheckpoint(prior.checkpointId);
      if (!certificate) throw new Error("checkpoint operation references missing certificate");
      const workspace = await this.options.workspace.load(input.workspace);
      return { certificate, workspace };
    }
    const snapshot = await this.options.workspace.snapshot(input.workspace);
    if (snapshot.resultTree !== input.checkpoint.workspace.treeDigest)
      throw new Error("checkpoint workspace changed before capture");
    const artifactRoots = input.checkpoint.artifacts.roots.map((root) => {
      const artifact = this.options.journal.getArtifact(root);
      return artifact?.digest ?? root;
    });
    for (const digest of artifactRoots) {
      if (!/^[a-f0-9]{64}$/.test(digest))
        throw new Error(`checkpoint artifact root is not a content digest: ${digest}`);
      this.options.journal.blobs.read({ digest });
    }
    const certificate = await createCheckpointCut(
      {
        ...input.checkpoint,
        artifacts: { ...input.checkpoint.artifacts, roots: artifactRoots },
      },
      stableId,
    );
    this.options.journal.saveCheckpoint(certificate);
    const captureRecord = {
      sourceRunId: certificate.sourceRunId,
      repositoryPath: input.workspace.repositoryPath,
      parentCommit: input.workspace.baseCommit,
      workspaceId: input.workspace.workspaceId,
      tree: snapshot.resultTree,
      artifactRoots: certificate.retainedArtifactRoots,
    };
    this.options.journal.recordCheckpointOperation({
      id: id("checkpoint-op"),
      checkpointId: certificate.checkpointId,
      kind: "checkpoint.capture",
      requestKey: input.requestKey,
      record: captureRecord,
    });
    return { certificate, workspace: input.workspace };
  }

  /**
   * Allocate two independent children from one retained tree. The request key
   * is the recovery boundary: retrying after a crash reuses each child run and
   * worktree instead of creating a third identity.
   */
  async fork(input: {
    checkpointId: string;
    requestKey: string;
    name?: string;
    workflowId?: string;
    bundle?: Bundle;
    input?: Record<string, unknown>;
    executionProfile?: ExecutionProfile;
    /** Prompt replacements keyed by compiled node id. Only unexecuted agent nodes may change. */
    promptVariants?: Readonly<Record<string, string>>;
    count?: number;
    config?: Pick<
      CheckpointInput,
      "revision" | "bundleDigest" | "configDependencyDigest" | "artifacts" | "workspace"
    >;
  }): Promise<readonly MaterializedFork[]> {
    const certificate = this.options.journal.getCheckpoint(input.checkpointId);
    if (!certificate) throw new Error(`Checkpoint not found: ${input.checkpointId}`);
    if (!input.bundle || !input.config)
      throw new Error("fork requires current bundle and configuration dependency identity");
    const invalidation = invalidateCheckpoint(certificate, input.config);
    if (!invalidation.valid)
      throw new Error(`checkpoint invalidated: ${invalidation.reasons.join(", ")}`);
    const capture = this.options.journal.listCheckpointOperations(
      certificate.checkpointId,
      "checkpoint.capture",
    )[0];
    if (!capture) throw new Error("checkpoint capture materialization record not found");
    const record = capture.record;
    const sourceBundle = input.bundle;
    if (!sourceBundle) throw new Error("checkpoint source bundle not found");
    const projection = prepareForkProjection(certificate);
    const childBundle = await materializePromptVariant(
      sourceBundle,
      input.promptVariants ?? {},
      this.options.journal.getView(certificate.sourceRunId),
      certificate.inheritedSourceInvocationIds,
    );
    if (
      input.executionProfile !== undefined &&
      !["scripted", "codex-readonly", "pi-readonly"].includes(input.executionProfile)
    )
      throw new Error("unsupported fork execution profile");
    const sourceInput = this.options.journal.getRunInput(certificate.sourceRunId) ?? {};
    const childInput = { ...sourceInput, ...input.input };
    if (input.executionProfile) childInput.__kouroExecutionProfile = input.executionProfile;
    const withoutProfile = (value: Record<string, unknown>) => {
      const copy = { ...value };
      delete copy.__kouroExecutionProfile;
      return copy;
    };
    if (canonicalize(withoutProfile(childInput)) !== canonicalize(withoutProfile(sourceInput)))
      throw new Error("fork variant may change only execution profile");
    const childProfile =
      typeof childInput.__kouroExecutionProfile === "string"
        ? childInput.__kouroExecutionProfile
        : "scripted";
    const childConfigDependencyDigest = `sha256:${createHash("sha256")
      .update(
        canonicalize({
          input: childInput,
          profile: childProfile,
          promptVariants: input.promptVariants ?? {},
          bundleDigest: childBundle.digest,
        }),
      )
      .digest("hex")}`;
    const results: MaterializedFork[] = [];
    const count = input.count ?? 2;
    for (let index = 0; index < count; index += 1) {
      const childKey = `${input.requestKey}:${index}`;
      const prior = this.options.journal.getCheckpointOperation(childKey);
      const childId =
        typeof prior?.record.childRunId === "string" ? prior.record.childRunId : undefined;
      const created = this.options.journal.createRun({
        workflowId:
          input.workflowId ?? this.options.journal.getRunRow(certificate.sourceRunId)!.workflowId,
        bundle: childBundle,
        input: {
          ...childInput,
          __kouroFork: {
            checkpointId: certificate.checkpointId,
            sourceRunId: certificate.sourceRunId,
            projection,
            attemptsSpent: certificate.attemptsSpent,
            ...(input.name ? { name: input.name, branch: index + 1 } : {}),
            executionProfile: childProfile,
            bundleDigest: childBundle.digest,
            promptVariants: input.promptVariants ?? {},
            configDependencyDigest: childConfigDependencyDigest,
          },
        },
        idempotencyKey: childKey,
      });
      if (childId && childId !== created.run.runId)
        throw new Error("fork request resolved to a different child identity");
      // Turn the retained successful prefix into fresh child lifecycle facts.
      // This intentionally does not copy parent envelopes, attempts, effects,
      // approvals, sessions, or deliveries.
      if (!prior && this.options.journal.getView(created.run.runId)?.revision === 0)
        this.options.journal.materializeInheritedPrefix(
          created.run.runId,
          certificate.sourceRunId,
          certificate.inheritedSourceInvocationIds,
          certificate.pendingFrontier.map((item) => item.invocationId),
          certificate.counters,
        );
      let workspace: WorkspaceRef;
      try {
        workspace = await this.options.workspace.loadByIdentity(created.run.runId, `fork-${index}`);
      } catch {
        workspace = await this.options.workspace.createAtTree({
          repositoryPath: String(record.repositoryPath),
          parentCommit: String(record.parentCommit),
          tree: certificate.workspaceTreeDigest,
          runId: created.run.runId,
          workspaceId: `fork-${index}`,
        });
      }
      // A retry may find a worktree allocated before the preparation record
      // was committed. Do not adopt it if its bytes have since diverged from
      // the certified checkpoint tree. A recorded child may legitimately have
      // advanced, so this check applies only to unprepared children.
      if (!prior) {
        const snapshot = await this.options.workspace.snapshot(workspace);
        if (snapshot.resultTree !== certificate.workspaceTreeDigest)
          throw new Error("unprepared fork workspace diverged from checkpoint tree");
      }
      this.options.journal.updateRunInput(created.run.runId, {
        ...this.options.journal.getRunInput(created.run.runId),
        __kouroWorkspace: workspace,
      });
      this.options.journal.recordCheckpointOperation({
        id: id("fork-op"),
        checkpointId: certificate.checkpointId,
        kind: "fork.preparation",
        requestKey: childKey,
        record: {
          childRunId: created.run.runId,
          workspaceId: workspace.workspaceId,
          tree: certificate.workspaceTreeDigest,
        },
      });
      results.push({
        runId: created.run.runId,
        workspace,
        inheritedInvocationIds: projection.inherited.map((item) => item.sourceInvocationId),
        pendingInvocationIds: projection.pending.map((item) => item.invocationId),
      });
    }
    return results;
  }
}

function stableCheckpointId(requestKey: string): string {
  return `cp_${createHash("sha256").update(requestKey).digest("hex").slice(0, 32)}`;
}

/**
 * Build an executable child bundle without recompiling or changing its graph.
 * The structural digest deliberately excludes only agent prompts; schemas and
 * every control/data field remain byte-for-byte identical to the source.
 */
async function materializePromptVariant(
  source: Bundle,
  replacements: Readonly<Record<string, string>>,
  sourceView: RunView | null,
  inheritedInvocationIds: readonly string[],
): Promise<Bundle> {
  const entries = Object.entries(replacements);
  if (entries.some(([nodeId, prompt]) => !nodeId || typeof prompt !== "string"))
    throw new Error("prompt variants require non-empty node ids and string prompts");
  const inheritedNodeIds = new Set(
    inheritedInvocationIds.map((invocationId) => {
      const invocation = sourceView?.state.invocations[invocationId];
      if (!invocation)
        throw new Error(`checkpoint inherited invocation not found: ${invocationId}`);
      return invocation.nodeId;
    }),
  );
  // M7 currently rejects nested-scope checkpoint cuts. Restrict prompt edits
  // to the root definition too; a bare node ID must never silently rewrite
  // a same-named agent in another reusable subworkflow.
  const root = source.definitions[source.rootDefinitionId];
  if (!root) throw new Error("checkpoint source root definition is missing");
  const nodes = new Map(root.nodes.map((node) => [node.id, node] as const));
  for (const [nodeId] of entries) {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`prompt variant targets unknown node: ${nodeId}`);
    if (inheritedNodeIds.has(nodeId))
      throw new Error(`prompt variant cannot change completed node: ${nodeId}`);
    if (node.kind !== "agent") throw new Error(`prompt variant targets non-agent node: ${nodeId}`);
  }
  if (entries.length === 0) return source;

  const definitions = {
    ...source.definitions,
    [source.rootDefinitionId]: {
      ...root,
      nodes: root.nodes.map((node) =>
        node.kind === "agent" && Object.hasOwn(replacements, node.id)
          ? { ...node, prompt: replacements[node.id]! }
          : node,
      ),
    },
  };
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
  const candidate = { ...executable, digest, canonicalJson } as Bundle;
  if (structuralIdentity(source) !== structuralIdentity(candidate))
    throw new Error("prompt variant changed workflow graph or schema");
  return candidate;
}

function structuralIdentity(bundle: Bundle): string {
  return canonicalize({
    formatVersion: bundle.formatVersion,
    semanticVersions: bundle.semanticVersions,
    rootDefinitionId: bundle.rootDefinitionId,
    definitions: Object.fromEntries(
      Object.entries(bundle.definitions).map(([id, definition]) => [
        id,
        {
          ...definition,
          nodes: definition.nodes.map((node) =>
            node.kind === "agent"
              ? Object.fromEntries(Object.entries(node).filter(([key]) => key !== "prompt"))
              : node,
          ),
        },
      ]),
    ),
    schemas: bundle.schemas,
    limits: bundle.limits,
    sourceMap: bundle.sourceMap,
    boundSummary: bundle.boundSummary,
  });
}
