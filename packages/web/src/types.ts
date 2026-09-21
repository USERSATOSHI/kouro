import type {
  ArtifactRef,
  Bundle,
  Definition,
  InvocationState,
  AttemptState,
  ProjectionFrame as CoreProjectionFrame,
  RunView as CoreRunView,
  ScopeState,
  Harness,
  RuntimeHarness,
} from "@kouro/core/contracts";

export type { CoreProjectionFrame, CoreRunView };
export type EntityMap<T> = Readonly<Record<string, T>>;
export type RunState = CoreRunView["state"]["status"];
export interface WorkflowNode {
  id: string;
  label: string;
  kind: string;
  role?: string;
  position?: { x: number; y: number };
  /** Optional M4 metadata. Older hosts may omit all of these fields. */
  scopeId?: string;
  definitionId?: string;
  parentNodeId?: string;
  harness?: Harness;
  groupId?: string;
  parallelGroupId?: string;
  joinId?: string;
}
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  definitionId?: string;
}
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups?: Array<{ id: string; label?: string; parentId?: string; definitionId?: string }>;
}
export interface WorkflowSummary {
  id: string;
  name?: string;
  version?: string;
  digest?: string;
  graph?: WorkflowGraph;
  validation?: { valid: boolean; errors?: string[] };
  bundle?: Bundle;
}
export interface RunSummary {
  id: string;
  workflowId: string;
  state: RunState | "preparing";
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  revision?: number;
  activeCount?: number;
  executionProfile?: string;
  task?: string;
  workItem?: unknown;
}
export interface ExecutionProfile {
  id: "scripted" | "codex-readonly" | "pi-readonly";
  name: string;
  description: string;
  available: boolean;
  harness: RuntimeHarness;
  model?: string;
  capabilities: Record<string, "supported" | "unsupported" | "conditional">;
  unavailableReason?: string;
}
export type ScopeView = ScopeState;
export type InvocationView = InvocationState;
export type AttemptView = AttemptState;
export type ArtifactView = ArtifactRef;
export type RunView = CoreRunView;
export type ProjectionFrame = CoreProjectionFrame;
export type SpanView = {
  spanId: string;
  invocationId?: string;
  attemptId?: string;
  kind: string;
  startUtc?: string;
  endUtc?: string;
  elapsedMs?: number;
  state?: string;
  timingSource?: string;
  precision?: string;
};
export type StoreStatus = "idle" | "connecting" | "live" | "stale" | "disconnected" | "error";
export interface UiInvocation {
  invocationId: string;
  sourceNodeId: string;
  scopeId: string;
  state: InvocationState["status"];
  ordinal: number;
  startedAt?: string;
  endedAt?: string;
  outputArtifactIds: string[];
  evidenceArtifactIds: string[];
  artifactIds: string[];
  error?: string;
  approval?: {
    status: "pending" | "approved" | "rejected";
    requestedAt?: string;
    decidedAt?: string;
  };
}
export interface UiAttempt {
  attemptId: string;
  invocationId: string;
  state: AttemptState["status"];
  ordinal: number;
  startedAt?: string;
  endedAt?: string;
  artifactIds: string[];
  output?: unknown;
  error?: string;
  command?: { executable?: string; args?: string[] };
  result?: { exitCode?: number; status?: string };
  resolvedExecution?: unknown;
  sessionRef?: unknown;
}
export interface UiArtifact {
  artifactId: string;
  kind?: string;
  name?: string;
  contentType?: string;
  size?: number;
}
export type ContextAvailability = "supplied" | "omitted" | "summarized" | "unavailable";
export interface ContextSegment {
  id: string;
  source: string;
  reason?: string;
  tokenEstimate?: number;
  tokenQuality?: "exact" | "estimated" | "unavailable";
  availability: ContextAvailability;
  detail?: string;
  invocationId?: string;
  attemptId?: string;
}
export interface ToolCallView {
  id: string;
  name: string;
  status: string;
  capability?: string;
  startedAt?: string;
  endedAt?: string;
  input?: unknown;
  output?: unknown;
  invocationId?: string;
  attemptId?: string;
}
export interface LogEntryView {
  id: string;
  level: "debug" | "info" | "warn" | "error" | string;
  message: string;
  timestamp?: string;
  source?: string;
  invocationId?: string;
  attemptId?: string;
}
export interface UsageView {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
  cost?: number;
  currency?: string;
  completeness: "complete" | "partial" | "unavailable";
  detail?: string;
  invocationId?: string;
  attemptId?: string;
}
export interface RunCapabilities {
  cancel?: boolean;
  retry?: boolean;
  steer?: boolean;
  reattach?: boolean;
  pause?: boolean;
  resume?: boolean;
  interrupt?: boolean;
  detach?: boolean;
  approve?: boolean;
  reject?: boolean;
}
export interface DiagnosticView {
  id: string;
  severity: "info" | "warning" | "error" | string;
  message: string;
  detail?: string;
  invocationId?: string;
  attemptId?: string;
}

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
const array = (value: unknown): UnknownRecord[] =>
  Array.isArray(value) ? value.map(record).filter((x): x is UnknownRecord => Boolean(x)) : [];
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const availability = (value: unknown): ContextAvailability =>
  value === "supplied" || value === "omitted" || value === "summarized" || value === "unavailable"
    ? value
    : "unavailable";
