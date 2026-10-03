import type { JsonValue } from "@kouro/core";

/** Only provider limits are resumable waits. Ordinary errors remain failures. */
export function providerLimit(
  error: string | undefined,
): "usage-limit" | "turn-limit" | "budget-limit" | undefined {
  if (!error) return undefined;
  if (/error_max_budget_usd|max[ _-]?budget|budget.*exceeded/i.test(error)) return "budget-limit";
  if (/error_max_turns|maximum.*turns|max[ _-]?turns/i.test(error)) return "turn-limit";
  if (
    /usage[ _-]?limit|rate[ _-]?limit|quota|hit your limit|hit.*usage.*limit|limit.*resets|too many requests|\b429\b/i.test(
      error,
    )
  )
    return "usage-limit";
  return undefined;
}

/** Native resumed conversations report running totals; charge an attempt only for its increment. */
export function sessionUsageIncrement(
  current: JsonValue,
  previous: JsonValue | undefined,
): JsonValue {
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    !previous ||
    typeof previous !== "object" ||
    Array.isArray(previous)
  )
    return current;
  return Object.fromEntries(
    Object.entries(current).map(([key, value]) => {
      const baseline = previous[key];
      if (
        ![
          "inputTokens",
          "outputTokens",
          "totalTokens",
          "cost",
          "uncachedInputTokens",
          "cacheReadInputTokens",
          "cacheCreationInputTokens",
        ].includes(key) ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !baseline ||
        typeof baseline !== "object" ||
        Array.isArray(baseline) ||
        typeof value.value !== "number" ||
        typeof baseline.value !== "number" ||
        !Number.isFinite(value.value) ||
        !Number.isFinite(baseline.value)
      )
        return [key, value];
      // Providers can reset counters after compaction or a clear; never report a negative increment.
      return [
        key,
        {
          ...value,
          value: value.value >= baseline.value ? value.value - baseline.value : value.value,
        },
      ];
    }),
  );
}

/** A failed query can omit counters; retain the last known cumulative baseline for recovery. */
export function sessionUsageBaseline(
  current: JsonValue,
  previous: JsonValue | undefined,
): JsonValue {
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    !previous ||
    typeof previous !== "object" ||
    Array.isArray(previous)
  )
    return current;
  return Object.fromEntries(
    Object.entries({ ...previous, ...current }).map(([key, value]) => {
      const baseline = previous[key];
      const known =
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.value === "number" &&
        Number.isFinite(value.value);
      return [key, known ? value : (baseline ?? value)];
    }),
  );
}
