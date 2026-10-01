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
  scale: { durationMs: number | null };
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
}: {
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
  const [tab, setTab] = useState<"matrix" | "timeline" | "pairwise">("matrix");
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
    <section className="m5-workbench" data-testid="eval-workbench">
      <header className="m5-header">
        <div>
          <div className="eyebrow">EVALUATION WORKBENCH</div>
          <h1>{experiment.name}</h1>
          <p>
            {experiment.dataset} <span>·</span>{" "}
            {new Date(experiment.createdAt).toLocaleDateString()}
          </p>
          {experiments && experiments.length > 1 && (
            <label className="experiment-picker">
              EXPERIMENT
              <select
                value={experiment.id}
                onChange={(event) => onSelectExperiment?.(event.target.value)}
              >
                {experiments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="m5-header-actions">
          <button className="subtle-button" onClick={() => setShowDataset((value) => !value)}>
            {showDataset ? "Hide dataset" : "Inspect dataset"}
          </button>
          {experiment.status === "running" && onCancel ? (
            <button className="subtle-button" onClick={onCancel}>
              Cancel
            </button>
          ) : onResume ? (
            <button className="primary-cta compact" onClick={onResume}>
              Run pending cells <span>→</span>
            </button>
          ) : null}
        </div>
      </header>
      {showDataset && (
        <section className="dataset-inspector" aria-label="Experiment dataset">
          <h2>{experiment.dataset}</h2>
          <p>Cases and declared acceptance checks used by this experiment.</p>
          <pre>{JSON.stringify(experiment.cases, null, 2)}</pre>
        </section>
      )}
      <div className="m5-summary" aria-label="experiment status">
        {Object.entries(summary).map(([status, count]) => (
          <span key={status} className={`m5-stat ${status}`}>
            <b>{count}</b> {status === "evaluator-error" ? "eval errors" : status}
          </span>
        ))}
      </div>
      <div className="m5-summary m5-evaluation-summary" aria-label="evaluation outcome summary">
        <span>
          <b>{evaluation.executionSucceeded}</b> execution succeeded
        </span>
        <span>
          <b>{evaluation.acceptance.passed}</b> acceptance passed
        </span>
        <span>
          <b>{evaluation.acceptance.failed}</b> acceptance failed
        </span>
        <span>
          <b>{evaluation.acceptance.missing + evaluation.acceptance.unavailable}</b> acceptance
          unavailable
        </span>
        <span>
          <b>{evaluation.evaluatorErrors}</b> evaluator errors
        </span>
      </div>
      <nav className="m5-tabs" aria-label="Evaluation views">
        {(
          [
            ["matrix", "RESULT MATRIX"],
            ["timeline", "TIMELINE COMPARE"],
            ["pairwise", "PAIRWISE REVIEW"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "matrix" && (
        <MatrixView
          experiment={experiment}
          selected={selected}
          onSelect={setSelected}
          onOpenRun={onOpenRun}
        />
      )}
      {tab === "timeline" && (
        <>
          {onCompare && (
            <button
              className="subtle-button"
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
            </button>
          )}
          <TimelineCompare timeline={comparisonTimeline} error={comparisonTimelineError} />
        </>
      )}
      {tab === "pairwise" && (
        <PairwiseReview
          experiment={experiment}
          reveal={reveal || pairwise?.revealed === true}
          setReveal={setReveal}
          pairwise={pairwise}
          onStart={onPairwiseStart}
          onChoice={onPairwiseChoice}
          onOpenRun={onOpenRun}
        />
      )}
      {selected && (
        <EvidenceDetail
          cell={{ ...selected, evidence: loadedEvidence[selected.id] ?? selected.evidence }}
          onOpenRun={onOpenRun}
          loading={evidenceLoading}
          error={evidenceError}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
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
  return (
    <div className="m5-panel matrix-panel">
      <div className="m5-panel-heading">
        <div>
          <strong>EXPERIMENT MATRIX</strong>
          <span>click a cell to inspect evidence</span>
        </div>
        <label className="compact-select">
          REPETITIONS{" "}
          <select defaultValue="1">
            <option>1</option>
            <option>3</option>
            <option>5</option>
          </select>
        </label>
      </div>
      <div className="matrix-scroll">
        <table className="eval-matrix">
          <thead>
            <tr>
              <th>CASE</th>
              {experiment.variants.map((variant) => (
                <th key={variant.id}>
                  <strong>{variant.label}</strong>
                  <small>{variant.profile}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {experiment.cases.map((testCase) => (
              <tr key={testCase.id}>
                <th>
                  <strong>{testCase.label}</strong>
                  <small>{testCase.description}</small>
                </th>
                {experiment.variants.map((variant) => {
                  const cell = cellFor(experiment, testCase.id, variant.id);
                  return (
                    <td key={variant.id}>
                      {cell ? (
                        <button
                          className={`eval-cell ${cell.status} ${selected?.id === cell.id ? "selected" : ""}`}
                          onClick={() => onSelect(cell)}
                        >
                          {cell.runId && onOpenRun ? (
                            <span
                              className="cell-run"
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenRun(cell.runId!);
                              }}
                            >
                              {STATUS_ICON[cell.status]} {STATUS_LABEL[cell.status]}
                            </span>
                          ) : (
                            <span>
                              {STATUS_ICON[cell.status]} {STATUS_LABEL[cell.status]}
                            </span>
                          )}
                          <small>
                            {cell.score === undefined
                              ? (cell.error ??
                                (cell.status === "running" ? "in progress" : "not started"))
                              : `${Math.round(cell.score * 100)}% · ${duration(cell.durationMs)}`}
                          </small>
                        </button>
                      ) : (
                        <span className="empty-cell">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EvidenceDetail({
  cell,
  onOpenRun,
  onClose,
  loading,
  error,
}: {
  cell: EvalCell;
  onOpenRun?: (runId: string) => void;
  onClose: () => void;
  loading?: boolean;
  error?: string;
}) {
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
  return (
    <aside className="m5-detail" data-testid="evidence-detail">
      <div className="m5-detail-heading">
        <div>
          <span className={`m5-status ${cell.status}`}>{STATUS_ICON[cell.status]}</span>
          <strong>
            {cell.caseId} / {cell.variantId}
          </strong>
          <small>
            repetition {cell.repetition} · {STATUS_LABEL[cell.status]}
          </small>
        </div>
        <button aria-label="Close evidence" onClick={onClose}>
          ×
        </button>
      </div>
      {cell.error && <div className="m5-error">{cell.error}</div>}
      {error && (
        <div className="m5-error" role="alert">
          {error}
        </div>
      )}
      {(["deterministic", "workflow", "efficiency", "judge", "human"] as EvidenceKind[]).map(
        (kind) => (
          <section className={`evidence-group ${kind}`} key={kind}>
            <h3>
              {kind} <span>{kind === "judge" || kind === "human" ? "subjective" : "recorded"}</span>
            </h3>
            {grouped[kind].length ? (
              grouped[kind].map((item) => (
                <div className="m5-evidence-row" key={`${item.label}-${item.value}`}>
                  <span>{item.label}</span>
                  <strong>{formatEvidenceValue(item.value)}</strong>
                  {item.detail && <small>{item.detail}</small>}
                </div>
              ))
            ) : (
              <p className="pending-copy">
                {loading ? "Loading evidence…" : `No ${kind} evidence recorded.`}
              </p>
            )}
          </section>
        ),
      )}
      {cell.runId && (
        <button className="subtle-button" onClick={() => onOpenRun?.(cell.runId!)}>
          Open normal run {cell.runId.slice(0, 14)} ↗
        </button>
      )}
    </aside>
  );
}

function TimelineCompare({ timeline, error }: { timeline?: ComparisonTimeline; error?: string }) {
  const max = Math.max(timeline?.scale.durationMs ?? 0, 1);
  return (
    <div className="m5-panel compare-panel">
      <div className="m5-panel-heading">
        <div>
          <strong>SHARED-SCALE TIMELINE</strong>
          <span>durable aligned stages · {timeline?.runs.length ?? 0} selected runs</span>
        </div>
        <span className="timeline-fit-state">Scale fits the selected runs</span>
      </div>
      <div className="compare-axis">
        <span>0s</span>
        <span>{duration(max / 2)}</span>
        <span>{duration(max)}</span>
      </div>
      {error && <p className="m5-error">{error}</p>}
      {(timeline?.rows ?? []).map((row) => (
        <div className="compare-row" key={row.anchorId}>
          <label>
            {row.label}
            <small>{row.anchorId}</small>
          </label>
          <div className="compare-track">
            {row.spans.map((span, index) =>
              span ? (
                <div
                  className={`compare-bar ${String(span.status ?? "succeeded")}`}
                  key={`${row.anchorId}-${index}`}
                >
                  <span>
                    {String(span.label ?? "stage")} · {String(span.status ?? "observed")}
                  </span>
                </div>
              ) : (
                <div className="compare-missing" key={`${row.anchorId}-${index}`}>
                  missing stage
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
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
  return (
    <div className="m5-panel pairwise-panel">
      <div className="m5-panel-heading">
        <div>
          <strong>BLINDED PAIRWISE REVIEW</strong>
          <span>{testCase.label} · identities remain hidden until a durable decision</span>
        </div>
        {pairwise ? (
          <button
            className="subtle-button"
            disabled={!pairwise.decision}
            onClick={() => setReveal(!reveal)}
          >
            {reveal ? "Hide identities" : "Reveal identities"}
          </button>
        ) : (
          <button className="primary-cta compact" onClick={onStart}>
            Start review
          </button>
        )}
      </div>
      <div className="blind-note">
        Choose based on evidence, diff, and tests. Variant/model names are withheld to reduce
        preference bias.
      </div>
      <div className="pair-cards">
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
            <article className="pair-card" key={variant.id}>
              <header>
                <span>OPTION {index === 0 ? "A" : "B"}</span>
                {revealedVariant && (
                  <small>
                    {revealedVariant.label} · {revealedVariant.profile}
                  </small>
                )}
              </header>
              <strong>
                {pairwise && !cell
                  ? "Blinded run"
                  : cell?.status === "succeeded"
                    ? `Run ${STATUS_LABEL[cell.status]}`
                    : STATUS_LABEL[cell?.status ?? "pending"]}
              </strong>
              <p>
                {evidence
                  ?.map((item) => `${item.label}: ${formatEvidenceValue(item.value)}`)
                  .join(" · ") ??
                  cell?.evidence
                    ?.map((item) => `${item.label}: ${formatEvidenceValue(item.value)}`)
                    .join(" · ") ??
                  "No evidence available"}
              </p>
              <small className="pair-acceptance">
                {pairwise && !cell
                  ? "Pinned evidence snapshot"
                  : `Acceptance: ${acceptanceLabel(cell ? acceptanceStatus(cell) : "missing")}`}
              </small>
              {cell?.runId && (
                <button className="diff-link" onClick={() => onOpenRun?.(cell.runId!)}>
                  Inspect run ↗
                </button>
              )}
            </article>
          );
        })}
      </div>
      <div className="pair-actions">
        <button className="pair-choice" disabled={!pairwise} onClick={() => onChoice?.("a")}>
          A better
        </button>
        <button className="pair-choice" disabled={!pairwise} onClick={() => onChoice?.("tie")}>
          Tie
        </button>
        <button className="pair-choice" disabled={!pairwise} onClick={() => onChoice?.("b")}>
          B better
        </button>
        <button
          className="pair-choice muted-choice"
          disabled={!pairwise}
          onClick={() => onChoice?.("abstain")}
        >
          Abstain
        </button>
      </div>
      <p className="pending-copy">
        {pairwise?.decision
          ? `Decision recorded: ${pairwise.decision.choice}.`
          : "Your decision is saved as human evidence and reveals identity only after the journal accepts it."}
      </p>
    </div>
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
