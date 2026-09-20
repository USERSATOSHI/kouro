import { describe, expect, test } from "bun:test";
import {
  createCheckpointCut,
  evaluateCheckpointEligibility,
  invalidateCheckpoint,
  prepareForkProjection,
  type CheckpointInput,
} from "../src/index";

const base = (): CheckpointInput => ({
  runId: "run-1",
  revision: 7,
  eventCursor: 7,
  status: "paused",
  admissionPaused: true,
  bundleDigest: "sha256:bundle",
  configDependencyDigest: "sha256:config",
  artifacts: { verified: true, roots: ["blob-a", "blob-b"] },
  workspace: { verified: true, treeDigest: "tree-a", roots: ["tree-a"] },
  completedInvocationIds: ["inv-1"],
  pendingFrontier: [{ invocationId: "inv-2", nodeId: "agent" }],
  approvals: [
    {
      id: "approval-1",
      invocationId: "inv-2",
      action: "write",
      status: "pending",
      bindingDigest: "b",
      subjectRevision: 7,
    },
  ],
});

describe("M7 checkpoint contracts", () => {
  test("requires a paused, drained and verified cut while allowing pending frontier", () => {
    const input = base();
    expect(evaluateCheckpointEligibility(input)).toMatchObject({
      eligible: true,
      pendingFrontierAllowed: true,
    });
    expect(
      evaluateCheckpointEligibility({
        ...input,
        admissionPaused: false,
        effects: [{ id: "e", state: "running" }],
      }).reasons,
    ).toEqual(["admission-not-paused", "active-effect"]);
    expect(
      evaluateCheckpointEligibility({
        ...input,
        unsupportedNestedInvocationIds: ["child-invocation"],
      }).reasons,
    ).toContain("unsupported-nested-scope");
  });

  test("captures exact roots and strips authority for a fork projection", async () => {
    const cut = await createCheckpointCut(base(), "cp-1");
    expect(Object.isFrozen(cut)).toBe(true);
    expect(cut.certificateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(cut.inheritedSourceInvocationIds).toEqual(["inv-1"]);
    expect(prepareForkProjection(cut)).toEqual({
      inherited: [
        {
          sourceInvocationId: "inv-1",
          status: "succeeded",
          provenance: "inherited",
          authority: "none",
        },
      ],
      pending: [{ invocationId: "inv-2", nodeId: "agent" }],
      approvals: [{ invocationId: "inv-2", status: "fresh-required" }],
      sessions: [],
      deliveries: [],
    });
  });

  test("invalidates changed dependencies or retained closure", async () => {
    const cut = await createCheckpointCut(base(), "cp-1");
    expect(invalidateCheckpoint(cut, { ...base(), revision: 8 }).valid).toBe(false);
    expect(
      invalidateCheckpoint(cut, { ...base(), revision: 7, configDependencyDigest: "changed" })
        .reasons,
    ).toEqual(["config-dependencies-changed"]);
  });
});
