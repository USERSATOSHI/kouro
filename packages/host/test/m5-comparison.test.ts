import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Journal } from "../src/storage/journal.ts";
import { makeEvidence } from "@kouro/core";

function journal() {
  const dir = mkdtempSync(`${tmpdir()}/kouro-m5-`);
  const value = new Journal({ dataDir: dir, requireOwner: false });
  return { value, dir };
}
function runBundle() {
  return {
    formatVersion: 1,
    semanticVersions: { compiler: "1", expressions: "1", schemas: "1" },
    rootDefinitionId: "root",
    definitions: {
      root: {
        id: "root",
        inputPorts: [],
        outputPorts: [],
        nodes: [
          {
            id: "entry",
            kind: "complete",
            inputPorts: [],
            outputPorts: [],
            bindings: [],
            result: "succeeded",
          },
        ],
        controlEdges: [],
        dataBindings: [],
        entry: "entry",
        exits: ["entry"],
        counters: [],
      },
    },
    schemas: {},
    limits: {} as never,
    sourceMap: {},
    boundSummary: { scopes: 1, invocations: 1, attempts: 1, saturated: false },
    digest: "bundle",
    canonicalJson: "{}",
  } as never;
}
function createRun(value: Journal, key: string) {
  const run = value.createRun({ workflowId: "fixture", bundle: runBundle(), idempotencyKey: key });
  value.append({
    runId: run.run.runId,
    type: "run.started",
    payload: { rootDefinitionId: "root" },
  });
  return run.run.runId;
}

describe("M5 comparison and pairwise evidence", () => {
  test("persists explicit alignment and preserves missing timeline stages", async () => {
    const { value, dir } = journal();
    try {
      const runA = createRun(value, "comparison-a");
      const runB = createRun(value, "comparison-b");
      const comparison = value.saveComparison({
        id: "cmp-1",
        evidenceRevision: 1,
        runs: [
          { runId: runA, revision: 1 },
          { runId: runB, revision: 1 },
        ],
        anchors: [
          { id: "start", kind: "start", leftNodeKey: "entry", rightNodeKey: "entry" },
          { id: "validate", kind: "invocation", leftNodeKey: "entry", rightNodeKey: "entry" },
          { id: "qa", kind: "explicit", leftNodeKey: "entry", rightNodeKey: "entry" },
        ],
      });
      expect(value.getComparison(comparison.id)?.anchors[1]?.rightNodeKey).toBe("entry");
    } finally {
      value.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps variant identity hidden until an eligible actor records a decision", () => {
    const { value, dir } = journal();
    try {
      const runA = createRun(value, "pair-a");
      const runB = createRun(value, "pair-b");
      value.saveComparison({
        id: "cmp-2",
        evidenceRevision: 1,
        runs: [
          { runId: runA, revision: 1 },
          { runId: runB, revision: 1 },
        ],
        anchors: [],
      });
      const assignment = value.createPairwiseAssignment({
        id: "pair-1",
        comparisonId: "cmp-2",
        runA: { runId: runA, revision: 1 },
        runB: { runId: runB, revision: 1 },
        sideA: "side-1",
        sideB: "side-2",
        rubric: { quality: true },
        eligibleActor: "alice",
        evidenceRevision: 1,
        leakageRisk: ["diff names may leak identity"],
        evidenceA: [{ label: "tests", value: "pass" }],
        evidenceB: [{ label: "tests", value: "pass" }],
      });
      expect(
        JSON.stringify({ side: assignment.sideA, evidence: value.pairwiseEvidence(assignment.id) }),
      ).not.toContain(runA);
      expect(() =>
        value.pairwiseDecision({
          assignmentId: assignment.id,
          actor: "bob",
          choice: "a",
          idempotencyKey: "wrong",
        }),
      ).toThrow("eligible");
      const decision = value.pairwiseDecision({
        assignmentId: assignment.id,
        actor: "alice",
        choice: "tie",
        idempotencyKey: "one",
      });
      expect(decision.choice).toBe("tie");
      expect(value.latestPairwiseDecision(assignment.id)?.choice).toBe("tie");
      const correction = value.pairwiseDecision({
        assignmentId: assignment.id,
        actor: "alice",
        choice: "a",
        idempotencyKey: "two",
        correctionOf: decision.id,
      });
      expect(correction.correctionOf).toBe(decision.id);
      expect(value.latestPairwiseDecision(assignment.id)?.choice).toBe("a");
      expect(() =>
        value.pairwiseDecision({
          assignmentId: assignment.id,
          actor: "alice",
          choice: "b",
          idempotencyKey: "two",
        }),
      ).toThrow("payload conflict");
    } finally {
      value.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("human pairwise decisions do not overwrite deterministic evidence", async () => {
    const { value, dir } = journal();
    try {
      const bundle = {
        formatVersion: 1,
        semanticVersions: { compiler: "1", expressions: "1", schemas: "1" },
        rootDefinitionId: "root",
        definitions: {},
        schemas: {},
        limits: {} as never,
        sourceMap: {},
        boundSummary: { scopes: 1, invocations: 1, attempts: 1, saturated: false },
        digest: "bundle",
        canonicalJson: "{}",
      } as never;
      const created = value.createRun({
        workflowId: "fixture",
        bundle,
        idempotencyKey: "human-evidence-run",
      });
      value.append({
        runId: created.run.runId,
        type: "run.started",
        payload: { rootDefinitionId: "root" },
      });
      const deterministic = await makeEvidence({
        id: "deterministic-1",
        evaluator: { id: "tests", version: "1", sourceDigest: "tests" },
        evidenceClass: "deterministic",
        target: { runId: created.run.runId, revision: 1 },
        name: "tests",
        status: "passed",
        value: { passed: 3 },
      });
      value.recordEvaluationEvidence(deterministic);
      const other = createRun(value, "other-human-run");
      value.saveComparison({
        id: "cmp-3",
        evidenceRevision: 1,
        runs: [
          { runId: created.run.runId, revision: 1 },
          { runId: other, revision: 1 },
        ],
        anchors: [],
      });
      const assignment = value.createPairwiseAssignment({
        id: "pair-3",
        comparisonId: "cmp-3",
        runA: { runId: created.run.runId, revision: 1 },
        runB: { runId: other, revision: 1 },
        sideA: "a",
        sideB: "b",
        rubric: { quality: true },
        eligibleActor: "alice",
        evidenceRevision: 1,
        leakageRisk: [],
        evidenceA: [{ kind: "human", value: "A" }],
        evidenceB: [{ kind: "human", value: "B" }],
      });
      value.pairwiseDecision({
        assignmentId: assignment.id,
        actor: "alice",
        choice: "a",
        idempotencyKey: "human-decision-1",
      });
      expect(value.getEvaluationEvidence(created.run.runId, { revision: 1 })).toEqual([
        deterministic,
      ]);
      expect(value.getEvaluationEvidence(created.run.runId, { evaluatorId: "tests" })).toEqual([
        deterministic,
      ]);
    } finally {
      value.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
