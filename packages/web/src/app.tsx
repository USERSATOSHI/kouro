import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { RunSyncStore } from "./data/syncStore";
import { makeTimeScale, spanBounds } from "./data/timeScale";
import { virtualRows } from "./data/virtualRows";
import { shouldReconnectOnVisibility } from "./data/reconnect";
import {
  graphSelectionBreadcrumbs,
  projectHierarchicalGraph,
  type GraphScope,
} from "./data/hierarchicalProjection";
import {
  asArray,
  type ArtifactView,
  type UiAttempt,
  type UiInvocation,
  type UiRunView,
  type ProjectionFrame,
  type RunSummary,
  type RunView,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowSummary,
  bundleGraph,
  type ContextSegment,
  type DiagnosticView,
  type LogEntryView,
  type ToolCallView,
  type UsageView,
} from "./types";
import {
  M5Workbench,
  completedComparisonRuns,
  type BlindedPairwise,
  type ComparisonTimeline,
  type EvalExperiment,
  type EvalEvidence,
} from "./m5";
import { SwarmWorkbench } from "./swarm";
import { M7Workbench, M7_ENDPOINTS } from "./m7";
import { ActivityValue, ToolActivity } from "./components/ActivityValue";
import { WorkflowInputs, launchInputs } from "./components/WorkflowInputs";
import {
  AgentSessionModal,
  boundedActivity,
  SafeMarkdown,
  type ActivityPage,
} from "./components/AgentSession";

type ControlAction = (
  action: string,
  invocationId?: string,
  message?: string,
  attemptId?: string,
) => Promise<boolean>;

interface ScoutTimelineRequest {
  requestId: string;
  parentInvocationId: string;
  parentAttemptId: string;
  scoutId: string;
  state: "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  createdAt: string;
  updatedAt: string;
  error?: string;
  question?: string;
  modelId?: string;
  effectiveHarness?: string;
  result?: unknown;
  resultArtifactId?: string;
}

interface PendingApproval {
  runId: string;
  workflowId: string;
  task?: string;
  invocationId: string;
  approvalId?: string;
  action: string;
  revision: number;
}

interface PendingRunDeletion {
  runId: string;
  status: string;
  task?: unknown;
  workflowId?: unknown;
  error?: string;
}

let csrfToken: string | undefined;
let sessionPromise: Promise<void> | undefined;

function invalidateSession(): void {
  csrfToken = undefined;
  sessionPromise = undefined;
}

function currentSession(): Promise<void> {
  sessionPromise ??= ensureSession().catch((cause: unknown) => {
    invalidateSession();
    throw cause;
  });
  return sessionPromise;
}

function readPreference(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The workbench remains usable when browser storage is disabled.
  }
}

function readPairingToken(): string | null {
  try {
    return window.sessionStorage.getItem("kouro.pairing-token");
  } catch {
    return null;
  }
}

function savePairingToken(token: string): void {
  try {
    window.sessionStorage.setItem("kouro.pairing-token", token);
  } catch {
    // Pairing still works for this page load if session storage is unavailable.
  }
}

