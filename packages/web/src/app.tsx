import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import { projectHierarchicalGraph, type GraphScope } from "./data/hierarchicalProjection";
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
  type ExecutionProfile,
  type LogEntryView,
  type ToolCallView,
  type UsageView,
} from "./types";
import {
  M5Workbench,
  type BlindedPairwise,
  type ComparisonTimeline,
  type EvalExperiment,
} from "./m5";
import { SwarmWorkbench } from "./swarm";
import { M7Workbench, M7_ENDPOINTS } from "./m7";

let csrfToken: string | undefined;
let sessionPromise: Promise<void> | undefined;

const ensureSession = async (): Promise<void> => {
  const existing = await fetch("/api/session", { headers: { accept: "application/json" } });
  if (existing.ok) {
    csrfToken = ((await existing.json()) as { csrfToken: string }).csrfToken;
    return;
  }
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (!token) throw new Error("This browser is not paired with the local Kouro host");
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
};

const api = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  sessionPromise ??= ensureSession();
  await sessionPromise;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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
    executionProfile: typeof item.executionProfile === "string" ? item.executionProfile : undefined,
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
    const stored = Number(window.localStorage.getItem(key));
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
  const [shownRunCount, setShownRunCount] = useState(12);
  const [hasMoreRuns, setHasMoreRuns] = useState(true);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  const [workflowId, setWorkflowId] = useState("tiny");
  const [task, setTask] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [profileId, setProfileId] = useState<ExecutionProfile["id"]>("scripted");
  const [allowUnrestrictedCommands, setAllowUnrestrictedCommands] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("run") ?? undefined,
  );
  const [store] = useState(() => new RunSyncStore());
  const [selectedInvocationId, setSelectedInvocationId] = useState<string>();
  const [surface, setSurface] = useState<
    "runs" | "new-run" | "evals" | "swarm" | "development" | "checkpoints"
  >("runs");
  const [experiments, setExperiments] = useState<EvalExperiment[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string>();
  const [experimentError, setExperimentError] = useState<string>();
  const [comparisonTimeline, setComparisonTimeline] = useState<ComparisonTimeline>();
  const [comparisonTimelineError, setComparisonTimelineError] = useState<string>();
  const [pairwise, setPairwise] = useState<BlindedPairwise>();
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [pendingAction, setPendingAction] = useState<string>();
  const [actionNotice, setActionNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readPanelWidth("kouro.sidebar.width", 232, 180, 420),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readPanelWidth("kouro.inspector.width", 310, 260, 560),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    window.localStorage.setItem("kouro.sidebar.width", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    window.localStorage.setItem("kouro.inspector.width", String(inspectorWidth));
  }, [inspectorWidth]);

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
    try {
      const [workflowPayload, runsPayload, profilePayload, experimentPayload] = await Promise.all([
        api<unknown[] | { workflows?: unknown[]; items?: unknown[] }>("/api/workflows"),
        api<unknown[] | { runs?: unknown[]; items?: unknown[] }>("/api/runs"),
        api<unknown[] | { profiles?: unknown[]; items?: unknown[] }>("/api/execution-profiles"),
        api<unknown[] | { experiments?: unknown[]; items?: unknown[] }>("/api/experiments"),
      ]);
      const nextWorkflows = unwrapArray(workflowPayload, "workflows")
        .map(normalizeWorkflow)
        .filter((item): item is WorkflowSummary => Boolean(item));
      const nextRuns = unwrapArray(runsPayload, "runs")
        .map(normalizeRun)
        .filter((item): item is RunSummary => Boolean(item));
      const nextProfiles = unwrapArray(profilePayload, "profiles").filter(
        (item): item is ExecutionProfile => Boolean(item && typeof item === "object"),
      );
      setWorkflows(nextWorkflows);
      setRuns((current) => [
        ...nextRuns,
        ...current.filter((run) => !nextRuns.some((fresh) => fresh.id === run.id)),
      ]);
      if (nextRuns.length < 100) setHasMoreRuns(false);
      setProfiles(nextProfiles);
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
      if (!selectedExperimentId && nextExperiments[0])
        setSelectedExperimentId(nextExperiments[0].id);
      if (!nextProfiles.some((item) => item.id === profileId && item.available)) {
        const firstAvailable = nextProfiles.find((item) => item.available);
        if (firstAvailable) setProfileId(firstAvailable.id);
      }
      if (!workflowId && nextWorkflows[0]) setWorkflowId(nextWorkflows[0].id);
      if (!selectedRunId && nextRuns[0]) setSelectedRunId(nextRuns[0].id);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reach local host");
    } finally {
      setLoading(false);
    }
  }, [profileId, selectedRunId, workflowId, selectedExperimentId]);

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
  useEffect(() => {
    if (!selectedExperiment) {
      setComparisonTimeline(undefined);
      setComparisonTimelineError(undefined);
      return;
    }
    let cancelled = false;
    const cells = selectedExperiment.cells.filter((cell) => cell.runId).slice(0, 2);
    void (async () => {
      try {
        const views = await Promise.all(
          cells.map((cell) => api<UiRunView>(`/api/runs/${encodeURIComponent(cell.runId!)}/view`)),
        );
        if (views.length !== 2) {
          setComparisonTimeline(undefined);
          setComparisonTimelineError("Two completed runs are required for timeline comparison.");
          return;
        }
        const leftView = views[0] as unknown as {
          state?: { invocations?: unknown };
          invocations?: unknown;
        };
        const rightView = views[1] as unknown as {
          state?: { invocations?: unknown };
          invocations?: unknown;
        };
        const left = asArray(
          (leftView.state?.invocations ?? leftView.invocations) as Record<string, unknown>,
        ).map((item) => {
          const record = item as Record<string, unknown>;
          return String(record.sourceNodeId ?? record.nodeId ?? "");
        });
        const right = asArray(
          (rightView.state?.invocations ?? rightView.invocations) as Record<string, unknown>,
        ).map((item) => {
          const record = item as Record<string, unknown>;
          return String(record.sourceNodeId ?? record.nodeId ?? "");
        });
        const nodes = [...new Set([...left, ...right])];
        if (!nodes.length) throw new Error("No invocation stages were found in the selected runs.");
        const anchors = nodes.map((node, index) => ({
          id: `node-${index}`,
          kind: "node-id" as const,
          leftNodeKey: left.includes(node) ? node : "__missing__",
          rightNodeKey: right.includes(node) ? node : "__missing__",
        }));
        const comparison = await api<{ id: string }>("/api/comparisons", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runs: views.map((view) => ({ runId: view.runId, revision: view.revision })),
            anchors,
            evidenceRevision: 0,
          }),
        });
        const timeline = await api<ComparisonTimeline>(
          `/api/comparisons/${encodeURIComponent(comparison.id)}/timeline`,
        );
        if (!timeline.rows.length) throw new Error("The comparison returned no aligned stages.");
        if (!cancelled) {
          setComparisonTimeline(timeline);
          setComparisonTimelineError(undefined);
        }
      } catch {
        if (!cancelled) {
          setComparisonTimeline(undefined);
          setComparisonTimelineError("Unable to load an authoritative timeline comparison.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedExperiment]);
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
    const runs =
      selectedExperiment?.cells
        .map((cell) => cell.runId)
        .filter((id): id is string => Boolean(id))
        .slice(0, 2) ?? [];
    if (runs.length !== 2) {
      setExperimentError("Pairwise review requires two completed ordinary runs.");
      return;
    }
    try {
      const comparison = await api<{ id: string }>("/api/comparisons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runs: runs.map((runId) => ({ runId, revision: 0 })),
          anchors: [],
          evidenceRevision: 0,
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
          evidenceRevision: 0,
        }),
      });
      setPairwise({
        id: dto.assignmentId,
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
    const connect = async () => {
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
        source.onopen = () => store.setStatus("live");
        source.onmessage = (event) => {
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
        source.onerror = () => store.setStatus("disconnected");
      } catch (cause) {
        store.setStatus("error", cause instanceof Error ? cause.message : "Unable to load run");
      }
    };
    void connect();
    const reset = () => {
      void connect();
    };
    const onVisibilityChange = () => {
      if (shouldReconnectOnVisibility(document.visibilityState, store.status)) void connect();
    };
    const unsubscribe = store.onReset(reset);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      connectionGeneration += 1;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      source?.close();
    };
  }, [selectedRunId, store]);

  const launch = async () => {
    setLaunching(true);
    setError(undefined);
    try {
      const created = await api<RunSummary>("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId,
          executionProfile: profileId,
          allowUnrestrictedCommands,
          idempotencyKey: crypto.randomUUID(),
          ...(task.trim() ? { input: { task: task.trim() } } : {}),
          ...(workspacePath.trim() ? { workspace: { repositoryPath: workspacePath.trim() } } : {}),
        }),
      });
      setRuns((old) => [created, ...old.filter((run) => run.id !== created.id)]);
      setSelectedRunId(created.id);
      setSelectedInvocationId(undefined);
      setSurface("runs");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to launch run");
    } finally {
      setLaunching(false);
    }
  };

  const openNewRun = () => {
    setTask("");
    setError(undefined);
    setSurface("new-run");
  };

  const controlRun = async (action: string, invocationId?: string) => {
    if (!selectedRunId || pendingAction) return;
    setPendingAction(action);
    setActionNotice(undefined);
    try {
      await api(`/api/runs/${encodeURIComponent(selectedRunId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          invocationId,
          expectedRevision: snapshot?.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setActionNotice(`${action} requested; waiting for the durable event.`);
    } catch (cause) {
      setActionNotice(cause instanceof Error ? cause.message : `Unable to request ${action}`);
    } finally {
      setPendingAction(undefined);
    }
  };

  const workflow = workflows.find((candidate) => candidate.id === workflowId) ?? workflows[0];
  const activeRun = runs.find((run) => run.id === selectedRunId);
  const fetchCollaboration = useCallback(
    (runId: string) => api<unknown>(`/api/runs/${encodeURIComponent(runId)}/collaboration`),
    [],
  );
  const fetchCheckpointView = useCallback(
    (runId: string) => api<unknown>(M7_ENDPOINTS.view(runId)),
    [],
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
      input: { name: string; profile?: string; promptVariants?: Record<string, string> },
    ) => {
      const result = await api<{ checkpointId: string }>(M7_ENDPOINTS.fork(checkpointId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          count: 2,
          requestKey: `fork:${checkpointId}:${input.name}:${crypto.randomUUID()}`,
          name: input.name,
          ...(input.profile ? { executionProfile: input.profile } : {}),
          ...(input.promptVariants ? { promptVariants: input.promptVariants } : {}),
        }),
      });
      return selectedRunId ? await fetchCheckpointView(selectedRunId).catch(() => result) : result;
    },
    [fetchCheckpointView, selectedRunId],
  );
  const invocations = asArray(snapshot?.invocations);
  const selectedInvocation =
    invocations.find((item) => item.invocationId === selectedInvocationId) ??
    invocations[invocations.length - 1];
  const visibleRuns = runs.map((run) =>
    run.id === selectedRunId && snapshot
      ? {
          ...run,
          state: snapshot.state,
          revision: snapshot.revision,
          startedAt: snapshot.startedAt,
          endedAt: snapshot.finishedAt,
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
        workflowId={workflowId}
        selectedRunId={selectedRunId}
        setWorkflowId={(id) => {
          setWorkflowId(id);
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
          view={surface === "new-run" ? null : snapshot}
          store={store}
          onLaunch={launch}
          onNewRun={openNewRun}
          launching={launching}
          profiles={profiles}
          profileId={profileId}
          setProfileId={setProfileId}
          allowUnrestrictedCommands={allowUnrestrictedCommands}
          setAllowUnrestrictedCommands={setAllowUnrestrictedCommands}
          pendingAction={pendingAction}
          actionNotice={actionNotice}
          onControl={controlRun}
          workflows={workflows}
          workflowId={workflowId}
          setWorkflowId={(id) => {
            setWorkflowId(id);
            openNewRun();
          }}
          surface={surface}
          setSurface={setSurface}
        />
        {error && (
          <div className="notice error">
            <span>!</span>
            {error}
            <button onClick={() => void loadCatalog()}>Retry</button>
          </div>
        )}
        {experimentError && surface === "evals" && (
          <div className="notice error">
            <span>!</span>
            {experimentError}
            <button onClick={() => setExperimentError(undefined)}>Dismiss</button>
          </div>
        )}
        {surface === "checkpoints" && selectedRunId ? (
          <M7Workbench
            runId={selectedRunId}
            revision={snapshot?.revision}
            fetchView={fetchCheckpointView}
            createCheckpoint={captureCheckpoint}
            forkCheckpoint={forkCheckpoint}
            availableProfiles={profiles
              .filter((profile) => profile.available)
              .map((profile) => ({ id: profile.id, name: profile.name }))}
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
          selectedExperiment ? (
            <M5Workbench
              experiment={selectedExperiment}
              comparisonTimeline={comparisonTimeline}
              comparisonTimelineError={comparisonTimelineError}
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
          ) : (
            <div className="empty-state">No experiments have been created yet.</div>
          )
        ) : surface === "swarm" && selectedRunId ? (
          <SwarmWorkbench runId={selectedRunId} fetchView={fetchCollaboration} />
        ) : loading ? (
          <div className="empty-state">
            <div className="loader" />
            Loading local workbench…
          </div>
        ) : surface !== "new-run" && selectedRunId && snapshot ? (
          <Workbench
            workflow={workflow}
            view={snapshot}
            selectedInvocationId={selectedInvocation?.invocationId}
            setSelectedInvocationId={setSelectedInvocationId}
            onControl={controlRun}
            pendingAction={pendingAction}
            onInspectorResizeStart={(event) => startPanelResize("inspector", event)}
          />
        ) : (
          <Preview
            workflow={workflow}
            task={task}
            setTask={setTask}
            workspacePath={workspacePath}
            setWorkspacePath={setWorkspacePath}
            onLaunch={launch}
            launching={launching}
          />
        )}
      </main>
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
          executionProfile: "scripted",
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
          <button
            className={`run-row ${run.id === selectedRunId ? "selected" : ""}`}
            key={run.id}
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

function Topbar({
  run,
  view,
  store,
  onLaunch,
  onNewRun,
  launching,
  profiles,
  profileId,
  setProfileId,
  allowUnrestrictedCommands,
  setAllowUnrestrictedCommands,
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
  profiles: ExecutionProfile[];
  profileId: ExecutionProfile["id"];
  setProfileId: (id: ExecutionProfile["id"]) => void;
  allowUnrestrictedCommands: boolean;
  setAllowUnrestrictedCommands: (enabled: boolean) => void;
  pendingAction?: string;
  actionNotice?: string;
  onControl: (action: string, invocationId?: string) => void;
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
            <RoleBadge label="operator" />
          </>
        ) : (
          <span className="muted">No active run</span>
        )}
      </div>
      <div className="top-actions">
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
        <label className="profile-picker">
          <span>PROFILE</span>
          <select
            aria-label="Execution profile"
            value={profileId}
            onChange={(event) => setProfileId(event.target.value as ExecutionProfile["id"])}
          >
            {(profiles.length
              ? profiles
              : [
                  {
                    id: "scripted",
                    name: "Scripted fixture",
                    description: "",
                    available: true,
                    harness: "scripted",
                    capabilities: {},
                  },
                ]
            ).map((profile) => (
              <option key={profile.id} value={profile.id} disabled={!profile.available}>
                {profile.name}
                {profile.available ? "" : " · unavailable"}
              </option>
            ))}
          </select>
        </label>
        <label className="profile-picker">
          <input
            type="checkbox"
            aria-label="Allow legacy unrestricted commands"
            checked={allowUnrestrictedCommands}
            onChange={(event) => setAllowUnrestrictedCommands(event.target.checked)}
          />
          <span>ALLOW LEGACY COMMANDS</span>
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
          disabled={launching}
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
  task,
  setTask,
  workspacePath,
  setWorkspacePath,
  onLaunch,
  launching,
}: {
  workflow?: WorkflowSummary;
  task: string;
  setTask: (task: string) => void;
  workspacePath: string;
  setWorkspacePath: (path: string) => void;
  onLaunch: () => void;
  launching: boolean;
}) {
  const root = workflow?.bundle?.definitions[workflow.bundle.rootDefinitionId];
  const taskInput = root?.inputPorts?.find((port) => port.name === "task");
  const taskRequired = taskInput?.required === true;
  return (
    <section className="preview">
      <div className="preview-kicker">
        WORKFLOW PREVIEW <span>UNEXECUTED</span>
      </div>
      <h1>{workflow?.name ?? workflow?.id ?? "Select a workflow"}</h1>
      <p className="preview-desc">
        Review the compiled execution path before admitting a local run.
      </p>
      {workflow?.validation && !workflow.validation.valid && (
        <div className="validation-warning">
          Bundle validation failed: {workflow.validation.errors?.join(", ")}
        </div>
      )}
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
        disabled={!workflow || launching || (taskRequired && !task.trim())}
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
  onControl: (action: string, invocationId?: string) => void;
  pendingAction?: string;
  onInspectorResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const [mode, setMode] = useState<"graph" | "split" | "timeline">("split");
  return (
    <section className="workbench">
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
      </div>
      <div className={`work-area ${mode}`}>
        <GraphPanel
          graph={workflow?.graph}
          view={view}
          selectedId={selectedInvocationId}
          onSelect={setSelectedInvocationId}
        />
        <Timeline
          view={view}
          selectedId={selectedInvocationId}
          onSelect={setSelectedInvocationId}
        />
      </div>
      <Inspector
        view={view}
        graph={workflow?.graph}
        selectedId={selectedInvocationId}
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

function GraphPanel({
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
    () => projectHierarchicalGraph(graph, view, collapsed, selectedId),
    [graph, view, collapsed, selectedId],
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
  const nodes = projection.nodes.map((node) =>
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
      : node,
  );
  const edges: Edge[] = projection.edges
    .filter((edge) => !edge.hidden)
    .map((edge) => ({
      ...edge,
      type: "smoothstep",
      animated: Boolean(runningNodeIds.has(edge.source)),
      className: "work-edge",
      labelStyle: { fill: "#71809a", fontSize: 10 },
      labelBgStyle: { fill: "#111824", fillOpacity: 0.92 },
      labelBgPadding: [5, 3],
    }));
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
          {projection.breadcrumbs.length > 0 && (
            <span className="graph-breadcrumb" data-testid="graph-breadcrumb">
              root / {projection.breadcrumbs.join(" / ")}
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
}

function Timeline({
  view,
  selectedId,
  onSelect,
}: {
  view: UiRunView;
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
    return [...invocations]
      .sort((a, b) => a.ordinal - b.ordinal || a.invocationId.localeCompare(b.invocationId))
      .map((invocation) => {
        const related = attemptsByInvocation.get(invocation.invocationId) ?? [];
        const start = isoMs(invocation.startedAt, fallback);
        const end = isoMs(invocation.endedAt, start + 1);
        return { invocation, attempts: related, start, end, depth: scopeDepth(invocation.scopeId) };
      });
  }, [view.invocations, view.attempts, view.scopes, view.servedAt]);
  const hasActive = rows.some(({ invocation }) => invocation.state === "running");
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
        <svg
          data-testid="timeline-canvas"
          width={canvasWidth}
          height={graphHeight}
          className="timeline-svg"
        >
          {scale.ticks.map((tick) => (
            <g key={tick} transform={`translate(${gutter + scale.x(tick)},0)`}>
              <line y2={graphHeight} />
              <text y={18}>{scale.tickFormat(tick)}</text>
            </g>
          ))}
          {hasActive && (
            <line className="timeline-now" x1={nowX} x2={nowX} y1={20} y2={graphHeight} />
          )}
          {rows
            .slice(firstVisibleRow, lastVisibleRow)
            .map(
              (
                { invocation, attempts: related, start, end: persistedEnd, depth },
                visibleIndex,
              ) => {
                const index = firstVisibleRow + visibleIndex;
                const end = invocation.state === "running" ? now : persistedEnd;
                const x = gutter + scale.x(start);
                const w = Math.max(3, scale.x(end) - scale.x(start));
                const active = invocation.state === "running";
                return (
                  <g
                    key={invocation.invocationId}
                    className={`timeline-row ${selectedId === invocation.invocationId ? "selected" : ""}`}
                    onClick={() => onSelect(invocation.invocationId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(invocation.invocationId);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Select ${invocation.sourceNodeId} invocation, ${invocation.state}`}
                    transform={`translate(0,${28 + index * rowHeight})`}
                  >
                    <text className="timeline-label" x={8 + depth * 14} y={18}>
                      {depth > 0 ? "↳ " : ""}
                      {invocation.sourceNodeId}
                    </text>
                    <rect
                      data-testid="timeline-bar"
                      data-invocation-id={invocation.invocationId}
                      data-source-node-id={invocation.sourceNodeId}
                      data-active={active ? "true" : "false"}
                      data-duration-ms={Math.max(0, Math.round(end - start))}
                      className={`invocation-bar state-${invocation.state}`}
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
        {!rows.length && <div className="empty-inline">Waiting for the first invocation…</div>}
      </div>
    </div>
  );
}

