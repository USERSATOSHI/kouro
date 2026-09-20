import { describe, expect, test } from "bun:test";
import { makeTimeScale } from "./timeScale";

describe("timeline scale", () => {
  test("keeps a fixed run origin in elapsed labels", () => {
    const scale = makeTimeScale(1_000, 31_000, 620);
    expect(scale.x(1_000)).toBe(0);
    expect(scale.x(31_000)).toBe(620);
    expect(scale.tickFormat(1_000)).toBe("0s");
    expect(scale.tickFormat(11_000)).toBe("10s");
  });

  test("densifies ticks with the available width", () => {
    expect(makeTimeScale(0, 3_600_000, 200).ticks.length).toBeLessThan(
      makeTimeScale(0, 3_600_000, 1_200).ticks.length,
    );
  });

  test("maps short and long runs continuously without duration buckets", () => {
    for (const duration of [3_000, 30_000, 3 * 60 * 60_000, 8 * 60 * 60_000]) {
      const scale = makeTimeScale(1_000, 1_000 + duration, 900);
      expect(scale.x(1_000)).toBe(0);
      expect(scale.x(1_000 + duration)).toBe(900);
      expect(scale.x(1_000 + duration / 2)).toBeCloseTo(450, 5);
      expect(scale.ticks.every((tick, index) => index === 0 || tick > scale.ticks[index - 1])).toBe(
        true,
      );
      expect(scale.ticks.every((tick) => scale.tickFormat(tick).length > 0)).toBe(true);
    }
  });
});
