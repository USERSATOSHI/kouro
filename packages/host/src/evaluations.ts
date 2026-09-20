import {
  datasetDigest,
  evaluateBehavior,
  evaluateEfficiency,
  evaluateRunStatus,
  makeEvidence,
  sha256Hex,
  validateExperiment,
  type DatasetDefinition,
  type ExperimentCell,
  type ExperimentDefinition,
  type ExperimentSnapshot,
} from "@kouro/core";
import type { ApplicationService } from "./application/service.ts";
import { runDeterministicCommandEvaluator } from "./evaluation/verifier.ts";

/** Durable experiment orchestration. Cells only point at ordinary Kouro runs. */
export class ExperimentService {
  constructor(private readonly app: ApplicationService) {}

  async create(definition: ExperimentDefinition): Promise<{ id: string; cells: number }> {
    validateExperiment(definition);
    await this.persist(definition);
    return {
      id: definition.id,
      cells: definition.dataset.cases.length * definition.variants.length * definition.repetitions,
    };
  }

  async createDataset(
    dataset: DatasetDefinition,
  ): Promise<{ id: string; version: string; digest: string }> {
    const digest = await datasetDigest(dataset);
    this.app.coordinator.journal.saveDataset({ ...dataset, digest });
    return { id: dataset.id, version: dataset.version, digest };
  }

  listDatasets() {
    return this.app.coordinator.journal.listDatasets();
  }

  private async persist(definition: ExperimentDefinition): Promise<void> {
    this.app.coordinator.journal.saveExperiment({
      definition,
      datasetDigest: await datasetDigest(definition.dataset),
    });
  }

  get(id: string): ExperimentSnapshot | undefined {
    return this.app.coordinator.journal.getExperiment(id);
  }
  list() {
    return this.app.coordinator.journal.listExperiments();
  }
  summary(experimentId: string) {
    const experiment = this.get(experimentId);
    if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
    const succeeded = experiment.cells.filter((cell) => cell.status === "succeeded").length;
    const failed = experiment.cells.filter((cell) => cell.status === "failed").length;
    const cancelled = experiment.cells.filter((cell) => cell.status === "cancelled").length;
    const eligible = succeeded + failed;
    return {
      total: experiment.cells.length,
      succeeded,
      failed,
      cancelled,
      eligible,
      missing: experiment.cells.length - eligible - cancelled,
      sampleSize: eligible,
      successRate: eligible ? succeeded / eligible : null,
    };
  }

