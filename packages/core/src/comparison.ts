import { canonicalize, sha256Hex } from "./canonical";

/** A durable reference to one run at an immutable projection revision. */
export interface ComparisonRunRef {
  readonly runId: string;
  readonly revision: number;
  readonly label?: string;
}

export interface ComparisonNodeSpan {
  readonly runId: string;
  readonly nodeKey: string;
  readonly label: string;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly status: string;
  readonly attempt?: number;
}

export interface ComparisonAnchor {
  readonly id: string;
  readonly leftNodeKey: string;
  readonly rightNodeKey: string;
  readonly kind: "start" | "invocation" | "explicit" | "node-id" | "label";
}

export interface RunComparisonRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly runs: readonly ComparisonRunRef[];
  readonly anchors: readonly ComparisonAnchor[];
  readonly evidenceRevision: number;
}

/** Timeline DTO intentionally keeps a row for a missing stage instead of shifting stages. */
export interface ComparisonTimelineRow {
  readonly anchorId: string;
  readonly label: string;
  readonly spans: readonly (ComparisonNodeSpan | null)[];
}

export interface ComparisonTimelineDto {
  readonly comparisonId: string;
  readonly runs: readonly ComparisonRunRef[];
  readonly anchors: readonly ComparisonAnchor[];
  readonly rows: readonly ComparisonTimelineRow[];
  readonly scale: {
    readonly startAt: string | null;
    readonly endAt: string | null;
    readonly durationMs: number | null;
  };
}

export function buildComparisonTimeline(
  record: RunComparisonRecord,
  spans: readonly ComparisonNodeSpan[],
): ComparisonTimelineDto {
  const byRunNode = new Map(spans.map((span) => [`${span.runId}:${span.nodeKey}`, span]));
  const dates = spans
    .flatMap((span) => [span.startAt, span.endAt])
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  const start = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
  const end = dates.length ? new Date(Math.max(...dates)).toISOString() : null;
  return {
    comparisonId: record.id,
    runs: record.runs,
    anchors: record.anchors,
    rows: record.anchors.map((anchor) => ({
      anchorId: anchor.id,
      label: anchor.id,
      spans: record.runs.map((run, index) => {
        const nodeKey = index === 0 ? anchor.leftNodeKey : anchor.rightNodeKey;
        return byRunNode.get(`${run.runId}:${nodeKey}`) ?? null;
      }),
    })),
    scale: {
      startAt: start,
      endAt: end,
      durationMs: start && end ? Date.parse(end) - Date.parse(start) : null,
    },
  };
}

export type PairwiseChoice = "a" | "b" | "tie" | "abstain";
export interface PairwiseAssignment {
  readonly id: string;
  readonly comparisonId: string;
  readonly runA: ComparisonRunRef;
  readonly runB: ComparisonRunRef;
  readonly sideA: string;
  readonly sideB: string;
  readonly rubric: unknown;
  readonly eligibleActor: string;
  readonly evidenceRevision: number;
  readonly artifactLeakageRisk: readonly string[];
  readonly assignedAt: string;
  readonly decidedAt?: string;
}

export interface BlindedPairwiseDto {
  readonly assignmentId: string;
  readonly comparisonId: string;
  readonly sides: readonly { sideId: string; evidence: readonly unknown[] }[];
  readonly rubric: unknown;
  readonly artifactLeakageRisk: readonly string[];
  readonly decided: boolean;
}

export interface PairwiseDecision {
  readonly id: string;
  readonly assignmentId: string;
  readonly choice: PairwiseChoice;
  readonly actor: string;
  readonly reason?: string;
  readonly recordedAt: string;
  readonly correctionOf?: string;
}

export function blindedDto(
  assignment: PairwiseAssignment,
  evidence: { sideA: readonly unknown[]; sideB: readonly unknown[] },
  decided: boolean,
): BlindedPairwiseDto {
  return {
    assignmentId: assignment.id,
    comparisonId: assignment.comparisonId,
    sides: [
      { sideId: assignment.sideA, evidence: evidence.sideA },
      { sideId: assignment.sideB, evidence: evidence.sideB },
    ],
    rubric: assignment.rubric,
    artifactLeakageRisk: assignment.artifactLeakageRisk,
    decided,
  };
}

export function comparisonDigest(record: Omit<RunComparisonRecord, "id">): Promise<string> {
  return sha256Hex(canonicalize(record));
}