function Inspector({
  view,
  graph,
  selectedId,
  onControl,
  pendingAction,
  onResizeStart,
}: {
  view: UiRunView;
  graph?: WorkflowGraph;
  selectedId?: string;
  onControl: (action: string, invocationId?: string) => void;
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
  >("output");
  const [focusedAttemptId, setFocusedAttemptId] = useState<string>();
  const invocation = asArray(view.invocations).find((item) => item.invocationId === selectedId);
  const node = graph?.nodes.find((candidate) => candidate.id === invocation?.sourceNodeId);
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
  const tools = view.tools.filter(belongs);
  const logs = view.logs.filter(belongs);
  const usage = view.usage.filter(belongs);
  const diagnostics = view.diagnostics.filter(belongs);
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
      {invocation ? (
        <>
          <div className="inspector-title">
            <StatusDot state={invocation.state} />
            <div>
              <strong>{invocation.sourceNodeId}</strong>
              <em>workflow invocation</em>
            </div>
          </div>
          <div className="detail-grid">
            <span>INVOCATION</span>
            <b data-testid="selected-invocation">{invocation.invocationId.slice(0, 18)}</b>
            <span>STATE</span>
            <b className={`text-${invocation.state}`}>{invocation.state}</b>
            <span>ATTEMPTS</span>
            <b>{attempts.length || "—"}</b>
          </div>
          <LifecycleNotice invocation={invocation} view={view} />
          <ApprovalPanel
            invocation={invocation}
            nodeKind={node?.kind}
            view={view}
            pendingAction={pendingAction}
            onControl={onControl}
          />
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
            {tab === "output" && <OutputPanel attempt={latest} invocation={invocation} />}
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
          </div>
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
        items.map((item) => (
          <div className="evidence-card" key={item.id}>
            <div>
              <StatusDot state={item.status} />
              <strong>{item.name}</strong>
              <span>{item.status}</span>
            </div>
            {item.capability && <p>capability: {item.capability}</p>}
            {item.input !== undefined && <pre>{JSON.stringify(item.input, null, 2)}</pre>}
          </div>
        ))
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
              <code>{item.message}</code>
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
  onControl: (action: string, invocationId?: string) => void;
}) {
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
      {pending && (
        <div className="approval-actions">
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
  useEffect(() => {
    let cancelled = false;
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
        if (typeof value.patch !== "string" || !Array.isArray(value.changedPaths)) {
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
          patch: value.patch,
          patchDigest: typeof value.patchDigest === "string" ? value.patchDigest : "unavailable",
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
  }, [runId]);
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
          requestKey: `web:${runId}:${state.patchDigest}`,
          message: `Deliver ${runId}`,
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
            message: `Deliver ${runId}`,
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
            {delivery.kind === "idle" && (
              <button className="control-button approve" onClick={() => void prepare()}>
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

function OutputPanel({ attempt, invocation }: { attempt?: UiAttempt; invocation: UiInvocation }) {
  const output = attempt?.output;
  const captured = Array.isArray(output) ? output.length > 0 : output !== undefined;
  return (
    <div className="output-panel">
      <div className="section-label">
        STRUCTURED OUTPUT <span>{captured ? "captured" : "none"}</span>
      </div>
      {captured ? (
        <pre>{JSON.stringify(output, null, 2)}</pre>
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
            aria-label={`Inspect attempt ${attempt.ordinal}`}
          >
            <div>
              <StatusDot state={attempt.state} />
              <strong>attempt {attempt.ordinal}</strong>
              <span>{attempt.state}</span>
            </div>
            <small className="repair-label">
              {attempt.ordinal > 1 ? `repair pass ${attempt.ordinal - 1}` : "initial pass"}
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
function ArtifactPanel({
  artifacts,
}: {
  artifacts: Array<ArtifactView | { artifactId: string; contentType?: string }>;
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
            <a
              className="artifact-row"
              key={id}
              href={`/api/artifacts/${encodeURIComponent(id)}/content`}
              target="_blank"
              rel="noreferrer"
            >
              <span className="artifact-icon">◇</span>
              <div>
                <strong>{id.slice(0, 14)}</strong>
                <em>artifact · {mediaType ?? "application/json"}</em>
              </div>
              <small>open</small>
            </a>
          );
        })
      ) : (
        <div className="pending-copy">No artifacts attached.</div>
      )}
    </div>
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