  /** Optional scripted judge: a normal linked run, never a second execution engine. */
  async runScriptedJudge(input: {
    experimentId: string;
    cellKey: string;
    candidateRunId: string;
  }): Promise<{ runId: string }> {
    const digest = (await this.app.bundle("tiny")).digest;
    const run = await this.app.createRun({
      workflowId: "tiny",
      idempotencyKey: `judge:${input.experimentId}:${input.cellKey}`,
      executionProfile: "scripted",
      input: {
        __judge: {
          experimentId: input.experimentId,
          cellKey: input.cellKey,
          candidateRunId: input.candidateRunId,
          context: "candidate summary and deterministic evidence",
          usage: { inputTokens: null, outputTokens: null, cost: null },
          workflowDigest: digest,
        },
      },
    });
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const view = this.app.getView(run.runId);
      if (view && !["pending", "running"].includes(view.state.status)) {
        const evidence = await makeEvidence({
          id: `scripted-judge:${input.experimentId}:${input.cellKey}`,
          evaluator: {
            id: "kouro.scripted-judge",
            version: "1",
            sourceDigest: "scripted-judge-v1",
            config: { candidateRunId: input.candidateRunId },
          },
          evidenceClass: "judge-opinion",
          target: { runId: run.runId, revision: view.revision },
          name: "judge.opinion",
          status: view.state.status === "succeeded" ? "passed" : "error",
          value: {
            verdict: view.state.status === "succeeded" ? "acceptable" : "unavailable",
            rationale: "scripted judge fixture",
          },
          provenance: [{ kind: "run", id: input.candidateRunId }],
        });
        this.app.recordEvaluationEvidence(evidence, {
          experimentId: input.experimentId,
          cellKey: input.cellKey,
        });
        return { runId: run.runId };
      }
      await Bun.sleep(5);
    }
    throw new Error(`judge run did not finish: ${run.runId}`);
  }

  async resume(
    experimentId: string,
    options: { actor?: string; maxConcurrent?: number } = {},
  ): Promise<void> {
    const experiment = this.get(experimentId);
    if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
    this.app.coordinator.journal.setExperimentStatus(experimentId, "running");
    const maxConcurrent = Math.max(1, options.maxConcurrent ?? experiment.maxConcurrent);
    const pending = experiment.cells.filter(
      (cell) => cell.status === "pending" || cell.status === "reserved",
    );
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const cell = pending[cursor++];
        if (!cell) return;
        await this.launchCell(experimentId, cell, experiment, options.actor);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, pending.length) }, worker));
    const after = this.get(experimentId);
    if (
      after?.status === "running" &&
      after.cells.every((cell) => ["succeeded", "failed", "cancelled"].includes(cell.status))
    )
      this.app.coordinator.journal.setExperimentStatus(experimentId, "completed");
  }

  cancel(experimentId: string): void {
    const experiment = this.get(experimentId);
    if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
    this.app.coordinator.journal.setExperimentStatus(experimentId, "cancelled");
    for (const cell of experiment.cells) {
      if (["pending", "reserved"].includes(cell.status)) {
        this.app.coordinator.journal.setExperimentCellStatus(experimentId, cell.key, "cancelled");
      } else if (cell.status === "running" && cell.runId) {
        const view = this.app.getView(cell.runId);
        if (view && ["pending", "running"].includes(view.state.status)) {
          try {
            this.app.control({
              runId: cell.runId,
              action: "cancel",
              expectedRevision: view.revision,
              actor: "experiment",
              idempotencyKey: `experiment-cancel:${experimentId}:${cell.key}`,
            });
            this.app.coordinator.journal.setExperimentCellStatus(
              experimentId,
              cell.key,
              "cancelled",
              "cancelled by experiment operator",
            );
          } catch {
            /* another operator may have already cancelled it */
          }
        }
      }
    }
  }

  /** Three cases x three variants x two repetitions: 18 normal runs. */
  static reproducibleFixture(workflowDigest = ""): ExperimentDefinition {
    const dataset: DatasetDefinition = {
      id: "fixture-cases",
      version: "1",
      cases: ["alpha", "beta", "gamma"].map((id) => ({ id, input: { task: `fixture-${id}` } })),
    };
    return {
      id: "fixture-3x3x2",
      dataset,
      repetitions: 2,
      maxConcurrent: 3,
      variants: ["baseline", "quality", "experimental"].map((id) => ({
        id,
        workflowId: "tiny",
        workflowDigest,
        executionProfile: "scripted",
        configuration: { variant: id },
      })),
    };
  }

  private async launchCell(
    experimentId: string,
    cell: ExperimentCell,
    experiment: ExperimentSnapshot,
    actor?: string,
  ): Promise<void> {
    const variants = experiment.variants;
    if (this.get(experimentId)?.status === "cancelled") return;
    const variant = variants.find((item) => item.id === cell.variantId);
    if (!variant) throw new Error(`Variant not found: ${cell.variantId}`);
    if (variant.executionProfile !== "scripted" && variant.executionProfile !== "codex-readonly")
      throw new Error(`Unsupported execution profile: ${variant.executionProfile}`);
    const bundle = await this.app.bundle(variant.workflowId);
    if (bundle.digest !== variant.workflowDigest)
      throw new Error(
        `workflow digest mismatch for variant ${variant.id}: expected ${variant.workflowDigest}, actual ${bundle.digest}`,
      );
    const token = `reservation:${experimentId}:${cell.key}`;
    const reserved = this.app.coordinator.journal.reserveExperimentCell(
      experimentId,
      cell.key,
      token,
    );
    if (!reserved || !["reserved", "running"].includes(reserved.status)) return;
    const run = await this.app.createRun({
      workflowId: variant.workflowId,
      idempotencyKey: `experiment:${experimentId}:${cell.key}`,
      actor,
      executionProfile: variant.executionProfile,
      input: {
        ...this.caseInput(experimentId, cell.caseId),
        __experiment: {
          experimentId,
          cellKey: cell.key,
          variantId: cell.variantId,
          repetition: cell.repetition,
          workflowDigest: variant.workflowDigest,
          executionProfile: variant.executionProfile,
          promptChecksums: variant.promptChecksums ?? {},
          configuration: variant.configuration ?? {},
        },
      },
      workspace: experiment.repositoryPath
        ? { repositoryPath: experiment.repositoryPath }
        : undefined,
    });
    this.app.coordinator.journal.associateExperimentCell(
      experimentId,
      cell.key,
      token,
      run.runId,
      "running",
    );
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if (
        this.get(experimentId)?.cells.find((candidate) => candidate.key === cell.key)?.status ===
        "cancelled"
      )
        return;
      const view = this.app.getView(run.runId);
      if (view && !["pending", "running"].includes(view.state.status)) {
        const target = {
          runId: run.runId,
          revision: view.revision,
          treeDigest: Object.values(view.state.invocations)
            .map((invocation) => invocation.workspace?.treeDigest)
            .find((digest): digest is string => Boolean(digest)),
        };
        const evaluator = {
          id: "kouro.builtin.metrics",
          version: "1",
          sourceDigest: "builtin-metrics-v1",
        };
        for (const evidence of await Promise.all([
          evaluateRunStatus(view, evaluator),
          evaluateBehavior(view, evaluator),
          evaluateEfficiency(view, evaluator),
        ])) {
          this.app.recordEvaluationEvidence(
            { ...evidence, target },
            { experimentId, cellKey: cell.key },
          );
        }
        const datasetCase = experiment.dataset.cases.find((item) => item.id === cell.caseId);
        if (datasetCase?.acceptance) {
          const acceptance = datasetCase.acceptance;
          const acceptanceSourceDigest = await sha256Hex(acceptance.source);
          const snapshot = await this.app.workspaceSnapshot(run.runId);
          const candidateWorkspace = this.app.workspacePath(run.runId);
          let acceptanceEvidence;
          if (!snapshot || !candidateWorkspace) {
            acceptanceEvidence = await makeEvidence({
              id: `${acceptance.id}:${run.runId}:${view.revision}:acceptance`,
              evaluator: {
                id: acceptance.id,
                version: acceptance.version,
                sourceDigest: acceptanceSourceDigest,
                config: acceptance,
              },
              evidenceClass: "deterministic",
              target: { runId: run.runId, revision: view.revision },
              name: "acceptance.command",
              status: "error",
              explanation: "Evaluator requires a repository-backed candidate workspace.",
              completeness: { complete: false, missing: ["candidate-workspace"] },
            });
          } else {
            try {
              const result = await runDeterministicCommandEvaluator({
                evaluator: {
                  id: acceptance.id,
                  version: acceptance.version,
                  sourceDigest: acceptanceSourceDigest,
                  config: acceptance,
                },
                target: {
                  runId: run.runId,
                  revision: view.revision,
                  treeDigest: snapshot.resultTree,
                },
                candidateWorkspace,
                candidateTreeDigest: snapshot.resultTree,
                resolveCandidateTreeDigest: async () =>
                  (await this.app.workspaceSnapshot(run.runId))?.resultTree ?? "",
                verifierWorkspace: `${this.app.coordinator.journal.blobs.root}/verifiers`,
                acceptanceSource: new TextEncoder().encode(acceptance.source),
                executable: acceptance.executable,
                args: acceptance.args,
                timeoutMs: acceptance.timeoutMs,
                artifactSink: this.app.coordinator.journal.blobs,
              });
              acceptanceEvidence = result.evidence;
            } catch (cause) {
              acceptanceEvidence = await makeEvidence({
                id: `${acceptance.id}:${run.runId}:${view.revision}:acceptance`,
                evaluator: {
                  id: acceptance.id,
                  version: acceptance.version,
                  sourceDigest: acceptanceSourceDigest,
                  config: acceptance,
                },
                evidenceClass: "deterministic",
                target: {
                  runId: run.runId,
                  revision: view.revision,
                  treeDigest: snapshot.resultTree,
                },
                name: "acceptance.command",
                status: "error",
                explanation: `Evaluator infrastructure failed: ${String(cause)}`,
                completeness: { complete: false, missing: ["verifier-execution"] },
              });
            }
          }
          this.app.recordEvaluationEvidence(acceptanceEvidence, {
            experimentId,
            cellKey: cell.key,
          });
        }
        this.app.coordinator.journal.setExperimentCellStatus(
          experimentId,
          cell.key,
          view.state.status === "succeeded"
            ? "succeeded"
            : view.state.status === "cancelled"
              ? "cancelled"
              : "failed",
          view.state.status === "succeeded" ? undefined : `run ended ${view.state.status}`,
        );
        return;
      }
      await Bun.sleep(5);
    }
    throw new Error(`experiment cell run did not finish: ${cell.key}`);
  }

  private caseInput(experimentId: string, caseId: string): Record<string, unknown> {
    const experiment = this.get(experimentId);
    const datasetCase = experiment?.dataset.cases.find((item) => item.id === caseId);
    return datasetCase?.input ?? { caseId };
  }
}
