import type { StoreStatus } from "../types";

/** A background tab can suspend EventSource delivery; refresh once when it is visible again. */
export function shouldReconnectOnVisibility(
  visibilityState: DocumentVisibilityState,
  status: StoreStatus,
): boolean {
  return visibilityState === "visible" && status !== "idle" && status !== "connecting";
}
