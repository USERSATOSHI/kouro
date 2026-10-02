import { TaskLauncher, type TaskLaunchRequest } from "./components/TaskLauncher";
import { readApiJson } from "./data/apiResponse";
import { MilestonesPanel } from "./components/MilestonesPanel";
import { FusionSessions, fusionGroups } from "./components/FusionSessions";
import { artifactIdentity, evidenceBelongsTo, invocationLabel } from "./data/evidenceIdentity";
import { layoutWorkbenchGraph } from "./data/workbenchLayout";
import { PageHeader, WorkbenchPanel } from "./components/WorkbenchPrimitives";
import { useComputedColorScheme } from "@mantine/core";
import { Grid, Stepper, JsonInput } from "@mantine/core";
import { WorkflowPreviewGraph } from "./components/WorkflowPreviewGraph";
import {
  AppShell,
  ActionIcon,
  Alert,
  Badge,
  Box,
  Burger,
  Divider,
  Drawer,
  Flex,
  Indicator,
  Modal,
  NavLink,
  Popover,
  ScrollArea,
  SegmentedControl,
  Splitter,
  Tabs,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
  IconActivity,
  IconArrowRight,
  IconChartBar,
  IconCode,
  IconGitBranch,
  IconLayoutDashboard,
  IconList,
  IconPlayerPlay,
  IconSettings,
  IconShieldCheck,
  IconTrash,
  IconUsers,
  IconRoute,
} from "@tabler/icons-react";
import { RunsDashboard, ApprovalQueue, WorkbenchSettings } from "./components/WorkbenchPages";
import { stateColor } from "./theme";
import {
  Anchor,
  Button,
  Checkbox,
  Code,
  Fieldset,
  Group,
  List,
  Loader,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { Disclosure, DisclosureTitle } from "./components/Disclosure";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
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
import { projectSession } from "./session";
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
import { SwarmLauncher, type SwarmLaunchRequest } from "./components/SwarmLauncher";
import { M7Workbench, M7_ENDPOINTS } from "./m7";
import { ActivityValue, ToolActivity } from "./components/ActivityValue";
import { WorkflowInputs, launchInputs } from "./components/WorkflowInputs";
import {
  AgentSessionModal,
  boundedActivity,
  SafeMarkdown,
  type ActivityPage,
} from "./components/AgentSession";

type Surface =
  | "runs"
  | "new-run"
  | "evals"
  | "swarm"
  | "task"
  | "development"
  | "checkpoints"
  | "dashboard"
  | "approvals"
  | "settings";

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
    csrfToken = (await readApiJson<{ csrfToken: string }>(existing, "/api/session")).csrfToken;
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
  csrfToken = (await readApiJson<{ csrfToken: string }>(response, "/api/session")).csrfToken;
  savePairingToken(token);
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
  return readApiJson<T>(response, path);
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
  return (
    <ThemeIcon
      size={10}
      radius="xl"
      color={stateColor(state)}
      variant="filled"
      aria-label={state ?? "idle"}
      className={`status-dot status-${state ?? "idle"}`}
    />
  );
}
function LogoMark() {
  return (
    <ThemeIcon variant="light" size={32} radius="md">
      <IconActivity size={21} />
    </ThemeIcon>
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

export function App() {
  const [navigationOpen, navigation] = useDisclosure(false);
  const appearance = useComputedColorScheme("dark");
  const [requestedWorkspace, setRequestedWorkspace] = useState<{
    tab: "session" | "review" | "milestones";
    nonce: number;
  }>();
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
  const [surface, setSurface] = useState<Surface>(() =>
    new URLSearchParams(window.location.search).has("run") ? "runs" : "dashboard",
  );
  const [experiments, setExperiments] = useState<EvalExperiment[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string>();
  const [experimentError, setExperimentError] = useState<string>();
  const [comparisonTimeline, setComparisonTimeline] = useState<ComparisonTimeline>();
  const [comparisonTimelineError, setComparisonTimelineError] = useState<string>();
  const [comparisonRunIds, setComparisonRunIds] = useState<string[]>([]);
  const [pairwise, setPairwise] = useState<BlindedPairwise>();
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [composingSwarm, setComposingSwarm] = useState(true);
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
    readPanelWidth("kouro.sidebar.width", 258, 200, 360),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readPanelWidth("kouro.inspector.width", 420, 280, 560),
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

  const launchSwarm = async (request: SwarmLaunchRequest) => {
    if (launchingRef.current) return false;
    launchingRef.current = true;
    setLaunching(true);
    setError(undefined);
    try {
      const created = await api<RunSummary>("/api/swarms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      setRuns((old) => [created, ...old.filter((run) => run.id !== created.id)]);
      setSelectedRunId(created.id);
      setSelectedInvocationId(undefined);
      setComposingSwarm(false);
      setSurface("swarm");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start swarm");
      return false;
    } finally {
      launchingRef.current = false;
      setLaunching(false);
    }
  };

  const launchTask = async (request: TaskLaunchRequest) => {
    if (launchingRef.current) return false;
    launchingRef.current = true;
    setLaunching(true);
    setError(undefined);
    try {
      const created = await api<RunSummary>("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      setRuns((old) => [created, ...old.filter((run) => run.id !== created.id)]);
      setSelectedRunId(created.id);
      setSelectedInvocationId(undefined);
      setSurface("runs");
      setRequestedWorkspace({ tab: "milestones", nonce: Date.now() });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start workflow task");
      return false;
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

  const confirmAbandonedShutdown = async (shutdownId: string) => {
    const preview = deletionPreview;
    if (!preview || typeof preview.runId !== "string") return;
    setDeletingRun(true);
    setDeletionError(undefined);
    try {
      setDeletionPreview(
        await api<Record<string, unknown>>(
          `/api/runs/${encodeURIComponent(preview.runId)}/confirm-harness-shutdown`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              shutdownId,
              expectedRevision: preview.revision,
              verifiedStopped: true,
              actor: "operator",
            }),
          },
        ),
      );
      void loadCatalog();
    } catch (cause) {
      setDeletionError(
        cause instanceof Error
          ? cause.message
          : "Unable to confirm shutdown. Restart Kouro with this checkout to load the recovery action.",
      );
    } finally {
      setDeletingRun(false);
    }
  };

  const stopRecoveryRun = async () => {
    const preview = deletionPreview;
    if (!preview || typeof preview.runId !== "string") return;
    setDeletingRun(true);
    setDeletionError(undefined);
    try {
      await api(`/api/runs/${encodeURIComponent(preview.runId)}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "cancel",
          expectedRevision: preview.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      await previewRunDeletion(preview.runId);
      void loadCatalog();
    } catch (cause) {
      setDeletionError(cause instanceof Error ? cause.message : "Unable to stop recovery run");
    } finally {
      setDeletingRun(false);
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
    [...invocations]
      .reverse()
      .find((item) =>
        activeView?.bundle.definitions[
          activeView.scopes[item.scopeId]?.definitionId ?? activeView.bundle.rootDefinitionId
        ]?.nodes.some((node) => node.id === item.sourceNodeId && node.kind === "agent"),
      ) ??
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
    <AppShell
      layout="alt"
      header={{ height: 64 }}
      navbar={{ width: sidebarWidth, breakpoint: "md", collapsed: { mobile: !navigationOpen } }}
      padding={0}
    >
      <AppShell.Header bg="var(--mantine-color-body)">
        <Group h="100%" px="lg" justify="space-between" wrap="nowrap">
          <Group gap="md" wrap="nowrap">
            <Burger
              opened={navigationOpen}
              onClick={navigation.toggle}
              hiddenFrom="md"
              size="sm"
              aria-label="Toggle navigation"
            />
            <Text visibleFrom="sm" size="xs" c="dimmed">
              LOCAL
            </Text>
            <Text size="sm" visibleFrom="sm">
              Local workbench
            </Text>
            <Text size="sm" hiddenFrom="sm">
              Kouro
            </Text>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Text visibleFrom="sm" size="xs" c={store.status === "live" ? "teal" : "dimmed"}>
              {selectedRunId
                ? store.status === "live"
                  ? "● connected"
                  : store.status
                : "local host"}
            </Text>
            <ApprovalInbox
              items={pendingApprovals}
              onOpen={(approval) => {
                setSelectedRunId(approval.runId);
                setSelectedInvocationId(approval.invocationId);
                setSurface("runs");
              }}
            />
            <RunDeletionInbox
              items={pendingRunDeletions}
              onOpen={(runId) => void previewRunDeletion(runId)}
            />
            <Button
              variant="filled"
              onClick={() => {
                openNewRun();
                navigation.close();
              }}
            >
              New run
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar bg="var(--mantine-color-body)" p={0}>
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
            navigation.close();
          }}
          setSelectedRunId={(id) => {
            setSelectedRunId(id);
            setSelectedInvocationId(undefined);
            setComposingSwarm(false);
            setSurface(
              runs.find((run) => run.id === id)?.workflowId.startsWith("agent-swarm-")
                ? "swarm"
                : "runs",
            );
            navigation.close();
          }}
          surface={surface}
          setSurface={(next) => {
            if (next === "swarm") setComposingSwarm(true);
            setSurface(next);
            navigation.close();
          }}
          approvals={pendingApprovals.length}
        />
      </AppShell.Navbar>
      <AppShell.Main bg={appearance === "dark" ? "dark.8" : "gray.0"}>
        <Stack gap={0} className="main-column" miw={0}>
          {["runs", "swarm", "checkpoints"].includes(surface) &&
            !(surface === "swarm" && composingSwarm) && (
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
                setSurface={(next) => {
                  if (next === "swarm") setComposingSwarm(false);
                  setSurface(next);
                }}
              />
            )}
          {(error || catalogError) && (
            <Alert color="red" title="Action needs attention">
              <Stack gap="xs">
                <Text component="span" size="sm">
                  !
                </Text>
                {error || catalogError}
                {catalogError && <Button onClick={() => void loadCatalog()}>Retry</Button>}
                {error && <Button onClick={() => setError(undefined)}>Dismiss</Button>}
              </Stack>
            </Alert>
          )}
          {experimentError && surface === "evals" && (
            <Alert color="red" title="Action needs attention">
              <Stack gap="xs">
                <Text component="span" size="sm">
                  !
                </Text>
                {experimentError}
                <Button onClick={() => setExperimentError(undefined)}>Dismiss</Button>
              </Stack>
            </Alert>
          )}
          {surface === "runs" && selectedRunId && store.status !== "live" && (
            <Alert color="yellow" role="status">
              <Stack gap="xs">
                {store.error ?? "Loading the selected run…"}
                <Button onClick={() => setConnectionNonce((value) => value + 1)}>Reconnect</Button>
              </Stack>
            </Alert>
          )}
          {surface === "dashboard" ? (
            <RunsDashboard
              selectedRunId={selectedRunId}
              runs={visibleRuns}
              workflows={workflows}
              approvals={pendingApprovals.length}
              onNew={openNewRun}
              onOpen={(id) => {
                setSelectedRunId(id);
                setSelectedInvocationId(undefined);
                setRequestedWorkspace(undefined);
                setSurface("runs");
              }}
              onDelete={(id) => void previewRunDeletion(id)}
              hasMore={hasMoreRuns}
              onOlder={showOlderRuns}
              loadingOlder={loadingOlderRuns}
            />
          ) : surface === "approvals" ? (
            <ApprovalQueue
              items={pendingApprovals}
              onSelect={(item) => {
                setSelectedRunId(item.runId);
                setSelectedInvocationId(item.invocationId);
              }}
              onOpen={(item) => {
                setSelectedRunId(item.runId);
                setSelectedInvocationId(item.invocationId);
                setRequestedWorkspace({ tab: "review", nonce: Date.now() });
                setSurface("runs");
              }}
              renderDetail={(item) => {
                if (!activeView || activeView.runId !== item.runId) return <Loader size="sm" />;
                const invocation = asArray(activeView.invocations).find(
                  (invocation) => invocation.invocationId === item.invocationId,
                );
                return invocation ? (
                  <Stack gap="md">
                    <Text size="xs" c="dimmed">
                      EVIDENCE
                    </Text>
                    <ArtifactPanel
                      artifacts={asArray(activeView.artifacts).filter((artifact) =>
                        [
                          ...invocation.evidenceArtifactIds,
                          ...invocation.outputArtifactIds,
                        ].includes(artifact.artifactId),
                      )}
                    />
                    <ApprovalPanel
                      invocation={invocation}
                      nodeKind="approval"
                      view={activeView}
                      pendingAction={pendingAction}
                      onControl={controlRun}
                    />
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed">
                    This gate is no longer present in the current revision.
                  </Text>
                );
              }}
            />
          ) : surface === "settings" ? (
            <WorkbenchSettings
              sidebarWidth={sidebarWidth}
              setSidebarWidth={setSidebarWidth}
              inspectorWidth={inspectorWidth}
              setInspectorWidth={setInspectorWidth}
              status={store.status}
              error={store.error}
              onReconnect={() => setConnectionNonce((value) => value + 1)}
              onOpenSession={() => {
                setRequestedWorkspace({ tab: "session", nonce: Date.now() });
                setSurface("runs");
              }}
            />
          ) : surface === "checkpoints" && selectedRunId ? (
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
              {selectedExperiment ? (
                <>
                  <M5Workbench
                    comparisonPicker={
                      <RunComparisonPanel
                        runs={visibleRuns}
                        selectedIds={comparisonRunIds}
                        onSelectionChange={setComparisonRunIds}
                        onCompare={() => void compareSelectedRuns()}
                        timeline={comparisonTimeline}
                        error={comparisonTimelineError}
                      />
                    }
                    creator={
                      <ExperimentCreator
                        workflows={workflows}
                        onCreated={(id) => {
                          setSelectedExperimentId(id);
                          void loadCatalog();
                        }}
                      />
                    }
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
                <Stack p="lg" gap="lg">
                  <RunComparisonPanel
                    runs={visibleRuns}
                    selectedIds={comparisonRunIds}
                    onSelectionChange={setComparisonRunIds}
                    onCompare={() => void compareSelectedRuns()}
                    timeline={comparisonTimeline}
                    error={comparisonTimelineError}
                  />
                  <ExperimentCreator
                    workflows={workflows}
                    initiallyOpen
                    onCreated={(id) => {
                      setSelectedExperimentId(id);
                      void loadCatalog();
                    }}
                  />
                </Stack>
              )}
            </>
          ) : surface === "task" ? (
            <TaskLauncher api={api} onLaunch={launchTask} launching={launching} />
          ) : surface === "swarm" && (composingSwarm || !selectedRunId) ? (
            <SwarmLauncher onLaunch={launchSwarm} launching={launching} />
          ) : surface === "swarm" && selectedRunId ? (
            <>
              <Group px="lg" pt="md">
                <Button variant="light" onClick={() => setComposingSwarm(true)}>
                  New swarm
                </Button>
              </Group>
              <SwarmWorkbench
                runId={selectedRunId}
                runView={activeView ?? undefined}
                fetchView={fetchCollaboration}
                objective={runs.find((run) => run.id === selectedRunId)?.task}
                onOpenParticipant={(participantId) => {
                  if (!activeView) return;
                  const root = activeView.bundle.definitions[activeView.bundle.rootDefinitionId];
                  const member = root?.nodes.find(
                    (node) => node.kind === "agent" && node.role === participantId,
                  );
                  const synthesis = asArray(activeView.invocations)
                    .filter((item) => item.sourceNodeId === "synthesis")
                    .at(-1);
                  const invocation =
                    (member?.id === "member-1" && synthesis) ||
                    asArray(activeView.invocations)
                      .filter((item) => item.sourceNodeId === member?.id)
                      .at(-1);
                  setSelectedInvocationId(invocation?.invocationId);
                  setRequestedWorkspace({ tab: "session", nonce: Date.now() });
                  setSurface("runs");
                }}
                checkpointPanel={
                  <M7Workbench
                    compact
                    runId={selectedRunId}
                    revision={activeView?.revision}
                    fetchView={fetchCheckpointView}
                    createCheckpoint={captureCheckpoint}
                    forkCheckpoint={forkCheckpoint}
                  />
                }
              />
            </>
          ) : loading ? (
            <Stack p="xl" align="center" justify="center" mih={240} className="empty-state">
              <Loader size="sm" className="loader" />
              Loading local workbench…
            </Stack>
          ) : surface !== "new-run" && selectedRunId && activeView ? (
            <Workbench
              key={activeView.runId}
              workflow={activeWorkflow}
              view={activeView}
              selectedInvocationId={selectedInvocation?.invocationId}
              setSelectedInvocationId={setSelectedInvocationId}
              onControl={controlRun}
              pendingAction={pendingAction}
              requestedWorkspace={requestedWorkspace}
              taskLabel={activeRun?.task}
              inspectorWidth={inspectorWidth}
              setInspectorWidth={setInspectorWidth}
            />
          ) : surface === "runs" && selectedRunId ? (
            <Stack p="xl" align="center" justify="center" mih={240} className="empty-state">
              {store.error ?? "Loading the selected run…"}
            </Stack>
          ) : (
            <Preview
              workflows={workflows}
              onSelectWorkflow={(id) => {
                setWorkflowId(id);
                setNodeSettings({});
                setInputDrafts({});
              }}
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
        </Stack>
      </AppShell.Main>
      {deletionPreview && (
        <RunDeletionDialog
          preview={deletionPreview}
          error={deletionError}
          busy={deletingRun}
          onClose={() => {
            if (!deletingRun) setDeletionPreview(undefined);
          }}
          onConfirm={() => void confirmRunDeletion()}
          onRefresh={() => void previewRunDeletion(String(deletionPreview.runId))}
          onConfirmShutdown={(shutdownId) => void confirmAbandonedShutdown(shutdownId)}
          onStop={() => void stopRecoveryRun()}
        />
      )}
    </AppShell>
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
    <Stack gap={0} className="development-workbench">
      <Paper p="md" radius={0} withBorder={false}>
        <Text size="sm">Developer tools</Text>
      </Paper>
      <Divider />
      <Grid gap="lg" p="lg">
        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Stack gap="lg">
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                PROMPT RENDERING
              </Text>
              <Paper>
                <Stack gap="md">
                  <Textarea
                    label="Prompt template"
                    value={prompt}
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                    minRows={3}
                    autosize
                    maxRows={12}
                  />
                  <Group>
                    <Button variant="filled" disabled={busy} onClick={() => void runPrompt()}>
                      Run prompt fixture
                    </Button>
                    <Button disabled={busy} onClick={() => void run("prompt")}>
                      Render prompt
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            </Stack>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                SCHEMA VALIDATION
              </Text>
              <Paper>
                <Stack gap="md">
                  <JsonInput
                    label="Variable schema"
                    value={schema}
                    onChange={setSchema}
                    minRows={6}
                    autosize
                    maxRows={14}
                    formatOnBlur
                    validationError="Enter valid JSON"
                  />
                  <JsonInput
                    label="Fixture JSON"
                    value={value}
                    onChange={setValue}
                    minRows={4}
                    autosize
                    maxRows={12}
                    formatOnBlur
                    validationError="Enter valid JSON"
                  />
                  <Button variant="filled" disabled={busy} onClick={() => void run("schema")}>
                    Validate schema
                  </Button>
                </Stack>
              </Paper>
            </Stack>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Stack gap="lg">
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                LAUNCHED RUN
              </Text>
              <Paper>
                <Stack gap="md">
                  {promptRunId ? (
                    <>
                      <Code>{promptRunId} · prompt fixture</Code>
                      <Button onClick={() => onOpenRun(promptRunId)}>Open run</Button>
                    </>
                  ) : (
                    <Text size="sm" c="dimmed">
                      Run a prompt fixture to inspect its ordinary execution.
                    </Text>
                  )}
                </Stack>
              </Paper>
            </Stack>
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                RESULT
              </Text>
              <Paper>
                <Code block mah={500} style={{ overflow: "auto" }} aria-live="polite">
                  {result ?? "Validation paths and rendered prompt results appear here."}
                </Code>
              </Paper>
            </Stack>
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
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
  approvals,
}: {
  workflows: WorkflowSummary[];
  runs: RunSummary[];
  shownRunCount: number;
  hasMoreRuns: boolean;
  loadingOlderRuns: boolean;
  onShowOlderRuns: () => void;
  onDeleteRun: (id: string) => void;
  workflowId: string;
  selectedRunId?: string;
  setWorkflowId: (id: string) => void;
  setSelectedRunId: (id: string) => void;
  surface:
    | "runs"
    | "new-run"
    | "evals"
    | "swarm"
    | "task"
    | "development"
    | "checkpoints"
    | "dashboard"
    | "approvals"
    | "settings";
  setSurface: (
    surface:
      | "runs"
      | "new-run"
      | "evals"
      | "swarm"
      | "task"
      | "task"
      | "development"
      | "checkpoints"
      | "dashboard"
      | "approvals"
      | "settings",
  ) => void;
  approvals: number;
}) {
  const links = [
    { id: "dashboard", label: "Runs", icon: IconLayoutDashboard },
    { id: "new-run", label: "Workflows", icon: IconRoute },
    { id: "approvals", label: "Approvals", icon: IconShieldCheck },
    { id: "swarm", label: "Agent swarm", icon: IconUsers },
    { id: "task", label: "Workflow task", icon: IconRoute },
    { id: "evals", label: "Evaluations", icon: IconChartBar },
    { id: "checkpoints", label: "Checkpoints", icon: IconGitBranch },
    { id: "development", label: "Developer tools", icon: IconCode },
    { id: "settings", label: "Settings", icon: IconSettings },
  ] as const;
  return (
    <Stack className="sidebar" h="100%" gap={0}>
      <Group h={64} px="lg" wrap="nowrap">
        <Text fw={700} fz={20}>
          KOURO
        </Text>
      </Group>
      <Divider />
      <AppShell.Section p="sm">
        <Stack gap={2}>
          {links
            .filter((link) => link.id !== "settings")
            .map((link) => (
              <NavLink
                component="button"
                type="button"
                key={link.id}
                label={link.label}
                color="gray"
                variant="subtle"
                active={surface === link.id || (link.id === "dashboard" && surface === "runs")}
                disabled={link.id === "checkpoints" && !selectedRunId}
                rightSection={
                  link.id === "approvals" && approvals ? (
                    <Badge size="xs" color="indigo">
                      {approvals}
                    </Badge>
                  ) : undefined
                }
                onClick={() => setSurface(link.id)}
              />
            ))}
        </Stack>
      </AppShell.Section>
      <AppShell.Section grow component={ScrollArea} p="sm">
        <Stack gap="sm">
          <Text size="xs" c="dimmed" px="xs" mt="sm">
            RECENT RUNS
          </Text>
          {runs.slice(0, shownRunCount).map((run) => (
            <Group key={run.id} gap={0} wrap="nowrap">
              <NavLink
                component="button"
                type="button"
                className="run-row"
                flex={1}
                active={run.id === selectedRunId && surface === "runs"}
                label={run.task?.slice(0, 30) || run.workflowId}
                description={run.id.slice(0, 8)}
                rightSection={
                  <Text size="xs" c={stateColor(run.state)}>
                    {run.state === "succeeded"
                      ? "done"
                      : run.state === "recovery-required"
                        ? "recovery"
                        : run.state}
                  </Text>
                }
                onClick={() => setSelectedRunId(run.id)}
              />
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={`Delete run ${run.id.slice(0, 12)}`}
                onClick={() => onDeleteRun(run.id)}
              >
                <IconTrash size={13} />
              </ActionIcon>
            </Group>
          ))}
          {(runs.length > shownRunCount || hasMoreRuns) && (
            <Button size="xs" onClick={onShowOlderRuns} loading={loadingOlderRuns}>
              Show older runs
            </Button>
          )}
        </Stack>
      </AppShell.Section>
      <Divider />
      <AppShell.Section p="sm">
        <NavLink
          component="button"
          type="button"
          label="Settings"
          color="gray"
          variant="subtle"
          active={surface === "settings"}
          onClick={() => setSurface("settings")}
        />
      </AppShell.Section>
    </Stack>
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
    <Paper component="section" className={`experiment-creator ${open ? "expanded" : ""}`}>
      {!open ? (
        <Button className="subtle-button" onClick={() => setOpen(true)}>
          ＋ New experiment
        </Button>
      ) : (
        <Stack
          gap="xs"
          component="form"
          onSubmit={(event) => void create(event as unknown as FormEvent<HTMLFormElement>)}
        >
          <Group gap="xs" justify="space-between" wrap="wrap" component="header">
            <Stack gap="xs">
              <Stack gap="xs" className="eyebrow">
                EVALUATION SETUP
              </Stack>
              <Title order={2}>Create experiment</Title>
            </Stack>
            {!initiallyOpen && (
              <Button type="button" className="subtle-button" onClick={() => setOpen(false)}>
                Close
              </Button>
            )}
          </Group>
          <Stack gap={4} component="label">
            NAME
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. prompt-baseline-check"
            />
          </Stack>
          <Stack gap={4} component="label">
            WORKFLOW
            <NativeSelect
              value={workflowId}
              onChange={(event) => setWorkflowId(event.target.value)}
            >
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name ?? item.id}
                </option>
              ))}
            </NativeSelect>
          </Stack>
          <Stack gap={4} component="label">
            DATASET CASES · JSON
            <Textarea
              value={cases}
              onChange={(event) => setCases(event.target.value)}
              rows={5}
              spellCheck={false}
            />
          </Stack>
          <Group gap="xs" justify="space-between" wrap="wrap" className="experiment-numeric-fields">
            <Stack gap={4} component="label">
              REPETITIONS
              <TextInput
                type="number"
                min={1}
                max={100}
                value={repetitions}
                onChange={(event) => setRepetitions(Math.max(1, Number(event.target.value) || 1))}
              />
            </Stack>
            <Stack gap={4} component="label">
              MAX CONCURRENT
              <TextInput
                type="number"
                min={1}
                max={32}
                value={maxConcurrent}
                onChange={(event) => setMaxConcurrent(Math.max(1, Number(event.target.value) || 1))}
              />
            </Stack>
          </Group>
          <Text size="sm">
            Creates one scripted baseline variant. Dataset manifests are immutable after creation.
          </Text>
          {error && (
            <Text size="sm" className="notice error" role="alert">
              {error}
            </Text>
          )}
          <Button
            variant="filled"
            className="primary-button"
            type="submit"
            disabled={busy || !available.length}
          >
            {busy ? "Creating…" : "Create experiment"}
          </Button>
        </Stack>
      )}
    </Paper>
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
    <Popover
      opened={open}
      onChange={setOpen}
      width={340}
      position="bottom-end"
      withArrow
      shadow="md"
    >
      <Popover.Target>
        <Button
          className="subtle-button surface-switch"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Cleanup{" "}
          <Text component="span" size="sm" fw={600}>
            {items.length}
          </Text>
        </Button>
      </Popover.Target>
      {open && (
        <Popover.Dropdown>
          <Stack
            gap="sm"
            mah={420}
            style={{ overflow: "auto" }}
            component="section"
            className="approval-inbox-menu"
            role="dialog"
            aria-label="Incomplete run cleanup"
          >
            <Group gap="xs" justify="space-between" wrap="wrap" component="header">
              <Text component="span" size="sm" fw={600}>
                Incomplete run cleanup
              </Text>
              <Button onClick={() => setOpen(false)} aria-label="Close cleanup list">
                ×
              </Button>
            </Group>
            {items.map((item) => (
              <Button
                key={item.runId}
                onClick={() => {
                  onOpen(item.runId);
                  setOpen(false);
                }}
              >
                <Text component="span" size="sm" fw={600}>
                  {item.status}
                </Text>
                <Text component="span" size="sm">
                  {String(item.task || item.workflowId || item.runId)}
                </Text>
                <Text component="span" size="xs" c="dimmed">
                  {item.error || item.runId}
                </Text>
              </Button>
            ))}
          </Stack>
        </Popover.Dropdown>
      )}
    </Popover>
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
    <Popover
      opened={open}
      onChange={setOpen}
      width={340}
      position="bottom-end"
      withArrow
      shadow="md"
    >
      <Popover.Target>
        <Button
          className="subtle-button surface-switch"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
        >
          Approvals{" "}
          <Badge size="xs" ml="xs" variant="light">
            {items.length}
          </Badge>
        </Button>
      </Popover.Target>
      {open && (
        <Popover.Dropdown>
          <Stack
            gap="sm"
            mah={420}
            style={{ overflow: "auto" }}
            component="section"
            className="approval-inbox-menu"
            role="dialog"
            aria-label="Pending approvals"
          >
            <Group gap="xs" justify="space-between" wrap="wrap" component="header">
              <Text component="span" size="sm" fw={600}>
                Pending approvals
              </Text>
              <Button onClick={() => setOpen(false)} aria-label="Close approvals">
                ×
              </Button>
            </Group>
            {items.length ? (
              items.map((item) => (
                <Button
                  key={item.approvalId ?? `${item.runId}:${item.invocationId}`}
                  onClick={() => {
                    onOpen(item);
                    setOpen(false);
                  }}
                >
                  <Text component="span" size="sm" fw={600}>
                    {item.action}
                  </Text>
                  <Text component="span" size="sm">
                    {item.task || item.workflowId}
                  </Text>
                  <Text component="span" size="xs" c="dimmed">
                    {item.runId.slice(0, 12)} · {item.invocationId.slice(0, 12)}
                  </Text>
                </Button>
              ))
            ) : (
              <Text size="sm">No pending approvals.</Text>
            )}
          </Stack>
        </Popover.Dropdown>
      )}
    </Popover>
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
    <Paper component="section" className="run-comparison-panel" aria-label="Compare ordinary runs">
      <Stack gap="md">
        <Group gap="xs" justify="space-between" wrap="wrap" component="header">
          <Stack gap="xs">
            <Stack gap="xs" className="eyebrow">
              RUN COMPARISON
            </Stack>
            <Title order={2}>Compare two runs</Title>
            <Text size="sm">
              Select any two runs. The comparison is pinned to their current journal revisions.
            </Text>
          </Stack>
          <Button
            variant="filled"
            className="primary-button"
            disabled={selectedIds.length !== 2}
            onClick={onCompare}
          >
            Compare selected
          </Button>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          {[0, 1].map((index) => (
            <NativeSelect
              key={index}
              label={`Run ${index === 0 ? "A" : "B"}`}
              disabled={index === 1 && !selectedIds[0]}
              value={selectedIds[index] ?? ""}
              onChange={(event) => {
                const next = [...selectedIds];
                next[index] = event.currentTarget.value;
                onSelectionChange(index === 0 && !next[0] ? [] : next.filter(Boolean));
              }}
              data={[
                { value: "", label: "Choose a run" },
                ...runs
                  .filter((run) => run.id !== selectedIds[1 - index])
                  .map((run) => ({
                    value: run.id,
                    label: `${run.task?.slice(0, 45) || run.workflowId} · ${run.state} · ${run.id.slice(0, 12)}`,
                  })),
              ]}
            />
          ))}
        </SimpleGrid>
        {incompatible && (
          <Text size="sm" className="comparison-warning">
            These runs use different workflow or execution-profile settings. Stage alignment is
            best-effort; outputs may not be directly equivalent.
          </Text>
        )}
        {error && (
          <Text size="sm" className="notice error" role="alert">
            {error}
          </Text>
        )}
        {timeline && (
          <Stack gap="xs" className="comparison-result" aria-live="polite">
            <Title order={3}>Stages · {timeline.rows.length}</Title>
            {timeline.rows.map((row) => (
              <Stack gap="xs" key={row.anchorId}>
                <Text component="span" size="sm" fw={600}>
                  {row.label}
                </Text>
                <Text component="span" size="sm">
                  {row.spans
                    .map((span) =>
                      span ? String(span.status ?? span.label ?? "observed") : "missing",
                    )
                    .join(" · ")}
                </Text>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

function RunDeletionDialog({
  preview,
  error,
  busy,
  onClose,
  onConfirm,
  onRefresh,
  onConfirmShutdown,
  onStop,
}: {
  onStop: () => void;
  onRefresh: () => void;
  onConfirmShutdown: (shutdownId: string) => void;
  preview: Record<string, unknown>;
  error?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [verifiedStopped, setVerifiedStopped] = useState(false);
  useEffect(() => setVerifiedStopped(false), [preview.revision]);
  const workspaces = Array.isArray(preview.workspaces) ? preview.workspaces : [];
  const blockers = Array.isArray(preview.blockers) ? preview.blockers : [];
  const removes = (preview.removes ?? {}) as Record<string, unknown>;
  const task =
    typeof preview.task === "string" && preview.task.trim() ? preview.task : "Untitled task";
  const runId = typeof preview.runId === "string" ? preview.runId : "unknown";
  const canDelete = preview.canDelete === true;
  const needsRecovery = preview.status === "recovery-required";
  return (
    <Modal
      opened
      onClose={onClose}
      closeOnEscape={!busy}
      closeOnClickOutside={!busy}
      withCloseButton={!busy}
      title={needsRecovery ? "Stop recovery run" : "Delete this run?"}
      size="lg"
      className="run-deletion-dialog"
    >
      <Stack gap="md">
        <Group gap="xs" justify="space-between" wrap="wrap" component="header">
          <Stack gap="xs">
            <Stack gap="xs" className="eyebrow">
              {needsRecovery ? "RESOLVE RECOVERY" : "REMOVE FINISHED RUN"}
            </Stack>
            <Title order={2} id="run-deletion-title">
              {needsRecovery ? "Stop recovery run" : "Delete this run?"}
            </Title>
          </Stack>
          <Button type="button" className="subtle-button" onClick={onClose} disabled={busy}>
            Close
          </Button>
        </Group>
        <Text size="sm" className="deletion-task">
          {task}
        </Text>
        <Text size="sm" className="deletion-run-id">
          {runId}
        </Text>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" className="deletion-summary">
          <Text component="span" size="sm">
            {String(removes.historyEvents ?? 0)} history events
          </Text>
          <Text component="span" size="sm">
            {String(removes.attempts ?? 0)} attempts
          </Text>
          <Text component="span" size="sm">
            {String(removes.artifacts ?? 0)} artifacts
          </Text>
          <Text component="span" size="sm">
            {String(removes.workspaces ?? workspaces.length)} owned worktrees
          </Text>
        </SimpleGrid>
        {workspaces.length > 0 && (
          <Stack gap="xs" component="section">
            <Title order={3}>Owned worktrees to remove</Title>
            <List>
              {workspaces.map((item, index) => {
                const workspace = item as Record<string, unknown>;
                return (
                  <List.Item key={`${String(workspace.workspaceId ?? index)}`}>
                    {String(workspace.path ?? "worktree")}
                  </List.Item>
                );
              })}
            </List>
          </Stack>
        )}
        {blockers.length > 0 && (
          <Stack gap="xs" component="section">
            <Title order={3}>What blocks deletion</Title>
            <List>
              {blockers.map((item, index) => (
                <List.Item key={index}>
                  {String(
                    (item as Record<string, unknown>).message ?? "Referenced by retained data",
                  )}
                </List.Item>
              ))}
            </List>
          </Stack>
        )}
        {preview.drained === false && (
          <Alert color="yellow" title="Agent shutdown is not confirmed">
            {String(
              preview.drainReason ?? "The host has not confirmed that all execution has stopped.",
            )}
          </Alert>
        )}
        {preview.terminal === false && (
          <Alert color="yellow">Stop the active run before deleting its history.</Alert>
        )}
        {preview.status === "recovery-required" &&
          blockers.some(
            (item) => (item as Record<string, unknown>).kind === "unconfirmed-harness-shutdown",
          ) && (
            <Paper>
              <Stack gap="sm">
                <Text size="sm" fw={600}>
                  Resolve an abandoned agent
                </Text>
                <Text size="sm">
                  A host restart left this agent’s outcome unknown. Stop its external process or
                  verify that it has exited, then acknowledge its shutdown. This preserves the
                  recovery record, cancels the run once all agents are confirmed stopped, and
                  enables deletion once all blockers are resolved.
                </Text>
                <Checkbox
                  checked={verifiedStopped}
                  onChange={(event) => setVerifiedStopped(event.currentTarget.checked)}
                  label="I verified that this run’s external agent has stopped"
                />
                {blockers
                  .filter(
                    (item) =>
                      (item as Record<string, unknown>).kind === "unconfirmed-harness-shutdown",
                  )
                  .map((item) => {
                    const blocker = item as Record<string, unknown>;
                    return (
                      <Button
                        key={String(blocker.id)}
                        disabled={!verifiedStopped || busy}
                        onClick={() => onConfirmShutdown(String(blocker.id))}
                      >
                        Confirm agent stopped
                      </Button>
                    );
                  })}
              </Stack>
            </Paper>
          )}
        {preview.status === "recovery-required" && preview.drained === true && (
          <Alert color="teal">
            <Stack gap="sm">
              <Text size="sm">
                Agent execution has stopped. Cancel the recovery run while retaining its history.
              </Text>
              <Button onClick={onStop} disabled={busy}>
                Stop run
              </Button>
            </Stack>
          </Alert>
        )}
        {preview.status === "cancelled" && preview.drained === true && (
          <Alert color="teal" title="Run stopped">
            Its history is retained. Close this dialog to keep it, or delete it below.
          </Alert>
        )}
        {preview.workspaceAdapterMissing === true && (
          <Text size="sm" className="notice error">
            The workspace adapter is unavailable, so owned worktrees cannot be safely removed.
          </Text>
        )}
        {error && (
          <Text size="sm" className="notice error" role="alert">
            {error}
          </Text>
        )}
        <Group gap="xs" justify="space-between" wrap="wrap" component="footer">
          <Button type="button" className="subtle-button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onRefresh} disabled={busy}>
            Refresh blockers
          </Button>
          <Button
            color="red"
            variant="filled"
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
          </Button>
        </Group>
      </Stack>
    </Modal>
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
  surface: Surface;
  setSurface: (surface: Surface) => void;
}) {
  const now = useServerNow(view?.servedAt, 250);
  const start = isoMs(view?.startedAt ?? run?.startedAt ?? view?.serverClock, now);
  const end = isoMs(view?.finishedAt ?? run?.endedAt, now);
  const elapsed = Math.max(0, end - start);
  const state = view?.state ?? run?.state;
  return (
    <Paper radius={0} withBorder={false} p="md" className="topbar">
      <Group justify="space-between" gap="sm">
        <Group gap="sm" wrap="nowrap" miw={0} flex={1}>
          <Text size="sm" c="dimmed" visibleFrom="sm">
            Local workbench /
          </Text>
          <Text
            size="sm"
            fw={600}
            truncate
            maw={{ base: 140, md: 440 }}
            title={run?.task ?? run?.workflowId}
          >
            {run?.task ?? run?.workflowId ?? "Choose a run"}
          </Text>
          {run && <Code visibleFrom="lg">{run.id.slice(0, 16)}</Code>}
        </Group>
        <Group gap="sm">
          {run && (
            <Button
              variant="subtle"
              onClick={() => setSurface(surface === "swarm" ? "runs" : "swarm")}
            >
              {surface === "swarm"
                ? "Run workbench"
                : run.workflowId.startsWith("agent-swarm-")
                  ? "Swarm activity"
                  : "Team activity"}
            </Button>
          )}
          <Text
            size="xs"
            c={store.status === "live" ? "teal" : "yellow"}
            className={`stream-state ${store.status}`}
          >
            {store.status === "live" ? "● connected" : store.status}
          </Text>
          {run && (
            <Text size="xs" ff="monospace" c="teal" className="elapsed">
              {formatDuration(elapsed)}
            </Text>
          )}
          {run && view && (
            <RunControlBar view={view} pendingAction={pendingAction} onControl={onControl} />
          )}
          {run && state === "recovery-required" && (
            <Button color="red" onClick={() => onOpenDeletion(run.id)}>
              Stop recovery run
            </Button>
          )}
          <Badge variant="light" color={stateColor(state)} data-testid="run-status">
            {state ?? "idle"}
          </Badge>
        </Group>
      </Group>
      {actionNotice && (
        <Alert mt="sm" role="status">
          {actionNotice}
        </Alert>
      )}
    </Paper>
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
    <Button
      color={name === "cancel" ? "red" : undefined}
      className={`control-button ${name === "cancel" ? "danger" : ""}`}
      disabled={pendingAction !== undefined || !allowed(view, capability)}
      title={
        !allowed(view, capability) ? "The runtime has not declared this operation safe" : label
      }
      aria-label={label}
      onClick={() => onControl(name)}
    >
      {pendingAction === name ? `${label}…` : label}
    </Button>
  );
  return (
    <Group
      gap="xs"
      justify="space-between"
      wrap="wrap"
      className="run-controls"
      aria-label="Run controls"
    >
      {running && allowed(view, "pause") && action("pause", "pause", "Pause")}
      {paused && allowed(view, "resume") && action("resume", "resume", "Resume")}
      {running && allowed(view, "interrupt") && action("interrupt", "interrupt", "Interrupt")}
      {(running || paused) && allowed(view, "cancel") && action("cancel", "cancel", "Cancel")}
      {!running &&
        !paused &&
        allowed(view, "reattach") &&
        action("reattach", "reattach", "Reattach")}
    </Group>
  );
}

function Preview({
  workflows,
  onSelectWorkflow,
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
  workflows: WorkflowSummary[];
  onSelectWorkflow: (id: string) => void;
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
        .filter(
          (node) =>
            node.kind !== "agent" ||
            !node.fusion ||
            ["draft", "synthesis"].includes(node.fusion.stage),
        )
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
    <Stack gap={0} className="preview">
      <PageHeader
        actions={
          <Text size="xs" c="dimmed" ff="monospace">
            Launch preview · next run uses v{workflow?.version ?? "local"}
          </Text>
        }
      >
        Workflows /{" "}
        <Text component="span" fw={600}>
          {workflow?.name ?? workflow?.id ?? "Select a workflow"}
        </Text>
      </PageHeader>
      <Tabs value="launch">
        <Tabs.List px="lg">
          <Tabs.Tab value="launch">Launch</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      <Grid gap={0}>
        <Grid.Col span={{ base: 12, lg: 3, xl: 3 }}>
          <Paper radius={0} h="100%" withBorder={false} p="lg">
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                DISCOVERED WORKFLOWS
              </Text>
              <Text size="xs" c="dimmed">
                Local workflow bundles
              </Text>
              {workflows.map((item) => (
                <NavLink
                  component="button"
                  type="button"
                  key={item.id}
                  active={item.id === workflow?.id}
                  label={item.name ?? item.id}
                  description={item.version ? `v${item.version}` : "Local bundle"}
                  onClick={() => onSelectWorkflow(item.id)}
                />
              ))}
            </Stack>
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 9, xl: 5 }}>
          <Stack gap="md">
            <Paper radius={0} p="lg" withBorder={false}>
              <Stack gap="md">
                <Group justify="space-between">
                  <Title order={3}>Compiled workflow</Title>
                  <Badge variant="light">{workflow?.graph?.nodes.length ?? 0} nodes</Badge>
                </Group>
                <WorkflowPreviewGraph
                  graph={workflow?.graph}
                  rootDefinitionId={workflow?.bundle?.rootDefinitionId}
                />
                <Group>
                  <Code>{workflow?.id ?? "No workflow selected"}</Code>
                  {workflow?.version && <Badge variant="outline">v{workflow.version}</Badge>}
                  <Text size="xs" c="dimmed">
                    {workflow?.digest?.slice(0, 16) ?? ""}
                  </Text>
                </Group>
                {workflow?.validation && !workflow.validation.valid ? (
                  <Alert color="red" title="Bundle validation failed">
                    {workflow.validation.errors?.join(", ")}
                  </Alert>
                ) : (
                  workflow && (
                    <Paper p="sm">
                      <Text size="sm">
                        No validation failures. Review required inputs before starting.
                      </Text>
                    </Paper>
                  )
                )}
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, xl: 4 }}>
          <Paper radius={0} p="lg" withBorder={false}>
            <Stack gap="md">
              <Title order={3}>Launch run</Title>
              {taskInput && (
                <Textarea
                  label="Work item / task"
                  aria-label="Work item / task"
                  required={taskRequired}
                  value={task}
                  onChange={(event) => setTask(event.currentTarget.value)}
                  placeholder="Describe what this workflow should accomplish…"
                  minRows={4}
                  autosize
                  maxRows={10}
                  description="Delivered as the workflow's typed root input."
                />
              )}
              <WorkflowInputs
                bundle={workflow?.bundle}
                drafts={inputDrafts}
                onChange={setInputDrafts}
                errors={inputs.errors}
              />
              <TextInput
                label="Repository / workspace"
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.currentTarget.value)}
                placeholder="/path/to/a git repository"
                description="Optional. Effects run in an isolated managed worktree."
              />
              {editableNodes.length > 0 && (
                <Stack gap="md">
                  <Stack gap={4}>
                    <Title order={2}>Node settings</Title>
                    <Text size="sm" c="dimmed">
                      Choose harnesses and models for parent and child agents. Read-only subagents
                      cannot write to the repository.
                    </Text>
                  </Stack>
                  <Stack gap="md">
                    {editableNodes.map(({ node, definitionId, key, readOnly }) => {
                      const settings = nodeSettings[key] ?? {};
                      const capabilities = settings.capabilities ?? node.capabilities ?? [];
                      return (
                        <Fieldset
                          key={key}
                          legend={`${definitionId} / ${node.id} · ${readOnly ? "read-only subagent" : node.kind}`}
                        >
                          <Stack gap="md">
                            {node.kind === "agent" && node.fusion?.stage === "draft" && (
                              <Text size="sm" c="dimmed">
                                This model selection also applies to every review and revision
                                round.
                              </Text>
                            )}
                            {node.kind === "agent" && (
                              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                                <NativeSelect
                                  label="Harness"
                                  value={settings.harness ?? node.harness ?? ""}
                                  onChange={(event) =>
                                    updateNode(key, {
                                      harness: event.currentTarget.value || undefined,
                                    })
                                  }
                                  data={[
                                    { value: "", label: "Host default" },
                                    { value: "codex", label: "Codex" },
                                    { value: "pi", label: "Pi" },
                                    { value: "claude", label: "Claude" },
                                    { value: "opencode", label: "OpenCode" },
                                  ]}
                                />
                                <TextInput
                                  label="Model"
                                  value={settings.modelId ?? node.modelId ?? ""}
                                  placeholder="Harness default"
                                  onChange={(event) =>
                                    updateNode(key, {
                                      modelId: event.currentTarget.value || undefined,
                                    })
                                  }
                                />
                              </SimpleGrid>
                            )}
                            <Group gap="md">
                              <Checkbox
                                label="Repository read"
                                checked={capabilities.includes("repository.read")}
                                onChange={(event) =>
                                  updateNode(key, {
                                    capabilities: event.currentTarget.checked
                                      ? [...capabilities, "repository.read"]
                                      : capabilities.filter((item) => item !== "repository.read"),
                                  })
                                }
                              />
                              <Checkbox
                                label="Repository write"
                                disabled={readOnly}
                                checked={capabilities.includes("repository.write")}
                                onChange={(event) =>
                                  updateNode(key, {
                                    capabilities: event.currentTarget.checked
                                      ? [...capabilities, "repository.write"]
                                      : capabilities.filter((item) => item !== "repository.write"),
                                  })
                                }
                              />
                              {node.kind === "command" && (
                                <Checkbox
                                  label="Run command outside the sandbox"
                                  checked={capabilities.includes("terminal.execute")}
                                  onChange={(event) =>
                                    updateNode(key, {
                                      capabilities: event.currentTarget.checked
                                        ? [...capabilities, "terminal.execute"]
                                        : capabilities.filter(
                                            (item) => item !== "terminal.execute",
                                          ),
                                    })
                                  }
                                />
                              )}
                            </Group>
                          </Stack>
                        </Fieldset>
                      );
                    })}
                  </Stack>
                </Stack>
              )}
              <Button
                fullWidth
                variant="filled"
                size="sm"
                data-testid="start-run"
                className="primary-cta"
                disabled={
                  !workflow || launching || !inputs.valid || workflow.validation?.valid === false
                }
                loading={launching}
                onClick={onLaunch}
                rightSection={<IconArrowRight size={16} />}
              >
                {launching ? "Starting run…" : taskRequired ? "Run workflow" : "Start demo run"}
              </Button>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function Workbench({
  workflow,
  view,
  selectedInvocationId,
  setSelectedInvocationId,
  onControl,
  pendingAction,
  inspectorWidth,
  setInspectorWidth,
  taskLabel,
  requestedWorkspace,
}: {
  requestedWorkspace?: { tab: "session" | "review" | "milestones"; nonce: number };
  taskLabel?: string;
  workflow?: WorkflowSummary;
  view: UiRunView;
  selectedInvocationId?: string;
  setSelectedInvocationId: (id: string) => void;
  onControl: ControlAction;
  pendingAction?: string;
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
}) {
  const [scoutRequests, setScoutRequests] = useState<ScoutTimelineRequest[]>([]);
  const hasFusion = fusionGroups(view).length > 0;
  const hasMilestones = Object.values(view.bundle.definitions).some((definition) =>
    definition.nodes.some((node) => node.kind === "milestones"),
  );
  const [sessionMode, setSessionMode] = useState(() =>
    readPreference("kouro.session.mode", "fusion"),
  );
  useEffect(() => writePreference("kouro.session.mode", sessionMode), [sessionMode]);
  const [mode, setMode] = useState<"graph" | "split" | "timeline">(() => {
    const saved = readPreference("kouro.view.mode", "split");
    return saved === "graph" || saved === "timeline" ? saved : "split";
  });
  const [evidenceScope, setEvidenceScope] = useState<"invocation" | "run">("invocation");
  const [focusedEvidenceAttempt, setFocusedEvidenceAttempt] = useState<string>();
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [sessionRequest, setSessionRequest] = useState(0);
  const mobile = useMediaQuery("(max-width: 61.99em)");
  const [workspaceTab, setWorkspaceTab] = useState<string>(
    requestedWorkspace?.tab === "milestones" && !hasMilestones
      ? "workbench"
      : (requestedWorkspace?.tab ?? "workbench"),
  );
  useEffect(() => {
    if (requestedWorkspace)
      setWorkspaceTab(
        requestedWorkspace.tab === "milestones" && !hasMilestones
          ? "workbench"
          : requestedWorkspace.tab,
      );
  }, [requestedWorkspace, hasMilestones]);
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
  useEffect(() => {
    if (requestedWorkspace?.tab === "session" && sessionTarget)
      setSelectedInvocationId(sessionTarget.invocationId);
  }, [requestedWorkspace]);
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
  const inspector = (
    <Inspector
      view={view}
      scoutRequests={scoutRequests}
      graph={workflow?.graph}
      selectedId={selectedInvocationId}
      onSelect={selectInvocation}
      sessionRequest={sessionRequest}
      onControl={onControl}
      pendingAction={pendingAction}
      sessionEmbedded={workspaceTab === "session"}
      requestedAttemptId={focusedEvidenceAttempt}
      requestedTab={
        workspaceTab === "attempts"
          ? "attempts"
          : workspaceTab === "usage"
            ? "usage"
            : workspaceTab === "logs"
              ? "logs"
              : undefined
      }
    />
  );
  const selected = asArray(view.invocations).find(
    (item) => item.invocationId === selectedInvocationId,
  );
  const title = taskLabel?.split("\n")[0] || workflow?.name || workflow?.id || "Run workbench";
  const header = (
    <Group p="lg" justify="space-between" wrap="nowrap" miw={0}>
      <Text fz={{ base: 20, md: 30 }} fw={650} truncate title={title} flex={1}>
        {title}
      </Text>
      <Text visibleFrom="md" size="xs" c="dimmed">
        {workflow?.id?.toUpperCase()} {workflow?.version ? `· V${workflow.version}` : ""}
      </Text>
      <Popover position="bottom-end" withArrow>
        <Popover.Target>
          <Button size="compact-xs" variant="subtle">
            View
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack>
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(value) => setMode(value as typeof mode)}
              data={[
                { value: "split", label: "Split" },
                { value: "graph", label: "Graph" },
                { value: "timeline", label: "Timeline" },
              ]}
            />
            <Button
              size="xs"
              disabled={!sessionTarget}
              onClick={() => {
                if (!sessionTarget) return;
                setSelectedInvocationId(sessionTarget.invocationId);
                setSessionRequest((value) => value + 1);
              }}
            >
              Open agent session
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
      <Button size="xs" hiddenFrom="md" onClick={() => setMobileInspectorOpen(true)}>
        Inspector
      </Button>
    </Group>
  );
  const visual = (
    <Stack gap={0} miw={0}>
      {header}
      <Divider />
      {mobile ? (
        <Paper radius={0}>
          <Stack>
            <Title order={3}>Execution steps</Title>
            {asArray(view.invocations).map((item) => (
              <NavLink
                component="button"
                type="button"
                key={item.invocationId}
                active={item.invocationId === selectedInvocationId}
                label={item.sourceNodeId}
                description={`${item.scopeId} · ${item.state}`}
                leftSection={<StatusDot state={item.state} />}
                onClick={() => selectInvocation(item.invocationId)}
              />
            ))}
          </Stack>
        </Paper>
      ) : (
        mode !== "timeline" && (
          <GraphPanel
            graph={workflow?.graph}
            view={view}
            scoutRequests={scoutRequests}
            selectedId={selectedInvocationId}
            onSelect={selectInvocation}
          />
        )
      )}
      {mode !== "graph" && (
        <>
          <Divider />
          <Timeline
            view={view}
            scoutRequests={scoutRequests}
            selectedId={selectedInvocationId}
            onSelect={selectInvocation}
          />
        </>
      )}
    </Stack>
  );
  const belongs = (item: { invocationId?: string; attemptId?: string }) =>
    evidenceScope === "run" ||
    Boolean(selectedInvocationId && evidenceBelongsTo(view, selectedInvocationId, item));
  const evidenceArtifacts = asArray(view.artifacts).filter(
    (artifact) =>
      evidenceScope === "run" ||
      artifactIdentity(view, artifact.artifactId).owners.some(
        (owner) => owner.invocationId === selectedInvocationId,
      ),
  );
  const evidence = (
    <Stack gap="md" p="lg" miw={0}>
      <Group justify="space-between">
        <Title order={2}>
          {workspaceTab === "attempts"
            ? "Attempt history"
            : workspaceTab === "usage"
              ? "Usage & artifacts"
              : "Logs & events"}
        </Title>
        <Button size="xs" hiddenFrom="md" onClick={() => setMobileInspectorOpen(true)}>
          Inspector
        </Button>
      </Group>
      <SegmentedControl
        aria-label="Evidence scope"
        value={evidenceScope}
        onChange={(value) => setEvidenceScope(value as typeof evidenceScope)}
        data={[
          { value: "invocation", label: "Selected invocation" },
          { value: "run", label: "Whole run" },
        ]}
      />
      <InvocationPicker
        items={asArray(view.invocations)}
        selectedId={selectedInvocationId ?? ""}
        onSelect={selectInvocation}
      />
      <Text size="xs" c="dimmed">
        {evidenceScope === "run"
          ? "Showing all invocations in this run"
          : selectedInvocationId
            ? invocationLabel(view, selectedInvocationId)
            : "Select an invocation to inspect its evidence"}
      </Text>
      {workspaceTab === "usage" && (
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, xl: 6 }}>
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                USAGE BY ATTEMPT
              </Text>
              <UsagePanel items={view.usage.filter(belongs)} view={view} />
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, xl: 6 }}>
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                ARTIFACTS & PRODUCERS
              </Text>
              <ArtifactPanel artifacts={evidenceArtifacts} view={view} />
            </Stack>
          </Grid.Col>
        </Grid>
      )}
      {workspaceTab === "logs" && (
        <>
          <LogPanel items={view.logs.filter(belongs)} />
          <EventHistoryPanel
            runId={view.runId}
            invocationId={evidenceScope === "invocation" ? selectedInvocationId : undefined}
            attemptIds={
              evidenceScope === "invocation"
                ? asArray(view.attempts)
                    .filter((attempt) => attempt.invocationId === selectedInvocationId)
                    .map((attempt) => attempt.attemptId)
                : undefined
            }
          />
        </>
      )}
      {workspaceTab === "attempts" && (
        <EvidencePanel
          attempts={asArray(view.attempts).filter(belongs)}
          view={view}
          focusedAttemptId={focusedEvidenceAttempt}
          onFocus={(attemptId) => {
            setFocusedEvidenceAttempt(attemptId);
            const attempt = view.attempts[attemptId];
            if (attempt) selectInvocation(attempt.invocationId);
          }}
        />
      )}
    </Stack>
  );
  return (
    <Stack gap={0} className="workbench">
      <Tabs value={workspaceTab} onChange={(value) => setWorkspaceTab(value ?? "workbench")}>
        <Tabs.List px="lg" aria-label="Run views">
          <Tabs.Tab value="workbench">Workbench</Tabs.Tab>
          {hasMilestones && <Tabs.Tab value="milestones">Milestones</Tabs.Tab>}
          <Tabs.Tab
            value="session"
            onClick={() => {
              if (sessionTarget) setSelectedInvocationId(sessionTarget.invocationId);
            }}
          >
            Session
          </Tabs.Tab>
          <Tabs.Tab value="attempts">Attempts</Tabs.Tab>
          <Tabs.Tab value="usage">Usage & artifacts</Tabs.Tab>
          <Tabs.Tab value="logs">Logs & events</Tabs.Tab>
          <Tabs.Tab value="review">Review</Tabs.Tab>
          <Tabs.Tab value="delivery">Delivery</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {workspaceTab === "milestones" ? (
        <MilestonesPanel
          runId={view.runId}
          revision={view.revision}
          api={api}
          onOpen={(scopeId, approval) => {
            const belongs = (candidateScopeId: string) => {
              let scope = view.scopes[candidateScopeId];
              while (scope && scope.id !== scopeId && scope.parentScopeId)
                scope = view.scopes[scope.parentScopeId];
              return scope?.id === scopeId;
            };
            const candidates = Object.values(view.invocations).filter((item) =>
              belongs(item.scopeId),
            );
            const target =
              candidates.find(
                (item) =>
                  approval && item.state === "pending" && item.approval?.status === "pending",
              ) ??
              candidates.find(
                (item) =>
                  item.state === "running" &&
                  view.bundle.definitions[view.scopes[item.scopeId]!.definitionId]?.nodes.some(
                    (node) => node.id === item.sourceNodeId && node.kind === "agent",
                  ),
              ) ??
              candidates
                .filter((item) =>
                  view.bundle.definitions[view.scopes[item.scopeId]!.definitionId]?.nodes.some(
                    (node) => node.id === item.sourceNodeId && node.kind === "agent",
                  ),
                )
                .at(-1) ??
              candidates.at(-1);
            if (target) setSelectedInvocationId(target.invocationId);
            setWorkspaceTab(approval ? "review" : "session");
          }}
        />
      ) : workspaceTab === "session" ? (
        <Box p={{ base: "sm", md: "lg" }}>
          <Stack>
            {hasFusion && (
              <SegmentedControl
                aria-label="Session view"
                value={sessionMode}
                onChange={setSessionMode}
                data={[
                  { value: "single", label: "Single session" },
                  { value: "fusion", label: "Fusion split" },
                ]}
              />
            )}
            {hasFusion && sessionMode === "fusion" ? (
              <FusionSessions
                view={view}
                onControl={onControl}
                pendingAction={pendingAction}
                loadActivity={fetchActivityPage}
              />
            ) : (
              inspector
            )}
          </Stack>
        </Box>
      ) : workspaceTab === "delivery" ? (
        <Box p="lg">
          <DiffPanel runId={view.runId} revision={view.revision} showDelivery />
        </Box>
      ) : workspaceTab === "review" ? (
        <Grid gap={0}>
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Box p="lg">
              <DiffPanel
                runId={view.runId}
                revision={view.revision}
                invocationId={selectedInvocationId}
              />
            </Box>
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}>{inspector}</Grid.Col>
        </Grid>
      ) : workspaceTab === "usage" || workspaceTab === "logs" ? (
        evidence
      ) : mobile ? (
        <>
          {workspaceTab === "workbench" ? visual : evidence}
          <Drawer
            opened={mobileInspectorOpen}
            onClose={() => setMobileInspectorOpen(false)}
            title="Invocation inspector"
            position="bottom"
            size="85%"
            keepMounted
          >
            {inspector}
          </Drawer>
        </>
      ) : (
        <Splitter
          sizes={[100, `${inspectorWidth}px`]}
          onSizeChange={(sizes) => {
            const size = sizes[1];
            if (typeof size === "string" && size.endsWith("px"))
              setInspectorWidth(Math.round(parseFloat(size)));
          }}
          withHandle
          lineSize={1}
        >
          <Splitter.Pane defaultSize={100} min="40%">
            {workspaceTab === "workbench" ? visual : evidence}
          </Splitter.Pane>
          <Splitter.Pane defaultSize={`${inspectorWidth}px`} min="280px" max="560px">
            {inspector}
          </Splitter.Pane>
        </Splitter>
      )}
    </Stack>
  );
}

const nodeTypes = { work: WorkNode, scope: ScopeNode };
function WorkNode({ data, selected }: NodeProps) {
  const node = data.node as WorkflowNode;
  const state = data.state as string | undefined;
  return (
    <Paper
      p="sm"
      radius={0}
      w={176}
      mih={64}
      bg={selected ? "var(--mantine-primary-color-light)" : "var(--mantine-color-default)"}
      className={`work-node ${selected ? "selected" : ""} ${state ?? ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <Stack gap={3}>
        <Text size="sm" fw={600}>
          {node.definitionId &&
          node.definitionId !== data.rootDefinitionId &&
          node.id === "subagent"
            ? node.definitionId
            : node.id}
        </Text>
        <Text size="xs" c={stateColor(state)}>
          {state ?? "not started"}
        </Text>
      </Stack>
      <Handle type="source" position={Position.Right} />
    </Paper>
  );
}

function ScopeNode({ data }: NodeProps) {
  const scope = data.scope as GraphScope;
  const toggle = data.onToggle as ((id: string) => void) | undefined;
  return (
    <Paper
      p="xs"
      h="100%"
      bg="var(--mantine-color-default-hover)"
      className="scope-node"
      data-testid={`scope-${scope.id}`}
    >
      <Button
        type="button"
        className="scope-toggle"
        data-collapsed={scope.collapsed ? "true" : "false"}
        onClick={(event) => {
          event.stopPropagation();
          toggle?.(scope.id);
        }}
      >
        <Text component="span" size="sm">
          {scope.label}
        </Text>
        <Text component="span" size="xs" c="dimmed">
          {scope.collapsed ? "collapsed" : "scope"}
        </Text>
      </Button>
    </Paper>
  );
}

const GraphPanel = memo(function GraphPanel({
  graph,
  view,
  selectedId,
  onSelect,
  scoutRequests,
}: {
  graph?: WorkflowGraph;
  scoutRequests: ScoutTimelineRequest[];
  view: UiRunView;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const reactFlow = useReactFlow();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showOutline, setShowOutline] = useState(false);
  const graphAppearance = useComputedColorScheme("dark");
  const invocations = asArray(view.invocations);
  const runningNodeIds = useMemo(
    () =>
      new Set(
        invocations.filter((item) => item.state === "running").map((item) => item.sourceNodeId),
      ),
    [invocations],
  );
  const projection = useMemo(() => {
    const layout = layoutWorkbenchGraph(
      projectHierarchicalGraph(graph, view, collapsed),
      view.bundle.rootDefinitionId,
      showOutline,
    );
    return {
      ...layout,
      nodes: layout.nodes.map((node) => {
        if (node.type !== "work" || node.data.invocationId) return node;
        const source = node.data.node as WorkflowNode;
        const request = [...scoutRequests]
          .reverse()
          .find((request) => request.scoutId === source.definitionId);
        return request
          ? {
              ...node,
              data: {
                ...node.data,
                state: request.state,
                parentInvocationId: request.parentInvocationId,
              },
            }
          : node;
      }),
    };
  }, [graph, view, collapsed, showOutline, scoutRequests]);
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
          style: {
            stroke: edge.className?.includes("repair")
              ? "var(--mantine-color-yellow-5)"
              : "var(--mantine-color-dark-2)",
            strokeWidth: 1.5,
          },
          labelStyle: { fill: "var(--mantine-color-dimmed)", fontSize: 10 },
          labelBgStyle: { fill: "var(--mantine-color-body)", fillOpacity: 0.92 },
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
      (node.data.parentInvocationId as string | undefined) ??
      nodeInvocations.find((item) => item.invocationId === selectedId)?.invocationId ??
      invokeId(node.data.node as WorkflowNode, invocations);
    if (id) onSelect(id);
  };
  return (
    <Paper
      radius={0}
      p={0}
      withBorder={false}
      h={{ base: 390, md: "calc(100dvh - 520px)" }}
      mih={320}
      className="graph-panel"
      data-testid="workflow-graph"
    >
      <Stack gap={0} h="100%">
        <Group gap="xs" justify="space-between" wrap="wrap" className="panel-heading" p="sm">
          <Text size="sm" fw={600}>
            Execution graph
          </Text>
          <Group gap="xs">
            {breadcrumbs.length > 0 && (
              <Text
                component="span"
                size="sm"
                className="graph-breadcrumb"
                data-testid="graph-breadcrumb"
              >
                root / {breadcrumbs.join(" / ")}
              </Text>
            )}
            {(() => {
              const source = invocations.find(
                (item) => item.invocationId === selectedId,
              )?.sourceNodeId;
              const instances = projection.instances.filter((item) => item.sourceNodeId === source);
              return instances.length > 1 ? (
                <NativeSelect
                  aria-label="Invocation instance"
                  value={selectedId ?? ""}
                  onChange={(event) => onSelect(event.target.value)}
                >
                  {instances.map((item) => (
                    <option key={item.invocationId} value={item.invocationId}>
                      instance {item.ordinal} · {item.scopeId}
                    </option>
                  ))}
                </NativeSelect>
              ) : null;
            })()}
            <Button
              aria-label={showOutline ? "Hide workflow outline" : "Show workflow outline"}
              aria-expanded={showOutline}
              onClick={() => setShowOutline((value) => !value)}
            >
              Outline
            </Button>
            <Button
              aria-label="Fit graph to view"
              onClick={() => reactFlow.fitView({ duration: 500, padding: 0.25 })}
            >
              Fit
            </Button>
            <Button aria-label="Zoom graph in" onClick={() => reactFlow.zoomIn({ duration: 180 })}>
              +
            </Button>
            <Button
              aria-label="Zoom graph out"
              onClick={() => reactFlow.zoomOut({ duration: 180 })}
            >
              −
            </Button>
          </Group>
        </Group>
        <Box flex={1} mih={200} miw={0} className="graph-canvas">
          {graph?.nodes?.length ? (
            <ReactFlow
              colorMode={graphAppearance}
              style={{ backgroundColor: "var(--mantine-color-body)" }}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={handleNode}
              fitView
              minZoom={0.1}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <Stack gap="xs" className="empty-inline">
              No compiled graph returned for this workflow.
            </Stack>
          )}
        </Box>
        {showOutline && (
          <Box
            maw="100%"
            mah={400}
            style={{ overflow: "auto" }}
            className="graph-outline"
            role="region"
            aria-label="Workflow outline"
          >
            <List type="ordered">
              {[...invocations]
                .sort((a, b) => a.ordinal - b.ordinal)
                .map((invocation) => (
                  <List.Item key={invocation.invocationId}>
                    <Button
                      type="button"
                      aria-current={selectedId === invocation.invocationId ? "true" : undefined}
                      onClick={() => onSelect(invocation.invocationId)}
                    >
                      {invocation.sourceNodeId} · {invocation.state} · {invocation.scopeId}
                    </Button>
                  </List.Item>
                ))}
            </List>
            {!invocations.length && <Text size="sm">No invocations have started.</Text>}
          </Box>
        )}
      </Stack>
    </Paper>
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
        const start = isoMs(
          invocation.startedAt,
          isoMs(invocation.endedAt, isoMs(view.finishedAt, fallback)),
        );
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
    <Paper
      radius={0}
      p={0}
      withBorder={false}
      className="timeline-panel"
      ref={ref}
      data-testid="execution-timeline"
    >
      <Stack gap={0}>
        <Group gap="xs" justify="space-between" wrap="wrap" p="sm" className="panel-heading">
          <Text component="span" size="sm">
            Timeline{" "}
            <Text component="span" size="xs" c="dimmed">
              continuous wall time
            </Text>
          </Text>
          <Group gap="xs" justify="space-between" wrap="wrap" className="timeline-tools">
            <Group gap="xs" justify="space-between" wrap="wrap" className="timeline-legend">
              <Text component="span" size="sm">
                <Text component="span" size="sm" className="legend-agent" /> agent
              </Text>
              <Text component="span" size="sm">
                <Text component="span" size="sm" className="legend-command" /> command
              </Text>
              <Text component="span" size="sm">
                <Text component="span" size="sm" className="legend-subagent" /> subagent
              </Text>
            </Group>
            <Button
              data-testid="timeline-fit"
              aria-label="Fit timeline to run"
              onClick={() => setZoom(1)}
            >
              FIT
            </Button>
            <Button
              aria-label="Zoom timeline out"
              onClick={() => setZoom((value) => Math.max(1, value / 1.5))}
            >
              −
            </Button>
            <Button
              data-testid="timeline-zoom-in"
              aria-label="Zoom timeline in"
              onClick={() => setZoom((value) => Math.min(12, value * 1.5))}
            >
              +
            </Button>
          </Group>
        </Group>
        <Box
          h={180}
          style={{ overflow: "auto" }}
          className="timeline-scroll"
          ref={scrollRef}
          onScroll={(event) =>
            setViewport({
              top: event.currentTarget.scrollTop,
              height: event.currentTarget.clientHeight,
            })
          }
        >
          <Box h={graphHeight} w={canvasWidth}>
            <svg
              data-testid="timeline-canvas"
              width={canvasWidth}
              height={viewport.height}
              style={{ position: "sticky", top: 0, display: "block" }}
              className="timeline-svg"
            >
              {scale.ticks.map((tick) => (
                <g key={tick} transform={`translate(${gutter + scale.x(tick)},0)`}>
                  <line y2={viewport.height} stroke="var(--mantine-color-default-border)" />
                  <text y={18} fill="var(--mantine-color-dimmed)" fontSize={10}>
                    {scale.tickFormat(tick)}
                  </text>
                </g>
              ))}
              {hasActive && (
                <line
                  stroke="var(--mantine-color-indigo-4)"
                  strokeDasharray="4 4"
                  className="timeline-now"
                  x1={nowX}
                  x2={nowX}
                  y1={20}
                  y2={viewport.height}
                />
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
                        <text
                          fill="var(--mantine-color-text)"
                          fontSize={11}
                          className="timeline-label"
                          x={8 + depth * 14}
                          y={18}
                        >
                          {depth > 0 ? "↳ " : ""}
                          {label}
                        </text>
                        <rect
                          fill={
                            invocationId === selectedId
                              ? "var(--mantine-color-indigo-4)"
                              : state === "failed"
                                ? "var(--mantine-color-red-5)"
                                : active
                                  ? "var(--mantine-color-indigo-4)"
                                  : kind === "scout"
                                    ? "var(--mantine-color-dark-3)"
                                    : "var(--mantine-color-dark-1)"
                          }
                          stroke={
                            selectedId === invocationId ? "var(--mantine-color-text)" : "none"
                          }
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
                        <text
                          fill="var(--mantine-color-dimmed)"
                          fontSize={10}
                          className="bar-time"
                          x={Math.min(canvasWidth - 34, x + w + 6)}
                          y={16}
                        >
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
                              fill={`var(--mantine-color-${stateColor(attempt.state)}-4)`}
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
          </Box>
          {!rows.length && (
            <Stack gap="xs" className="empty-inline">
              Waiting for the first invocation…
            </Stack>
          )}
        </Box>
      </Stack>
    </Paper>
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
    <Stack gap="xs" className="invocation-picker">
      {items.length > size && (
        <Stack gap={4} component="label">
          Find invocation
          <TextInput
            aria-label="Search invocations"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </Stack>
      )}
      <Stack gap={4} component="label">
        Invocation
        <NativeSelect
          aria-label="Inspect invocation"
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
        >
          {options.map((item) => (
            <option key={item.invocationId} value={item.invocationId}>
              {item.sourceNodeId} · {item.state} · #{item.ordinal + 1}
            </option>
          ))}
        </NativeSelect>
      </Stack>
      {matches.length > size && (
        <Group gap="xs" justify="space-between" wrap="wrap" className="lane-navigation">
          <Button disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous invocations
          </Button>
          <Text component="span" size="sm">
            {current * size + 1}–{Math.min(matches.length, (current + 1) * size)} of{" "}
            {matches.length}
          </Text>
          <Button
            disabled={(current + 1) * size >= matches.length}
            onClick={() => setPage(current + 1)}
          >
            Next invocations
          </Button>
        </Group>
      )}
      {search && !matches.length && (
        <Text component="span" size="xs" c="dimmed">
          No matching invocations.
        </Text>
      )}
    </Stack>
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
  requestedTab,
  requestedAttemptId,
  sessionEmbedded = false,
}: {
  view: UiRunView;
  scoutRequests?: ScoutTimelineRequest[];
  graph?: WorkflowGraph;
  selectedId?: string;
  onSelect: (id: string) => void;
  sessionRequest: number;
  onControl: ControlAction;
  pendingAction?: string;
  requestedTab?: "attempts" | "usage" | "logs";
  requestedAttemptId?: string;
  sessionEmbedded?: boolean;
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
  useEffect(() => {
    if (requestedTab) setTab(requestedTab);
  }, [requestedTab]);
  const [activityOpen, setActivityOpen] = useState(() =>
    Boolean(new URLSearchParams(window.location.search).get("attempt")),
  );
  const [sessionSpeaker, setSessionSpeaker] = useState("all");
  const [focusedAttemptId, setFocusedAttemptId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("attempt") ?? undefined,
  );
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get("attempt");
    setFocusedAttemptId((previous) =>
      previous === linked &&
      asArray(view.attempts).some(
        (attempt) => attempt.attemptId === previous && attempt.invocationId === selectedId,
      )
        ? previous
        : undefined,
    );
  }, [selectedId]);
  useEffect(() => {
    if (requestedAttemptId && view.attempts[requestedAttemptId]?.invocationId === selectedId)
      setFocusedAttemptId(requestedAttemptId);
  }, [requestedAttemptId, selectedId]);
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
    [
      ...(invocation?.outputArtifactIds ?? []),
      ...(invocation?.evidenceArtifactIds ?? []),
      ...(invocation?.artifactIds ?? []),
      ...attempts.flatMap((attempt) => [
        ...attempt.artifactIds,
        ...(attempt.outputArtifactIds ?? []),
        ...(attempt.evidenceArtifactIds ?? []),
      ]),
    ].includes(artifact.artifactId),
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
  const session =
    latest && invocation ? (
      <AgentSessionModal
        embedded={sessionEmbedded}
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
        invocationId={invocation!.invocationId}
        attemptId={latest.attemptId}
        nodeId={node?.label ?? invocation!.sourceNodeId}
        harness={`${String(execution.harness ?? "Harness")}${execution.modelId ? ` · ${String(execution.modelId)}` : ""}`}
        events={sessionEvents}
        live={latest.state === "running"}
        steerable={canSteer}
        canStop={Boolean(view.capabilities.cancel)}
        stopPending={pendingAction === "cancel"}
        onStop={() => onControl("cancel")}
        canInterrupt={
          latest.state === "running" &&
          Boolean(view.interruptibleInvocationIds?.includes(invocation!.invocationId))
        }
        interruptPending={pendingAction === "interrupt-attempt"}
        onInterrupt={() =>
          onControl("interrupt-attempt", invocation!.invocationId, undefined, latest.attemptId)
        }
        onSteer={async (message) =>
          (await onControl("steer", invocation!.invocationId, message, latest.attemptId)) !== false
        }
        loadActivity={fetchActivityPage}
        onClose={() => setActivityOpen(false)}
      />
    ) : null;
  if (sessionEmbedded)
    return (
      <Stack gap="md">
        <InvocationPicker
          items={asArray(view.invocations)}
          selectedId={selectedId ?? ""}
          onSelect={onSelect}
        />
        {session ?? (
          <Paper>
            <Text c="dimmed" size="sm">
              Select an agent invocation with a retained attempt to view its session.
            </Text>
          </Paper>
        )}
      </Stack>
    );
  return (
    <Paper
      radius={0}
      bg="var(--mantine-color-body)"
      withBorder={false}
      miw={0}
      maw="100%"
      h={{ base: "calc(85dvh - 80px)", md: "calc(100dvh - 154px)" }}
      component="aside"
      className="inspector"
      data-testid="node-inspector"
      data-invocation-id={invocation?.invocationId}
    >
      <Stack gap="sm" h="100%" miw={0}>
        <Group gap="xs" justify="space-between" wrap="wrap" className="inspector-header">
          <Text component="span" size="sm">
            INSPECTOR
          </Text>
          <Text component="span" size="sm" className="inspector-rev">
            r{view.revision}
          </Text>
        </Group>

        {invocation ? (
          <>
            <Stack gap={4}>
              <Title order={2}>{invocation.sourceNodeId}</Title>
              <Text size="xs" c={stateColor(invocation.state)}>
                {invocation.state} · attempt {latest ? latest.ordinal + 1 : "—"} ·{" "}
                {String(execution.harness ?? node?.kind ?? "unknown")}
              </Text>
            </Stack>
            <NativeSelect
              aria-label="Inspect invocation"
              value={selectedId ?? ""}
              onChange={(event) => onSelect(event.currentTarget.value)}
              data={asArray(view.invocations).map((item) => ({
                value: item.invocationId,
                label: `${item.sourceNodeId} · ${item.state} · #${item.ordinal + 1}`,
              }))}
            />
            {node?.kind === "agent" && attempts.length > 0 && (
              <Stack gap="xs" className="session-launch-row">
                <Button
                  variant="filled"
                  className="open-agent-session"
                  onClick={() => {
                    setSessionSpeaker("all");
                    setActivityOpen(true);
                  }}
                  type="button"
                >
                  {view.state === "running" &&
                  invocation.state === "running" &&
                  latest?.state === "running"
                    ? "Watch agent live"
                    : "View agent session"}
                </Button>
              </Stack>
            )}
            <Tabs value={tab} onChange={(value) => setTab(value as typeof tab)}>
              <Tabs.List>
                {tabs.map((name) => (
                  <Tabs.Tab px="xs" key={name} value={name}>
                    {name.charAt(0).toUpperCase() + name.slice(1)}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs>
            <ScrollArea flex={1} mih={0} miw={0} scrollbars="y" type="auto" offsetScrollbars="y">
              <Stack gap="sm" miw={0}>
                <Disclosure>
                  <DisclosureTitle>Invocation & attempt details</DisclosureTitle>{" "}
                  {latest && (
                    <Stack gap="xs" className="session-identity">
                      {String(execution.harness ?? node?.kind ?? "")}
                      {execution.modelId ? ` · ${String(execution.modelId)}` : ""} · attempt{" "}
                      {latest.ordinal + 1}
                      {latest.error && (
                        <Text size="sm" className="session-error">
                          {latest.error}
                        </Text>
                      )}
                    </Stack>
                  )}
                  <SimpleGrid cols={2} spacing="xs" className="detail-grid">
                    <Text component="span" size="sm">
                      INVOCATION
                    </Text>
                    <Text component="span" size="sm" fw={600} data-testid="selected-invocation">
                      {invocation.invocationId.slice(0, 18)}
                    </Text>
                    <Text component="span" size="sm">
                      STATE
                    </Text>
                    <Text
                      component="span"
                      size="sm"
                      fw={600}
                      className={`text-${invocation.state}`}
                    >
                      {invocation.state}
                    </Text>
                    <Text component="span" size="sm">
                      ATTEMPTS
                    </Text>
                    <Text component="span" size="sm" fw={600}>
                      {attempts.length || "—"}
                    </Text>
                  </SimpleGrid>
                </Disclosure>
                <LifecycleNotice invocation={invocation} view={view} />
                {selectedScouts.length > 0 && (
                  <Stack
                    gap="xs"
                    component="section"
                    className="scout-activity"
                    aria-label="Subagent activity"
                  >
                    <Stack gap="xs" className="section-label">
                      SUBAGENTS
                    </Stack>
                    {selectedScouts.map((scout) => (
                      <Disclosure key={`${scout.parentAttemptId}:${scout.requestId}`}>
                        <DisclosureTitle>
                          <Text component="span" size="sm" fw={600}>
                            {scout.scoutId}
                          </Text>
                          <Text component="span" size="sm" className={`scout-state ${scout.state}`}>
                            {scout.state}
                          </Text>
                          {scout.modelId && (
                            <Text component="span" size="xs" c="dimmed">
                              {scout.modelId}
                            </Text>
                          )}
                        </DisclosureTitle>
                        {scout.question && <Text size="sm">{scout.question}</Text>}
                        <Text component="span" size="xs" c="dimmed">
                          {scout.effectiveHarness ?? "Host default"} · {scout.requestId}
                        </Text>
                        {scout.result !== undefined && <ActivityValue value={scout.result} />}
                        {scout.error && (
                          <Text size="sm" className="session-error">
                            {scout.error}
                          </Text>
                        )}
                        <Button
                          className="subtle-button"
                          onClick={() => {
                            setSessionSpeaker(scout.scoutId);
                            setActivityOpen(true);
                          }}
                        >
                          View subagent activity
                        </Button>
                      </Disclosure>
                    ))}
                  </Stack>
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
                    <Button
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
                    </Button>
                  )}
                {invocation.state === "failed" &&
                  view.capabilities.retry === true &&
                  (view.retryableInvocationIds?.includes(invocation.invocationId) ?? true) && (
                    <Paper
                      component="section"
                      className="invocation-recovery"
                      aria-label="Failed invocation recovery"
                    >
                      <Stack gap="md">
                        <Text size="sm">
                          This invocation ended in failure. Retry starts another attempt for this
                          invocation.
                        </Text>
                        <Button
                          className="control-button"
                          disabled={pendingAction !== undefined}
                          onClick={() => onControl("retry", invocation.invocationId)}
                        >
                          {pendingAction === "retry" ? "Retrying…" : "Retry invocation"}
                        </Button>
                      </Stack>
                    </Paper>
                  )}

                <Stack gap="xs" className="inspector-content">
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
                  {tab === "usage" && <UsagePanel items={usage} view={view} />}
                  {tab === "artifacts" && (
                    <ArtifactPanel artifacts={selectedArtifacts} view={view} />
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
                  {tab === "events" && (
                    <EventHistoryPanel
                      runId={view.runId}
                      invocationId={selectedId}
                      attemptIds={attempts.map((attempt) => attempt.attemptId)}
                    />
                  )}
                </Stack>
              </Stack>
            </ScrollArea>
            {activityOpen && session && createPortal(session, document.body)}
          </>
        ) : (
          <Stack gap="xs" className="inspector-empty">
            <Text component="span" size="sm">
              ⌁
            </Text>
            <Text component="span" size="sm" fw={600}>
              Select an invocation
            </Text>
            <Text size="sm">Graph and timeline selection stay linked to this panel.</Text>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

function ContextPanel({ items }: { items: ContextSegment[] }) {
  return (
    <Stack gap="xs" className="evidence-panel">
      {items.length ? (
        items.map((item) => (
          <Stack gap="xs" className="evidence-card" key={item.id}>
            <Stack gap="xs">
              <Text component="span" size="sm" fw={600}>
                {item.source}
              </Text>
              <Text component="span" size="sm">
                {item.availability}
              </Text>
            </Stack>
            <Text size="sm">
              {item.reason ?? item.detail ?? "No reason recorded."}
              {item.tokenEstimate === undefined
                ? " · tokens unavailable"
                : ` · ~${item.tokenEstimate} tokens`}
            </Text>
          </Stack>
        ))
      ) : (
        <Stack gap="xs" className="pending-copy">
          Context manifest unavailable from this harness.
        </Stack>
      )}
    </Stack>
  );
}
function ToolPanel({ items }: { items: ToolCallView[] }) {
  return (
    <Stack gap="xs" className="evidence-panel">
      {items.length ? (
        items.map((item) => <ToolActivity key={item.id} tool={item} />)
      ) : (
        <Stack gap="xs" className="pending-copy">
          No declared tool calls for this attempt.
        </Stack>
      )}
    </Stack>
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
    <Stack gap="xs" className="log-panel">
      <Group gap="xs" justify="space-between" wrap="wrap" className="log-toolbar">
        <Stack gap={4} component="label">
          Search logs{" "}
          <TextInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Stack>
        <Button type="button" aria-pressed={follow} onClick={() => setFollow((value) => !value)}>
          {follow ? "Following" : "Follow logs"}
        </Button>
      </Group>
      <Stack
        gap="xs"
        mah={420}
        miw={0}
        style={{ overflowY: "auto" }}
        className="evidence-panel log-results"
        ref={listRef}
        role="log"
        aria-live={follow ? "polite" : "off"}
      >
        {visible.length ? (
          visible.map((item) => (
            <Stack gap="xs" className="log-line" key={item.id}>
              <Text component="span" size="sm">
                {item.level}
              </Text>
              <ActivityValue value={item.message} />
            </Stack>
          ))
        ) : (
          <Stack gap="xs" className="pending-copy">
            {items.length ? "No logs match the search." : "No readable logs were published."}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}
function UsagePanel({ items, view }: { items: UsageView[]; view?: UiRunView }) {
  const [billing, setBilling] = useState(() =>
    readPreference("kouro.usage.billing", "subscription"),
  );
  return (
    <Stack gap="sm" miw={0}>
      <NativeSelect
        label="Billing context"
        value={billing}
        onChange={(event) => {
          setBilling(event.currentTarget.value);
          writePreference("kouro.usage.billing", event.currentTarget.value);
        }}
        data={[
          { value: "subscription", label: "Subscription" },
          { value: "api", label: "API / pay as you go" },
          { value: "unknown", label: "Unknown" },
        ]}
      />
      <Text size="xs" c="dimmed">
        {billing === "subscription"
          ? "Your subscription is billed for the plan. Tokens below measure usage; a provider cost figure is not a per-run subscription charge. Extra usage or credits are not reported here."
          : "Cost figures below are reported by the provider. Your provider invoice remains the billing source."}
      </Text>
      {!items.length && (
        <Text size="sm" c="dimmed">
          This invocation has no reported usage telemetry.
        </Text>
      )}
      {items.map((item, index) => (
        <Paper key={`${item.attemptId ?? "run"}-${index}`} p="sm" miw={0}>
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              {view
                ? invocationLabel(view, item.invocationId, item.attemptId)
                : (item.attemptId ?? item.invocationId ?? "Run-level usage")}
            </Text>
            <Group justify="space-between">
              <Text size="sm" fw={600}>
                {item.totalTokens === undefined
                  ? "Tokens not reported"
                  : `${item.totalTokens.toLocaleString()} tokens`}
              </Text>
              <Badge variant="light" color={item.completeness === "complete" ? "teal" : "gray"}>
                {item.completeness}
              </Badge>
            </Group>
            {(item.inputTokens !== undefined || item.outputTokens !== undefined) && (
              <Text size="xs" c="dimmed">
                Input {item.inputTokens?.toLocaleString() ?? "not reported"} · output{" "}
                {item.outputTokens?.toLocaleString() ?? "not reported"}
                {item.estimated ? " · estimated" : ""}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {item.cost === undefined
                ? billing === "subscription"
                  ? "Per-run subscription charge is not reported"
                  : "Provider cost is not reported"
                : `Provider-reported value: ${item.currency ?? ""}${item.cost}${billing === "subscription" ? " · not your subscription bill" : ""}`}
            </Text>
            {item.detail && (
              <Text size="xs" c="dimmed">
                {item.detail}
              </Text>
            )}
            {item.attemptId && (
              <Text size="xs" c="dimmed">
                {item.attemptId}
              </Text>
            )}
          </Stack>
        </Paper>
      ))}
      <Disclosure>
        <DisclosureTitle>How subscription estimates work</DisclosureTitle>
        <Text size="sm">
          An API-equivalent estimate needs the exact model, billable input, output and cache token
          counts, and the provider’s rates. It is a comparison value. Allocating a monthly
          subscription fee to this run would also require usage across the entire billing period,
          including other apps. Kouro does not receive that billing history, so it cannot calculate
          an actual subscription cost per run.
        </Text>
      </Disclosure>
    </Stack>
  );
}
function DiagnosticPanel({ items }: { items: DiagnosticView[] }) {
  return (
    <Stack gap="xs" className="evidence-panel">
      {items.length ? (
        items.map((item) => (
          <Stack gap="xs" className="evidence-card" key={item.id}>
            <Stack gap="xs">
              <Text component="span" size="sm" fw={600}>
                {item.severity}
              </Text>
            </Stack>
            <Text size="sm">{item.message}</Text>
            {item.detail && <Code>{item.detail}</Code>}
          </Stack>
        ))
      ) : (
        <Stack gap="xs" className="pending-copy">
          No warnings or errors recorded for this invocation. Open Agent session for live messages,
          thinking and tool activity.
        </Stack>
      )}
    </Stack>
  );
}

function LifecycleNotice({ invocation, view }: { invocation: UiInvocation; view: UiRunView }) {
  if (invocation.state === "running" && view.state !== "running")
    return (
      <Alert color="yellow" className="stale-action" role="alert">
        This invocation is not live in the current run revision. Refresh before acting.
      </Alert>
    );
  if (invocation.state === "failed" && invocation.error)
    return (
      <Alert color="red" className="stale-action failure" role="status">
        Last attempt failed: {invocation.error}
      </Alert>
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
    <Paper
      component="section"
      className="approval-card"
      data-testid="approval-panel"
      aria-labelledby="approval-heading"
    >
      <Stack gap="md">
        <Group gap="xs" justify="space-between" wrap="wrap" className="approval-heading">
          <Text component="span" size="sm" fw={600} id="approval-heading">
            Human approval
          </Text>
          <Text component="span" size="sm">
            {invocation.approval?.status ?? invocation.state}
          </Text>
        </Group>
        <Text size="sm">
          {pending
            ? "This gate is waiting for an operator decision. The request is durable; no optimistic transition is shown."
            : "Decision recorded in the execution journal."}
        </Text>
        {invocation.approval?.feedback && (
          <Text size="sm" className="approval-feedback">
            {invocation.approval.feedback}
          </Text>
        )}
        {pending && (invocation.approval?.repairsRemaining ?? 0) > 0 && (
          <Stack gap={4} component="label" className="task-input">
            <Text component="span" size="sm">
              Changes to request · {invocation.approval?.repairsRemaining} repairs remaining
            </Text>
            <Textarea
              aria-label="Requested changes"
              value={feedback}
              maxLength={20000}
              onChange={(event) => setFeedback(event.target.value)}
              rows={3}
              placeholder="Describe what the agent should change before another review…"
            />
          </Stack>
        )}
        {pending && (
          <Group gap="xs" justify="space-between" wrap="wrap" className="approval-actions">
            {(invocation.approval?.repairsRemaining ?? 0) > 0 && (
              <Button
                className="control-button"
                disabled={pendingAction !== undefined || !feedback.trim()}
                onClick={async () => {
                  if (
                    (await onControl("request-changes", invocation.invocationId, feedback)) !==
                    false
                  )
                    setFeedback("");
                }}
              >
                {" "}
                {pendingAction === "request-changes" ? "Requesting changes…" : "Request changes"}
              </Button>
            )}
            <Button
              data-testid="approve-run"
              color="teal"
              variant="light"
              className="control-button approve"
              disabled={pendingAction !== undefined || view.capabilities.approve !== true}
              onClick={() => onControl("approve", invocation.invocationId)}
            >
              {pendingAction === "approve" ? "Approve…" : "Approve"}
            </Button>
            <Button
              data-testid="reject-run"
              color="red"
              variant="light"
              className="control-button danger"
              disabled={pendingAction !== undefined || view.capabilities.reject !== true}
              onClick={() => onControl("reject", invocation.invocationId)}
            >
              {pendingAction === "reject" ? "Reject…" : "Reject"}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function patchPreview(patch: string, path?: string): string {
  let value = patch || "(empty diff)";
  if (path) {
    const chunks = patch.split(/(?=^diff --git )/m);
    value =
      chunks
        .filter(
          (chunk) =>
            chunk.startsWith(`diff --git a/${path} b/${path}\n`) ||
            chunk.includes(`\n+++ b/${path}\n`) ||
            chunk.includes(`\n--- a/${path}\n`) ||
            chunk.startsWith(
              `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n`,
            ),
        )
        .join("") ||
      "A file-specific text preview is unavailable for this Git path. Choose All files or open the complete Git diff.";
  }
  return value.length > 250000
    ? `${value.slice(0, 250000)}\n… preview truncated; open the complete Git diff for the full patch.`
    : value;
}

function DiffPanel({
  runId,
  revision,
  showDelivery = false,
  invocationId,
}: {
  runId: string;
  revision: number;
  showDelivery?: boolean;
  invocationId?: string;
}) {
  const diffUrl = `/api/runs/${encodeURIComponent(runId)}/diff${invocationId ? `?invocationId=${encodeURIComponent(invocationId)}` : ""}`;
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
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
    setSelectedPath(undefined);
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
    void api<unknown>(diffUrl)
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
  }, [diffUrl, revision, refreshNonce]);
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
    <Stack gap="xs" className="diff-panel" data-testid="diff-panel">
      <Stack gap="xs" className="section-label">
        {showDelivery ? "LOCAL DELIVERY" : "WORKTREE DIFF"}{" "}
        <Text component="span" size="sm">
          authoritative
        </Text>
        <Button type="button" onClick={refresh}>
          Refresh reviewed diff
        </Button>
      </Stack>
      <Text size="sm" className="pending-copy">
        The diff is read from the run worktree, not inferred from agent output.
      </Text>
      <Anchor className="diff-link" href={diffUrl} target="_blank" rel="noreferrer">
        Open complete Git diff ↗
      </Anchor>
      {state.kind === "loading" && (
        <Stack gap="xs" className="diff-placeholder">
          Loading authoritative workspace state…
        </Stack>
      )}
      {state.kind === "none" && (
        <Stack gap="xs" className="diff-placeholder" data-testid="diff-no-workspace">
          {state.message}
        </Stack>
      )}
      {state.kind === "error" && (
        <Stack gap="xs" className="diff-placeholder diff-error" role="alert">
          {state.message}
        </Stack>
      )}
      {state.kind === "snapshot" && (
        <>
          <Stack gap="xs" className="diff-summary" data-testid="diff-summary">
            <Text component="span" size="sm" fw={600}>
              {state.changedPaths.length
                ? `${state.changedPaths.length} changed path${state.changedPaths.length === 1 ? "" : "s"}`
                : "No changed paths"}
            </Text>
            <Text component="span" size="sm">
              patch {state.patchDigest.slice(0, 12)}
            </Text>
          </Stack>
          {showDelivery ? (
            <Grid gap="lg">
              <Grid.Col span={{ base: 12, lg: 5 }}>
                <Paper>
                  <Stack gap="md">
                    <Title order={3}>Local delivery</Title>
                    <Stepper
                      size="xs"
                      active={
                        delivery.kind === "action"
                          ? delivery.status === "committed"
                            ? 3
                            : delivery.status === "approved"
                              ? 2
                              : 1
                          : 0
                      }
                      allowNextStepsSelect={false}
                    >
                      <Stepper.Step label="Prepare" description="Exact tree & message" />
                      <Stepper.Step label="Approve" description="Durable decision" />
                      <Stepper.Step label="Commit" description="Local repository effect" />
                      <Stepper.Completed>
                        <Text size="sm" c="teal">
                          Approved tree committed.
                        </Text>
                      </Stepper.Completed>
                    </Stepper>
                    <Stack gap="md" className="delivery-actions" data-testid="delivery-actions">
                      <Stack gap="xs" className="section-label">
                        DELIVERY{" "}
                        <Text component="span" size="sm">
                          {delivery.kind === "action" ? delivery.status : "pending"}
                        </Text>
                      </Stack>
                      <Text size="sm" className="pending-copy">
                        Prepare this exact tree for a durable approval before the local commit
                        effect.
                      </Text>
                      <Stack gap={4} component="label" className="task-input">
                        <Text component="span" size="sm">
                          Commit message
                        </Text>
                        <Textarea
                          aria-label="Commit message"
                          rows={2}
                          maxLength={4000}
                          value={commitMessage}
                          disabled={delivery.kind !== "idle" && delivery.kind !== "error"}
                          onChange={(event) => setCommitMessage(event.target.value)}
                        />
                      </Stack>
                      {delivery.kind === "idle" && (
                        <Button
                          color="teal"
                          variant="light"
                          className="control-button approve"
                          disabled={!commitMessage.trim()}
                          onClick={() => void prepare()}
                        >
                          Prepare delivery
                        </Button>
                      )}
                      {delivery.kind === "working" && (
                        <Stack gap="xs" className="diff-placeholder">
                          Updating delivery action…
                        </Stack>
                      )}
                      {delivery.kind === "error" && (
                        <Stack gap="xs" className="diff-placeholder diff-error">
                          {delivery.message}
                        </Stack>
                      )}
                      {delivery.kind === "action" && delivery.status === "pending" && (
                        <Group
                          gap="xs"
                          justify="space-between"
                          wrap="wrap"
                          className="approval-actions"
                        >
                          <Button
                            color="teal"
                            variant="light"
                            className="control-button approve"
                            onClick={() => void decide("approved")}
                          >
                            Approve delivery
                          </Button>
                          <Button
                            color="red"
                            variant="light"
                            className="control-button danger"
                            onClick={() => void decide("rejected")}
                          >
                            Reject delivery
                          </Button>
                        </Group>
                      )}
                      {delivery.kind === "action" && delivery.status === "approved" && (
                        <Button
                          color="teal"
                          variant="light"
                          className="control-button approve"
                          onClick={() => void commit()}
                        >
                          Commit approved tree
                        </Button>
                      )}
                      {delivery.kind === "action" && delivery.status === "committed" && (
                        <Stack gap="xs" className="diff-placeholder">
                          Delivery committed.
                        </Stack>
                      )}
                    </Stack>
                  </Stack>
                </Paper>
              </Grid.Col>
              <Grid.Col span={{ base: 12, lg: 7 }}>
                {" "}
                <Grid gap="md">
                  <Grid.Col span={{ base: 12, lg: 4 }}>
                    <Stack gap="sm">
                      <Title order={3}>Changed files</Title>
                      <ScrollArea.Autosize mah={460}>
                        <Stack gap={2}>
                          <NavLink
                            active={!selectedPath}
                            label="All files"
                            description={`${state.changedPaths.length} changed paths`}
                            onClick={() => setSelectedPath(undefined)}
                          />
                          {state.changedPaths.map((item) => (
                            <NavLink
                              key={`${item.status}:${item.path}`}
                              active={selectedPath === item.path}
                              label={item.path}
                              description={`${item.status}${item.binary ? " · binary" : ""}`}
                              onClick={() => setSelectedPath(item.path)}
                            />
                          ))}
                        </Stack>
                      </ScrollArea.Autosize>
                    </Stack>
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, lg: 8 }}>
                    <Stack gap="sm">
                      <Group justify="space-between">
                        <Title order={3}>{selectedPath ?? "Complete patch"}</Title>
                        <Badge variant="light">Git worktree</Badge>
                      </Group>
                      <Code
                        block
                        mah={460}
                        style={{ overflow: "auto" }}
                        className="diff-content"
                        data-testid="diff-content"
                      >
                        {patchPreview(state.patch, selectedPath)
                          .split("\n")
                          .map((line, index) => (
                            <Text
                              key={index}
                              component="span"
                              display="block"
                              ff="monospace"
                              size="xs"
                              c={
                                line.startsWith("+") && !line.startsWith("+++")
                                  ? "teal"
                                  : line.startsWith("-") && !line.startsWith("---")
                                    ? "red"
                                    : line.startsWith("@@")
                                      ? "indigo"
                                      : undefined
                              }
                            >
                              {line || " "}
                            </Text>
                          ))}
                      </Code>
                      {selectedPath &&
                        state.changedPaths.find((item) => item.path === selectedPath)?.binary && (
                          <Alert color="yellow">
                            This file is binary. Git reports the change without a textual patch.
                          </Alert>
                        )}
                    </Stack>
                  </Grid.Col>
                </Grid>
              </Grid.Col>
            </Grid>
          ) : (
            <Grid gap="md">
              <Grid.Col span={{ base: 12, lg: 4 }}>
                <Stack gap="sm">
                  <Title order={3}>Changed files</Title>
                  <ScrollArea.Autosize mah={460}>
                    <Stack gap={2}>
                      <NavLink
                        active={!selectedPath}
                        label="All files"
                        description={`${state.changedPaths.length} changed paths`}
                        onClick={() => setSelectedPath(undefined)}
                      />
                      {state.changedPaths.map((item) => (
                        <NavLink
                          key={`${item.status}:${item.path}`}
                          active={selectedPath === item.path}
                          label={item.path}
                          description={`${item.status}${item.binary ? " · binary" : ""}`}
                          onClick={() => setSelectedPath(item.path)}
                        />
                      ))}
                    </Stack>
                  </ScrollArea.Autosize>
                </Stack>
              </Grid.Col>
              <Grid.Col span={{ base: 12, lg: 8 }}>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Title order={3}>{selectedPath ?? "Complete patch"}</Title>
                    <Badge variant="light">Git worktree</Badge>
                  </Group>
                  <Code
                    block
                    mah={460}
                    style={{ overflow: "auto" }}
                    className="diff-content"
                    data-testid="diff-content"
                  >
                    {patchPreview(state.patch, selectedPath)
                      .split("\n")
                      .map((line, index) => (
                        <Text
                          key={index}
                          component="span"
                          display="block"
                          ff="monospace"
                          size="xs"
                          c={
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "teal"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "red"
                                : line.startsWith("@@")
                                  ? "indigo"
                                  : undefined
                          }
                        >
                          {line || " "}
                        </Text>
                      ))}
                  </Code>
                  {selectedPath &&
                    state.changedPaths.find((item) => item.path === selectedPath)?.binary && (
                      <Alert color="yellow">
                        This file is binary. Git reports the change without a textual patch.
                      </Alert>
                    )}
                </Stack>
              </Grid.Col>
            </Grid>
          )}
        </>
      )}
    </Stack>
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
  const activityEntries = projectSession(
    liveActivity.flatMap((item) =>
      item.event && typeof item.event === "object" && !Array.isArray(item.event)
        ? [{ ...item, event: item.event as Record<string, unknown> }]
        : [],
    ),
  );
  const liveText = activityEntries
    .filter((entry) => entry.kind === "message" && entry.channel === undefined)
    .map((entry) =>
      entry.kind === "message" ? `${entry.scoutId ? `[${entry.scoutId}]: ` : ""}${entry.text}` : "",
    )
    .join("\n\n");
  const activityLabels = activityEntries
    .filter((entry) => entry.kind !== "message" || entry.channel === "thinking")
    .map((entry) => {
      const speaker = entry.scoutId ? `${entry.scoutId} · ` : "";
      if (entry.kind === "tool") return `${speaker}${entry.name} · ${entry.status}`;
      if (entry.kind === "status") return `${speaker}${entry.message}`;
      return `${speaker}${entry.text.slice(0, 160)}`;
    });
  const [steeringText, setSteeringText] = useState("");
  return (
    <Stack gap="xs" className="output-panel">
      {(invocation.state === "running" || liveActivity.length > 0) && (
        <Stack gap="xs" component="section" className="live-agent-activity" aria-live="polite">
          <Stack gap="xs" className="section-label">
            AGENT ACTIVITY{" "}
            <Text component="span" size="sm">
              {invocation.state === "running" ? "live" : "captured"}
            </Text>
          </Stack>
          <Text size="sm">{activityLabels.at(-1) ?? "Thinking"}</Text>
          {activityLabels.length > 1 && (
            <List>
              {activityLabels.slice(-8).map((label, index) => (
                <List.Item key={`${index}:${label}`}>{label}</List.Item>
              ))}
            </List>
          )}
          {liveText && (
            <Code block mah={380} style={{ overflow: "auto" }} className="live-agent-reply">
              {liveText}
            </Code>
          )}
          {steerable ? (
            <Stack
              gap="xs"
              component="form"
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
              <Textarea
                minRows={3}
                autosize
                maxRows={12}
                aria-label="Steer active agent"
                placeholder="Send an instruction to the active agent"
                value={steeringText}
                onChange={(event) => setSteeringText(event.target.value)}
                maxLength={4000}
              />
              <Button type="submit" disabled={!steeringText.trim() || Boolean(pendingAction)}>
                Steer agent
              </Button>
            </Stack>
          ) : (
            <Text component="span" size="xs" c="dimmed">
              This harness accepts input after its current turn.
            </Text>
          )}
        </Stack>
      )}
      <Stack gap="xs" className="section-label">
        STRUCTURED OUTPUT{" "}
        <Text component="span" size="sm">
          {captured ? "captured" : "none"}
        </Text>
      </Stack>
      {captured ? (
        Array.isArray(output) &&
        output.every((item) => item && typeof item === "object" && "id" in item) ? (
          <ArtifactPanel artifacts={output as ArtifactView[]} initiallyOpen />
        ) : (
          <Code block mah={380} style={{ overflow: "auto" }}>
            {JSON.stringify(output, null, 2)}
          </Code>
        )
      ) : (
        <Stack gap="xs" className="pending-copy">
          {invocation.state === "running"
            ? "No typed output has been published yet."
            : "No structured output was published for this invocation."}
        </Stack>
      )}
      <Stack gap="xs" className="section-label command-label">
        NODE{" "}
        <Text component="span" size="sm">
          {invocation.sourceNodeId}
        </Text>
      </Stack>
      {attempt?.command?.stderrArtifactId && (
        <ArtifactContent artifactId={attempt.command.stderrArtifactId} />
      )}
    </Stack>
  );
}
function EvidencePanel({
  attempts,
  focusedAttemptId,
  onFocus,
  view,
}: {
  view?: UiRunView;
  attempts: UiAttempt[];
  focusedAttemptId?: string;
  onFocus: (attemptId: string) => void;
}) {
  return (
    <Stack gap="xs" className="evidence-panel">
      {attempts.length ? (
        attempts.map((attempt) => (
          <Paper
            p="sm"
            className={`evidence-card attempt-card ${focusedAttemptId === attempt.attemptId ? "focused" : ""}`}
            key={attempt.attemptId}
            aria-label={`Inspect attempt ${attempt.ordinal + 1}`}
          >
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" fw={600}>
                  {view
                    ? invocationLabel(view, attempt.invocationId, attempt.attemptId)
                    : `Attempt ${attempt.ordinal + 1}`}
                </Text>
                <Button size="xs" onClick={() => onFocus(attempt.attemptId)}>
                  Inspect attempt {attempt.ordinal + 1}
                </Button>
              </Group>
              <StatusDot state={attempt.state} />
              <Text component="span" size="sm" fw={600}>
                attempt {attempt.ordinal + 1}
              </Text>
              <Text component="span" size="sm">
                {attempt.state}
              </Text>
              <Text size="xs" c="dimmed">
                {attempt.attemptId}
              </Text>
            </Stack>
            <Text component="span" size="xs" c="dimmed" className="repair-label">
              {attempt.ordinal > 0 ? "additional attempt" : "initial attempt"}
            </Text>
            {attempt.command && (
              <Code>
                {attempt.command.executable} {(attempt.command.args ?? []).join(" ")}
              </Code>
            )}
            {attempt.command?.executionMode === "trusted-unrestricted" && (
              <Text component="span" size="xs" c="dimmed">
                TRUSTED UNRESTRICTED COMMAND
              </Text>
            )}
            {attempt.result && (
              <Text size="sm">
                exit {attempt.result.exitCode ?? "—"} · {attempt.result.status ?? attempt.state}
              </Text>
            )}
          </Paper>
        ))
      ) : (
        <Stack gap="xs" className="pending-copy">
          No attempt evidence yet.
        </Stack>
      )}
    </Stack>
  );
}
function EventHistoryPanel({
  runId,
  invocationId,
  attemptIds,
}: {
  runId: string;
  invocationId?: string;
  attemptIds?: string[];
}) {
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
  const visible = events.filter((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const matchesScope =
      attemptIds === undefined ||
      payload.invocationId === invocationId ||
      (typeof payload.attemptId === "string" && attemptIds.includes(payload.attemptId));
    return matchesScope && (!term || JSON.stringify(event).toLocaleLowerCase().includes(term));
  });
  return (
    <Stack gap="xs" className="event-history-panel">
      <Group gap="xs" justify="space-between" wrap="wrap" className="event-history-controls">
        <TextInput
          aria-label="Filter run events"
          placeholder="Filter event type or payload"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Text component="span" size="sm">
          {visible.length} shown
        </Text>
      </Group>
      {error && (
        <Text size="sm" className="notice error" role="alert">
          {error} <Button onClick={() => void loadPage(cursor, events.length === 0)}>Retry</Button>
        </Text>
      )}
      {visible.map((event, index) => (
        <Disclosure
          className="event-history-row"
          key={`${String(event.sequence ?? index)}:${String(event.eventId ?? "")}`}
        >
          <DisclosureTitle>
            <Text component="span" size="sm">
              r{String(event.sequence ?? "?")}
            </Text>
            <Text component="span" size="sm" fw={600}>
              {String(event.type ?? "unknown event")}
            </Text>
            <Text component="span" size="xs" c="dimmed">
              {String(event.recordedAt ?? "")}
            </Text>
          </DisclosureTitle>
          <Group gap="xs" justify="space-between" wrap="wrap" className="event-history-meta">
            {String(event.actor ?? "system")}
            {event.causationId ? ` · caused by ${String(event.causationId)}` : ""}
          </Group>
          <Code block mah={380} style={{ overflow: "auto" }}>
            {boundedActivity(event.payload)}
          </Code>
        </Disclosure>
      ))}
      {hasMore && (
        <Button
          className="older-runs-button"
          disabled={loading}
          onClick={() => void loadPage(cursor, false)}
        >
          {loading ? "Loading…" : "Load more journal events"}
        </Button>
      )}
      {!visible.length && !loading && !error && (
        <Text size="sm" c="dimmed">
          {attemptIds === undefined
            ? "No matching journal events."
            : "No matching events for this invocation in the loaded history."}
        </Text>
      )}
    </Stack>
  );
}

function ArtifactPanel({
  artifacts,
  initiallyOpen = false,
  view,
}: {
  view?: UiRunView;
  artifacts: Array<ArtifactView | { artifactId: string; contentType?: string }>;
  initiallyOpen?: boolean;
}) {
  return (
    <Stack gap="xs" className="artifact-panel">
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
            <ArtifactRow
              key={id}
              id={id}
              mediaType={mediaType}
              initiallyOpen={initiallyOpen}
              identity={view ? artifactIdentity(view, id) : undefined}
            />
          );
        })
      ) : (
        <Stack gap="xs" className="pending-copy">
          No artifacts attached.
        </Stack>
      )}
    </Stack>
  );
}

function ArtifactRow({
  id,
  mediaType,
  initiallyOpen,
  identity,
}: {
  identity?: ReturnType<typeof artifactIdentity>;
  id: string;
  mediaType?: string;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <Disclosure className="artifact-row" open={open} onToggle={setOpen}>
      <DisclosureTitle>
        <Text component="span" display="block" size="sm" fw={600}>
          {identity?.name ?? "Artifact"}
        </Text>
        {identity?.owners.map((owner) => (
          <Text
            component="span"
            display="block"
            key={`${owner.invocationId}:${owner.attemptId ?? ""}`}
            size="xs"
            c="dimmed"
          >
            {owner.label}
          </Text>
        ))}
        <Text component="span" display="block" size="xs" c="dimmed">
          {id} · {mediaType ?? "media type not reported"}
        </Text>
      </DisclosureTitle>
      {open && <ArtifactContent artifactId={id} />}
    </Disclosure>
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
    <Stack gap="xs" component="section" className="artifact-preview">
      <Anchor
        href={`/api/artifacts/${encodeURIComponent(artifactId)}/content`}
        target="_blank"
        rel="noreferrer"
      >
        Open full artifact
      </Anchor>
      {error ? (
        <Text size="sm" role="alert">
          {error} <Button onClick={() => setRetry((value) => value + 1)}>Retry</Button>
        </Text>
      ) : content === undefined ? (
        <Text size="sm">Loading artifact…</Text>
      ) : mediaType.includes("markdown") ? (
        <SafeMarkdown text={content} />
      ) : (
        <Code block mah={380} style={{ overflow: "auto" }}>
          {content}
        </Code>
      )}
      {truncated && (
        <Text size="sm">Preview limited to 256 KiB. Open the full artifact to read the rest.</Text>
      )}
    </Stack>
  );
}

function RoleBadge({ label }: { label: string }) {
  return (
    <Text component="span" size="sm" className="role-badge">
      {label}
    </Text>
  );
}
function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000)
    return `${Math.floor(ms / 60_000)}m ${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
