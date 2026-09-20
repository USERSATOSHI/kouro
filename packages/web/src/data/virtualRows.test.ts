import { describe, expect, test } from "bun:test";
import { virtualRows } from "./virtualRows";

describe("timeline row virtualization", () => {
  test("keeps a 10,000-row history to a small visible window", () => {
    const top = virtualRows(10_000, 0, 380, 38);
    const middle = virtualRows(10_000, 190_000, 380, 38);
    const end = virtualRows(10_000, 379_620, 380, 38);
    expect(top.last - top.first).toBeLessThan(30);
    expect(middle.last - middle.first).toBeLessThan(30);
    expect(end.last).toBe(10_000);
    expect(middle.first).toBeGreaterThan(4_000);
  });
});
