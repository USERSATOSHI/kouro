import { describe, expect, it } from "vitest";
import {
  M5_FIXTURE,
  acceptanceStatus,
  cellFor,
  cellStatusSummary,
  evaluationSummary,
  formatEvidenceValue,
} from "./m5";

describe("evaluation workbench DTO helpers", () => {
  it("keeps matrix lookup keyed by case, variant, and repetition", () => {
    expect(cellFor(M5_FIXTURE, "race", "fusion")?.runId).toBe("run_race_fusion");
    expect(cellFor(M5_FIXTURE, "migration", "fusion", 2)).toBeUndefined();
  });

  it("reports every explicit lifecycle state without collapsing evaluator errors", () => {
    const summary = cellStatusSummary(M5_FIXTURE.cells);
    expect(summary.pending).toBe(3);
    expect(summary.running).toBe(1);
    expect(summary.succeeded).toBe(5);
    expect(summary.failed).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(summary["evaluator-error"]).toBe(1);
  });

  it("keeps successful execution separate from missing acceptance", () => {
    const cell = cellFor(M5_FIXTURE, "cache", "baseline")!;
    expect(cell.status).toBe("succeeded");
    expect(acceptanceStatus(cell)).toBe("missing");
    expect(evaluationSummary([cell]).acceptance.passed).toBe(0);
  });

  it("distinguishes failed acceptance from evaluator error", () => {
    const failedAcceptance = {
      ...cellFor(M5_FIXTURE, "race", "baseline")!,
      status: "succeeded" as const,
      evidence: [{ kind: "deterministic" as const, label: "acceptance", value: "failed" }],
    };
    const evaluatorError = cellFor(M5_FIXTURE, "race", "fusion-qa")!;
    expect(acceptanceStatus(failedAcceptance)).toBe("failed");
    expect(acceptanceStatus(evaluatorError)).toBe("unavailable");
    const summary = evaluationSummary([failedAcceptance, evaluatorError]);
    expect(summary.acceptance.failed).toBe(1);
    expect(summary.evaluatorErrors).toBe(1);
  });

  it("formats structured evidence without rendering a raw JSON blob", () => {
    expect(formatEvidenceValue('{"passed":24,"failed":0}')).toBe("passed: 24 · failed: 0");
  });
});
