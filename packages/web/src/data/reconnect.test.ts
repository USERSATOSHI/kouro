import { describe, expect, test } from "bun:test";
import { shouldReconnectOnVisibility } from "./reconnect";

describe("stream visibility recovery", () => {
  test("refreshes a selected run when a hidden tab becomes visible", () => {
    expect(shouldReconnectOnVisibility("visible", "live")).toBe(true);
    expect(shouldReconnectOnVisibility("visible", "disconnected")).toBe(true);
    expect(shouldReconnectOnVisibility("hidden", "disconnected")).toBe(false);
  });

  test("does not start a second connection while the snapshot is loading", () => {
    expect(shouldReconnectOnVisibility("visible", "idle")).toBe(false);
    expect(shouldReconnectOnVisibility("visible", "connecting")).toBe(false);
  });
});
