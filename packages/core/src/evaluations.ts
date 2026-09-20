import { canonicalize, sha256Hex } from "./canonical";

export type DatasetCase = {
  id: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Trusted, frozen acceptance source; it is never loaded from the candidate tree. */
  acceptance?: DeterministicAcceptance;
};

export type DeterministicAcceptance = {
  id: string;
  version: string;
  source: string;
  executable: string;
  args?: readonly string[];
  timeoutMs?: number;
};

export type DatasetDefinition = {
  id: string;
  version: string;
  cases: readonly DatasetCase[];
};

export type ExperimentVariant = {
  id: string;
  workflowId: string;
  workflowDigest: string;
  executionProfile: string;
  promptChecksums?: Readonly<Record<string, string>>;
  configuration?: Record<string, unknown>;
};

export type ExperimentStatus = "draft" | "running" | "paused" | "cancelled" | "completed";
export type ExperimentCellStatus =
  | "pending"
  | "reserved"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ExperimentCell = {
  key: string;
  caseId: string;
  variantId: string;
  repetition: number;
  status: ExperimentCellStatus;
  runId?: string;
  error?: string;
};

export type ExperimentDefinition = {
  id: string;
  dataset: DatasetDefinition;
  variants: readonly ExperimentVariant[];
  repetitions: number;
  maxConcurrent?: number;
  /** Local repository used to materialize candidate worktrees for this experiment. */
  repositoryPath?: string;
};

export type ExperimentSnapshot = {
  id: string;
  status: ExperimentStatus;
  dataset: DatasetDefinition;
  variants: readonly ExperimentVariant[];
  repetitions: number;
  maxConcurrent: number;
  repositoryPath?: string;
  cells: readonly ExperimentCell[];
};

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
}

export function validateDataset(dataset: DatasetDefinition): DatasetDefinition {
  nonEmpty(dataset.id, "dataset.id");
  nonEmpty(dataset.version, "dataset.version");
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0)
    throw new Error("dataset.cases must not be empty");
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    nonEmpty(item.id, "dataset case id");
    if (ids.has(item.id)) throw new Error(`duplicate dataset case: ${item.id}`);
    ids.add(item.id);
    if (!item.input || typeof item.input !== "object" || Array.isArray(item.input))
      throw new Error(`dataset case ${item.id} input must be an object`);
  }
  return dataset;
}

export function validateExperiment(definition: ExperimentDefinition): ExperimentDefinition {
  nonEmpty(definition.id, "experiment.id");
  validateDataset(definition.dataset);
  if (!Number.isInteger(definition.repetitions) || definition.repetitions < 1)
    throw new Error("repetitions must be a positive integer");
  if (!Array.isArray(definition.variants) || definition.variants.length === 0)
    throw new Error("variants must not be empty");
  const ids = new Set<string>();
  for (const variant of definition.variants) {
    nonEmpty(variant.id, "variant.id");
    nonEmpty(variant.workflowId, "variant.workflowId");
    nonEmpty(variant.workflowDigest, "variant.workflowDigest");
    nonEmpty(variant.executionProfile, "variant.executionProfile");
    if (ids.has(variant.id)) throw new Error(`duplicate variant: ${variant.id}`);
    ids.add(variant.id);
  }
  if (
    definition.maxConcurrent !== undefined &&
    (!Number.isInteger(definition.maxConcurrent) || definition.maxConcurrent < 1)
  )
    throw new Error("maxConcurrent must be a positive integer");
  return definition;
}

export function experimentCellKey(caseId: string, variantId: string, repetition: number): string {
  return `${caseId}::${variantId}::${repetition}`;
}

export function datasetDigest(dataset: DatasetDefinition): Promise<string> {
  return sha256Hex(canonicalize(dataset));
}
