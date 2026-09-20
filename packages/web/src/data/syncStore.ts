import type { CoreProjectionFrame, CoreRunView, StoreStatus, UiRunView } from "../types";
import { viewFromCore } from "../types";

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
  getSnapshot = () => this.ui;
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
    this.ui = viewFromCore(view);
    this._lastMessageAt = Date.now();
    this._status = "live";
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
    const next = {
      ...current,
      revision: frame.revision,
      eventCursor: frame.eventCursor,
      serverClock: current.serverClock,
      state: frame.state,
    };
    this.core = next;
    this.ui = viewFromCore(next);
    this._lastMessageAt = Date.now();
    this._status = "live";
    this._error = undefined;
    this.notify();
    return "applied";
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
