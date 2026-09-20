export * from "./contracts";
export * from "./builder";
export * from "./compiler";
export * from "./execution";
export { canonicalize, sha256Hex } from "./canonical";
export * from "./harness";
export * from "./evaluations";
export * from "./evaluator";
export * from "./comparison";
export * from "./collaboration";
export * from "./handoff";
export * from "./checkpoint";
export * from "./development";

import {
  PROJECTION_VERSION,
  type Bundle,
  type ExecutionState,
  type EventEnvelope,
  type LifecycleEvent,
  type LifecycleEventType,
  type ProjectionFrame,
  type RunView,
} from "./contracts";

/** Construct a lifecycle envelope from host-assigned identity and time values. */
export function createLifecycleEvent<T extends LifecycleEventType, P>(
  type: T,
  values: Omit<EventEnvelope<T, P>, "schemaVersion" | "type" | "payload">,
  payload: P,
): EventEnvelope<T, P> {
  return { ...values, schemaVersion: 1, type, payload };
}

/** Build the full small-run frame used by the initial host adapter. */
export function createProjectionFrame(
  previous: ExecutionState,
  next: ExecutionState,
): ProjectionFrame {
  if (previous.runId !== next.runId)
    throw new Error("Projection frame states must belong to one run");
  return {
    projectionVersion: PROJECTION_VERSION,
    runId: next.runId,
    baseRevision: previous.revision,
    revision: next.revision,
    eventCursor: next.eventCursor,
    state: next,
  };
}

export function createRunView(bundle: Bundle, state: ExecutionState, serverClock: string): RunView {
  return {
    projectionVersion: PROJECTION_VERSION,
    runId: state.runId,
    revision: state.revision,
    eventCursor: state.eventCursor,
    bundle,
    state,
    serverClock,
  };
}

export type { LifecycleEvent };
