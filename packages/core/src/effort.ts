import {
  REASONING_EFFORTS,
  ReasoningEffort,
  type ReasoningEffortValue,
  type RuntimeHarness,
} from "./contracts";

export function isReasoningEffort(value: unknown): value is ReasoningEffortValue {
  return REASONING_EFFORTS.some((effort) => effort === value);
}

/** Adapter-supported levels; individual models may support a narrower range. */
export function reasoningEffortsForHarness(
  harness: RuntimeHarness,
): readonly ReasoningEffortValue[] {
  switch (harness) {
    case "codex":
    case "scripted":
      return REASONING_EFFORTS;
    case "claude":
      return [
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
        ReasoningEffort.MAX,
      ];
    case "pi":
      return [
        ReasoningEffort.MINIMAL,
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
        ReasoningEffort.MAX,
      ];
    case "opencode":
      return [];
  }
}

export function validateReasoningEffort(
  value: unknown,
  harness?: RuntimeHarness,
): string | undefined {
  if (value === undefined) return;
  if (!isReasoningEffort(value)) return `Invalid reasoning effort: ${String(value)}`;
  if (harness && !reasoningEffortsForHarness(harness).includes(value))
    return `Reasoning effort ${value} is unsupported by ${harness}`;
}
