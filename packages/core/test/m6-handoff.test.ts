import { describe, expect, test } from "bun:test";
import {
  assertNoEscalation,
  createAgentHandoff,
  createCollaborationWorkflowTemplate,
  resolveSessionDecision,
  validateCollaborationTermination,
} from "../src/index";

const context = { version: 1 as const, attemptId: "attempt-1", digest: "sha256:context" };
const base = {
  handoffId: "handoff-1",
  sourceAttemptId: "attempt-1",
  objective: { text: "Implement the bounded fix", source: "agent" as const, verified: false },
  completed: [{ text: "Found the failing fixture", source: "artifact" as const, verified: true }],
  decisions: [{ text: "Use a fresh session", source: "user" as const, verified: true }],
  files: [{ path: "packages/core/src/handoff.ts", source: "host" as const }],
  unresolved: [
    { text: "Confirm the second harness capability", source: "agent" as const, verified: false },
  ],
  evidence: [{ text: "Scripted fixture passed", source: "artifact" as const, verified: true }],
  nextSteps: [
    { text: "Run deterministic reproduction", source: "agent" as const, verified: false },
  ],
  contextManifest: context,
  provenance: {
    sourceHarnessId: "scripted",
    sourceModelId: "fixture",
    createdBy: "host" as const,
    createdAt: "2026-09-19T00:00:00.000Z",
  },
};

describe("M6 handoff and bounded collaboration template", () => {
  test("creates an attributable handoff and always uses a new session when continuity is unavailable", async () => {
    const handoff = await createAgentHandoff(base);
    expect(handoff.digest).toMatch(/^sha256:/);
    expect(handoff.contextManifest.attemptId).toBe("attempt-1");
    expect(
      resolveSessionDecision({
        nativeResume: "unsupported",
        sameHarness: false,
        sameModel: false,
        permissionEnvelopeUnchanged: true,
      }),
    ).toEqual({ kind: "fresh-session", reason: "harness-changed", requiresHandoff: true });
    expect(
      resolveSessionDecision({
        nativeResume: "supported",
        sameHarness: true,
        sameModel: true,
        permissionEnvelopeUnchanged: true,
      }).kind,
    ).toBe("native-resume");
  });

  test("rejects oversized or escalated handoffs", async () => {
    await expect(
      createAgentHandoff(
        { ...base, objective: { ...base.objective, text: "x".repeat(9000) } },
        { maxClaimBytes: 100 },
      ),
    ).rejects.toThrow("oversized");
    expect(() =>
      assertNoEscalation({
        sourceBudget: { turns: 2 },
        targetBudget: { turns: 3 },
        sourcePermissions: ["read"],
        targetPermissions: ["read"],
      }),
    ).toThrow("budget");
    expect(() =>
      assertNoEscalation({
        sourceBudget: { turns: 2 },
        targetBudget: { turns: 2 },
        sourcePermissions: ["read"],
        targetPermissions: ["write"],
      }),
    ).toThrow("permission");
  });

  test("declares roles, direct tools, parallel branches, bounded response and reproduction gate", () => {
    const template = createCollaborationWorkflowTemplate({
      roles: [
        { id: "implementer", objective: "implement" },
        { id: "qa", objective: "verify" },
      ],
      directMessageTools: [{ name: "sendFinding", from: "qa", to: "implementer" }],
      parallelBranches: [
        { id: "impl", roleId: "implementer" },
        { id: "check", roleId: "qa" },
      ],
      join: { mode: "all", branchIds: ["impl", "check"] },
      respondLoop: { maxTurns: 3, idleDeadlineMs: 1000, maxMessagesPerTurn: 2 },
      deterministicReproductionGate: {
        required: true,
        command: "bun test fixture",
        evidenceKind: "deterministic",
      },
    });
    expect(template.respondLoop.maxTurns).toBe(3);
    expect(template.deterministicReproductionGate.required).toBe(true);
    expect(() => validateCollaborationTermination({ template, evidence: [] })).toThrow("evidence");
    expect(() =>
      validateCollaborationTermination({
        template,
        evidence: [
          { kind: "deterministic", command: "bun test fixture", status: "failed", attemptId: "a" },
        ],
      }),
    ).toThrow("evidence");
    expect(
      validateCollaborationTermination({
        template,
        evidence: [
          { kind: "deterministic", command: "bun test fixture", status: "passed", attemptId: "a" },
        ],
      }).allowed,
    ).toBe(true);
  });
});
