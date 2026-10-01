import type { CoreProjectionFrame, CoreRunView, StoreStatus, UiRunView } from "../types";
import { viewFromCore } from "../types";
import { projectSession, type SessionObservation } from "../session";

type Listener = () => void;
type ResetListener = (reason: string) => void;

/** One browser store for graph, timeline and inspector; frames replace the core state atomically. */
export class RunSyncStore {
  private core: CoreRunView | null = null;
  private listeners = new Set<Listener>();
  private resetListeners = new Set<ResetListener>();
  private _status: StoreStatus = "idle";
  private _lastMessageAt = 0;
  private _error?: string;
  private ui: UiRunView | null = null;
  private liveActivity: Array<{
    attemptId: string;
    cursor?: number;
    event: Record<string, unknown>;
  }> = [];
  getSnapshot = () => this.ui;
  getConnectionSnapshot = () => `${this._status}:${this._error ?? ""}`;
  get status() {
    return this._status;
  }
  get lastMessageAt() {
    return this._lastMessageAt;
  }
  get error() {
    return this._error;
  }
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  onReset = (listener: ResetListener) => {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  };
  private notify() {
    this.listeners.forEach((listener) => listener());
  }
  setStatus(status: StoreStatus, error?: string) {
    this._status = status;
    this._error = error;
    if (this.ui) this.ui = { ...this.ui };
    this.notify();
  }
  replace(view: CoreRunView) {
    this.core = view;
    const activity = (view as CoreRunView & { m2?: { activity?: SessionObservation[] } }).m2
      ?.activity;
    this.liveActivity = (activity ?? persistedActivities(view)).slice(-1500);
    this.ui = this.projectView(view);
    this._lastMessageAt = Date.now();
    this._status = "live";
    this._error = undefined;
    this.notify();
  }
  beginRun(runId: string) {
    if (this.core?.runId === runId) return;
    this.core = null;
    this.liveActivity = [];
    this.ui = null;
    this._status = "connecting";
    this._error = undefined;
    this.notify();
  }
  clear() {
    this.core = null;
    this.liveActivity = [];
    this.ui = null;
    this._status = "idle";
    this._error = undefined;
    this.notify();
  }
  apply(frame: CoreProjectionFrame): "applied" | "duplicate" | "reset" {
    const current = this.core;
    if (
      !current ||
      frame.runId !== current.runId ||
      frame.projectionVersion !== current.projectionVersion
    )
      return this.reset("projection version or run mismatch");
    if (frame.revision <= current.revision || frame.eventCursor <= current.eventCursor)
      return "duplicate";
    if (frame.baseRevision !== current.revision || frame.eventCursor !== frame.revision)
      return this.reset("projection gap");
    const operatorState = (frame as CoreProjectionFrame & { m2?: unknown }).m2;
    const next = {
      ...current,
      ...(operatorState ? { m2: operatorState } : {}),
      revision: frame.revision,
      eventCursor: frame.eventCursor,
      serverClock: current.serverClock,
      state: frame.state,
    };
    // Keep cursor identities through attempt completion. Re-appending every
    // attempt's retained events on each frame multiplied the session history.
    this.liveActivity = [...this.liveActivity];
    for (const attempt of Object.values(next.state.attempts)) {
      if (
        attempt.harnessEvents !== current.state.attempts[attempt.id]?.harnessEvents &&
        !this.liveActivity.some((item) => item.attemptId === attempt.id)
      ) {
        this.liveActivity.push(
          ...persistedActivities({
            ...next,
            state: { ...next.state, attempts: { [attempt.id]: attempt } },
          }),
        );
      }
    }
    this.core = next;
    if (frame.activity) {
      this.liveActivity.push({
        attemptId: frame.activity.attemptId,
        cursor: frame.revision,
        event: frame.activity.event as Record<string, unknown>,
      });
    }
    if (this.liveActivity.length > 1500)
      this.liveActivity.splice(0, this.liveActivity.length - 1500);
    this.ui = this.projectView(next);
    this._lastMessageAt = Date.now();
    this._status = "live";
    this._error = undefined;
    this.notify();
    return "applied";
  }
  private projectView(view: CoreRunView): UiRunView {
    const ui = { ...viewFromCore(view), liveActivity: this.liveActivity };
    const byAttempt = new Map<string, SessionObservation[]>();
    for (const activity of this.liveActivity) {
      const group = byAttempt.get(activity.attemptId) ?? [];
      group.push(activity);
      byAttempt.set(activity.attemptId, group);
    }
    const tools = new Map(ui.tools.map((tool) => [tool.id, tool]));
    for (const [attemptId, observations] of byAttempt) {
      for (const entry of projectSession(observations))
        if (entry.kind === "tool") {
          tools.set(entry.id, {
            ...tools.get(entry.id),
            ...entry,
            attemptId,
            invocationId: view.state.attempts[attemptId]?.invocationId,
          });
        }
      const logs = observations.filter((item) => item.event.type === "log");
      if (logs.length) {
        ui.logs = ui.logs.filter((log) => log.attemptId !== attemptId);
        ui.logs.push(
          ...logs.map((item, index) => {
            const data =
              item.event.data && typeof item.event.data === "object"
                ? (item.event.data as Record<string, unknown>)
                : {};
            const message = String(
              data.text ?? data.message ?? data.status ?? item.event.data ?? "Provider activity",
            );
            return {
              id: `${attemptId}:activity-log:${item.cursor ?? index}`,
              level: String(data.level ?? item.event.level ?? "info"),
              message: data.detail ? `${message} · ${String(data.detail)}` : message,
              attemptId,
              invocationId: view.state.attempts[attemptId]?.invocationId,
            };
          }),
        );
      }
    }
    ui.tools = [...tools.values()];
    return ui;
  }
  private reset(reason: string): "reset" {
    this._status = "stale";
    this._error = reason;
    if (this.ui) this.ui = { ...this.ui };
    this.resetListeners.forEach((listener) => listener(reason));
    this.notify();
    return "reset";
  }
}

function persistedActivities(view: CoreRunView) {
  return Object.values(view.state.attempts).flatMap((attempt) =>
    (attempt.harnessEvents ?? []).flatMap((event) =>
      event && typeof event === "object" && !Array.isArray(event)
        ? [{ attemptId: attempt.id, event: event as Record<string, unknown> }]
        : [],
    ),
  );
}
