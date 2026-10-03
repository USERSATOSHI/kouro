import { expect, test } from "bun:test";
import { sessionUsageBaseline, sessionUsageIncrement } from "../src/adapters/harness/session";

test("resumed session usage counts the increment and preserves unavailable or reset counters", () => {
  const metric = (value: number | null) => ({
    value,
    quality: value === null ? "unavailable" : "observed",
  });
  const previous = {
    inputTokens: metric(100),
    outputTokens: metric(20),
    totalTokens: metric(120),
    cost: metric(null),
  };
  const current = {
    inputTokens: metric(150),
    outputTokens: metric(35),
    totalTokens: metric(185),
    cost: metric(null),
  };
  expect(sessionUsageIncrement(current, previous)).toEqual({
    inputTokens: metric(50),
    outputTokens: metric(15),
    totalTokens: metric(65),
    cost: metric(null),
  });
  expect(sessionUsageIncrement(previous, undefined)).toEqual(previous);
  expect(sessionUsageIncrement({ totalTokens: metric(10) }, previous)).toEqual({
    totalTokens: metric(10),
  });
  expect(sessionUsageIncrement({ totalTokens: metric(null) }, previous)).toEqual({
    totalTokens: metric(null),
  });
  expect(sessionUsageBaseline({ totalTokens: metric(null) }, previous)).toEqual(previous);
  expect(sessionUsageBaseline(current, previous)).toEqual(current);
});
