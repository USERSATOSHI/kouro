import { Grid, SimpleGrid } from "@mantine/core";
import { PageHeader } from "./components/WorkbenchPrimitives";
import type { ReactNode } from "react";
import { Badge, Drawer, Tabs, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { stateColor } from "./theme";
import {
  Box,
  Button,
  Code,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";

export type EvalCellStatus =
  | "pending"
  | "reserved"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "evaluator-error";
export type EvidenceKind = "deterministic" | "workflow" | "efficiency" | "judge" | "human";

export interface EvalEvidence {
  kind: EvidenceKind;
  label: string;
  value: string;
  detail?: string;
  confidence?: "high" | "medium" | "low";
}
export interface EvalCell {
  id: string;
  caseId: string;
  variantId: string;
  repetition: number;
  status: EvalCellStatus;
  runId?: string;
  durationMs?: number;
  score?: number;
  evidence?: EvalEvidence[];
  error?: string;
}
export type AcceptanceStatus = "passed" | "failed" | "unavailable" | "error" | "missing";
export interface EvalCase {
  id: string;
  label: string;
  description?: string;
  input?: unknown;
  acceptance?: unknown;
}
export interface EvalVariant {
  id: string;
  label: string;
  workflow: string;
  profile: string;
}
export interface EvalExperiment {
  id: string;
  name: string;
  status?: "draft" | "running" | "paused" | "cancelled" | "completed";
  dataset: string;
  createdAt: string;
  cases: EvalCase[];
  variants: EvalVariant[];
  cells: EvalCell[];
}
export interface BlindedPairwise {
  id: string;
  evidence?: Array<{ side: string; items?: EvalEvidence[] }>;
  /** Side ids are ordered as the durable assignment's A and B options. */
  sides?: string[];
  decision?: { choice: "a" | "b" | "tie" | "abstain"; reason?: string };
  revealed?: boolean;
  /** Populated only from the post-decision server assignment. */
  revealMap?: Record<string, string>;
}
export interface ComparisonRun {
  runId: string;
  label: string;
  variant: string;
  color: string;
  spans: Array<{
    label: string;
    startMs: number;
    endMs?: number;
    state?: "running" | "succeeded" | "failed";
  }>;
}
export interface ComparisonTimeline {
  comparisonId: string;
  rows: Array<{ anchorId: string; label: string; spans: Array<Record<string, unknown> | null> }>;
  runs: Array<{ runId: string }>;
  scale: { durationMs: number | null; startAt?: string | null; endAt?: string | null };
}

export const M5_FIXTURE: EvalExperiment = {
  id: "exp_feature-repair-01",
  name: "Feature repair strategies",
  dataset: "feature-regressions / 12 cases",
  createdAt: "2026-09-19T08:30:00.000Z",
  cases: [
    {
      id: "export",
      label: "export feature",
      description: "Preserve generated exports after repair",
    },
    { id: "race", label: "retry race", description: "Reproduce a concurrent retry" },
    { id: "cache", label: "cache refactor", description: "Avoid stale cache reads" },
    { id: "migration", label: "migration", description: "Validate a forward-only migration" },
  ],
  variants: [
    { id: "baseline", label: "Baseline", workflow: "feature@a", profile: "balanced" },
    { id: "fusion", label: "Fusion", workflow: "feature@a", profile: "planner-fusion" },
    { id: "fusion-qa", label: "Fusion + QA", workflow: "feature@a", profile: "planner-fusion-qa" },
  ],
  cells: [
    {
      id: "export-baseline",
      caseId: "export",
      variantId: "baseline",
      repetition: 1,
      status: "succeeded",
      runId: "run_export_base",
      durationMs: 128000,
      score: 0.96,
      evidence: [
        { kind: "deterministic", label: "tests", value: "24 / 24", detail: "passed" },
        { kind: "efficiency", label: "wall time", value: "2m 08s" },
      ],
    },
    {
      id: "export-fusion",
      caseId: "export",
      variantId: "fusion",
      repetition: 1,
      status: "succeeded",
      runId: "run_export_fusion",
      durationMs: 182000,
      score: 1,
      evidence: [
        { kind: "deterministic", label: "tests", value: "24 / 24" },
        { kind: "workflow", label: "repairs", value: "0" },
      ],
    },
    {
      id: "export-qa",
      caseId: "export",
      variantId: "fusion-qa",
      repetition: 1,
      status: "running",
      runId: "run_export_qa",
      durationMs: 69000,
      evidence: [{ kind: "workflow", label: "active node", value: "qa" }],
    },
    {
      id: "race-baseline",
      caseId: "race",
      variantId: "baseline",
      repetition: 1,
      status: "failed",
      runId: "run_race_base",
      durationMs: 93000,
      score: 0,
      error: "tests failed: race condition",
      evidence: [{ kind: "deterministic", label: "tests", value: "22 / 24", detail: "2 failed" }],
    },
    {
      id: "race-fusion",
      caseId: "race",
      variantId: "fusion",
      repetition: 1,
      status: "succeeded",
      runId: "run_race_fusion",
      durationMs: 249000,
      score: 0.92,
      evidence: [
        { kind: "deterministic", label: "tests", value: "24 / 24" },
        { kind: "workflow", label: "repairs", value: "1" },
        { kind: "judge", label: "review", value: "0.92", confidence: "medium" },
      ],
    },
    {
      id: "race-qa",
      caseId: "race",
      variantId: "fusion-qa",
      repetition: 1,
      status: "evaluator-error",
      runId: "run_race_qa",
      durationMs: 201000,
      error: "judge evaluator timed out",
      evidence: [
        { kind: "deterministic", label: "tests", value: "24 / 24" },
        { kind: "judge", label: "review", value: "unavailable", detail: "timeout" },
      ],
    },
    {
      id: "cache-baseline",
      caseId: "cache",
      variantId: "baseline",
      repetition: 1,
      status: "succeeded",
      runId: "run_cache_base",
      durationMs: 154000,
      score: 0.84,
      evidence: [{ kind: "deterministic", label: "tests", value: "18 / 18" }],
    },
    {
      id: "cache-fusion",
      caseId: "cache",
      variantId: "fusion",
      repetition: 1,
      status: "cancelled",
      durationMs: 37000,
      error: "cancelled by operator",
    },
    {
      id: "cache-qa",
      caseId: "cache",
      variantId: "fusion-qa",
      repetition: 1,
      status: "succeeded",
      runId: "run_cache_qa",
      durationMs: 281000,
      score: 0.98,
      evidence: [
        { kind: "deterministic", label: "tests", value: "18 / 18" },
        { kind: "human", label: "annotation", value: "safe" },
      ],
    },
    {
      id: "migration-baseline",
      caseId: "migration",
      variantId: "baseline",
      repetition: 1,
      status: "pending",
    },
    {
      id: "migration-fusion",
      caseId: "migration",
      variantId: "fusion",
      repetition: 1,
      status: "pending",
    },
    {
      id: "migration-qa",
      caseId: "migration",
      variantId: "fusion-qa",
      repetition: 1,
      status: "pending",
    },
  ],
};

const STATUS_LABEL: Record<EvalCellStatus, string> = {
  pending: "pending",
  reserved: "reserved",
  running: "running",
  succeeded: "pass",
  failed: "failed",
  cancelled: "cancelled",
  "evaluator-error": "eval error",
};
const STATUS_ICON: Record<EvalCellStatus, string> = {
  pending: "·",
  reserved: "·",
  running: "◌",
  succeeded: "✓",
  failed: "×",
  cancelled: "—",
  "evaluator-error": "!",
};

export function cellFor(
  experiment: EvalExperiment,
  caseId: string,
  variantId: string,
  repetition = 1,
) {
  return experiment.cells.find(
    (cell) =>
      cell.caseId === caseId && cell.variantId === variantId && cell.repetition === repetition,
  );
}
export function cellStatusSummary(cells: EvalCell[]) {
  return cells.reduce<Record<EvalCellStatus, number>>(
    (out, cell) => {
      out[cell.status] += 1;
      return out;
    },
    {
      pending: 0,
      reserved: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      "evaluator-error": 0,
    },
  );
}

/** Execution and acceptance are separate observations; absent scores are not failures. */
export function acceptanceStatus(cell: EvalCell): AcceptanceStatus {
  const acceptance = (cell.evidence ?? []).find(
    (item) => item.label.toLowerCase().includes("accept") || item.kind === "judge",
  );
  if (!acceptance) return "missing";
  const value = acceptance.value.toLowerCase();
  if (value === "unavailable" || value === "missing") return "unavailable";
  if (value === "error" || acceptance.detail?.toLowerCase().includes("error")) return "error";
  if (value.includes("fail") || value.includes("reject")) return "failed";
  if (value.includes("pass") || value.includes("accept") || value === "true") return "passed";
  return "unavailable";
}

export function evaluationSummary(cells: EvalCell[]) {
  return cells.reduce(
    (summary, cell) => {
      if (cell.status === "succeeded") summary.executionSucceeded += 1;
      else if (cell.status === "failed") summary.executionFailed += 1;
      else if (cell.status === "evaluator-error") summary.evaluatorErrors += 1;
      summary.acceptance[acceptanceStatus(cell)] += 1;
      return summary;
    },
    {
      executionSucceeded: 0,
      executionFailed: 0,
      evaluatorErrors: 0,
      acceptance: { passed: 0, failed: 0, unavailable: 0, error: 0, missing: 0 } as Record<
        AcceptanceStatus,
        number
      >,
    },
  );
}

export function formatEvidenceValue(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
        .join(" · ");
    }
  } catch {
    // Plain evidence values are already readable.
  }
  return value;
}