const declaredCapability = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return ["supported", "available", "enabled", "declared"].includes(value);
  return undefined;
};
export interface UiRunView {
  projectionVersion: number;
  runId: string;
  workflowId: string;
  revision: number;
  eventCursor: number;
  serverClock: string;
  servedAt?: string;
  state: RunState;
  startedAt?: string;
  finishedAt?: string;
  scopes: EntityMap<ScopeView>;
  invocations: EntityMap<UiInvocation>;
  attempts: EntityMap<UiAttempt>;
  spans: EntityMap<SpanView>;
  artifacts: EntityMap<UiArtifact>;
  context: ContextSegment[];
  tools: ToolCallView[];
  logs: LogEntryView[];
  usage: UsageView[];
  diagnostics: DiagnosticView[];
  capabilities: RunCapabilities;
}
export const asArray = <T>(value: Readonly<Record<string, T>> | undefined): T[] =>
  Object.values(value ?? {});
export function viewFromCore(view: CoreRunView): UiRunView {
  const invocations: Record<string, UiInvocation> = {};
  for (const item of Object.values(view.state.invocations)) {
    const firstAttempt = Object.values(view.state.attempts).find(
      (attempt) => attempt.invocationId === item.id,
    );
    invocations[item.id] = {
      invocationId: item.id,
      sourceNodeId: item.nodeId,
      scopeId: item.scopeId,
      state: item.status,
      ordinal: item.activationOrdinal,
      startedAt: firstAttempt?.startedAt ?? undefined,
      endedAt: item.completedAt ?? undefined,
      outputArtifactIds: item.output.map((ref) => ref.id),
      evidenceArtifactIds: item.evidence.map((ref) => ref.id),
      artifactIds: item.artifacts.map((ref) => ref.id),
      error: item.error,
      approval: (() => {
        const approval = Object.values(view.state.approvals).find(
          (candidate) => candidate.invocationId === item.id,
        );
        if (!approval) return undefined;
        return {
          status: approval.status,
          decidedAt: approval.decidedAt,
        };
      })(),
    };
  }
  const attempts: Record<string, UiAttempt> = {};
  for (const item of Object.values(view.state.attempts)) {
    const rawAttempt = item as unknown as UnknownRecord;
    attempts[item.id] = {
      attemptId: item.id,
      invocationId: item.invocationId,
      state: item.status,
      ordinal: item.ordinal,
      startedAt: item.startedAt ?? undefined,
      endedAt: item.finishedAt ?? undefined,
      artifactIds: item.artifacts.map((ref) => ref.id),
      error: item.error,
      output: item.output,
      command: item.commandEvidence
        ? { executable: item.commandEvidence.executable, args: [...item.commandEvidence.args] }
        : undefined,
      result: item.commandEvidence
        ? {
            exitCode: item.commandEvidence.exitCode ?? undefined,
            status: item.commandEvidence.kind,
          }
        : undefined,
    };
    const resolved = record(rawAttempt.resolvedExecution);
    if (resolved) attempts[item.id].resolvedExecution = resolved;
    if (rawAttempt.sessionReference !== undefined)
      attempts[item.id].sessionRef = rawAttempt.sessionReference;
  }
  const artifacts: Record<string, UiArtifact> = {};
  for (const item of Object.values(view.state.attempts).flatMap((attempt) => [
    ...attempt.output,
    ...attempt.evidence,
    ...attempt.artifacts,
  ]))
    artifacts[item.id] = { artifactId: item.id, contentType: item.mediaType };
  // M2 data is authoritative on each attempt. Top-level compatibility is used only
  // when no attempt has declared the corresponding field.
  const raw = view as unknown as UnknownRecord;
  const state = record(raw.state) ?? {};
  const m2 = record(raw.m2) ?? record(state.m2);
  const context: ContextSegment[] = [];
  const tools: ToolCallView[] = [];
  const logs: LogEntryView[] = [];
  const usage: UsageView[] = [];
  const diagnostics: DiagnosticView[] = [];
  const capabilities: RunCapabilities = {};
  let declaredAttemptContext = false;
  let declaredAttemptUsage = false;
  let declaredAttemptCapabilities = false;
  for (const attempt of Object.values(view.state.attempts)) {
    const a = attempt as unknown as UnknownRecord;
    const contextManifest = a.contextManifest;
    if (contextManifest !== undefined) {
      declaredAttemptContext = true;
      const manifest = record(contextManifest);
      const segments = array(manifest?.segments ?? contextManifest);
      for (const segment of segments) {
        const id = text(segment.id) ?? `${attempt.id}:context:${context.length}`;
        const supplied = segment.supplied;
        const summaryOf = Array.isArray(segment.summaryOf) ? segment.summaryOf : [];
        context.push({
          id,
          source: text(segment.source) ?? text(segment.kind) ?? "context",
          reason: text(segment.reason),
          detail: text(segment.detail),
          tokenEstimate: number(
            segment.tokenCount ??
              segment.tokenEstimate ??
              segment.estimatedTokens ??
              segment.tokens,
          ),
          tokenQuality:
            segment.tokenQuality === "exact" ||
            segment.tokenQuality === "estimated" ||
            segment.tokenQuality === "unavailable"
              ? segment.tokenQuality
              : undefined,
          availability:
            summaryOf.length > 0
              ? "summarized"
              : supplied === true
                ? "supplied"
                : supplied === false
                  ? "omitted"
                  : availability(segment.availability ?? segment.status),
          invocationId: attempt.invocationId,
          attemptId: attempt.id,
        });
      }
    }
    const events = array(a.harnessEvents);
    for (const event of events) {
      const kind = text(event.type ?? event.kind) ?? "log";
      if (kind === "tool" || kind === "tool_call" || kind === "tool_result")
        tools.push({
          id: text(event.id) ?? `${attempt.id}:tool:${tools.length}`,
          name: text(event.name ?? event.tool) ?? "tool",
          status: text(event.status) ?? (kind === "tool_result" ? "completed" : "started"),
          capability: text(event.capability),
          input: event.input,
          output: event.output,
          startedAt: text(event.startedAt ?? event.recordedAt),
          endedAt: text(event.endedAt),
          invocationId: attempt.invocationId,
          attemptId: attempt.id,
        });
      else {
        const data = record(event.data);
        logs.push({
          id: text(event.id) ?? `${attempt.id}:log:${logs.length}`,
          level: text(event.level) ?? (kind === "error" ? "error" : "info"),
          message:
            text(event.message ?? event.detail ?? event.data) ??
            text(data?.message ?? data?.text) ??
            kind,
          timestamp: text(event.timestamp ?? event.recordedAt ?? event.at),
          source: text(event.source ?? event.origin),
          invocationId: attempt.invocationId,
          attemptId: attempt.id,
        });
      }
    }
    if (a.usage !== undefined) {
      declaredAttemptUsage = true;
      const u = record(a.usage) ?? {};
      const usageValue = (value: unknown) => number(record(value)?.value ?? value);
      const qualities = [u.inputTokens, u.outputTokens, u.totalTokens]
        .map((value) => text(record(value)?.quality))
        .filter(Boolean);
      const observed = qualities.filter((value) => value === "observed").length;
      usage.push({
        inputTokens: usageValue(u.inputTokens),
        outputTokens: usageValue(u.outputTokens),
        totalTokens: usageValue(u.totalTokens),
        estimated: qualities.includes("estimated") || u.estimated === true,
        cost: usageValue(u.cost),
        currency: text(u.currency),
        completeness:
          u.completeness === "complete" ||
          u.completeness === "partial" ||
          u.completeness === "unavailable"
            ? u.completeness
            : observed === 3
              ? "complete"
              : observed > 0
                ? "partial"
                : "unavailable",
        detail: text(u.detail),
        invocationId: attempt.invocationId,
        attemptId: attempt.id,
      });
    }
    if (Array.isArray(a.diagnostics))
      for (const item of a.diagnostics) {
        const diagnostic = record(item);
        diagnostics.push({
          id: text(diagnostic?.id) ?? `${attempt.id}:diagnostic:${diagnostics.length}`,
          severity: text(diagnostic?.severity) ?? "info",
          message: text(diagnostic?.message) ?? text(item) ?? "Diagnostic",
          detail: text(diagnostic?.detail),
          invocationId: attempt.invocationId,
          attemptId: attempt.id,
        });
      }
    const declared = record(a.capabilities) ?? record(record(a.sessionReference)?.capabilities);
    if (declared) {
      declaredAttemptCapabilities = true;
      for (const name of [
        "cancel",
        "retry",
        "steer",
        "reattach",
        "pause",
        "resume",
        "interrupt",
        "detach",
        "approve",
        "reject",
      ] as const) {
        const state = declaredCapability(declared[name]);
        if (state !== undefined) capabilities[name] = state;
      }
    }
  }
  const compatibility = <T>(name: string): T[] => {
    const source = m2?.[name] ?? raw[name] ?? state[name];
    return Array.isArray(source) ? (source as T[]) : [];
  };
  if (!declaredAttemptContext) context.push(...compatibility<ContextSegment>("context"));
  if (!declaredAttemptUsage) usage.push(...compatibility<UsageView>("usage"));
  if (!tools.length) tools.push(...compatibility<ToolCallView>("tools"));
  if (!logs.length) logs.push(...compatibility<LogEntryView>("logs"));
  if (!diagnostics.length) diagnostics.push(...compatibility<DiagnosticView>("diagnostics"));
  if (!declaredAttemptCapabilities) {
    const declared = record(m2?.capabilities ?? raw.capabilities ?? state.capabilities);
    if (declared)
      for (const name of [
        "cancel",
        "retry",
        "steer",
        "reattach",
        "pause",
        "resume",
        "interrupt",
        "detach",
        "approve",
        "reject",
      ] as const) {
        const state = declaredCapability(declared[name]);
        if (state !== undefined) capabilities[name] = state;
      }
  }
  // Kouro-owned run controls are declared by the host independently of native
  // harness capabilities. A prior attempt's sparse capability record must not
  // hide pause/resume/detach once that attempt has completed.
  const runControls = record(m2?.capabilities);
  if (runControls)
    for (const name of ["pause", "resume", "detach"] as const) {
      const state = declaredCapability(runControls[name]);
      if (state !== undefined) capabilities[name] = state;
    }
  if (Object.values(view.state.approvals).some((approval) => approval.status === "pending")) {
    capabilities.approve = true;
    capabilities.reject = true;
  }
  // Capabilities are sparse: an operation must be explicitly declared by the
  // authoritative host/policy and also be eligible in the current run state.
  // Never fabricate controls from a generic state alone.
  const active = view.state.status === "running" || view.state.status === "paused";
  const eligible: Record<string, boolean> = {
    pause: view.state.status === "running",
    resume: view.state.status === "paused",
    interrupt: view.state.status === "running",
    cancel: active,
    detach: active,
    reattach: false,
  };
  for (const [name, allowed] of Object.entries(eligible)) {
    if (!allowed || capabilities[name as keyof RunCapabilities] !== true)
      delete capabilities[name as keyof RunCapabilities];
  }
  const retryEligible = Object.values(view.state.invocations).some((invocation) => {
    if (invocation.status !== "failed") return false;
    return Object.values(view.state.attempts).some(
      (attempt) => attempt.invocationId === invocation.id && attempt.status === "failed",
    );
  });
  if (capabilities.retry !== true || !retryEligible) delete capabilities.retry;
  for (const [name, value] of Object.entries(capabilities))
    if (value !== true) delete capabilities[name as keyof RunCapabilities];
  return {
    projectionVersion: view.projectionVersion,
    runId: view.runId,
    workflowId: view.bundle.rootDefinitionId,
    revision: view.revision,
    eventCursor: view.eventCursor,
    serverClock: view.serverClock,
    servedAt:
      typeof (view as CoreRunView & { servedAt?: unknown }).servedAt === "string"
        ? (view as CoreRunView & { servedAt: string }).servedAt
        : undefined,
    state: view.state.status,
    startedAt: view.state.startedAt ?? undefined,
    finishedAt: view.state.finishedAt ?? undefined,
    scopes: view.state.scopes,
    invocations,
    attempts,
    spans: {},
    artifacts,
    context,
    tools,
    logs,
    usage,
    diagnostics,
    capabilities,
  };
}
export function bundleGraph(bundle: Bundle): WorkflowGraph {
  const definition: Definition = bundle.definitions[bundle.rootDefinitionId];
  const nodes = definition.nodes.map((node, index) => ({
    id: node.id,
    label:
      node.kind === "agent" ? node.role : node.kind === "command" ? node.executable : node.kind,
    kind: node.kind,
    role: node.kind === "agent" ? node.role : undefined,
    position: { x: (index % 3) * 230 + 60, y: Math.floor(index / 3) * 150 + 65 },
  }));
  return {
    nodes,
    edges: definition.controlEdges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      label: edge.id.endsWith(":repair")
        ? `${edge.outcome} · repair`
        : edge.id.endsWith(":repair-exhausted")
          ? `${edge.outcome} · exhausted`
          : edge.outcome,
    })),
  };
}