const ensureSession = async (): Promise<void> => {
  const existing = await fetch("/api/session", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (existing.ok) {
    csrfToken = ((await existing.json()) as { csrfToken: string }).csrfToken;
    return;
  }
  const token =
    new URLSearchParams(window.location.hash.slice(1)).get("token") ?? readPairingToken();
  if (!token) throw new Error("This browser is not paired with the local Kouro host");
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  savePairingToken(token);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
};

const api = async <T,>(path: string, init: RequestInit = {}, recovered = false): Promise<T> => {
  await currentSession();
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(method === "GET" ? 20_000 : 120_000),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload: unknown = await response.json();
      if (payload && typeof payload === "object" && "message" in payload)
        detail = String(payload.message ?? "");
      else if (payload && typeof payload === "object" && "error" in payload)
        detail = String(payload.error ?? "");
    } catch {
      // The host may return a non-JSON proxy or transport error.
    }
    const authFailure =
      response.status === 401 ||
      (response.status === 403 && detail === "Origin or CSRF check failed");
    if (authFailure && !recovered) {
      // Restore authentication for the next action. Never replay this request: it may
      // have been a mutation whose outcome the caller needs to inspect first.
      invalidateSession();
      try {
        await currentSession();
      } catch (cause) {
        const recovery = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${detail || `${response.status} ${response.statusText}`}; ${recovery}`);
      }
      if (method === "GET" || method === "HEAD") return api<T>(path, init, true);
      throw new Error(`${detail || "Authentication expired"}; session restored, retry the action`);
    }
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
};

/** Advance host wall time from a snapshot using a monotonic browser clock. */
function useServerNow(servedAt: string | undefined, intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  const anchor = useRef<{ serverMs: number; monoMs: number } | undefined>(undefined);
  useEffect(() => {
    const serverMs = Date.parse(servedAt ?? "");
    anchor.current = Number.isFinite(serverMs)
      ? { serverMs, monoMs: performance.now() }
      : undefined;
    setNow(Number.isFinite(serverMs) ? serverMs : Date.now());
  }, [servedAt]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = anchor.current;
      setNow(current ? current.serverMs + performance.now() - current.monoMs : Date.now());
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const unwrapArray = <T,>(
  value: T[] | { items?: T[]; runs?: T[]; workflows?: T[]; profiles?: T[] } | undefined,
  key: "runs" | "workflows" | "profiles",
) => (Array.isArray(value) ? value : (value?.[key] ?? value?.items ?? []));

const normalizeRun = (raw: unknown): RunSummary | null => {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = String(item.id ?? item.runId ?? "");
  if (!id) return null;
  return {
    id,
    workflowId: String(item.workflowId ?? ""),
    state: String(item.state ?? item.status ?? "preparing") as RunSummary["state"],
    createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    startedAt: typeof item.startedAt === "string" ? item.startedAt : undefined,
    endedAt: typeof item.endedAt === "string" ? item.endedAt : undefined,
    revision: typeof item.revision === "number" ? item.revision : undefined,
    task: typeof item.task === "string" ? item.task : undefined,
    workItem: item.workItem,
  };
};
const normalizeWorkflow = (raw: unknown): WorkflowSummary | null => {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const bundle = item.bundle as WorkflowSummary["bundle"];
  const id = String(
    item.id ?? (bundle as Record<string, unknown> | undefined)?.rootDefinitionId ?? "",
  );
  if (!id) return null;
  const graph =
    item.graph && typeof item.graph === "object"
      ? (item.graph as WorkflowGraph)
      : bundle
        ? bundleGraph(bundle)
        : undefined;
  return {
    id,
    name: typeof item.name === "string" ? item.name : id,
    version: typeof item.version === "string" ? item.version : undefined,
    digest: typeof item.digest === "string" ? item.digest : bundle?.digest,
    graph,
    bundle,
  };
};

const isoMs = (value: number | string | undefined, fallback = 0) => {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value) || fallback;
  return fallback;
};

const invokeId = (node: WorkflowNode, invocations: UiInvocation[]) =>
  invocations.find((item) => item.sourceNodeId === node.id)?.invocationId;

const normalizeExperiment = (raw: unknown): EvalExperiment | null => {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const dataset = (
    value.dataset && typeof value.dataset === "object" ? value.dataset : {}
  ) as Record<string, unknown>;
  const variants = Array.isArray(value.variants) ? value.variants : [];
  const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
  const cells = Array.isArray(value.cells) ? value.cells : [];
  if (typeof value.id !== "string") return null;
  return {
    id: value.id,
    name: value.id,
    dataset: typeof dataset.id === "string" ? `${dataset.id} / ${cases.length} cases` : "dataset",
    createdAt: new Date().toISOString(),
    status: ["draft", "running", "paused", "cancelled", "completed"].includes(String(value.status))
      ? (String(value.status) as EvalExperiment["status"])
      : "draft",
    cases: cases.map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        id: String(entry.id ?? "case"),
        label: String(entry.id ?? "case"),
        description:
          typeof entry.metadata === "object" ? JSON.stringify(entry.metadata) : undefined,
        ...(entry.input !== undefined ? { input: entry.input } : {}),
        ...(entry.acceptance !== undefined ? { acceptance: entry.acceptance } : {}),
      };
    }),
    variants: variants.map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        id: String(entry.id ?? "variant"),
        label: String(entry.id ?? "variant"),
        workflow: String(entry.workflowId ?? "workflow"),
        profile: String(entry.executionProfile ?? "profile"),
      };
    }),
    cells: cells.map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        id: String(entry.key ?? `${entry.caseId}:${entry.variantId}:${entry.repetition}`),
        caseId: String(entry.caseId ?? ""),
        variantId: String(entry.variantId ?? ""),
        repetition: Number(entry.repetition ?? 1),
        status:
          entry.status === "reserved"
            ? "reserved"
            : entry.status === "evaluator-error"
              ? "evaluator-error"
              : (String(entry.status ?? "pending") as EvalExperiment["cells"][number]["status"]),
        runId: typeof entry.runId === "string" ? entry.runId : undefined,
        error: typeof entry.error === "string" ? entry.error : undefined,
      };
    }),
  };
};

function normalizeEvaluationEvidence(raw: unknown): EvalEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const evidence = item as Record<string, unknown>;
    const evidenceClass = String(evidence.evidenceClass ?? "workflow");
    const kind: EvalEvidence["kind"] =
      evidenceClass === "deterministic"
        ? "deterministic"
        : evidenceClass === "efficiency"
          ? "efficiency"
          : evidenceClass === "judge-opinion"
            ? "judge"
            : evidenceClass === "human-preference"
              ? "human"
              : "workflow";
    let value = evidence.value;
    if (typeof value !== "string") {
      try {
        value = JSON.stringify(value);
      } catch {
        value = String(value);
      }
    }
    return [
      {
        kind,
        label: String(evidence.name ?? evidence.evaluatorId ?? evidence.id ?? "Evidence"),
        value: String(value ?? evidence.status ?? "recorded"),
        ...(typeof evidence.explanation === "string" ? { detail: evidence.explanation } : {}),
      },
    ];
  });
}

async function fetchActivityPage(
  runId: string,
  attemptId: string,
  after: number,
): Promise<ActivityPage> {
  const query = new URLSearchParams({ attemptId, after: String(after), limit: "200" });
  return api<ActivityPage>(`/api/runs/${encodeURIComponent(runId)}/activity?${query}`);
}

function StatusDot({ state }: { state?: string }) {
  return <span className={`status-dot status-${state ?? "idle"}`} />;
}

function LogoMark() {
  return (
    <span className="logo-mark">
      <i />
      <i />
      <i />
    </span>
  );
}

function readPanelWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const stored = Number(readPreference(key, String(fallback)));
    return Number.isFinite(stored) ? Math.min(max, Math.max(min, stored)) : fallback;
  } catch {
    return fallback;
  }
}

function ResizeHandle({
  label,
  onStart,
}: {
  label: string;
  onStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onStart}
    />
  );
}

export function App() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [pendingRunDeletions, setPendingRunDeletions] = useState<PendingRunDeletion[]>([]);
  const [shownRunCount, setShownRunCount] = useState(12);
  const [hasMoreRuns, setHasMoreRuns] = useState(true);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  const [workflowId, setWorkflowId] = useState("tiny");
  const [task, setTask] = useState("");
  const [inputDrafts, setInputDrafts] = useState<Record<string, string>>({});
  const [workspacePath, setWorkspacePath] = useState("");
  const [nodeSettings, setNodeSettings] = useState<
    Record<string, { harness?: string; modelId?: string; capabilities?: string[] }>
  >({});
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("run") ?? undefined,
  );
  const [store] = useState(() => new RunSyncStore());
  const [selectedInvocationId, setSelectedInvocationId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("invocation") ?? undefined,
  );
  const [surface, setSurface] = useState<
    "runs" | "new-run" | "evals" | "swarm" | "development" | "checkpoints"
  >("runs");
  const [experiments, setExperiments] = useState<EvalExperiment[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string>();
  const [experimentError, setExperimentError] = useState<string>();
  const [comparisonTimeline, setComparisonTimeline] = useState<ComparisonTimeline>();
  const [comparisonTimelineError, setComparisonTimelineError] = useState<string>();
  const [comparisonRunIds, setComparisonRunIds] = useState<string[]>([]);
  const [pairwise, setPairwise] = useState<BlindedPairwise>();
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [pendingAction, setPendingAction] = useState<string>();
  const actionKeys = useRef(new Map<string, string>());
  const [actionNotice, setActionNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [catalogError, setCatalogError] = useState<string>();
  const [connectionNonce, setConnectionNonce] = useState(0);
  const catalogLoading = useRef(false);
  const launchRequest = useRef<{ identity: string; key: string } | undefined>(undefined);
  const launchingRef = useRef(false);
  const [deletionPreview, setDeletionPreview] = useState<Record<string, unknown>>();
  const [deletionError, setDeletionError] = useState<string>();
  const [deletingRun, setDeletingRun] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readPanelWidth("kouro.sidebar.width", 232, 180, 420),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readPanelWidth("kouro.inspector.width", 310, 260, 560),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useSyncExternalStore(store.subscribe, store.getConnectionSnapshot, store.getConnectionSnapshot);

  useEffect(() => {
    writePreference("kouro.sidebar.width", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    writePreference("kouro.inspector.width", String(inspectorWidth));
  }, [inspectorWidth]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedRunId) url.searchParams.set("run", selectedRunId);
    else url.searchParams.delete("run");
    if (selectedInvocationId) url.searchParams.set("invocation", selectedInvocationId);
    else url.searchParams.delete("invocation");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [selectedRunId, selectedInvocationId]);

  useEffect(() => {
    setPairwise(undefined);
    setComparisonTimeline(undefined);
    setComparisonTimelineError(undefined);
    setExperimentError(undefined);
  }, [selectedExperimentId]);

  const startPanelResize = useCallback(
    (panel: "sidebar" | "inspector", event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const initialX = event.clientX;
      const initialWidth = panel === "sidebar" ? sidebarWidth : inspectorWidth;
      const min = panel === "sidebar" ? 180 : 260;
      const max = panel === "sidebar" ? 420 : 560;
      const update = (move: PointerEvent) => {
        const delta = move.clientX - initialX;
        const next = Math.min(
          max,
          Math.max(min, initialWidth + (panel === "sidebar" ? delta : -delta)),
        );
        if (panel === "sidebar") setSidebarWidth(next);
        else setInspectorWidth(next);
      };
      const stop = () => {
        window.removeEventListener("pointermove", update);
        window.removeEventListener("pointerup", stop);
        document.body.classList.remove("resizing-panels");
      };
      document.body.classList.add("resizing-panels");
      window.addEventListener("pointermove", update);
      window.addEventListener("pointerup", stop, { once: true });
    },
    [inspectorWidth, sidebarWidth],
  );

  const loadCatalog = useCallback(async () => {
    if (catalogLoading.current) return;
    catalogLoading.current = true;
    try {
      const [workflowPayload, runsPayload, experimentPayload, approvalPayload, deletionPayload] =
        await Promise.all([
          api<unknown[] | { workflows?: unknown[]; items?: unknown[] }>("/api/workflows"),
          api<unknown[] | { runs?: unknown[]; items?: unknown[] }>("/api/runs"),
          api<unknown[] | { experiments?: unknown[]; items?: unknown[] }>("/api/experiments"),
          api<PendingApproval[]>("/api/approvals"),
          api<PendingRunDeletion[]>("/api/run-deletions"),
        ]);
      const nextWorkflows = unwrapArray(workflowPayload, "workflows")
        .map(normalizeWorkflow)
        .filter((item): item is WorkflowSummary => Boolean(item));
      const nextRuns = unwrapArray(runsPayload, "runs")
        .map(normalizeRun)
        .filter((item): item is RunSummary => Boolean(item));
      setWorkflows(nextWorkflows);
      setPendingApprovals(approvalPayload);
      setPendingRunDeletions(deletionPayload);
      setRuns((current) => [
        ...nextRuns,
        ...current.filter((run) => !nextRuns.some((fresh) => fresh.id === run.id)),
      ]);
      if (nextRuns.length < 100) setHasMoreRuns(false);
      const nextExperiments = (
        Array.isArray(experimentPayload)
          ? experimentPayload
          : ((experimentPayload as { experiments?: unknown[]; items?: unknown[] }).experiments ??
            (experimentPayload as { items?: unknown[] }).items ??
            [])
      )
        .map(normalizeExperiment)
        .filter((item): item is EvalExperiment => Boolean(item));
      setExperiments(nextExperiments);
      setSelectedExperimentId((current) => current ?? nextExperiments[0]?.id);
      setWorkflowId((current) =>
        nextWorkflows.some((item) => item.id === current) ? current : (nextWorkflows[0]?.id ?? ""),
      );
      setSelectedRunId((current) => current ?? nextRuns[0]?.id);
      setCatalogError(undefined);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : "Unable to reach local host");
    } finally {
      catalogLoading.current = false;
      setLoading(false);
    }
  }, []);

  const showOlderRuns = async () => {
    if (shownRunCount < runs.length) {
      setShownRunCount((count) => count + 12);
      return;
    }
    if (!hasMoreRuns || loadingOlderRuns) return;
    setLoadingOlderRuns(true);
    try {
      const page = await api<unknown[] | { runs?: unknown[]; items?: unknown[] }>(
        `/api/runs?limit=100&offset=${runs.length}`,
      );
      const older = unwrapArray(page, "runs")
        .map(normalizeRun)
        .filter((run): run is RunSummary => Boolean(run));
      setRuns((current) => [
        ...current,
        ...older.filter((run) => !current.some((known) => known.id === run.id)),
      ]);
      setHasMoreRuns(older.length === 100);
      setShownRunCount((count) => count + 12);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load older runs");
    } finally {
      setLoadingOlderRuns(false);
    }
  };

  const selectedExperiment =
    experiments.find((item) => item.id === selectedExperimentId) ?? experiments[0];
  const compareSelectedRuns = async (runIds = comparisonRunIds) => {
    if (runIds.length !== 2) return;
    setComparisonTimelineError(undefined);
    try {
      const views = await Promise.all(
        runIds.map((runId) => api<UiRunView>(`/api/runs/${encodeURIComponent(runId)}/view`)),
      );
      const nodeLists = views.map((view) => {
        const state = (view as unknown as { state?: { invocations?: unknown } }).state;
        return asArray(state?.invocations as Record<string, unknown>)
          .map((item) => {
            const record = item as Record<string, unknown>;
            return String(record.sourceNodeId ?? record.nodeId ?? "");
          })
          .filter(Boolean);
      });
      const nodes = [...new Set(nodeLists.flat())];
      if (!nodes.length) throw new Error("No invocation stages were found in the selected runs.");
      const anchors = nodes.map((node, index) => ({
        id: `node-${index}`,
        kind: "node-id" as const,
        leftNodeKey: nodeLists[0]?.includes(node) ? node : "__missing__",
        rightNodeKey: nodeLists[1]?.includes(node) ? node : "__missing__",
      }));
      const runRefs = views.map((view) => ({ runId: view.runId, revision: view.revision }));
      const comparisonMaterial = JSON.stringify({ runs: runRefs, anchors, evidenceRevision: 0 });
      const comparisonDigest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(comparisonMaterial),
      );
      const comparisonId = `cmp_web_${Array.from(new Uint8Array(comparisonDigest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const comparison = await api<{ id: string }>("/api/comparisons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: comparisonId,
          runs: runRefs,
          anchors,
          evidenceRevision: 0,
        }),
      });
      const timeline = await api<ComparisonTimeline>(
        `/api/comparisons/${encodeURIComponent(comparison.id)}/timeline`,
      );
      if (!timeline.rows.length) throw new Error("The comparison returned no aligned stages.");
      setComparisonTimeline(timeline);
    } catch (cause) {
      setComparisonTimeline(undefined);
      setComparisonTimelineError(
        cause instanceof Error ? cause.message : "Unable to compare these runs.",
      );
    }
  };
  const resumeExperiment = async () => {
    if (!selectedExperiment) return;
    try {
      const updated = await api<unknown>(
        `/api/experiments/${encodeURIComponent(selectedExperiment.id)}/resume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actor: "operator", maxConcurrent: 4 }),
        },
      );
      const mapped = normalizeExperiment(updated);
      if (mapped)
        setExperiments((old) => old.map((item) => (item.id === mapped.id ? mapped : item)));
    } catch (cause) {
      setExperimentError(cause instanceof Error ? cause.message : "Unable to resume experiment");
    }
  };
  const cancelExperiment = async () => {
    if (!selectedExperiment) return;
    try {
      const updated = await api<unknown>(
        `/api/experiments/${encodeURIComponent(selectedExperiment.id)}/cancel`,
        { method: "POST" },
      );
      const mapped = normalizeExperiment(updated);
      if (mapped)
        setExperiments((old) => old.map((item) => (item.id === mapped.id ? mapped : item)));
    } catch (cause) {
      setExperimentError(cause instanceof Error ? cause.message : "Unable to cancel experiment");
    }
  };
  const startPairwise = async () => {
    const runs = selectedExperiment ? completedComparisonRuns(selectedExperiment) : [];
    if (runs.length !== 2) {
      setExperimentError("Pairwise review requires two completed ordinary runs.");
      return;
    }
    try {
      const views = await Promise.all(
        runs.map((runId) => api<RunView>(`/api/runs/${encodeURIComponent(runId)}/view`)),
      );
      const runRefs = views.map((view) => {
        if (view.state.status !== "succeeded")
          throw new Error(`Run ${view.runId} is not successful at its current revision.`);
        return { runId: view.runId, revision: view.revision };
      });
      const evidenceRevision = Math.max(...runRefs.map((run) => run.revision));
      const comparison = await api<{ id: string }>("/api/comparisons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runs: runRefs,
          anchors: [],
          evidenceRevision,
        }),
      });
      const dto = await api<{
        assignmentId: string;
        sides: Array<{ sideId: string; evidence: unknown[] }>;
        decided: boolean;
      }>(`/api/comparisons/${encodeURIComponent(comparison.id)}/pairwise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: "operator",
          rubric: { prompt: "Which implementation is better?" },
          evidenceRevision,
        }),
      });
      setPairwise({
        id: dto.assignmentId,
        sides: dto.sides.map((side) => side.sideId),
        evidence: dto.sides.map((side) => ({
          side: side.sideId,
          items: side.evidence.map((item) => ({
            kind: "human",
            label: "evidence",
            value: typeof item === "string" ? item : JSON.stringify(item),
          })),
        })),
        revealed: false,
      });
    } catch (cause) {
      setExperimentError(
        cause instanceof Error ? cause.message : "Unable to create pairwise review",
      );
    }
  };
  const decidePairwise = async (choice: "a" | "b" | "tie" | "abstain") => {
    if (!pairwise) return;
    try {
      await api(`/api/pairwise/${encodeURIComponent(pairwise.id)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "operator", choice, idempotencyKey: crypto.randomUUID() }),
      });
      const decided = await api<{
        assignment?: {
          runA?: { runId?: string };
          runB?: { runId?: string };
          sideA?: string;
          sideB?: string;
        };
        decision?: { choice: "a" | "b" | "tie" | "abstain" };
      }>(`/api/pairwise/${encodeURIComponent(pairwise.id)}?actor=operator`);
      const assignment = decided.assignment;
      const revealMap: Record<string, string> = {};
      if (assignment?.sideA && assignment.runA?.runId) {
        const variant = selectedExperiment?.cells.find(
          (cell) => cell.runId === assignment.runA?.runId,
        )?.variantId;
        if (variant) revealMap[assignment.sideA] = variant;
      }
      if (assignment?.sideB && assignment.runB?.runId) {
        const variant = selectedExperiment?.cells.find(
          (cell) => cell.runId === assignment.runB?.runId,
        )?.variantId;
        if (variant) revealMap[assignment.sideB] = variant;
      }
      setPairwise((current) =>
        current ? { ...current, decision: decided.decision, revealMap, revealed: false } : current,
      );
    } catch (cause) {
      setExperimentError(
        cause instanceof Error ? cause.message : "Unable to record pairwise decision",
      );
    }
  };

  useEffect(() => {
    void loadCatalog();
    const timer = window.setInterval(() => void loadCatalog(), 5000);
    return () => window.clearInterval(timer);
  }, [loadCatalog]);

  useEffect(() => {
    if (!selectedRunId) return;
    let source: EventSource | undefined;
    let cancelled = false;
    let connectionGeneration = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const retry = () => {
      if (cancelled || retryTimer) return;
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          void connect();
        },
        Math.min(10_000, 1000 * 2 ** failures++),
      );
    };
    const connect = async () => {
      if (cancelled) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      const generation = ++connectionGeneration;
      source?.close();
      source = undefined;
      store.setStatus("connecting");
      try {
        const view = await api<RunView>(`/api/runs/${encodeURIComponent(selectedRunId)}/view`);
        if (cancelled || generation !== connectionGeneration) return;
        store.replace(view);
        const cursor = view.eventCursor;
        source = new EventSource(
          `/api/runs/${encodeURIComponent(selectedRunId)}/stream?after=${cursor}`,
        );
        source.onopen = () => {
          if (cancelled || generation !== connectionGeneration) return;
          failures = 0;
          store.setStatus("live");
        };
        source.onmessage = (event) => {
          if (cancelled || generation !== connectionGeneration) return;
          try {
            const payload = JSON.parse(event.data) as
              | ProjectionFrame
              | { frame?: ProjectionFrame; view?: RunView };
            if (payload && "view" in payload && payload.view) store.replace(payload.view);
            else
              store.apply(
                (payload && "frame" in payload ? payload.frame : payload) as ProjectionFrame,
              );
          } catch (cause) {
            store.setStatus(
              "error",
              cause instanceof Error ? cause.message : "Invalid stream frame",
            );
          }
        };
        source.onerror = () => {
          if (cancelled || generation !== connectionGeneration) return;
          source?.close();
          store.setStatus("disconnected", "Connection lost. Reconnecting to the host…");
          retry();
        };
      } catch (cause) {
        if (cancelled || generation !== connectionGeneration) return;
        store.setStatus("error", cause instanceof Error ? cause.message : "Unable to load run");
        retry();
      }
    };
    store.beginRun(selectedRunId);
    void connect();
    const reset = () => {
      void connect();
    };
    const onVisibilityChange = () => {
      if (shouldReconnectOnVisibility(document.visibilityState, store.status)) void connect();
    };
    const unsubscribe = store.onReset(reset);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", reset);
    return () => {
      cancelled = true;
      connectionGeneration += 1;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", reset);
      source?.close();
    };
  }, [selectedRunId, store, connectionNonce]);

  const launch = async () => {
    const selected = workflows.find((item) => item.id === workflowId);
    const inputs = launchInputs(selected?.bundle, task, inputDrafts);
    if (launchingRef.current || !selected || !inputs.valid) return;
    launchingRef.current = true;
    setLaunching(true);
    setError(undefined);
    try {
      const identity = JSON.stringify({
        workflowId,
        nodeSettings,
        input: inputs.input,
        workspacePath: workspacePath.trim(),
      });
      if (launchRequest.current?.identity !== identity)
        launchRequest.current = { identity, key: crypto.randomUUID() };
      const created = await api<RunSummary>("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId,
          nodeSettings,
          idempotencyKey: launchRequest.current.key,
          input: inputs.input,
          ...(workspacePath.trim() ? { workspace: { repositoryPath: workspacePath.trim() } } : {}),
        }),
      });
      setRuns((old) => [created, ...old.filter((run) => run.id !== created.id)]);
      setSelectedRunId(created.id);
      setSelectedInvocationId(undefined);
      setSurface("runs");
      launchRequest.current = undefined;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to launch run");
    } finally {
      launchingRef.current = false;
      setLaunching(false);
    }
  };

  const openNewRun = () => {
    setTask("");
    setError(undefined);
    setSurface("new-run");
  };

  const previewRunDeletion = async (runId: string) => {
    setDeletionError(undefined);
    try {
      setDeletionPreview(
        await api<Record<string, unknown>>(
          `/api/runs/${encodeURIComponent(runId)}/deletion-preview`,
        ),
      );
    } catch (cause) {
      setDeletionError(cause instanceof Error ? cause.message : "Unable to preview run deletion");
    }
  };

  const confirmRunDeletion = async () => {
    const preview = deletionPreview;
    if (!preview || typeof preview.runId !== "string") return;
    setDeletingRun(true);
    setDeletionError(undefined);
    try {
      const result = await api<{ status?: string }>(
        `/api/runs/${encodeURIComponent(preview.runId)}/delete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: preview.revision,
            idempotencyKey:
              typeof preview.deletionRequestKey === "string"
                ? preview.deletionRequestKey
                : crypto.randomUUID(),
            actor: "operator",
          }),
        },
      );
      if (result.status && result.status !== "completed") {
        await previewRunDeletion(preview.runId);
        setDeletionError(
          `Cleanup is incomplete (${result.status}). Retry cleanup after resolving the reported error.`,
        );
        return;
      }
      const remaining = runs.filter((run) => run.id !== preview.runId);
      setRuns(remaining);
      if (selectedRunId === preview.runId) {
        store.clear();
        setSelectedRunId(remaining[0]?.id);
        setSelectedInvocationId(undefined);
        setSurface(remaining.length ? "runs" : "new-run");
        const url = new URL(window.location.href);
        if (remaining[0]) url.searchParams.set("run", remaining[0].id);
        else url.searchParams.delete("run");
        url.searchParams.delete("invocation");
        url.searchParams.delete("attempt");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
      setDeletionPreview(undefined);
      void loadCatalog();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "Run deletion failed";
      if (typeof preview.runId === "string") await previewRunDeletion(preview.runId);
      setDeletionError(detail);
    } finally {
      setDeletingRun(false);
    }
  };

  const controlRun = async (
    action: string,
    invocationId?: string,
    message?: string,
    attemptId?: string,
  ) => {
    if (!selectedRunId || snapshot?.runId !== selectedRunId || pendingAction) return false;
    setPendingAction(action);
    setActionNotice(undefined);
    const actionIdentity = JSON.stringify([
      action,
      selectedRunId,
      invocationId,
      attemptId,
      message,
    ]);
    const idempotencyKey = actionKeys.current.get(actionIdentity) ?? crypto.randomUUID();
    actionKeys.current.set(actionIdentity, idempotencyKey);
    if (actionKeys.current.size > 128)
      actionKeys.current.delete(actionKeys.current.keys().next().value!);
    try {
      await api(`/api/runs/${encodeURIComponent(selectedRunId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          invocationId,
          attemptId,
          message,
          ...(action === "steer" ? {} : { expectedRevision: snapshot?.revision }),
          idempotencyKey,
        }),
      });
      actionKeys.current.delete(actionIdentity);
      setActionNotice(`${action} requested; waiting for the durable event.`);
      return true;
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("steer-rejected:"))
        actionKeys.current.delete(actionIdentity);
      setActionNotice(cause instanceof Error ? cause.message : `Unable to request ${action}`);
      return false;
    } finally {
      setPendingAction(undefined);
    }
  };

  const workflow = workflows.find((candidate) => candidate.id === workflowId) ?? workflows[0];
  const activeView = snapshot?.runId === selectedRunId ? snapshot : undefined;
  const activeBundle = activeView?.bundle;
  const pinnedWorkflow = useMemo(
    () => (activeBundle ? normalizeWorkflow({ bundle: activeBundle }) : undefined),
    [activeBundle],
  );
  const activeWorkflow = pinnedWorkflow ?? workflow;
  const activeRun = runs.find((run) => run.id === selectedRunId);
  const canLaunch = Boolean(
    workflow && !loading && launchInputs(workflow.bundle, task, inputDrafts).valid,
  );
  const fetchCollaboration = useCallback(
    (runId: string) => api<unknown>(`/api/runs/${encodeURIComponent(runId)}/collaboration`),
    [],
  );
  const fetchCheckpointView = useCallback(
    (runId: string) => api<unknown>(M7_ENDPOINTS.view(runId)),
    [],
  );
  const loadCellEvidence = useCallback(
    async (cellKey: string) => {
      if (!selectedExperiment) return [];
      const raw = await api<unknown>(
        `/api/experiments/${encodeURIComponent(selectedExperiment.id)}/cells/${encodeURIComponent(cellKey)}/evidence`,
      );
      return normalizeEvaluationEvidence(raw);
    },
    [selectedExperiment?.id],
  );
  const captureCheckpoint = useCallback(
    async (runId: string) => {
      const captured = await api<unknown>(M7_ENDPOINTS.checkpoint(runId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: snapshot?.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      return await fetchCheckpointView(runId).catch(() => captured);
    },
    [fetchCheckpointView, snapshot?.revision],
  );
  const forkCheckpoint = useCallback(
    async (
      checkpointId: string,
      input: { name: string; promptVariants?: Record<string, string> },
    ) => {
      const result = await api<{ checkpointId: string }>(M7_ENDPOINTS.fork(checkpointId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          count: 2,
          requestKey: `fork:${checkpointId}:${input.name}:${crypto.randomUUID()}`,
          name: input.name,
          ...(input.promptVariants ? { promptVariants: input.promptVariants } : {}),
        }),
      });
      return selectedRunId ? await fetchCheckpointView(selectedRunId).catch(() => result) : result;
    },
    [fetchCheckpointView, selectedRunId],
  );
  const invocations = asArray(activeView?.invocations);
  const selectedInvocation =
    invocations.find((item) => item.invocationId === selectedInvocationId) ??
    invocations.find((item) => item.approval?.status === "pending") ??
    invocations.find((item) => item.state === "running") ??
    [...invocations].reverse().find((item) => item.state === "failed") ??
    invocations[invocations.length - 1];
  const visibleRuns = runs.map((run) =>
    run.id === selectedRunId && activeView
      ? {
          ...run,
          state: activeView.state,
          revision: activeView.revision,
          startedAt: activeView.startedAt,
          endedAt: activeView.finishedAt,
        }
      : run,
  );
  return (
    <div
      className="app-shell"
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--inspector-width": `${inspectorWidth}px`,
        } as CSSProperties
      }
    >
      <Sidebar
        workflows={workflows}
        runs={visibleRuns}
        shownRunCount={shownRunCount}
        hasMoreRuns={hasMoreRuns}
        loadingOlderRuns={loadingOlderRuns}
        onShowOlderRuns={showOlderRuns}
        onDeleteRun={(runId) => void previewRunDeletion(runId)}
        workflowId={workflowId}
        selectedRunId={selectedRunId}
        setWorkflowId={(id) => {
          setWorkflowId(id);
          setNodeSettings({});
          setInputDrafts({});
          openNewRun();
        }}
        setSelectedRunId={(id) => {
          setSelectedRunId(id);
          setSelectedInvocationId(undefined);
          setSurface("runs");
        }}
        surface={surface}
        setSurface={setSurface}
        onResizeStart={(event) => startPanelResize("sidebar", event)}
      />
      <main className="main-column">
        <Topbar
          run={surface === "new-run" ? undefined : activeRun}
          view={surface === "new-run" ? null : (activeView ?? null)}
          store={store}
          onLaunch={launch}
          pendingApprovals={pendingApprovals}
          pendingRunDeletions={pendingRunDeletions}
          onOpenApproval={(approval) => {
            setSelectedRunId(approval.runId);
            setSelectedInvocationId(approval.invocationId);
            setSurface("runs");
          }}
          onOpenDeletion={(runId) => void previewRunDeletion(runId)}
          runs={visibleRuns}
          selectedRunId={selectedRunId}
          onSelectRun={(id) => {
            setSelectedRunId(id || undefined);
            setSelectedInvocationId(undefined);
            setSurface("runs");
            if (!id) store.clear();
          }}
          onNewRun={openNewRun}
          launching={launching}
          canLaunch={canLaunch}
          pendingAction={pendingAction}
          actionNotice={actionNotice}
          onControl={controlRun}
          workflows={workflows}
          workflowId={workflowId}
          setWorkflowId={(id) => {
            setWorkflowId(id);
            setNodeSettings({});
            setInputDrafts({});
            openNewRun();
          }}
          surface={surface}
          setSurface={setSurface}
        />
        {(error || catalogError) && (
          <div className="notice error">
            <span>!</span>
            {error || catalogError}
            {catalogError && <button onClick={() => void loadCatalog()}>Retry</button>}
            {error && <button onClick={() => setError(undefined)}>Dismiss</button>}
          </div>
        )}
        {experimentError && surface === "evals" && (
          <div className="notice error">
            <span>!</span>
            {experimentError}
            <button onClick={() => setExperimentError(undefined)}>Dismiss</button>
          </div>
        )}
        {surface === "runs" && selectedRunId && store.status !== "live" && (
          <div className="notice" role="status">
            {store.error ?? "Loading the selected run…"}
            <button onClick={() => setConnectionNonce((value) => value + 1)}>Reconnect</button>
          </div>
        )}
        {surface === "checkpoints" && selectedRunId ? (
          <M7Workbench
            runId={selectedRunId}
            revision={snapshot?.revision}
            fetchView={fetchCheckpointView}
            createCheckpoint={captureCheckpoint}
            forkCheckpoint={forkCheckpoint}
          />
        ) : surface === "development" ? (
          <DevelopmentWorkbench
            onOpenRun={(runId) => {
              setSelectedRunId(runId);
              setSurface("runs");
              void loadCatalog();
            }}
          />
        ) : surface === "evals" ? (
          <>
            <RunComparisonPanel
              runs={visibleRuns}
              selectedIds={comparisonRunIds}
              onSelectionChange={setComparisonRunIds}
              onCompare={() => void compareSelectedRuns()}
              timeline={comparisonTimeline}
              error={comparisonTimelineError}
            />
            {selectedExperiment ? (
              <>
                <ExperimentCreator
                  workflows={workflows}
                  onCreated={(id) => {
                    setSelectedExperimentId(id);
                    void loadCatalog();
                  }}
                />
                <M5Workbench
                  key={selectedExperiment.id}
                  experiment={selectedExperiment}
                  comparisonTimeline={comparisonTimeline}
                  comparisonTimelineError={comparisonTimelineError}
                  onCompare={() =>
                    void compareSelectedRuns(completedComparisonRuns(selectedExperiment))
                  }
                  onLoadEvidence={loadCellEvidence}
                  experiments={experiments.map((item) => ({ id: item.id, name: item.name }))}
                  onSelectExperiment={setSelectedExperimentId}
                  pairwise={pairwise}
                  onPairwiseStart={() => void startPairwise()}
                  onPairwiseChoice={(choice) => void decidePairwise(choice)}
                  onOpenRun={(runId) => {
                    setSurface("runs");
                    setSelectedRunId(runId);
                  }}
                  onResume={() => void resumeExperiment()}
                  onCancel={() => void cancelExperiment()}
                />
              </>
            ) : (
              <ExperimentCreator
                workflows={workflows}
                initiallyOpen
                onCreated={(id) => {
                  setSelectedExperimentId(id);
                  void loadCatalog();
                }}
              />
            )}
          </>
        ) : surface === "swarm" && selectedRunId ? (
          <SwarmWorkbench runId={selectedRunId} fetchView={fetchCollaboration} />
        ) : loading ? (
          <div className="empty-state">
            <div className="loader" />
            Loading local workbench…
          </div>
        ) : surface !== "new-run" && selectedRunId && activeView ? (
          <Workbench
            key={activeView.runId}
            workflow={activeWorkflow}
            view={activeView}
            selectedInvocationId={selectedInvocation?.invocationId}
            setSelectedInvocationId={setSelectedInvocationId}
            onControl={controlRun}
            pendingAction={pendingAction}
            onInspectorResizeStart={(event) => startPanelResize("inspector", event)}
          />
        ) : surface === "runs" && selectedRunId ? (
          <div className="empty-state">{store.error ?? "Loading the selected run…"}</div>
        ) : (
          <Preview
            workflow={workflow}
            nodeSettings={nodeSettings}
            setNodeSettings={setNodeSettings}
            task={task}
            setTask={setTask}
            inputDrafts={inputDrafts}
            setInputDrafts={setInputDrafts}
            workspacePath={workspacePath}
            setWorkspacePath={setWorkspacePath}
            onLaunch={launch}
            launching={launching}
          />
        )}
      </main>
      {deletionPreview && (
        <RunDeletionDialog
          preview={deletionPreview}
          error={deletionError}
          busy={deletingRun}
          onClose={() => {
            if (!deletingRun) setDeletionPreview(undefined);
          }}
          onConfirm={() => void confirmRunDeletion()}
        />
      )}
    </div>
  );
}

function DevelopmentWorkbench({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [schema, setSchema] = useState(
    '{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}',
  );
  const [value, setValue] = useState('{"name":"Ada"}');
  const [prompt, setPrompt] = useState("Summarize {{name}} as JSON.");
  const [result, setResult] = useState<string>();
  const [promptRunId, setPromptRunId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (kind: "schema" | "prompt") => {
    setBusy(true);
    try {
      const response = await api<Record<string, unknown>>(`/api/development/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          kind === "schema"
            ? { schema: JSON.parse(schema), value: JSON.parse(value) }
            : {
                id: "playground",
                template: prompt,
                variablesSchema: JSON.parse(schema),
                variables: JSON.parse(value),
              },
        ),
      });
      setResult(JSON.stringify(response, null, 2));
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const runPrompt = async () => {
    setBusy(true);
    setPromptRunId(undefined);
    try {
      const response = await api<{ id: string }>("/api/development/prompt/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixture: {
            id: "playground",
            template: prompt,
            variablesSchema: JSON.parse(schema),
            variables: JSON.parse(value),
          },
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setPromptRunId(response.id);
      setResult(
        `Started ordinary run ${response.id}. Open it to inspect the prompt context, attempt, and events.`,
      );
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="development-workbench" aria-label="Developer tools">
      <div className="section-heading">
        <div>
          <div className="eyebrow">M8.1 · DEVELOPMENT</div>
          <h1>Prompt & schema playground</h1>
          <p>Validate fixtures and render prompt versions without starting the feature workflow.</p>
        </div>
      </div>
      <div className="dev-grid">
        <label>
          VARIABLE SCHEMA
          <textarea value={schema} onChange={(event) => setSchema(event.target.value)} />
        </label>
        <label>
          FIXTURE JSON
          <textarea value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <label className="dev-prompt">
          PROMPT TEMPLATE
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <div className="dev-actions">
          <button className="primary-button" disabled={busy} onClick={() => void run("schema")}>
            Validate schema
          </button>
          <button className="subtle-button" disabled={busy} onClick={() => void run("prompt")}>
            Render prompt
          </button>
          <button className="subtle-button" disabled={busy} onClick={() => void runPrompt()}>
            Run prompt fixture
          </button>
        </div>
        {promptRunId && (
          <button className="subtle-button" onClick={() => onOpenRun(promptRunId)}>
            Open run {promptRunId.slice(0, 12)}
          </button>
        )}
        <pre className="dev-result" aria-live="polite">
          {result ?? "Results and precise validation paths appear here."}
        </pre>
      </div>
    </section>
  );
}