/** Compare distinct variants for the same case/repetition when available. */
export function completedComparisonRuns(experiment: EvalExperiment): string[] {
  const cells = experiment.cells.filter((cell) => cell.status === "succeeded" && cell.runId);
  const left = cells[0];
  if (!left) return [];
  const right =
    cells.find(
      (cell) =>
        cell.runId !== left.runId &&
        cell.variantId !== left.variantId &&
        cell.caseId === left.caseId &&
        cell.repetition === left.repetition,
    ) ??
    cells.find((cell) => cell.runId !== left.runId && cell.variantId !== left.variantId) ??
    cells.find((cell) => cell.runId !== left.runId);
  return right ? [left.runId!, right.runId!] : [left.runId!];
}

export function M5Workbench({
  experiment,
  onOpenRun,
  onResume,
  onCancel,
  pairwise,
  onPairwiseStart,
  onPairwiseChoice,
  comparisonTimeline,
  comparisonTimelineError,
  onLoadEvidence,
  experiments,
  onSelectExperiment,
  onCompare,
  comparisonPicker,
  creator,
}: {
  comparisonPicker?: ReactNode;
  creator?: ReactNode;
  experiment: EvalExperiment;
  onOpenRun?: (runId: string) => void;
  onResume?: () => void;
  onCancel?: () => void;
  pairwise?: BlindedPairwise;
  onPairwiseStart?: () => void;
  onPairwiseChoice?: (choice: "a" | "b" | "tie" | "abstain") => void;
  comparisonTimeline?: ComparisonTimeline;
  comparisonTimelineError?: string;
  onLoadEvidence?: (cellKey: string) => Promise<EvalEvidence[]>;
  experiments?: Array<{ id: string; name: string }>;
  onSelectExperiment?: (id: string) => void;
  onCompare?: () => void;
}) {
  const [selected, setSelected] = useState<EvalCell>();
  const [reveal, setReveal] = useState(false);
  const [showDataset, setShowDataset] = useState(false);
  const [loadedEvidence, setLoadedEvidence] = useState<Record<string, EvalEvidence[]>>({});
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string>();
  const summary = cellStatusSummary(experiment.cells);
  const evaluation = evaluationSummary(experiment.cells);
  useEffect(() => {
    setSelected(undefined);
    setLoadedEvidence({});
    setEvidenceError(undefined);
  }, [experiment.id]);
  useEffect(() => {
    if (!selected || !onLoadEvidence || loadedEvidence[selected.id]) return;
    let cancelled = false;
    setEvidenceLoading(true);
    setEvidenceError(undefined);
    void onLoadEvidence(selected.id)
      .then((items) => {
        if (!cancelled) setLoadedEvidence((current) => ({ ...current, [selected.id]: items }));
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setEvidenceError(cause instanceof Error ? cause.message : "Unable to load evidence");
      })
      .finally(() => {
        if (!cancelled) setEvidenceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, onLoadEvidence, loadedEvidence]);
  return (
    <Stack gap={0} component="section" data-testid="eval-workbench">
      <PageHeader
        actions={
          <Group gap="sm">
            <Button onClick={() => setShowDataset((value) => !value)}>
              {showDataset ? "Hide dataset" : "Inspect dataset"}
            </Button>
            {experiment.status === "running" && onCancel ? (
              <Button onClick={onCancel}>Cancel</Button>
            ) : onResume ? (
              <Button variant="filled" onClick={onResume}>
                Run pending cells
              </Button>
            ) : null}
          </Group>
        }
      >
        Evaluations / {experiment.name}
      </PageHeader>
      <Grid p="lg" gap="lg">
        <Grid.Col span={{ base: 12, xl: 7 }}>
          <Stack gap="lg">
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                RESULT MATRIX
              </Text>
              {experiments && experiments.length > 1 && (
                <NativeSelect
                  aria-label="Experiment"
                  value={experiment.id}
                  onChange={(event) => onSelectExperiment?.(event.currentTarget.value)}
                  data={experiments.map((item) => ({ value: item.id, label: item.name }))}
                />
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {experiment.dataset} · {new Date(experiment.createdAt).toLocaleDateString()}
            </Text>
            <Group gap="xs" aria-label="experiment status">
              {Object.entries(summary).map(([status, count]) => (
                <Badge key={status} color={stateColor(status)} variant="light">
                  {count} {status}
                </Badge>
              ))}
            </Group>
            <Text size="xs" c="dimmed" aria-label="evaluation outcome summary">
              {evaluation.executionSucceeded} execution succeeded · {evaluation.acceptance.passed}{" "}
              acceptance passed · {evaluation.acceptance.failed} acceptance failed ·{" "}
              {evaluation.acceptance.missing + evaluation.acceptance.unavailable} acceptance
              unavailable · {evaluation.evaluatorErrors} evaluator errors
            </Text>
            <MatrixView
              experiment={experiment}
              selected={selected}
              onSelect={setSelected}
              onOpenRun={onOpenRun}
            />
            {selected ? (
              <EvidenceDetail
                embedded
                cell={{ ...selected, evidence: loadedEvidence[selected.id] ?? selected.evidence }}
                onOpenRun={onOpenRun}
                loading={evidenceLoading}
                error={evidenceError}
                onClose={() => setSelected(undefined)}
              />
            ) : (
              <Paper>
                <Text size="sm" c="dimmed">
                  Select a matrix cell to inspect execution, acceptance checks and evidence
                  separately.
                </Text>
              </Paper>
            )}
            {showDataset && (
              <Paper>
                <Stack>
                  <Title order={3}>Dataset cases & acceptance</Title>
                  <Code block>{JSON.stringify(experiment.cases, null, 2)}</Code>
                </Stack>
              </Paper>
            )}
            {creator}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, xl: 5 }}>
          <Stack gap="lg">
            <Text size="xs" c="dimmed">
              TIMELINE COMPARE
            </Text>
            {comparisonPicker}
            {onCompare && (
              <Button
                disabled={
                  new Set(
                    experiment.cells
                      .filter((cell) => cell.status === "succeeded" && cell.runId)
                      .map((cell) => cell.runId),
                  ).size < 2
                }
                onClick={onCompare}
              >
                Compare completed cells
              </Button>
            )}
            <TimelineCompare timeline={comparisonTimeline} error={comparisonTimelineError} />
            <PairwiseReview
              experiment={experiment}
              reveal={reveal || pairwise?.revealed === true}
              setReveal={setReveal}
              pairwise={pairwise}
              onStart={onPairwiseStart}
              onChoice={onPairwiseChoice}
              onOpenRun={onOpenRun}
            />
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function MatrixView({
  experiment,
  selected,
  onSelect,
  onOpenRun,
}: {
  experiment: EvalExperiment;
  selected?: EvalCell;
  onSelect: (cell: EvalCell) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [repetition, setRepetition] = useState(1);
  return (
    <Paper className="m5-panel matrix-panel">
      <Stack gap="md">
        <Group gap="sm" justify="space-between" mb="md" className="m5-panel-heading">
          <Stack gap="xs">
            <Text component="span" size="sm" fw={600}>
              EXPERIMENT MATRIX
            </Text>
            <Text component="span" size="sm">
              click a cell to inspect evidence
            </Text>
          </Stack>
          <Stack gap={4} component="label" className="compact-select">
            REPETITIONS{" "}
            <NativeSelect
              aria-label="Repetition"
              value={repetition}
              onChange={(event) => setRepetition(Number(event.currentTarget.value))}
            >
              {[...new Set(experiment.cells.map((cell) => cell.repetition))]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
            </NativeSelect>
          </Stack>
        </Group>
        <Box maw="100%" mah={400} style={{ overflow: "auto" }} className="matrix-scroll">
          <Table className="eval-matrix">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>CASE</Table.Th>
                {experiment.variants.map((variant) => (
                  <Table.Th key={variant.id}>
                    <Text size="sm" fw={600}>
                      {variant.label}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {variant.profile}
                    </Text>
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {experiment.cases.map((testCase) => (
                <Table.Tr key={testCase.id}>
                  <Table.Th>
                    <Text component="span" size="sm" fw={600}>
                      {testCase.label}
                    </Text>
                    <Text component="span" size="xs" c="dimmed">
                      {testCase.description}
                    </Text>
                  </Table.Th>
                  {experiment.variants.map((variant) => {
                    const cell = cellFor(experiment, testCase.id, variant.id, repetition);
                    return (
                      <Table.Td key={variant.id}>
                        {cell ? (
                          <Stack gap={5}>
                            <Button
                              h="auto"
                              py="sm"
                              fullWidth
                              variant={selected?.id === cell.id ? "light" : "default"}
                              color={stateColor(cell.status)}
                              className={`eval-cell ${cell.status} ${selected?.id === cell.id ? "selected" : ""}`}
                              onClick={() => onSelect(cell)}
                            >
                              <Stack gap={4}>
                                <Text size="sm" fw={600}>
                                  {STATUS_ICON[cell.status]} {STATUS_LABEL[cell.status]}
                                </Text>
                                <Text size="xs" c="dimmed">
                                  {cell.score === undefined
                                    ? (cell.error ??
                                      (cell.status === "running" ? "in progress" : "not started"))
                                    : `${Math.round(cell.score * 100)}% · ${duration(cell.durationMs)}`}
                                </Text>
                              </Stack>
                            </Button>
                            {cell.runId && onOpenRun && (
                              <Button
                                variant="subtle"
                                size="compact-xs"
                                onClick={() => onOpenRun(cell.runId!)}
                              >
                                Open run ↗
                              </Button>
                            )}
                          </Stack>
                        ) : (
                          <Text component="span" size="sm" className="empty-cell">
                            —
                          </Text>
                        )}
                      </Table.Td>
                    );
                  })}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      </Stack>
    </Paper>
  );
}

function EvidenceDetail({
  cell,
  onOpenRun,
  onClose,
  loading,
  error,
  embedded = false,
}: {
  embedded?: boolean;
  cell: EvalCell;
  onOpenRun?: (runId: string) => void;
  onClose: () => void;
  loading?: boolean;
  error?: string;
}) {
  const mobile = useMediaQuery("(max-width: 48em)");
  const grouped = useMemo(
    () =>
      (cell.evidence ?? []).reduce<Record<EvidenceKind, EvalEvidence[]>>(
        (out, item) => {
          (out[item.kind] ??= []).push(item);
          return out;
        },
        { deterministic: [], workflow: [], efficiency: [], judge: [], human: [] },
      ),
    [cell.evidence],
  );
  const contents = (
    <Stack gap="md" className="m5-detail" data-testid="evidence-detail">
      <Group gap="xs" justify="space-between" wrap="wrap" className="m5-detail-heading">
        <Stack gap="xs">
          <Text component="span" size="sm" className={`m5-status ${cell.status}`}>
            {STATUS_ICON[cell.status]}
          </Text>
          <Text component="span" size="sm" fw={600}>
            {cell.caseId} / {cell.variantId}
          </Text>
          <Text component="span" size="xs" c="dimmed">
            repetition {cell.repetition} · {STATUS_LABEL[cell.status]}
          </Text>
        </Stack>
        <Button aria-label="Close evidence" onClick={onClose}>
          ×
        </Button>
      </Group>
      {cell.error && (
        <Stack gap="xs" className="m5-error">
          {cell.error}
        </Stack>
      )}
      {error && (
        <Stack gap="xs" className="m5-error" role="alert">
          {error}
        </Stack>
      )}
      {(["deterministic", "workflow", "efficiency", "judge", "human"] as EvidenceKind[]).map(
        (kind) => (
          <Stack gap="xs" component="section" className={`evidence-group ${kind}`} key={kind}>
            <Title order={3}>
              {kind}{" "}
              <Text component="span" size="sm">
                {kind === "judge" || kind === "human" ? "subjective" : "recorded"}
              </Text>
            </Title>
            {grouped[kind].length ? (
              grouped[kind].map((item) => (
                <Stack gap="xs" className="m5-evidence-row" key={`${item.label}-${item.value}`}>
                  <Text component="span" size="sm">
                    {item.label}
                  </Text>
                  <Text component="span" size="sm" fw={600}>
                    {formatEvidenceValue(item.value)}
                  </Text>
                  {item.detail && (
                    <Text component="span" size="xs" c="dimmed">
                      {item.detail}
                    </Text>
                  )}
                </Stack>
              ))
            ) : (
              <Text size="sm" className="pending-copy">
                {loading ? "Loading evidence…" : `No ${kind} evidence recorded.`}
              </Text>
            )}
          </Stack>
        ),
      )}
      {cell.runId && (
        <Button className="subtle-button" onClick={() => onOpenRun?.(cell.runId!)}>
          Open normal run {cell.runId.slice(0, 14)} ↗
        </Button>
      )}
    </Stack>
  );
  return embedded && !mobile ? (
    <Paper>{contents}</Paper>
  ) : (
    <Drawer
      opened
      onClose={onClose}
      title="Evaluation evidence"
      position="right"
      size={mobile ? "100%" : 480}
    >
      {contents}
    </Drawer>
  );
}

function TimelineCompare({ timeline, error }: { timeline?: ComparisonTimeline; error?: string }) {
  const max = Math.max(timeline?.scale.durationMs ?? 0, 1);
  const dates = (timeline?.rows ?? [])
    .flatMap((row) =>
      row.spans.flatMap((span) =>
        span && typeof span.startAt === "string" ? [Date.parse(span.startAt)] : [],
      ),
    )
    .filter(Number.isFinite);
  const start = timeline?.scale.startAt
    ? Date.parse(timeline.scale.startAt)
    : dates.length
      ? Math.min(...dates)
      : 0;
  return (
    <Paper className="m5-panel compare-panel">
      <Stack gap="md">
        <Group justify="space-between">
          <Stack gap={4}>
            <Title order={3}>Shared-scale timeline</Title>
            <Text size="xs" c="dimmed">
              Durable aligned stages · {timeline?.runs.length ?? 0} selected runs
            </Text>
          </Stack>
          <Badge variant="light">{duration(max)}</Badge>
        </Group>
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            0s
          </Text>
          <Text size="xs" c="dimmed">
            {duration(max / 2)}
          </Text>
          <Text size="xs" c="dimmed">
            {duration(max)}
          </Text>
        </Group>
        {(timeline?.rows ?? []).map((row) => (
          <Paper key={row.anchorId} p="sm">
            <Stack gap="sm">
              <Group>
                <Text fw={600} size="sm">
                  {row.label}
                </Text>
                <Code>{row.anchorId}</Code>
              </Group>
              {row.spans.map((span, index) => {
                const from =
                  span && typeof span.startAt === "string" ? Date.parse(span.startAt) : NaN;
                const to = span && typeof span.endAt === "string" ? Date.parse(span.endAt) : NaN;
                const known = Number.isFinite(from) && Number.isFinite(to);
                return (
                  <Group key={`${row.anchorId}-${index}`} wrap="nowrap">
                    <Text size="xs" c="dimmed" w={80} truncate title={timeline?.runs[index]?.runId}>
                      Run {index + 1}
                    </Text>
                    <Box flex={1} pos="relative" h={34} bg="var(--mantine-color-default-hover)">
                      {span && known ? (
                        <Tooltip
                          label={`${String(span.label ?? row.label)} · ${String(span.status ?? "observed")} · ${duration(to - from)}`}
                        >
                          <Paper
                            p={4}
                            pos="absolute"
                            left={`${Math.max(0, ((from - start) / max) * 100)}%`}
                            w={`${Math.max(0.5, Math.min(100, ((to - from) / max) * 100))}%`}
                            h={34}
                            bg={`var(--mantine-color-${stateColor(String(span.status))}-light)`}
                          >
                            <Text size="xs" truncate>
                              {String(span.status ?? "observed")}
                            </Text>
                          </Paper>
                        </Tooltip>
                      ) : (
                        <Text size="xs" c="dimmed" p={8}>
                          {span ? "Timing unavailable" : "Missing stage"}
                        </Text>
                      )}
                    </Box>
                  </Group>
                );
              })}
            </Stack>
          </Paper>
        ))}
        {!timeline && (
          <Text size="sm" c="dimmed">
            Compare at least two completed runs to load aligned stages.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function PairwiseReview({
  experiment,
  reveal,
  setReveal,
  pairwise,
  onStart,
  onChoice,
  onOpenRun,
}: {
  experiment: EvalExperiment;
  reveal: boolean;
  setReveal: (value: boolean) => void;
  pairwise?: BlindedPairwise;
  onStart?: () => void;
  onChoice?: (choice: "a" | "b" | "tie" | "abstain") => void;
  onOpenRun?: (runId: string) => void;
}) {
  const options = experiment.variants.slice(0, 2);
  const testCase = experiment.cases[0];
  if (!testCase)
    return (
      <Paper>
        <Text c="dimmed" size="sm">
          Pairwise review requires a dataset case.
        </Text>
      </Paper>
    );
  return (
    <Paper className="m5-panel pairwise-panel">
      <Stack gap="md">
        <Group gap="sm" justify="space-between" mb="md" className="m5-panel-heading">
          <Stack gap="xs">
            <Text component="span" size="sm" fw={600}>
              BLINDED PAIRWISE REVIEW
            </Text>
            <Text component="span" size="sm">
              {testCase.label} · identities remain hidden until a durable decision
            </Text>
          </Stack>
          {pairwise ? (
            <Button
              className="subtle-button"
              disabled={!pairwise.decision}
              onClick={() => setReveal(!reveal)}
            >
              {reveal ? "Hide identities" : "Reveal identities"}
            </Button>
          ) : (
            <Button variant="filled" className="primary-cta compact" onClick={onStart}>
              Start review
            </Button>
          )}
        </Group>
        <Stack gap="xs" className="blind-note">
          Choose based on evidence, diff, and tests. Variant/model names are withheld to reduce
          preference bias.
        </Stack>
        <SimpleGrid cols={{ base: 1, md: 2 }} className="pair-cards">
          {options.map((variant, index) => {
            const sideId = pairwise?.sides?.[index] ?? `side-redacted-${index + 1}`;
            const assignedVariant = reveal ? pairwise?.revealMap?.[sideId] : undefined;
            const revealedVariant = experiment.variants.find((item) => item.id === assignedVariant);
            const cell = assignedVariant
              ? cellFor(experiment, testCase.id, assignedVariant)
              : pairwise
                ? undefined
                : cellFor(experiment, testCase.id, variant.id);
            const evidence = pairwise?.evidence?.find((item) => item.side === sideId)?.items;
            return (
              <Paper component="article" className="pair-card" key={variant.id}>
                <Stack gap="md">
                  <Group gap="xs" justify="space-between" wrap="wrap" component="header">
                    <Text component="span" size="sm">
                      OPTION {index === 0 ? "A" : "B"}
                    </Text>
                    {revealedVariant && (
                      <Text component="span" size="xs" c="dimmed">
                        {revealedVariant.label} · {revealedVariant.profile}
                      </Text>
                    )}
                  </Group>
                  <Text component="span" size="sm" fw={600}>
                    {pairwise && !cell
                      ? "Blinded run"
                      : cell?.status === "succeeded"
                        ? `Run ${STATUS_LABEL[cell.status]}`
                        : STATUS_LABEL[cell?.status ?? "pending"]}
                  </Text>
                  <Text size="sm">
                    {evidence
                      ?.map((item) => `${item.label}: ${formatEvidenceValue(item.value)}`)
                      .join(" · ") ??
                      cell?.evidence
                        ?.map((item) => `${item.label}: ${formatEvidenceValue(item.value)}`)
                        .join(" · ") ??
                      "No evidence available"}
                  </Text>
                  <Text component="span" size="xs" c="dimmed" className="pair-acceptance">
                    {pairwise && !cell
                      ? "Pinned evidence snapshot"
                      : `Acceptance: ${acceptanceLabel(cell ? acceptanceStatus(cell) : "missing")}`}
                  </Text>
                  {cell?.runId && (
                    <Button className="diff-link" onClick={() => onOpenRun?.(cell.runId!)}>
                      Inspect run ↗
                    </Button>
                  )}
                </Stack>
              </Paper>
            );
          })}
        </SimpleGrid>
        <Group gap="xs" justify="space-between" wrap="wrap" className="pair-actions">
          <Button className="pair-choice" disabled={!pairwise} onClick={() => onChoice?.("a")}>
            A better
          </Button>
          <Button className="pair-choice" disabled={!pairwise} onClick={() => onChoice?.("tie")}>
            Tie
          </Button>
          <Button className="pair-choice" disabled={!pairwise} onClick={() => onChoice?.("b")}>
            B better
          </Button>
          <Button
            className="pair-choice muted-choice"
            disabled={!pairwise}
            onClick={() => onChoice?.("abstain")}
          >
            Abstain
          </Button>
        </Group>
        <Text size="sm" className="pending-copy">
          {pairwise?.decision
            ? `Decision recorded: ${pairwise.decision.choice}.`
            : "Your decision is saved as human evidence and reveals identity only after the journal accepts it."}
        </Text>
      </Stack>
    </Paper>
  );
}

function acceptanceLabel(status: AcceptanceStatus): string {
  return status === "missing" ? "not provided" : status;
}

function duration(ms?: number) {
  if (!ms || ms < 1000) return "—";
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
}
