import { describe, expect, it } from "vitest";
import {
  M7_FIXTURE,
  normalizeComparison,
  normalizeEligibility,
  normalizeGenealogy,
  normalizeM7View,
} from "./m7";

describe("M7 checkpoint DTO", () => {
  it("renders every eligibility predicate and keeps host ineligibility authoritative", () => {
    const result = normalizeEligibility({
      eligible: false,
      reasons: ["active-effect", "unverified-workspace"],
      pendingFrontierAllowed: true,
    });
    expect(result.eligible).toBe(false);
    expect(result.predicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "active-effect", satisfied: false }),
        expect.objectContaining({ id: "unverified-workspace", satisfied: false }),
      ]),
    );
  });

  it("normalizes parent links into children without inventing missing runs", () => {
    const tree = normalizeGenealogy({
      nodes: [
        { id: "parent", children: [] },
        { id: "child", parentId: "parent", inheritedInvocationIds: ["i1"] },
        { id: "foreign", parentId: "not-returned" },
      ],
    });
    expect(tree.nodes.find((node) => node.runId === "parent")?.children).toEqual(["child"]);
    expect(tree.nodes.find((node) => node.runId === "foreign")?.parentRunId).toBe("not-returned");
  });

  it("separates inherited spend from new spend and preserves unknown telemetry", () => {
    const comparison = normalizeComparison({
      entries: [
        { id: "a", status: "inherited", durationMs: 10, cost: 1 },
        { id: "b", status: "new", durationMs: 20 },
        { id: "c", status: "missing" },
        { id: "d", status: "provider-unknown" },
      ],
    });
    expect(comparison.inheritedDurationMs).toBe(10);
    expect(comparison.newDurationMs).toBe(20);
    expect(comparison.inheritedCost).toBe(1);
    expect(comparison.newCost).toBeUndefined();
    expect(comparison.missingCount).toBe(1);
    expect(comparison.unknownCount).toBe(1);
  });

  it("provides a deterministic fixture for keyboard and responsive browser checks", () => {
    expect(M7_FIXTURE.eligibility.eligible).toBe(true);
    expect(M7_FIXTURE.comparison.entries.map((entry) => entry.status)).toEqual([
      "inherited",
      "inherited",
      "new",
      "unknown",
    ]);
    const sparse = normalizeM7View({}, "run-sparse");
    expect(sparse.eligibility.eligible).toBe(false);
    expect(sparse.comparison.entries).toEqual([]);
  });
});