function Sidebar({
  workflows,
  runs,
  shownRunCount,
  hasMoreRuns,
  loadingOlderRuns,
  onShowOlderRuns,
  onDeleteRun,
  workflowId,
  selectedRunId,
  setWorkflowId,
  setSelectedRunId,
  surface,
  setSurface,
  onResizeStart,
}: {
  workflows: WorkflowSummary[];
  runs: RunSummary[];
  shownRunCount: number;
  hasMoreRuns: boolean;
  loadingOlderRuns: boolean;
  onShowOlderRuns: () => void;
  onDeleteRun: (runId: string) => void;
  workflowId: string;
  selectedRunId?: string;
  setWorkflowId: (id: string) => void;
  setSelectedRunId: (id: string) => void;
  surface: "runs" | "new-run" | "evals" | "swarm" | "development" | "checkpoints";
  setSurface: (
    surface: "runs" | "new-run" | "evals" | "swarm" | "development" | "checkpoints",
  ) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <LogoMark />
        <span>KOURO</span>
        <small>LOCAL</small>
      </div>
      <div className="side-label">
        WORKFLOWS <span>{workflows.length}</span>
      </div>
      <div className="workflow-list">
        {workflows.map((workflow) => (
          <button
            className={`workflow-row ${workflow.id === workflowId ? "selected" : ""}`}
            key={workflow.id}
            onClick={() => setWorkflowId(workflow.id)}
          >
            <span className="workflow-glyph">◇</span>
            <span>
              <strong>{workflow.name ?? workflow.id}</strong>
              <em>{workflow.version ? `v${workflow.version}` : "local bundle"}</em>
            </span>
          </button>
        ))}
      </div>
      <div className="side-label runs-label">
        RECENT RUNS <span>{runs.length}</span>
      </div>
      <button
        className={`workflow-row ${surface === "checkpoints" ? "selected" : ""}`}
        onClick={() => setSurface("checkpoints")}
        disabled={!selectedRunId}
        aria-label="Open checkpoints and forks"
      >
        <span className="workflow-glyph">⌘</span>
        <span>
          <strong>Checkpoints</strong>
          <em>safe forks & genealogy</em>
        </span>
      </button>
      <div className="side-label runs-label">WORKBENCH</div>
      <button
        className={`workflow-row ${surface === "swarm" ? "selected" : ""}`}
        disabled={!selectedRunId}
        onClick={() => setSurface("swarm")}
      >
        <span className="workflow-glyph">⌘</span>
        <span>
          <strong>Collaboration</strong>
          <em>participants · messages</em>
        </span>
      </button>
      <button
        className={`workflow-row ${surface === "development" ? "selected" : ""}`}
        onClick={() => setSurface("development")}
      >
        <span className="workflow-glyph">✦</span>
        <span>
          <strong>Developer tools</strong>
          <em>prompts · schemas · graph</em>
        </span>
      </button>
      <button
        className={`workflow-row ${surface === "evals" ? "selected" : ""}`}
        onClick={() => setSurface("evals")}
      >
        <span className="workflow-glyph">▦</span>
        <span>
          <strong>Evaluations</strong>
          <em>datasets · experiments</em>
        </span>
      </button>
      <div className="run-list">
        {runs.slice(0, shownRunCount).map((run) => (
          <div className="run-row-shell" key={run.id}>
            <button
              className={`run-row ${run.id === selectedRunId ? "selected" : ""}`}
              onClick={() => setSelectedRunId(run.id)}
            >
              <StatusDot state={run.state} />
              <span>
                <strong>{run.workflowId || "run"}</strong>
                <em>
                  {run.task ? `${run.task.slice(0, 48)} · ` : ""}
                  {run.id.slice(0, 12)} ·{" "}
                  {run.createdAt
                    ? new Date(run.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "just now"}
                </em>
              </span>
              <small>{run.state}</small>
            </button>
            <button
              type="button"
              className="run-delete-action"
              aria-label={`Delete run ${run.id.slice(0, 12)}`}
              title="Delete run"
              onClick={() => onDeleteRun(run.id)}
            >
              ×
            </button>
          </div>
        ))}
        {(runs.length > shownRunCount || hasMoreRuns) && (
          <button
            type="button"
            className="older-runs-button"
            onClick={onShowOlderRuns}
            disabled={loadingOlderRuns}
          >
            {loadingOlderRuns ? "Loading older runs…" : "Show older runs"}
          </button>
        )}
      </div>
      <div className="sidebar-footer">
        <span className="connection-dot" /> local host{" "}
        <span className="footer-version">v2 / local</span>
      </div>
      <ResizeHandle label="Resize navigation sidebar" onStart={onResizeStart} />
    </aside>
  );
}

function ExperimentCreator({
  workflows,
  onCreated,
  initiallyOpen = false,
}: {
  workflows: WorkflowSummary[];
  onCreated: (id: string) => void;
  initiallyOpen?: boolean;
}) {
  const available = workflows.filter((item) => item.id && item.digest);
  const [open, setOpen] = useState(initiallyOpen);
  const [workflowId, setWorkflowId] = useState(available[0]?.id ?? "");
  const [name, setName] = useState("");
  const [cases, setCases] = useState('[{"id":"case-1","input":{"task":"Describe the task"}}]');
  const [repetitions, setRepetitions] = useState(1);
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const workflow = available.find((item) => item.id === workflowId);
    if (!workflow?.digest) {
      setError("Choose a workflow with a compiled digest.");
      return;
    }
    setBusy(true);
    setError(undefined);
    const id =
      name
        .trim()
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `experiment-${Date.now()}`;
    try {
      const parsedCases: unknown = JSON.parse(cases);
      if (!Array.isArray(parsedCases) || parsedCases.length === 0)
        throw new Error("Dataset cases must be a non-empty JSON array.");
      const result = await api<{ id: string }>("/api/experiments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          dataset: { id: `${id}-dataset`, version: "1", cases: parsedCases },
          repetitions,
          maxConcurrent,
          variants: [
            {
              id: "baseline",
              workflowId,
              workflowDigest: workflow.digest,
              executionProfile: "scripted",
              configuration: {},
            },
          ],
        }),
      });
      onCreated(result.id);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create experiment");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`experiment-creator ${open ? "expanded" : ""}`}>
      {!open ? (
        <button className="subtle-button" onClick={() => setOpen(true)}>
          ＋ New experiment
        </button>
      ) : (
        <form onSubmit={(event) => void create(event)}>
          <header>
            <div>
              <div className="eyebrow">EVALUATION SETUP</div>
              <h2>Create experiment</h2>
            </div>
            {!initiallyOpen && (
              <button type="button" className="subtle-button" onClick={() => setOpen(false)}>
                Close
              </button>
            )}
          </header>
          <label>
            NAME
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. prompt-baseline-check"
            />
          </label>
          <label>
            WORKFLOW
            <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name ?? item.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            DATASET CASES · JSON
            <textarea
              value={cases}
              onChange={(event) => setCases(event.target.value)}
              rows={5}
              spellCheck={false}
            />
          </label>
          <div className="experiment-numeric-fields">
            <label>
              REPETITIONS
              <input
                type="number"
                min={1}
                max={100}
                value={repetitions}
                onChange={(event) => setRepetitions(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <label>
              MAX CONCURRENT
              <input
                type="number"
                min={1}
                max={32}
                value={maxConcurrent}
                onChange={(event) => setMaxConcurrent(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
          </div>
          <p>
            Creates one scripted baseline variant. Dataset manifests are immutable after creation.
          </p>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" type="submit" disabled={busy || !available.length}>
            {busy ? "Creating…" : "Create experiment"}
          </button>
        </form>
      )}
    </section>
  );
}

function RunDeletionInbox({
  items,
  onOpen,
}: {
  items: PendingRunDeletion[];
  onOpen: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="approval-inbox">
      <button
        className="subtle-button surface-switch"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Cleanup <b>{items.length}</b>
      </button>
      {open && (
        <section className="approval-inbox-menu" role="dialog" aria-label="Incomplete run cleanup">
          <header>
            <strong>Incomplete run cleanup</strong>
            <button onClick={() => setOpen(false)} aria-label="Close cleanup list">
              ×
            </button>
          </header>
          {items.map((item) => (
            <button
              key={item.runId}
              onClick={() => {
                onOpen(item.runId);
                setOpen(false);
              }}
            >
              <strong>{item.status}</strong>
              <span>{String(item.task || item.workflowId || item.runId)}</span>
              <small>{item.error || item.runId}</small>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function ApprovalInbox({
  items,
  onOpen,
}: {
  items: PendingApproval[];
  onOpen: (approval: PendingApproval) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="approval-inbox">
      <button
        className="subtle-button surface-switch"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        Approvals <b>{items.length}</b>
      </button>
      {open && (
        <section className="approval-inbox-menu" role="dialog" aria-label="Pending approvals">
          <header>
            <strong>Pending approvals</strong>
            <button onClick={() => setOpen(false)} aria-label="Close approvals">
              ×
            </button>
          </header>
          {items.length ? (
            items.map((item) => (
              <button
                key={item.approvalId ?? `${item.runId}:${item.invocationId}`}
                onClick={() => {
                  onOpen(item);
                  setOpen(false);
                }}
              >
                <strong>{item.action}</strong>
                <span>{item.task || item.workflowId}</span>
                <small>
                  {item.runId.slice(0, 12)} · {item.invocationId.slice(0, 12)}
                </small>
              </button>
            ))
          ) : (
            <p>No pending approvals.</p>
          )}
        </section>
      )}
    </div>
  );
}

function RunComparisonPanel({
  runs,
  selectedIds,
  onSelectionChange,
  onCompare,
  timeline,
  error,
}: {
  runs: RunSummary[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onCompare: () => void;
  timeline?: ComparisonTimeline;
  error?: string;
}) {
  const selected = selectedIds.map((id) => runs.find((run) => run.id === id)).filter(Boolean);
  const incompatible =
    selected.length === 2 &&
    (selected[0]?.workflowId !== selected[1]?.workflowId ||
      selected[0]?.executionProfile !== selected[1]?.executionProfile);
  return (
    <section className="run-comparison-panel" aria-label="Compare ordinary runs">
      <header>
        <div>
          <div className="eyebrow">RUN COMPARISON</div>
          <h2>Compare two runs</h2>
          <p>Select any two runs. The comparison is pinned to their current journal revisions.</p>
        </div>
        <button className="primary-button" disabled={selectedIds.length !== 2} onClick={onCompare}>
          Compare selected
        </button>
      </header>
      <div className="comparison-run-picker">
        {runs.slice(0, 16).map((run) => (
          <label key={run.id}>
            <input
              type="checkbox"
              checked={selectedIds.includes(run.id)}
              disabled={!selectedIds.includes(run.id) && selectedIds.length >= 2}
              onChange={(event) =>
                onSelectionChange(
                  event.target.checked
                    ? [...selectedIds, run.id].slice(-2)
                    : selectedIds.filter((id) => id !== run.id),
                )
              }
            />
            <span>
              <strong>{run.task || run.workflowId}</strong>
              <small>
                {run.workflowId} · {run.state} · {run.id.slice(0, 12)}
              </small>
            </span>
          </label>
        ))}
      </div>
      {incompatible && (
        <p className="comparison-warning">
          These runs use different workflow or execution-profile settings. Stage alignment is
          best-effort; outputs may not be directly equivalent.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {timeline && (
        <div className="comparison-result" aria-live="polite">
          <h3>Stages · {timeline.rows.length}</h3>
          {timeline.rows.map((row) => (
            <div key={row.anchorId}>
              <strong>{row.label}</strong>
              <span>
                {row.spans
                  .map((span) =>
                    span ? String(span.status ?? span.label ?? "observed") : "missing",
                  )
                  .join(" · ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RunDeletionDialog({
  preview,
  error,
  busy,
  onClose,
  onConfirm,
}: {
  preview: Record<string, unknown>;
  error?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);
  const workspaces = Array.isArray(preview.workspaces) ? preview.workspaces : [];
  const blockers = Array.isArray(preview.blockers) ? preview.blockers : [];
  const removes = (preview.removes ?? {}) as Record<string, unknown>;
  const task =
    typeof preview.task === "string" && preview.task.trim() ? preview.task : "Untitled task";
  const runId = typeof preview.runId === "string" ? preview.runId : "unknown";
  const canDelete = preview.canDelete === true;
  return (
    <dialog
      ref={dialog}
      className="run-deletion-dialog"
      aria-labelledby="run-deletion-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <header>
        <div>
          <div className="eyebrow">REMOVE FINISHED RUN</div>
          <h2 id="run-deletion-title">Delete this run?</h2>
        </div>
        <button type="button" className="subtle-button" onClick={onClose} disabled={busy}>
          Close
        </button>
      </header>
      <p className="deletion-task">{task}</p>
      <p className="deletion-run-id">{runId}</p>
      <div className="deletion-summary">
        <span>{String(removes.historyEvents ?? 0)} history events</span>
        <span>{String(removes.attempts ?? 0)} attempts</span>
        <span>{String(removes.artifacts ?? 0)} artifacts</span>
        <span>{String(removes.workspaces ?? workspaces.length)} owned worktrees</span>
      </div>
      {workspaces.length > 0 && (
        <section>
          <h3>Owned worktrees to remove</h3>
          <ul>
            {workspaces.map((item, index) => {
              const workspace = item as Record<string, unknown>;
              return (
                <li key={`${String(workspace.workspaceId ?? index)}`}>
                  {String(workspace.path ?? "worktree")}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {blockers.length > 0 && (
        <section>
          <h3>Retained references</h3>
          <ul>
            {blockers.map((item, index) => (
              <li key={index}>
                {String((item as Record<string, unknown>).message ?? "Referenced by retained data")}
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview.workspaceAdapterMissing === true && (
        <p className="notice error">
          The workspace adapter is unavailable, so owned worktrees cannot be safely removed.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button type="button" className="subtle-button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="danger-button"
          onClick={onConfirm}
          disabled={
            !(
              canDelete ||
              [
                "workspace-cleanup-failed",
                "workspace-cleaned",
                "purge-failed",
                "database-purged",
                "blob-cleanup-failed",
              ].includes(String(preview.deletionStatus))
            ) || busy
          }
        >
          {busy
            ? "Removing run…"
            : [
                  "workspace-cleanup-failed",
                  "workspace-cleaned",
                  "purge-failed",
                  "database-purged",
                  "blob-cleanup-failed",
                ].includes(String(preview.deletionStatus))
              ? "Retry cleanup"
              : "Delete run and owned history"}
        </button>
      </footer>
    </dialog>
  );
}

function Topbar({
  run,
  view,
  store,
  onLaunch,
  onNewRun,
  launching,
  canLaunch,
  runs,
  selectedRunId,
  onSelectRun,
  pendingApprovals,
  onOpenApproval,
  pendingRunDeletions,
  onOpenDeletion,
  pendingAction,
  actionNotice,
  onControl,
  workflows,
  workflowId,
  setWorkflowId,
  surface,
  setSurface,
}: {
  run?: RunSummary;
  view: UiRunView | null;
  store: RunSyncStore;
  onLaunch: () => void;
  onNewRun: () => void;
  launching: boolean;
  canLaunch: boolean;
  runs: RunSummary[];
  selectedRunId?: string;
  onSelectRun: (id: string) => void;
  pendingApprovals: PendingApproval[];
  pendingRunDeletions: PendingRunDeletion[];
  onOpenApproval: (approval: PendingApproval) => void;
  onOpenDeletion: (runId: string) => void;
  pendingAction?: string;
  actionNotice?: string;
  onControl: ControlAction;
  workflows: WorkflowSummary[];
  workflowId: string;
  setWorkflowId: (id: string) => void;
  surface: "runs" | "new-run" | "evals" | "swarm" | "development" | "checkpoints";
  setSurface: (
    surface: "runs" | "new-run" | "evals" | "swarm" | "development" | "checkpoints",
  ) => void;
}) {
  const now = useServerNow(view?.servedAt, 250);
  const start = isoMs(view?.startedAt ?? run?.startedAt ?? view?.serverClock, now);
  const end = isoMs(view?.finishedAt ?? run?.endedAt, now);
  const elapsed = Math.max(0, end - start);
  const state = view?.state ?? run?.state;
  return (
    <header className="topbar">
      <div className="crumb">
        Kouro <span>/</span> Local workbench
      </div>
      <div className="topbar-run">
        {run ? (
          <>
            <StatusDot state={state} />
            <span className="run-id">{run.id}</span>
            {run.task && (
              <span className="topbar-task" title={run.task}>
                {run.task}
              </span>
            )}
            <RoleBadge label="operator" />
          </>
        ) : (
          <span className="muted">No active run</span>
        )}
      </div>
      <div className="top-actions">
        <ApprovalInbox items={pendingApprovals} onOpen={onOpenApproval} />
        <RunDeletionInbox items={pendingRunDeletions} onOpen={onOpenDeletion} />
        <label className="compact-run-picker">
          <span>RUN</span>
          <select
            aria-label="Selected run"
            value={selectedRunId ?? ""}
            onChange={(event) => onSelectRun(event.target.value)}
          >
            <option value="">Choose a run</option>
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.task || item.workflowId} · {item.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`subtle-button surface-switch ${surface === "swarm" ? "active" : ""}`}
          disabled={!run}
          onClick={() => setSurface(surface === "swarm" ? "runs" : "swarm")}
        >
          Collaboration
        </button>
        <button
          className={`subtle-button surface-switch ${surface === "checkpoints" ? "active" : ""}`}
          onClick={() => setSurface(surface === "checkpoints" ? "runs" : "checkpoints")}
          disabled={!run}
          aria-label="Toggle checkpoints and forks"
        >
          <span aria-hidden="true">⌘</span> Checkpoints
        </button>
        <button
          className={`subtle-button surface-switch ${surface === "evals" ? "active" : ""}`}
          onClick={() => setSurface(surface === "evals" ? "runs" : "evals")}
        >
          Evaluations
        </button>
        <button
          className={`subtle-button surface-switch ${surface === "development" ? "active" : ""}`}
          onClick={() => setSurface(surface === "development" ? "runs" : "development")}
        >
          Developer tools
        </button>
        <label className="compact-workflow-picker">
          <span>WORKFLOW</span>
          <select
            aria-label="Workflow"
            value={workflowId}
            onChange={(event) => setWorkflowId(event.target.value)}
          >
            {workflows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name ?? item.id}
              </option>
            ))}
          </select>
        </label>
        <span className={`stream-state ${store.status}`}>
          <i />
          {store.status === "live" ? "LIVE" : store.status.toUpperCase()}
        </span>
        {run && <span className="elapsed">{formatDuration(elapsed)}</span>}
        {run && view && (
          <RunControlBar view={view} pendingAction={pendingAction} onControl={onControl} />
        )}
        <span data-testid="run-status" className="sr-only">
          {state ?? "idle"}
        </span>
        {run && (
          <button
            className="subtle-button"
            aria-label="New run with different input"
            onClick={onNewRun}
          >
            New run
          </button>
        )}
        <button
          data-testid="start-run"
          className="launch-button"
          disabled={launching || !canLaunch}
          onClick={onLaunch}
        >
          <span>＋</span>
          {launching ? "Starting" : "Run workflow"}
        </button>
      </div>
      {actionNotice && (
        <div className="action-notice" role="status">
          {actionNotice}
        </div>
      )}
    </header>
  );
}

function allowed(view: UiRunView, capability: keyof UiRunView["capabilities"]) {
  return view.capabilities[capability] === true;
}

function RunControlBar({
  view,
  pendingAction,
  onControl,
}: {
  view: UiRunView;
  pendingAction?: string;
  onControl: (action: string) => void;
}) {
  const running = view.state === "running";
  const paused = (view.state as string) === "paused";
  const action = (name: string, capability: keyof UiRunView["capabilities"], label: string) => (
    <button
      className={`control-button ${name === "cancel" ? "danger" : ""}`}
      disabled={pendingAction !== undefined || !allowed(view, capability)}
      title={
        !allowed(view, capability) ? "The runtime has not declared this operation safe" : label
      }
      aria-label={label}
      onClick={() => onControl(name)}
    >
      {pendingAction === name ? `${label}…` : label}
    </button>
  );
  return (
    <div className="run-controls" aria-label="Run controls">
      {running && allowed(view, "pause") && action("pause", "pause", "Pause")}
      {paused && allowed(view, "resume") && action("resume", "resume", "Resume")}
      {running && allowed(view, "interrupt") && action("interrupt", "interrupt", "Interrupt")}
      {(running || paused) && allowed(view, "cancel") && action("cancel", "cancel", "Cancel")}
      {!running &&
        !paused &&
        allowed(view, "reattach") &&
        action("reattach", "reattach", "Reattach")}
    </div>
  );
}

function Preview({
  workflow,
  nodeSettings,
  setNodeSettings,
  task,
  setTask,
  inputDrafts,
  setInputDrafts,
  workspacePath,
  setWorkspacePath,
  onLaunch,
  launching,
}: {
  workflow?: WorkflowSummary;
  nodeSettings: Record<string, { harness?: string; modelId?: string; capabilities?: string[] }>;
  setNodeSettings: (
    settings: Record<string, { harness?: string; modelId?: string; capabilities?: string[] }>,
  ) => void;
  task: string;
  setTask: (task: string) => void;
  inputDrafts: Record<string, string>;
  setInputDrafts: (drafts: Record<string, string>) => void;
  workspacePath: string;
  setWorkspacePath: (path: string) => void;
  onLaunch: () => void;
  launching: boolean;
}) {
  const root = workflow?.bundle?.definitions[workflow.bundle.rootDefinitionId];
  const taskInput = root?.inputPorts?.find((port) => port.name === "task");
  const taskRequired = taskInput?.required === true;
  const inputs = launchInputs(workflow?.bundle, task, inputDrafts);
  const childDefinitions = new Set(
    Object.values(workflow?.bundle?.definitions ?? {}).flatMap((definition) =>
      (definition.scouts ?? []).map((scout) => scout.definitionId),
    ),
  );
  const editableNodes = Object.entries(workflow?.bundle?.definitions ?? {}).flatMap(
    ([definitionId, definition]) =>
      definition.nodes
        .filter((node) => node.kind === "agent" || node.kind === "command")
        .map((node) => ({
          node,
          definitionId,
          key: `${definitionId}/${node.id}`,
          readOnly: childDefinitions.has(definitionId),
        })),
  );
  const updateNode = (
    nodeId: string,
    update: { harness?: string; modelId?: string; capabilities?: string[] },
  ) => setNodeSettings({ ...nodeSettings, [nodeId]: { ...nodeSettings[nodeId], ...update } });
  return (
    <section className="preview">
      <div className="preview-kicker">
        WORKFLOW PREVIEW <span>UNEXECUTED</span>
      </div>
      {editableNodes.length > 0 && (
        <section className="node-settings">
          <h2>Node settings</h2>
          <p>
            Choose the harness and model for each parent and child. Use a model your provider
            account can access.
          </p>
          {editableNodes.map(({ node, definitionId, key, readOnly }) => {
            const settings = nodeSettings[key] ?? {};
            const capabilities = settings.capabilities ?? node.capabilities ?? [];
            return (
              <fieldset key={key} className="node-setting">
                <legend>
                  {definitionId} / {node.id} · {readOnly ? "read-only subagent" : node.kind}
                </legend>
                {node.kind === "agent" && (
                  <>
                    <label>
                      Harness
                      <select
                        value={settings.harness ?? node.harness ?? ""}
                        onChange={(event) =>
                          updateNode(key, { harness: event.target.value || undefined })
                        }
                      >
                        <option value="">Host default</option>
                        <option value="codex">Codex</option>
                        <option value="pi">Pi</option>
                        <option value="claude">Claude</option>
                        <option value="opencode">OpenCode</option>
                      </select>
                    </label>
                    <label>
                      Model
                      <input
                        value={settings.modelId ?? node.modelId ?? ""}
                        placeholder="Harness default"
                        onChange={(event) =>
                          updateNode(key, { modelId: event.target.value || undefined })
                        }
                      />
                    </label>
                  </>
                )}
                <label className="node-capability">
                  <input
                    type="checkbox"
                    checked={capabilities.includes("repository.read")}
                    onChange={(event) =>
                      updateNode(key, {
                        capabilities: event.target.checked
                          ? [...capabilities, "repository.read"]
                          : capabilities.filter((item) => item !== "repository.read"),
                      })
                    }
                  />
                  Repository read
                </label>
                <label className="node-capability">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={capabilities.includes("repository.write")}
                    onChange={(event) =>
                      updateNode(key, {
                        capabilities: event.target.checked
                          ? [...capabilities, "repository.write"]
                          : capabilities.filter((item) => item !== "repository.write"),
                      })
                    }
                  />
                  Repository write
                </label>
                {node.kind === "command" && (
                  <label className="node-capability">
                    <input
                      type="checkbox"
                      checked={capabilities.includes("terminal.execute")}
                      onChange={(event) =>
                        updateNode(key, {
                          capabilities: event.target.checked
                            ? [...capabilities, "terminal.execute"]
                            : capabilities.filter((item) => item !== "terminal.execute"),
                        })
                      }
                    />
                    Run command outside the sandbox
                  </label>
                )}
              </fieldset>
            );
          })}
        </section>
      )}
      <h1>{workflow?.name ?? workflow?.id ?? "Select a workflow"}</h1>
      <p className="preview-desc">
        Review the compiled execution path before admitting a local run.
      </p>
      {workflow?.validation && !workflow.validation.valid && (
        <div className="validation-warning">
          Bundle validation failed: {workflow.validation.errors?.join(", ")}
        </div>
      )}
      {taskInput && (
        <label className="task-input">
          <span>WORK ITEM / TASK{taskRequired ? " · REQUIRED" : ""}</span>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="Describe what this workflow should accomplish…"
            rows={4}
          />
          <small>The task is delivered as the workflow's typed root input.</small>
        </label>
      )}
      <WorkflowInputs
        bundle={workflow?.bundle}
        drafts={inputDrafts}
        onChange={setInputDrafts}
        errors={inputs.errors}
      />
      <label className="task-input">
        <span>
          REPOSITORY / WORKSPACE <small>OPTIONAL</small>
        </span>
        <input
          value={workspacePath}
          onChange={(event) => setWorkspacePath(event.target.value)}
          placeholder="/path/to/a git repository"
        />
        <small>Workspace effects run in an isolated managed worktree.</small>
      </label>
      <div className="preview-map">
        {workflow?.graph?.nodes?.map((node, index) => (
          <div className="preview-node" key={node.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{node.label}</strong>
              <em>
                {node.kind}
                {node.role ? ` · ${node.role}` : ""}
              </em>
            </div>
          </div>
        )) ?? <div className="empty-inline">The host did not return a compiled graph.</div>}
      </div>
      <button
        className="primary-cta"
        disabled={!workflow || launching || !inputs.valid}
        onClick={onLaunch}
      >
        {launching ? "Starting run…" : taskRequired ? "Run workflow" : "Start demo run"}
        <span>→</span>
      </button>
    </section>
  );
}

function Workbench({
  workflow,
  view,
  selectedInvocationId,
  setSelectedInvocationId,
  onControl,
  pendingAction,
  onInspectorResizeStart,
}: {
  workflow?: WorkflowSummary;
  view: UiRunView;
  selectedInvocationId?: string;
  setSelectedInvocationId: (id: string) => void;
  onControl: ControlAction;
  pendingAction?: string;
  onInspectorResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [scoutRequests, setScoutRequests] = useState<ScoutTimelineRequest[]>([]);
  const [mode, setMode] = useState<"graph" | "split" | "timeline">(() => {
    const saved = readPreference("kouro.view.mode", "split");
    return saved === "graph" || saved === "timeline" ? saved : "split";
  });
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [sessionRequest, setSessionRequest] = useState(0);
  const selectInvocation = useCallback(
    (id: string) => {
      setSelectedInvocationId(id);
      if (window.matchMedia("(max-width: 800px)").matches) setMobileInspectorOpen(true);
    },
    [setSelectedInvocationId],
  );
  const agentInvocations = asArray(view.invocations).filter((invocation) =>
    view.bundle.definitions?.[
      view.scopes[invocation.scopeId]?.definitionId ?? view.bundle.rootDefinitionId
    ]?.nodes.some((node) => node.id === invocation.sourceNodeId && node.kind === "agent"),
  );
  const sessionTarget =
    agentInvocations.find((item) => item.invocationId === selectedInvocationId) ??
    agentInvocations.find((item) => item.state === "running") ??
    agentInvocations.at(-1);
  useEffect(() => writePreference("kouro.view.mode", mode), [mode]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const requests = await api<ScoutTimelineRequest[]>(
          `/api/runs/${encodeURIComponent(view.runId)}/scouts`,
        );
        if (!cancelled)
          setScoutRequests((previous) =>
            JSON.stringify(previous) === JSON.stringify(requests) ? previous : requests,
          );
      } catch {
        if (!cancelled) setScoutRequests((previous) => (previous.length ? [] : previous));
      }
    };
    void refresh();
    if (view.state === "running") {
      const timer = window.setInterval(() => void refresh(), 1000);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [view.runId, view.state]);
  return (
    <section className={`workbench ${mobileInspectorOpen ? "inspector-open" : ""}`}>
      <div className="view-toolbar">
        <div className="view-tabs">
          <button
            data-testid="split-view"
            className={mode === "split" ? "active" : ""}
            onClick={() => setMode("split")}
          >
            SPLIT VIEW
          </button>
          <button
            data-testid="graph-view"
            className={mode === "graph" ? "active" : ""}
            onClick={() => setMode("graph")}
          >
            GRAPH
          </button>
          <button
            data-testid="timeline-view"
            className={mode === "timeline" ? "active" : ""}
            onClick={() => setMode("timeline")}
          >
            TIMELINE
          </button>
        </div>
        <span className="toolbar-rule" />
        <span className="toolbar-caption">
          compiled graph <b>{workflow?.digest?.slice(0, 8) ?? "local"}</b>
        </span>
        <span className="toolbar-caption">rev {view.revision}</span>
        <button
          className="subtle-button"
          disabled={!sessionTarget}
          onClick={() => {
            if (!sessionTarget) return;
            setSelectedInvocationId(sessionTarget.invocationId);
            setSessionRequest((value) => value + 1);
          }}
        >
          Agent session
        </button>
        <button
          className="mobile-inspector-toggle"
          onClick={() => setMobileInspectorOpen((open) => !open)}
        >
          {mobileInspectorOpen ? "Close inspector" : "Inspector"}
        </button>
      </div>
      <div className={`work-area ${mode}`}>
        <GraphPanel
          graph={workflow?.graph}
          view={view}
          selectedId={selectedInvocationId}
          onSelect={selectInvocation}
        />
        <Timeline
          view={view}
          scoutRequests={scoutRequests}
          selectedId={selectedInvocationId}
          onSelect={selectInvocation}
        />
      </div>
      <Inspector
        view={view}
        scoutRequests={scoutRequests}
        graph={workflow?.graph}
        selectedId={selectedInvocationId}
        onSelect={selectInvocation}
        sessionRequest={sessionRequest}
        onControl={onControl}
        pendingAction={pendingAction}
        onResizeStart={onInspectorResizeStart}
      />
    </section>
  );
}

const nodeTypes = { work: WorkNode, scope: ScopeNode };
function WorkNode({ data, selected }: NodeProps) {
  const node = data.node as WorkflowNode;
  const state = data.state as string | undefined;
  return (
    <div className={`work-node ${selected ? "selected" : ""} ${state ?? ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-top">
        <span className="node-kind">{node.kind}</span>
        <StatusDot state={state} />
      </div>
      <strong>{node.label}</strong>
      <span className="sr-only">{state ?? "not started"}</span>
      {node.role && <em>{node.role}</em>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ScopeNode({ data }: NodeProps) {
  const scope = data.scope as GraphScope;
  const toggle = data.onToggle as ((id: string) => void) | undefined;
  return (
    <div className="scope-node" data-testid={`scope-${scope.id}`}>
      <button
        type="button"
        className="scope-toggle"
        data-collapsed={scope.collapsed ? "true" : "false"}
        onClick={(event) => {
          event.stopPropagation();
          toggle?.(scope.id);
        }}
      >
        <span>{scope.label}</span>
        <small>{scope.collapsed ? "collapsed" : "scope"}</small>
      </button>
    </div>
  );
}

const GraphPanel = memo(function GraphPanel({
  graph,
  view,
  selectedId,
  onSelect,
}: {
  graph?: WorkflowGraph;
  view: UiRunView;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const reactFlow = useReactFlow();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showOutline, setShowOutline] = useState(false);
  const invocations = asArray(view.invocations);
  const runningNodeIds = useMemo(
    () =>
      new Set(
        invocations.filter((item) => item.state === "running").map((item) => item.sourceNodeId),
      ),
    [invocations],
  );
  const projection = useMemo(
    () => projectHierarchicalGraph(graph, view, collapsed),
    [graph, view, collapsed],
  );
  const breadcrumbs = useMemo(
    () => graphSelectionBreadcrumbs(graph, view, selectedId),
    [graph, view, selectedId],
  );
  // React Flow's initial fit only runs on mount. Child scopes can arrive later,
  // and expanding a scope can place previously hidden nodes outside the current
  // viewport. Refit on topology changes, not on every live status frame.
  const layoutKey = projection.nodes.map((node) => node.id).join("|");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void reactFlow.fitView({ duration: 0, padding: 0.2 });
    });
    return () => cancelAnimationFrame(frame);
  }, [layoutKey, reactFlow]);
  const nodes = useMemo(
    () =>
      projection.nodes.map((node) =>
        node.type === "scope"
          ? {
              ...node,
              data: {
                ...node.data,
                onToggle: (id: string) =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  }),
              },
            }
          : { ...node, selected: node.data.invocationId === selectedId },
      ),
    [projection.nodes, selectedId],
  );
  const edges: Edge[] = useMemo(
    () =>
      projection.edges
        .filter((edge) => !edge.hidden)
        .map((edge) => ({
          ...edge,
          type: "smoothstep",
          animated: Boolean(runningNodeIds.has(edge.source)),
          className: edge.className ? `work-edge ${edge.className}` : "work-edge",
          labelStyle: { fill: "#71809a", fontSize: 10 },
          labelBgStyle: { fill: "#111824", fillOpacity: 0.92 },
          labelBgPadding: [5, 3] as [number, number],
        })),
    [projection.edges, runningNodeIds],
  );
  const handleNode = (_: unknown, node: Node) => {
    if (node.type === "scope") {
      // ScopeNode owns the toggle button. Keeping this handler passive avoids
      // a single click being applied twice (once by the button and once by
      // React Flow's node-level click delegate).
      return;
    }
    const projectedId = node.data.invocationId as string | undefined;
    const nodeInvocations = invocations.filter(
      (item) => item.sourceNodeId === (node.data.node as WorkflowNode).id,
    );
    const id =
      projectedId ??
      nodeInvocations.find((item) => item.invocationId === selectedId)?.invocationId ??
      invokeId(node.data.node as WorkflowNode, invocations);
    if (id) onSelect(id);
  };
  return (
    <div className="graph-panel" data-testid="workflow-graph">
      <div className="panel-heading">
        <span>EXECUTION GRAPH</span>
        <div>
          {breadcrumbs.length > 0 && (
            <span className="graph-breadcrumb" data-testid="graph-breadcrumb">
              root / {breadcrumbs.join(" / ")}
            </span>
          )}
          {(() => {
            const source = invocations.find(
              (item) => item.invocationId === selectedId,
            )?.sourceNodeId;
            const instances = projection.instances.filter((item) => item.sourceNodeId === source);
            return instances.length > 1 ? (
              <select
                aria-label="Invocation instance"
                value={selectedId ?? ""}
                onChange={(event) => onSelect(event.target.value)}
              >
                {instances.map((item) => (
                  <option key={item.invocationId} value={item.invocationId}>
                    instance {item.ordinal} · {item.scopeId}
                  </option>
                ))}
              </select>
            ) : null;
          })()}
          <button
            aria-label={showOutline ? "Hide workflow outline" : "Show workflow outline"}
            aria-expanded={showOutline}
            onClick={() => setShowOutline((value) => !value)}
          >
            OUTLINE
          </button>
          <button
            aria-label="Fit graph to view"
            onClick={() => reactFlow.fitView({ duration: 500, padding: 0.25 })}
          >
            FIT
          </button>
          <button aria-label="Zoom graph in" onClick={() => reactFlow.zoomIn({ duration: 180 })}>
            +
          </button>
          <button aria-label="Zoom graph out" onClick={() => reactFlow.zoomOut({ duration: 180 })}>
            −
          </button>
        </div>
      </div>
      <div className="graph-canvas">
        {graph?.nodes?.length ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNode}
            fitView
            minZoom={0.1}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#172131" gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : (
          <div className="empty-inline">No compiled graph returned for this workflow.</div>
        )}
      </div>
      {showOutline && (
        <div className="graph-outline" role="region" aria-label="Workflow outline">
          <ol>
            {[...invocations]
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((invocation) => (
                <li key={invocation.invocationId}>
                  <button
                    type="button"
                    aria-current={selectedId === invocation.invocationId ? "true" : undefined}
                    onClick={() => onSelect(invocation.invocationId)}
                  >
                    {invocation.sourceNodeId} · {invocation.state} · {invocation.scopeId}
                  </button>
                </li>
              ))}
          </ol>
          {!invocations.length && <p>No invocations have started.</p>}
        </div>
      )}
    </div>
  );
});

function Timeline({
  view,
  scoutRequests = [],
  selectedId,
  onSelect,
}: {
  view: UiRunView;
  scoutRequests?: ScoutTimelineRequest[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [width, setWidth] = useState(680);
  const now = useServerNow(view.servedAt, 120);
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 340 });
  const [domain, setDomain] = useState<{ runId: string; start: number; end: number }>();
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport({ top: element.scrollTop, height: element.clientHeight }),
    );
    observer.observe(element);
    setViewport({ top: element.scrollTop, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);
  // A clock tick must update the visible active bars, not sort and aggregate
  // the entire durable history again. The projection changes only on a frame.
  const rows = useMemo(() => {
    const invocations = asArray(view.invocations);
    const attempts = asArray(view.attempts);
    const attemptsByInvocation = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const related = attemptsByInvocation.get(attempt.invocationId) ?? [];
      related.push(attempt);
      attemptsByInvocation.set(attempt.invocationId, related);
    }
    const scopeDepth = (scopeId: string) => {
      let depth = 0;
      const seen = new Set<string>();
      let scope = view.scopes[scopeId];
      while (scope?.parentScopeId && !seen.has(scope.id)) {
        seen.add(scope.id);
        depth += 1;
        scope = view.scopes[scope.parentScopeId];
      }
      return depth;
    };
    const fallback = isoMs(view.servedAt, Date.now());
    // Activation order is durable; never let status updates reshuffle rows.
    const invocationRows = [...invocations]
      .sort((a, b) => a.ordinal - b.ordinal || a.invocationId.localeCompare(b.invocationId))
      .map((invocation) => {
        const related = attemptsByInvocation.get(invocation.invocationId) ?? [];
        const start = isoMs(invocation.startedAt, fallback);
        const end = isoMs(invocation.endedAt, start + 1);
        return {
          key: invocation.invocationId,
          invocationId: invocation.invocationId,
          label: invocation.sourceNodeId,
          state: invocation.state,
          start,
          end,
          depth: scopeDepth(invocation.scopeId),
          attempts: related,
          kind: "invocation" as const,
        };
      });
    const scoutRows = scoutRequests.map((request) => {
      const parent = invocations.find((item) => item.invocationId === request.parentInvocationId);
      const start = isoMs(request.createdAt, fallback);
      return {
        key: `${request.parentAttemptId}:${request.requestId}`,
        invocationId: request.parentInvocationId,
        label: request.scoutId,
        state: request.state,
        start,
        end: isoMs(request.updatedAt, start + 1),
        depth: parent ? scopeDepth(parent.scopeId) + 1 : 1,
        attempts: [] as typeof attempts,
        kind: "scout" as const,
      };
    });
    return [...invocationRows, ...scoutRows].sort(
      (a, b) => a.start - b.start || a.key.localeCompare(b.key),
    );
  }, [view.invocations, view.attempts, view.scopes, view.servedAt, scoutRequests]);
  const hasActive = rows.some(({ state }) => state === "running" || state === "accepted");
  const baseBound = useMemo(() => {
    const anchor = isoMs(view.finishedAt, isoMs(view.servedAt, Date.now()));
    return spanBounds(
      [
        ...rows,
        ...asArray(view.spans).map((span) => ({
          start: isoMs(span.startUtc, anchor),
          end: isoMs(span.endUtc, anchor),
          elapsed: span.elapsedMs,
        })),
      ],
      anchor,
    );
  }, [rows, view.spans, view.finishedAt, view.servedAt]);
  const bound = {
    start: baseBound.start,
    end: hasActive ? Math.max(baseBound.end, now) : baseBound.end,
  };
  useEffect(() => {
    setDomain((current) => {
      if (!current || current.runId !== view.runId)
        return {
          runId: view.runId,
          start: bound.start,
          end: Math.max(bound.start + 10_000, bound.end),
        };
      const start = Math.min(current.start, bound.start);
      if (bound.end <= current.end && start === current.start) return current;
      const currentSpan = Math.max(10_000, current.end - start);
      return { runId: view.runId, start, end: Math.max(bound.end, start + currentSpan * 1.5) };
    });
  }, [view.runId, bound.start, bound.end]);
  const visible =
    domain?.runId === view.runId
      ? domain
      : { runId: view.runId, start: bound.start, end: Math.max(bound.start + 10_000, bound.end) };
  const gutter = Math.min(158, Math.max(92, width * 0.24));
  const canvasWidth = Math.max(width, gutter + (width - gutter) * zoom);
  const scale = makeTimeScale(visible.start, visible.end, Math.max(1, canvasWidth - gutter));
  const rowHeight = 38;
  const graphHeight = Math.max(118, rows.length * rowHeight + 38);
  const { first: firstVisibleRow, last: lastVisibleRow } = virtualRows(
    rows.length,
    viewport.top - 28,
    viewport.height,
    rowHeight,
  );
  const nowX = gutter + scale.x(Math.min(visible.end, Math.max(visible.start, now)));
  return (
    <div className="timeline-panel" ref={ref} data-testid="execution-timeline">
      <div className="panel-heading">
        <span>
          EXECUTION TIMELINE <small>continuous wall time</small>
        </span>
        <div className="timeline-tools">
          <div className="timeline-legend">
            <span>
              <i className="legend-agent" /> agent
            </span>
            <span>
              <i className="legend-command" /> command
            </span>
            <span>
              <i className="legend-subagent" /> subagent
            </span>
          </div>
          <button
            data-testid="timeline-fit"
            aria-label="Fit timeline to run"
            onClick={() => setZoom(1)}
          >
            FIT
          </button>
          <button
            aria-label="Zoom timeline out"
            onClick={() => setZoom((value) => Math.max(1, value / 1.5))}
          >
            −
          </button>
          <button
            data-testid="timeline-zoom-in"
            aria-label="Zoom timeline in"
            onClick={() => setZoom((value) => Math.min(12, value * 1.5))}
          >
            +
          </button>
        </div>
      </div>
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onScroll={(event) =>
          setViewport({
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          })
        }
      >
        <div style={{ height: graphHeight, width: canvasWidth }}>
          <svg
            data-testid="timeline-canvas"
            width={canvasWidth}
            height={viewport.height}
            style={{ position: "sticky", top: 0, display: "block" }}
            className="timeline-svg"
          >
            {scale.ticks.map((tick) => (
              <g key={tick} transform={`translate(${gutter + scale.x(tick)},0)`}>
                <line y2={viewport.height} />
                <text y={18}>{scale.tickFormat(tick)}</text>
              </g>
            ))}
            {hasActive && (
              <line className="timeline-now" x1={nowX} x2={nowX} y1={20} y2={viewport.height} />
            )}
            {rows
              .slice(firstVisibleRow, lastVisibleRow)
              .map(
                (
                  {
                    key,
                    invocationId,
                    label,
                    state,
                    start,
                    end: persistedEnd,
                    depth,
                    attempts: related,
                    kind,
                  },
                  visibleIndex,
                ) => {
                  const index = firstVisibleRow + visibleIndex;
                  const end = state === "running" || state === "accepted" ? now : persistedEnd;
                  const x = gutter + scale.x(start);
                  const w = Math.max(3, scale.x(end) - scale.x(start));
                  const active = state === "running" || state === "accepted";
                  return (
                    <g
                      key={key}
                      className={`timeline-row ${kind === "scout" ? "scout-row" : ""} ${selectedId === invocationId ? "selected" : ""}`}
                      onClick={() => onSelect(invocationId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(invocationId);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`${kind === "scout" ? "Subagent" : "Invocation"} ${label}, ${state}`}
                      transform={`translate(0,${28 + index * rowHeight - viewport.top})`}
                    >
                      <text className="timeline-label" x={8 + depth * 14} y={18}>
                        {depth > 0 ? "↳ " : ""}
                        {label}
                      </text>
                      <rect
                        data-testid="timeline-bar"
                        data-invocation-id={invocationId}
                        data-source-node-id={label}
                        data-active={active ? "true" : "false"}
                        data-duration-ms={Math.max(0, Math.round(end - start))}
                        className={`invocation-bar state-${state} ${kind === "scout" ? "subagent-bar" : ""}`}
                        x={x}
                        y={6}
                        width={w}
                        height={11}
                        rx={2}
                      />
                      <text className="bar-time" x={Math.min(canvasWidth - 34, x + w + 6)} y={16}>
                        {formatDuration(end - start)}
                      </text>
                      {related.map((attempt, attemptIndex) => {
                        const aStart = isoMs(attempt.startedAt, start);
                        const aEnd = isoMs(
                          attempt.endedAt,
                          attempt.state === "running" ? now : aStart + 1,
                        );
                        return (
                          <rect
                            key={attempt.attemptId}
                            className={`attempt-bar ${attempt.state}`}
                            x={gutter + scale.x(aStart)}
                            y={22 + attemptIndex * 5}
                            width={Math.max(2, scale.x(aEnd) - scale.x(aStart))}
                            height={3}
                            rx={1}
                          />
                        );
                      })}
                    </g>
                  );
                },
              )}
          </svg>
        </div>
        {!rows.length && <div className="empty-inline">Waiting for the first invocation…</div>}
      </div>
    </div>
  );
}

function InvocationPicker({
  items,
  selectedId,
  onSelect,
}: {
  items: UiInvocation[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const size = 200;
  const matches = useMemo(
    () =>
      items.filter((item) =>
        `${item.sourceNodeId} ${item.invocationId} ${item.state} ${item.scopeId}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [items, search],
  );
  useEffect(() => {
    if (!search)
      setPage(
        Math.max(0, Math.floor(items.findIndex((item) => item.invocationId === selectedId) / size)),
      );
  }, [selectedId, search]);
  const current = Math.min(page, Math.max(0, Math.ceil(matches.length / size) - 1));
  const visible = matches.slice(current * size, (current + 1) * size);
  const selected = items.find((item) => item.invocationId === selectedId);
  const options = selected && !visible.includes(selected) ? [selected, ...visible] : visible;
  return (
    <div className="invocation-picker">
      {items.length > size && (
        <label>
          Find invocation
          <input
            aria-label="Search invocations"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </label>
      )}
      <label>
        Invocation
        <select
          aria-label="Inspect invocation"
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
        >
          {options.map((item) => (
            <option key={item.invocationId} value={item.invocationId}>
              {item.sourceNodeId} · {item.state} · #{item.ordinal + 1}
            </option>
          ))}
        </select>
      </label>
      {matches.length > size && (
        <div className="lane-navigation">
          <button disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous invocations
          </button>
          <span>
            {current * size + 1}–{Math.min(matches.length, (current + 1) * size)} of{" "}
            {matches.length}
          </span>
          <button
            disabled={(current + 1) * size >= matches.length}
            onClick={() => setPage(current + 1)}
          >
            Next invocations
          </button>
        </div>
      )}
      {search && !matches.length && <small>No matching invocations.</small>}
    </div>
  );
}

function Inspector({
  view,
  scoutRequests = [],
  graph,
  selectedId,
  onSelect,
  sessionRequest,
  onControl,
  pendingAction,
  onResizeStart,
}: {
  view: UiRunView;
  scoutRequests?: ScoutTimelineRequest[];
  graph?: WorkflowGraph;
  selectedId?: string;
  onSelect: (id: string) => void;
  sessionRequest: number;
  onControl: ControlAction;
  pendingAction?: string;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [tab, setTab] = useState<
    | "output"
    | "context"
    | "tools"
    | "logs"
    | "usage"
    | "artifacts"
    | "attempts"
    | "diagnostics"
    | "diff"
    | "events"
  >("output");
  const [activityOpen, setActivityOpen] = useState(() =>
    Boolean(new URLSearchParams(window.location.search).get("attempt")),
  );
  const [sessionSpeaker, setSessionSpeaker] = useState("all");
  const [focusedAttemptId, setFocusedAttemptId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("attempt") ?? undefined,
  );
  const invocation = asArray(view.invocations).find((item) => item.invocationId === selectedId);
  const node = graph?.nodes.find(
    (candidate) =>
      candidate.id === invocation?.sourceNodeId &&
      (!candidate.definitionId ||
        candidate.definitionId === view.scopes[invocation?.scopeId ?? ""]?.definitionId),
  );
  useEffect(() => {
    if (sessionRequest > 0) setActivityOpen(true);
  }, [sessionRequest]);
  const attempts = asArray(view.attempts).filter((attempt) => attempt.invocationId === selectedId);
  const artifacts = asArray(view.artifacts);
  const selectedArtifacts = artifacts.filter((artifact) =>
    [...(invocation?.outputArtifactIds ?? []), ...(invocation?.evidenceArtifactIds ?? [])].includes(
      artifact.artifactId,
    ),
  );
  const latest =
    attempts.find((attempt) => attempt.attemptId === focusedAttemptId) ??
    attempts[attempts.length - 1];
  const belongs = (item: { invocationId?: string; attemptId?: string }) =>
    item.invocationId === selectedId ||
    Boolean(item.attemptId && attempts.some((attempt) => attempt.attemptId === item.attemptId));
  const context = view.context.filter(belongs);
  const sessionEvents = latest
    ? (view.liveActivity ?? []).filter((item) => item.attemptId === latest.attemptId)
    : [];
  const execution =
    latest?.resolvedExecution && typeof latest.resolvedExecution === "object"
      ? (latest.resolvedExecution as Record<string, unknown>)
      : {};
  const canSteer =
    latest?.state === "running" &&
    invocation?.state === "running" &&
    view.capabilities.steer === true &&
    (view.steerableInvocationIds?.includes(invocation.invocationId) ?? true);
  const tools = view.tools.filter(belongs);
  const logs = view.logs.filter(belongs);
  const usage = view.usage.filter(belongs);
  const diagnostics = view.diagnostics.filter(belongs);
  const selectedScouts = scoutRequests.filter(
    (request) => request.parentInvocationId === selectedId,
  );
  const tabs = [
    "output",
    "context",
    "tools",
    "logs",
    "usage",
    "artifacts",
    "attempts",
    "diagnostics",
    "diff",
    "events",
  ] as const;
  return (
    <aside
      className="inspector"
      data-testid="node-inspector"
      data-invocation-id={invocation?.invocationId}
    >
      <ResizeHandle label="Resize inspector drawer" onStart={onResizeStart} />
      <div className="inspector-header">
        <span>INSPECTOR</span>
        <span className="inspector-rev">r{view.revision}</span>
      </div>
      <InvocationPicker
        items={asArray(view.invocations)}
        selectedId={selectedId ?? ""}
        onSelect={onSelect}
      />
      {invocation ? (
        <>
          <div className="inspector-title">
            <StatusDot state={invocation.state} />
            <div>
              <strong>{invocation.sourceNodeId}</strong>
              <em>workflow invocation</em>
            </div>
          </div>
          {node?.kind === "agent" && attempts.length > 0 && (
            <div className="session-launch-row">
              <button
                className="open-agent-session"
                onClick={() => {
                  setSessionSpeaker("all");
                  setActivityOpen(true);
                }}
                type="button"
              >
                <span aria-hidden="true">●</span>{" "}
                {invocation.state === "running" ? "Watch agent live" : "View agent session"}
              </button>
            </div>
          )}
          {latest && (
            <div className="session-identity">
              {String(execution.harness ?? node?.kind ?? "")}
              {execution.modelId ? ` · ${String(execution.modelId)}` : ""} · attempt{" "}
              {latest.ordinal + 1}
              {latest.error && <p className="session-error">{latest.error}</p>}
            </div>
          )}
          <div className="detail-grid">
            <span>INVOCATION</span>
            <b data-testid="selected-invocation">{invocation.invocationId.slice(0, 18)}</b>
            <span>STATE</span>
            <b className={`text-${invocation.state}`}>{invocation.state}</b>
            <span>ATTEMPTS</span>
            <b>{attempts.length || "—"}</b>
          </div>
          <LifecycleNotice invocation={invocation} view={view} />
          {selectedScouts.length > 0 && (
            <section className="scout-activity" aria-label="Subagent activity">
              <div className="section-label">SUBAGENTS</div>
              {selectedScouts.map((scout) => (
                <details key={`${scout.parentAttemptId}:${scout.requestId}`}>
                  <summary>
                    <strong>{scout.scoutId}</strong>
                    <span className={`scout-state ${scout.state}`}>{scout.state}</span>
                    {scout.modelId && <small>{scout.modelId}</small>}
                  </summary>
                  {scout.question && <p>{scout.question}</p>}
                  <small>
                    {scout.effectiveHarness ?? "Host default"} · {scout.requestId}
                  </small>
                  {scout.result !== undefined && <ActivityValue value={scout.result} />}
                  {scout.error && <p className="session-error">{scout.error}</p>}
                  <button
                    className="subtle-button"
                    onClick={() => {
                      setSessionSpeaker(scout.scoutId);
                      setActivityOpen(true);
                    }}
                  >
                    View subagent activity
                  </button>
                </details>
              ))}
            </section>
          )}
          <ApprovalPanel
            invocation={invocation}
            nodeKind={node?.kind}
            view={view}
            pendingAction={pendingAction}
            onControl={onControl}
          />
          {latest?.state === "running" &&
            view.interruptibleInvocationIds?.includes(invocation.invocationId) && (
              <button
                className="control-button"
                disabled={pendingAction !== undefined}
                onClick={() =>
                  onControl(
                    "interrupt-attempt",
                    invocation.invocationId,
                    undefined,
                    latest.attemptId,
                  )
                }
              >
                Interrupt agent
              </button>
            )}
          {invocation.state === "failed" &&
            view.capabilities.retry === true &&
            (view.retryableInvocationIds?.includes(invocation.invocationId) ?? true) && (
              <section className="invocation-recovery" aria-label="Failed invocation recovery">
                <p>
                  This invocation ended in failure. Retry starts another attempt for this
                  invocation.
                </p>
                <button
                  className="control-button"
                  disabled={pendingAction !== undefined}
                  onClick={() => onControl("retry", invocation.invocationId)}
                >
                  {pendingAction === "retry" ? "Retrying…" : "Retry invocation"}
                </button>
              </section>
            )}
          <div className="inspector-tabs">
            {tabs.map((name) => (
              <button
                key={name}
                className={tab === name ? "active" : ""}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="inspector-content">
            {tab === "output" && (
              <OutputPanel
                attempt={latest}
                invocation={invocation}
                steerable={canSteer}
                pendingAction={pendingAction}
                liveActivity={(view.liveActivity ?? []).filter(
                  (item) => item.attemptId === latest?.attemptId,
                )}
                onSteer={(message) =>
                  onControl("steer", invocation.invocationId, message, latest?.attemptId)
                }
              />
            )}
            {tab === "context" && <ContextPanel items={context} />}
            {tab === "tools" && <ToolPanel items={tools} />}
            {tab === "logs" && <LogPanel items={logs} />}
            {tab === "usage" && <UsagePanel items={usage} />}
            {tab === "artifacts" && (
              <ArtifactPanel artifacts={selectedArtifacts.length ? selectedArtifacts : artifacts} />
            )}
            {tab === "attempts" && (
              <EvidencePanel
                attempts={attempts}
                focusedAttemptId={focusedAttemptId}
                onFocus={setFocusedAttemptId}
              />
            )}
            {tab === "diagnostics" && <DiagnosticPanel items={diagnostics} />}
            {tab === "diff" && <DiffPanel runId={view.runId} revision={view.revision} />}
            {tab === "events" && <EventHistoryPanel runId={view.runId} />}
          </div>
          {activityOpen &&
            latest &&
            createPortal(
              <AgentSessionModal
                key={`${view.runId}:${latest.attemptId}`}
                runId={view.runId}
                initialSpeaker={sessionSpeaker}
                subagents={selectedScouts
                  .filter((scout) => scout.parentAttemptId === latest?.attemptId)
                  .map((scout) => ({
                    scoutId: scout.scoutId,
                    requestId: scout.requestId,
                    harness: scout.effectiveHarness,
                    modelId: scout.modelId,
                    state: scout.state,
                  }))}
                invocationId={invocation.invocationId}
                attemptId={latest.attemptId}
                nodeId={node?.label ?? invocation.sourceNodeId}
                harness={`${String(execution.harness ?? "Harness")}${execution.modelId ? ` · ${String(execution.modelId)}` : ""}`}
                events={sessionEvents}
                live={latest.state === "running"}
                steerable={canSteer}
                canStop={Boolean(view.capabilities.cancel)}
                stopPending={pendingAction === "cancel"}
                onStop={() => onControl("cancel")}
                canInterrupt={
                  latest.state === "running" &&
                  Boolean(view.interruptibleInvocationIds?.includes(invocation.invocationId))
                }
                interruptPending={pendingAction === "interrupt-attempt"}
                onInterrupt={() =>
                  onControl(
                    "interrupt-attempt",
                    invocation.invocationId,
                    undefined,
                    latest.attemptId,
                  )
                }
                onSteer={async (message) =>
                  (await onControl("steer", invocation.invocationId, message, latest.attemptId)) !==
                  false
                }
                loadActivity={fetchActivityPage}
                onClose={() => setActivityOpen(false)}
              />,
              document.body,
            )}
        </>
      ) : (
        <div className="inspector-empty">
          <span>⌁</span>
          <strong>Select an invocation</strong>
          <p>Graph and timeline selection stay linked to this panel.</p>
        </div>
      )}
    </aside>
  );
}

function ContextPanel({ items }: { items: ContextSegment[] }) {
  return (
    <div className="evidence-panel">
      {items.length ? (
        items.map((item) => (
          <div className="evidence-card" key={item.id}>
            <div>
              <strong>{item.source}</strong>
              <span>{item.availability}</span>
            </div>
            <p>
              {item.reason ?? item.detail ?? "No reason recorded."}
              {item.tokenEstimate === undefined
                ? " · tokens unavailable"
                : ` · ~${item.tokenEstimate} tokens`}
            </p>
          </div>
        ))
      ) : (
        <div className="pending-copy">Context manifest unavailable from this harness.</div>
      )}
    </div>
  );
}
function ToolPanel({ items }: { items: ToolCallView[] }) {
  return (
    <div className="evidence-panel">
      {items.length ? (
        items.map((item) => <ToolActivity key={item.id} tool={item} />)
      ) : (
        <div className="pending-copy">No declared tool calls for this attempt.</div>
      )}
    </div>
  );
}
function LogPanel({ items }: { items: LogEntryView[] }) {
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = items.filter((item) =>
    `${item.level} ${item.message}`.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [follow, items.length, query]);
  return (
    <div className="log-panel">
      <div className="log-toolbar">
        <label>
          Search logs{" "}
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" aria-pressed={follow} onClick={() => setFollow((value) => !value)}>
          {follow ? "Following" : "Follow logs"}
        </button>
      </div>
      <div
        className="evidence-panel log-results"
        ref={listRef}
        role="log"
        aria-live={follow ? "polite" : "off"}
      >
        {visible.length ? (
          visible.map((item) => (
            <div className="log-line" key={item.id}>
              <span>{item.level}</span>
              <ActivityValue value={item.message} />
            </div>
          ))
        ) : (
          <div className="pending-copy">
            {items.length ? "No logs match the search." : "No readable logs were published."}
          </div>
        )}
      </div>
    </div>
  );
}
function UsagePanel({ items }: { items: UsageView[] }) {
  if (!items.length)
    return (
      <div className="pending-copy">Usage unavailable; the provider did not declare telemetry.</div>
    );
  return (
    <div className="evidence-panel">
      {items.map((item, index) => (
        <div className="evidence-card" key={`${item.attemptId ?? "run"}-${index}`}>
          <div>
            <strong>{item.totalTokens ?? "—"} tokens</strong>
            <span>{item.completeness}</span>
          </div>
          <p>
            {item.inputTokens ?? "—"} in · {item.outputTokens ?? "—"} out
            {item.estimated ? " · estimated" : ""}
            {item.cost === undefined
              ? " · cost unavailable"
              : ` · ${item.currency ?? ""}${item.cost}`}
          </p>
        </div>
      ))}
    </div>
  );
}
function DiagnosticPanel({ items }: { items: DiagnosticView[] }) {
  return (
    <div className="evidence-panel">
      {items.length ? (
        items.map((item) => (
          <div className="evidence-card" key={item.id}>
            <div>
              <strong>{item.severity}</strong>
            </div>
            <p>{item.message}</p>
            {item.detail && <code>{item.detail}</code>}
          </div>
        ))
      ) : (
        <div className="pending-copy">No diagnostics recorded.</div>
      )}
    </div>
  );
}

function LifecycleNotice({ invocation, view }: { invocation: UiInvocation; view: UiRunView }) {
  if (invocation.state === "running" && view.state !== "running")
    return (
      <div className="stale-action" role="alert">
        This invocation is not live in the current run revision. Refresh before acting.
      </div>
    );
  if (invocation.state === "failed" && invocation.error)
    return (
      <div className="stale-action failure" role="status">
        Last attempt failed: {invocation.error}
      </div>
    );
  return null;
}

function ApprovalPanel({
  invocation,
  nodeKind,
  view,
  pendingAction,
  onControl,
}: {
  invocation: UiInvocation;
  nodeKind?: string;
  view: UiRunView;
  pendingAction?: string;
  onControl: ControlAction;
}) {
  const [feedback, setFeedback] = useState("");
  const isApproval = nodeKind === "approval" || invocation.approval !== undefined;
  if (!isApproval) return null;
  const pending =
    invocation.approval?.status === "pending" || (invocation.state as string) === "waiting";
  return (
    <section
      className="approval-card"
      data-testid="approval-panel"
      aria-labelledby="approval-heading"
    >
      <div className="approval-heading">
        <strong id="approval-heading">Human approval</strong>
        <span>{invocation.approval?.status ?? invocation.state}</span>
      </div>
      <p>
        {pending
          ? "This gate is waiting for an operator decision. The request is durable; no optimistic transition is shown."
          : "Decision recorded in the execution journal."}
      </p>
      {invocation.approval?.feedback && (
        <p className="approval-feedback">{invocation.approval.feedback}</p>
      )}
      {pending && (invocation.approval?.repairsRemaining ?? 0) > 0 && (
        <label className="task-input">
          <span>
            Changes to request · {invocation.approval?.repairsRemaining} repairs remaining
          </span>
          <textarea
            aria-label="Requested changes"
            value={feedback}
            maxLength={20000}
            onChange={(event) => setFeedback(event.target.value)}
            rows={3}
            placeholder="Describe what the agent should change before another review…"
          />
        </label>
      )}
      {pending && (
        <div className="approval-actions">
          {(invocation.approval?.repairsRemaining ?? 0) > 0 && (
            <button
              className="control-button"
              disabled={pendingAction !== undefined || !feedback.trim()}
              onClick={async () => {
                if (
                  (await onControl("request-changes", invocation.invocationId, feedback)) !== false
                )
                  setFeedback("");
              }}
            >
              {" "}
              {pendingAction === "request-changes" ? "Requesting changes…" : "Request changes"}
            </button>
          )}
          <button
            data-testid="approve-run"
            className="control-button approve"
            disabled={pendingAction !== undefined || view.capabilities.approve !== true}
            onClick={() => onControl("approve", invocation.invocationId)}
          >
            {pendingAction === "approve" ? "Approve…" : "Approve"}
          </button>
          <button
            data-testid="reject-run"
            className="control-button danger"
            disabled={pendingAction !== undefined || view.capabilities.reject !== true}
            onClick={() => onControl("reject", invocation.invocationId)}
          >
            {pendingAction === "reject" ? "Reject…" : "Reject"}
          </button>
        </div>
      )}
    </section>
  );
}

function DiffPanel({ runId, revision }: { runId: string; revision: number }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "none"; message: string }
    | {
        kind: "snapshot";
        resultTree: string;
        patch: string;
        changedPaths: Array<{ path: string; status: string; binary: boolean }>;
        patchDigest: string;
      }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [delivery, setDelivery] = useState<
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "error"; message: string }
    | { kind: "action"; id: string; status: string; resultTree: string }
  >({ kind: "idle" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [commitMessage, setCommitMessage] = useState(`Deliver ${runId}`);
  useEffect(() => {
    setCommitMessage(`Deliver ${runId}`);
    setDelivery({ kind: "idle" });
  }, [runId]);
  const refresh = () => {
    setDelivery({ kind: "idle" });
    setState({ kind: "loading" });
    setRefreshNonce((current) => current + 1);
  };
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void api<unknown>(`/api/runs/${encodeURIComponent(runId)}/diff`)
      .then((raw) => {
        if (cancelled) return;
        if (!raw || typeof raw !== "object") {
          setState({ kind: "error", message: "The host returned an invalid diff response." });
          return;
        }
        const value = raw as Record<string, unknown>;
        if (value.error === "workspace-not-configured") {
          setState({ kind: "none", message: "No repository workspace is attached to this run." });
          return;
        }
        if (
          typeof value.patch !== "string" ||
          typeof value.resultTree !== "string" ||
          typeof value.patchDigest !== "string" ||
          !Array.isArray(value.changedPaths)
        ) {
          setState({
            kind: "error",
            message:
              typeof value.message === "string"
                ? value.message
                : "The workspace diff is unavailable.",
          });
          return;
        }
        setState({
          kind: "snapshot",
          resultTree: value.resultTree,
          patch: value.patch,
          patchDigest: value.patchDigest,
          changedPaths: value.changedPaths
            .filter((item): item is { path: string; status: string; binary: boolean } => {
              if (!item || typeof item !== "object") return false;
              const candidate = item as Record<string, unknown>;
              return typeof candidate.path === "string" && typeof candidate.status === "string";
            })
            .map((item) => ({
              path: item.path,
              status: item.status,
              binary: item.binary === true,
            })),
        });
      })
      .catch((cause) => {
        if (!cancelled)
          setState({
            kind: "error",
            message:
              cause instanceof Error ? cause.message : "Unable to load the authoritative diff.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refreshNonce]);
  const prepare = async () => {
    if (state.kind !== "snapshot") return;
    setDelivery({ kind: "working" });
    try {
      const action = await api<{
        id: string;
        status: string;
        resultTree: string;
      }>(`/api/runs/${encodeURIComponent(runId)}/delivery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestKey: `web:${runId}:${state.patchDigest}:${commitMessage.trim()}`,
          message: commitMessage.trim(),
          expectedTree: state.resultTree,
          expectedPatchDigest: state.patchDigest,
        }),
      });
      setDelivery({ kind: "action", ...action });
    } catch (cause) {
      setDelivery({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Unable to prepare delivery.",
      });
    }
  };
  const decide = async (decision: "approved" | "rejected") => {
    if (delivery.kind !== "action") return;
    setDelivery({ kind: "working" });
    try {
      const action = await api<{
        id: string;
        status: string;
        resultTree: string;
      }>(`/api/runs/${encodeURIComponent(runId)}/delivery/${encodeURIComponent(delivery.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, actor: "local-operator" }),
      });
      setDelivery({ kind: "action", ...action });
    } catch (cause) {
      setDelivery({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Unable to record delivery decision.",
      });
    }
  };
  const commit = async () => {
    if (delivery.kind !== "action" || delivery.status !== "approved") return;
    setDelivery({ kind: "working" });
    try {
      const result = await api<{ status?: string }>(
        `/api/runs/${encodeURIComponent(runId)}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "deliver",
            expectedRevision: revision,
            idempotencyKey: `web:commit:${delivery.id}`,
            deliveryActionId: delivery.id,
            expectedTree: delivery.resultTree,
            message: commitMessage.trim(),
          }),
        },
      );
      setDelivery({ ...delivery, status: result.status ?? "committed" });
    } catch (cause) {
      setDelivery({
        kind: "error",
        message: cause instanceof Error ? cause.message : "Unable to commit delivery.",
      });
    }
  };
  return (
    <div className="diff-panel" data-testid="diff-panel">
      <div className="section-label">
        WORKTREE DIFF <span>authoritative</span>
        <button type="button" onClick={refresh}>
          Refresh reviewed diff
        </button>
      </div>
      <p className="pending-copy">
        The diff is read from the run worktree, not inferred from agent output.
      </p>
      <a
        className="diff-link"
        href={`/api/runs/${encodeURIComponent(runId)}/diff`}
        target="_blank"
        rel="noreferrer"
      >
        Open complete Git diff ↗
      </a>
      {state.kind === "loading" && (
        <div className="diff-placeholder">Loading authoritative workspace state…</div>
      )}
      {state.kind === "none" && (
        <div className="diff-placeholder" data-testid="diff-no-workspace">
          {state.message}
        </div>
      )}
      {state.kind === "error" && (
        <div className="diff-placeholder diff-error" role="alert">
          {state.message}
        </div>
      )}
      {state.kind === "snapshot" && (
        <>
          <div className="diff-summary" data-testid="diff-summary">
            <strong>
              {state.changedPaths.length
                ? `${state.changedPaths.length} changed path${state.changedPaths.length === 1 ? "" : "s"}`
                : "No changed paths"}
            </strong>
            <span>patch {state.patchDigest.slice(0, 12)}</span>
          </div>
          {state.changedPaths.length > 0 && (
            <ul className="diff-paths">
              {state.changedPaths.map((item) => (
                <li key={`${item.status}:${item.path}`}>
                  <code>{item.status}</code>
                  <span>
                    {item.path}
                    {item.binary ? " · binary" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <pre className="diff-content" data-testid="diff-content">
            {state.patch || "(empty diff)"}
          </pre>
          <div className="delivery-actions" data-testid="delivery-actions">
            <div className="section-label">
              DELIVERY <span>{delivery.kind === "action" ? delivery.status : "pending"}</span>
            </div>
            <p className="pending-copy">
              Prepare this exact tree for a durable approval before the local commit effect.
            </p>
            <label className="task-input">
              <span>Commit message</span>
              <textarea
                aria-label="Commit message"
                rows={2}
                maxLength={4000}
                value={commitMessage}
                disabled={delivery.kind !== "idle" && delivery.kind !== "error"}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
            </label>
            {delivery.kind === "idle" && (
              <button
                className="control-button approve"
                disabled={!commitMessage.trim()}
                onClick={() => void prepare()}
              >
                Prepare delivery
              </button>
            )}
            {delivery.kind === "working" && (
              <div className="diff-placeholder">Updating delivery action…</div>
            )}
            {delivery.kind === "error" && (
              <div className="diff-placeholder diff-error">{delivery.message}</div>
            )}
            {delivery.kind === "action" && delivery.status === "pending" && (
              <div className="approval-actions">
                <button className="control-button approve" onClick={() => void decide("approved")}>
                  Approve delivery
                </button>
                <button className="control-button danger" onClick={() => void decide("rejected")}>
                  Reject delivery
                </button>
              </div>
            )}
            {delivery.kind === "action" && delivery.status === "approved" && (
              <button className="control-button approve" onClick={() => void commit()}>
                Commit approved tree
              </button>
            )}
            {delivery.kind === "action" && delivery.status === "committed" && (
              <div className="diff-placeholder">Delivery committed.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function OutputPanel({
  attempt,
  invocation,
  liveActivity = [],
  onSteer,
  steerable,
  pendingAction,
}: {
  attempt?: UiAttempt;
  invocation: UiInvocation;
  liveActivity?: Array<{ attemptId: string; event: unknown }>;
  onSteer: (message: string) => Promise<boolean>;
  steerable: boolean;
  pendingAction?: string;
}) {
  const output = attempt?.output;
  const captured = Array.isArray(output) ? output.length > 0 : output !== undefined;
  const liveText = liveActivity
    .filter((item) => (item.event as { type?: string })?.type === "text")
    .map((item) => {
      const data = (item.event as { data?: unknown }).data;
      if (data && typeof data === "object" && "text" in data) {
        const text = String((data as { text: unknown }).text ?? "");
        const label = (data as { label?: unknown }).label === true;
        return `${label ? `[${String((data as { scoutId?: unknown }).scoutId ?? "scout")}]: ` : ""}${text}`;
      }
      return String(data ?? "");
    })
    .join("");
  const activityLabels = liveActivity
    .filter((item) => (item.event as { type?: string })?.type !== "text")
    .map((item) => {
      const event = item.event as { type?: string; data?: unknown };
      const data =
        event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
      if (event.type === "usage") return "Usage updated";
      if (event.type === "tool")
        return `${data.scoutId ? `${String(data.scoutId)} · ` : ""}${String(data.name ?? "Tool")} · ${String(data.status ?? "running")}`;
      return `${data.scoutId ? `${String(data.scoutId)} · ` : ""}${String(data.status ?? event.type ?? "Working")}`;
    });
  const [steeringText, setSteeringText] = useState("");
  return (
    <div className="output-panel">
      {(invocation.state === "running" || liveActivity.length > 0) && (
        <section className="live-agent-activity" aria-live="polite">
          <div className="section-label">
            AGENT ACTIVITY <span>{invocation.state === "running" ? "live" : "captured"}</span>
          </div>
          <p>{activityLabels.at(-1) ?? "Thinking"}</p>
          {activityLabels.length > 1 && (
            <ul>
              {activityLabels.slice(-8).map((label, index) => (
                <li key={`${index}:${label}`}>{label}</li>
              ))}
            </ul>
          )}
          {liveText && <pre className="live-agent-reply">{liveText}</pre>}
          {steerable ? (
            <form
              className="steer-form"
              onSubmit={(event) => {
                event.preventDefault();
                const message = steeringText.trim();
                if (message && !pendingAction) {
                  void onSteer(message).then((accepted) => {
                    if (accepted) setSteeringText("");
                  });
                }
              }}
            >
              <textarea
                aria-label="Steer active agent"
                placeholder="Send an instruction to the active agent"
                value={steeringText}
                onChange={(event) => setSteeringText(event.target.value)}
                maxLength={4000}
              />
              <button type="submit" disabled={!steeringText.trim() || Boolean(pendingAction)}>
                Steer agent
              </button>
            </form>
          ) : (
            <small>This harness accepts input after its current turn.</small>
          )}
        </section>
      )}
      <div className="section-label">
        STRUCTURED OUTPUT <span>{captured ? "captured" : "none"}</span>
      </div>
      {captured ? (
        Array.isArray(output) &&
        output.every((item) => item && typeof item === "object" && "id" in item) ? (
          <ArtifactPanel artifacts={output as ArtifactView[]} initiallyOpen />
        ) : (
          <pre>{JSON.stringify(output, null, 2)}</pre>
        )
      ) : (
        <div className="pending-copy">
          {invocation.state === "running"
            ? "No typed output has been published yet."
            : "No structured output was published for this invocation."}
        </div>
      )}
      <div className="section-label command-label">
        NODE <span>{invocation.sourceNodeId}</span>
      </div>
      {attempt?.command?.stderrArtifactId && (
        <ArtifactContent artifactId={attempt.command.stderrArtifactId} />
      )}
    </div>
  );
}
function EvidencePanel({
  attempts,
  focusedAttemptId,
  onFocus,
}: {
  attempts: UiAttempt[];
  focusedAttemptId?: string;
  onFocus: (attemptId: string) => void;
}) {
  return (
    <div className="evidence-panel">
      {attempts.length ? (
        attempts.map((attempt) => (
          <button
            className={`evidence-card attempt-card ${focusedAttemptId === attempt.attemptId ? "focused" : ""}`}
            key={attempt.attemptId}
            onClick={() => onFocus(attempt.attemptId)}
            aria-label={`Inspect attempt ${attempt.ordinal + 1}`}
          >
            <div>
              <StatusDot state={attempt.state} />
              <strong>attempt {attempt.ordinal + 1}</strong>
              <span>{attempt.state}</span>
            </div>
            <small className="repair-label">
              {attempt.ordinal > 0 ? "additional attempt" : "initial attempt"}
            </small>
            {attempt.command && (
              <code>
                {attempt.command.executable} {(attempt.command.args ?? []).join(" ")}
              </code>
            )}
            {attempt.command?.executionMode === "trusted-unrestricted" && (
              <small>TRUSTED UNRESTRICTED COMMAND</small>
            )}
            {attempt.result && (
              <p>
                exit {attempt.result.exitCode ?? "—"} · {attempt.result.status ?? attempt.state}
              </p>
            )}
          </button>
        ))
      ) : (
        <div className="pending-copy">No attempt evidence yet.</div>
      )}
    </div>
  );
}
function EventHistoryPanel({ runId }: { runId: string }) {
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const loadPage = useCallback(
    async (after: number, replace: boolean) => {
      setLoading(true);
      setError(undefined);
      try {
        const page = await api<{
          events?: Array<Record<string, unknown>>;
          nextCursor?: number;
          hasMore?: boolean;
        }>(`/api/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=200`);
        const items = page.events ?? [];
        setEvents((current) => (replace ? items : [...current, ...items]));
        setCursor(page.nextCursor ?? after);
        setHasMore(page.hasMore === true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to load run events");
      } finally {
        setLoading(false);
      }
    },
    [runId],
  );
  useEffect(() => {
    setEvents([]);
    setCursor(0);
    void loadPage(0, true);
  }, [loadPage]);
  const term = search.trim().toLocaleLowerCase();
  const visible = events.filter(
    (event) => !term || JSON.stringify(event).toLocaleLowerCase().includes(term),
  );
  return (
    <div className="event-history-panel">
      <div className="event-history-controls">
        <input
          aria-label="Filter run events"
          placeholder="Filter event type or payload"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span>{visible.length} shown</span>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error} <button onClick={() => void loadPage(cursor, events.length === 0)}>Retry</button>
        </p>
      )}
      {visible.map((event, index) => (
        <details
          className="event-history-row"
          key={`${String(event.sequence ?? index)}:${String(event.eventId ?? "")}`}
        >
          <summary>
            <span>r{String(event.sequence ?? "?")}</span>
            <strong>{String(event.type ?? "unknown event")}</strong>
            <small>{String(event.recordedAt ?? "")}</small>
          </summary>
          <div className="event-history-meta">
            {String(event.actor ?? "system")}
            {event.causationId ? ` · caused by ${String(event.causationId)}` : ""}
          </div>
          <pre>{boundedActivity(event.payload)}</pre>
        </details>
      ))}
      {hasMore && (
        <button
          className="older-runs-button"
          disabled={loading}
          onClick={() => void loadPage(cursor, false)}
        >
          {loading ? "Loading…" : "Load more journal events"}
        </button>
      )}
      {!events.length && !loading && !error && <p className="pending-copy">No journal events.</p>}
    </div>
  );
}

function ArtifactPanel({
  artifacts,
  initiallyOpen = false,
}: {
  artifacts: Array<ArtifactView | { artifactId: string; contentType?: string }>;
  initiallyOpen?: boolean;
}) {
  return (
    <div className="artifact-panel">
      {artifacts.length ? (
        artifacts.map((artifact) => {
          const id = "id" in artifact ? artifact.id : artifact.artifactId;
          const mediaType =
            "mediaType" in artifact
              ? artifact.mediaType
              : "contentType" in artifact
                ? artifact.contentType
                : undefined;
          return (
            <ArtifactRow key={id} id={id} mediaType={mediaType} initiallyOpen={initiallyOpen} />
          );
        })
      ) : (
        <div className="pending-copy">No artifacts attached.</div>
      )}
    </div>
  );
}

function ArtifactRow({
  id,
  mediaType,
  initiallyOpen,
}: {
  id: string;
  mediaType?: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      className="artifact-row"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="artifact-icon">◇</span>
        <span>
          <strong>{id.slice(0, 14)}</strong>
          <em>artifact · {mediaType ?? "application/json"}</em>
        </span>
      </summary>
      {open && <ArtifactContent artifactId={id} />}
    </details>
  );
}

function ArtifactContent({ artifactId }: { artifactId: string }) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [mediaType, setMediaType] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Artifact preview timed out. Retry to reconnect.")),
      20_000,
    );
    setContent(undefined);
    setError(undefined);
    setTruncated(false);
    void (async () => {
      await currentSession();
      const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/content`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Unable to load artifact (${response.status})`);
      const type = response.headers.get("content-type") ?? "";
      if (!type.startsWith("text/") && !type.includes("json"))
        throw new Error("Preview unavailable for this file type. Open or download the artifact.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Artifact has no content");
      const limit = 256 * 1024;
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      let limited = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const remaining = limit - bytes;
          text += decoder.decode(value.subarray(0, remaining), { stream: true });
          bytes += value.length;
          if (bytes >= limit) {
            limited = true;
            break;
          }
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      if (controller.signal.aborted) return;
      setMediaType(type);
      setTruncated(limited);
      if (type.includes("json") && !limited) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* preserve malformed content for inspection */
        }
      }
      setContent(text);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted || controller.signal.reason instanceof Error)
        setError(cause instanceof Error ? cause.message : "Unable to load artifact");
    });
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [artifactId, retry]);
  return (
    <section className="artifact-preview">
      <a
        href={`/api/artifacts/${encodeURIComponent(artifactId)}/content`}
        target="_blank"
        rel="noreferrer"
      >
        Open full artifact
      </a>
      {error ? (
        <p role="alert">
          {error} <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </p>
      ) : content === undefined ? (
        <p>Loading artifact…</p>
      ) : mediaType.includes("markdown") ? (
        <SafeMarkdown text={content} />
      ) : (
        <pre>{content}</pre>
      )}
      {truncated && <p>Preview limited to 256 KiB. Open the full artifact to read the rest.</p>}
    </section>
  );
}

function RoleBadge({ label }: { label: string }) {
  return <span className="role-badge">{label}</span>;
}
function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000)
    return `${Math.floor(ms / 60_000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
