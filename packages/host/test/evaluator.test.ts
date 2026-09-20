import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  runDeterministicCommandEvaluator,
  type VerifierProcess,
} from "../src/evaluation/verifier.ts";
import { Journal } from "../src/storage/journal.ts";
import { makeEvidence } from "@kouro/core";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const evaluator = { id: "acceptance", version: "1", sourceDigest: "module-sha" };
const target = { runId: "run_candidate", revision: 12, treeDigest: "tree-sha" };

describe("deterministic evaluator", () => {
  test("keeps acceptance source outside the candidate tree and binds its digest", async () => {
    mkdirSync("/tmp/kouro-candidate", { recursive: true });
    let observed: { cwd: string; source: string } | undefined;
    const process: VerifierProcess = {
      async execute(input) {
        observed = { cwd: input.cwd, source: input.env.KOURO_ACCEPTANCE_SOURCE };
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          spawnError: null,
          stdout: new TextEncoder().encode("ok"),
          stderr: new Uint8Array(),
        };
      },
    };
    const result = await runDeterministicCommandEvaluator({
      evaluator,
      target,
      candidateWorkspace: "/tmp/kouro-candidate",
      candidateTreeDigest: "tree-sha",
      resolveCandidateTreeDigest: () => "tree-sha",
      verifierWorkspace: "/tmp/kouro-verifier",
      acceptanceSource: new TextEncoder().encode("assert candidate()"),
      executable: "true",
      process,
    });
    expect(result.evidence.status).toBe("passed");
    expect(observed?.cwd.startsWith("/tmp/kouro-verifier/run-")).toBe(true);
    expect(observed?.cwd.endsWith("/candidate")).toBe(true);
    expect(observed?.source.startsWith("/tmp/kouro-verifier/run-")).toBe(true);
    expect(observed?.source.startsWith("/tmp/kouro-candidate/")).toBe(false);
    expect(existsSync(observed!.source)).toBe(false);
    expect(result.evidence.target).toEqual(target);
    expect(result.evidence.evaluatorConfigDigest).toBeTruthy();
  });

  test("can repeat the same evaluator without stale read-only source files", async () => {
    mkdirSync("/tmp/kouro-repeat-candidate", { recursive: true });
    const process: VerifierProcess = {
      async execute(input) {
        expect(existsSync(input.env.KOURO_ACCEPTANCE_SOURCE)).toBe(true);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          spawnError: null,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      },
    };
    const input = {
      evaluator,
      target,
      candidateWorkspace: "/tmp/kouro-repeat-candidate",
      candidateTreeDigest: "tree-sha",
      resolveCandidateTreeDigest: () => "tree-sha",
      verifierWorkspace: "/tmp/kouro-repeat-verifier",
      acceptanceSource: new Uint8Array([4, 5]),
      executable: "true",
      process,
    };
    expect((await runDeterministicCommandEvaluator(input)).evidence.status).toBe("passed");
    expect((await runDeterministicCommandEvaluator(input)).evidence.status).toBe("passed");
  });

  test("distinguishes candidate command failure from evaluator infrastructure error", async () => {
    mkdirSync("/tmp/kouro-candidate-failure", { recursive: true });
    mkdirSync("/tmp/kouro-candidate-error", { recursive: true });
    const failure = await runDeterministicCommandEvaluator({
      evaluator,
      target,
      candidateWorkspace: "/tmp/kouro-candidate-failure",
      candidateTreeDigest: "tree-sha",
      resolveCandidateTreeDigest: () => "tree-sha",
      verifierWorkspace: "/tmp/kouro-verifier-failure",
      acceptanceSource: new Uint8Array([1]),
      executable: "false",
      process: {
        async execute() {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            spawnError: null,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("assertion failed"),
          };
        },
      },
    });
    expect(failure.evidence.status).toBe("failed");
    const error = await runDeterministicCommandEvaluator({
      evaluator,
      target,
      candidateWorkspace: "/tmp/kouro-candidate-error",
      candidateTreeDigest: "tree-sha",
      resolveCandidateTreeDigest: () => "tree-sha",
      verifierWorkspace: "/tmp/kouro-verifier-error",
      acceptanceSource: new Uint8Array([1]),
      executable: "broken",
      process: {
        async execute() {
          throw new Error("verifier unavailable");
        },
      },
    });
    expect(error.evidence.status).toBe("error");
    expect(error.evidence.explanation).toContain("Evaluator infrastructure failed");
  });

  test("rejects a verifier directory nested in the candidate tree", async () => {
    mkdirSync("/tmp/kouro-tree", { recursive: true });
    await expect(
      runDeterministicCommandEvaluator({
        evaluator,
        target,
        candidateWorkspace: "/tmp/kouro-tree",
        candidateTreeDigest: "tree-sha",
        resolveCandidateTreeDigest: () => "tree-sha",
        verifierWorkspace: "/tmp/kouro-tree/verifier",
        acceptanceSource: new Uint8Array(),
        executable: "true",
        process: {
          async execute() {
            throw new Error("not called");
          },
        },
      }),
    ).rejects.toThrow("outside the candidate workspace");
  });

  test("rejects a changed candidate tree before running acceptance", async () => {
    mkdirSync("/tmp/kouro-digest-candidate", { recursive: true });
    let called = false;
    await expect(
      runDeterministicCommandEvaluator({
        evaluator,
        target,
        candidateWorkspace: "/tmp/kouro-digest-candidate",
        candidateTreeDigest: "expected",
        resolveCandidateTreeDigest: () => "observed",
        verifierWorkspace: "/tmp/kouro-digest-verifier",
        acceptanceSource: new Uint8Array(),
        executable: "true",
        process: {
          async execute() {
            called = true;
            throw new Error("must not run");
          },
        },
      }),
    ).rejects.toThrow("candidate tree digest mismatch");
    expect(called).toBe(false);
  });

  test("runs acceptance against a disposable copy so candidate mutation cannot persist", async () => {
    mkdirSync("/tmp/kouro-copy-candidate", { recursive: true });
    writeFileSync("/tmp/kouro-copy-candidate/file.txt", "original");
    await runDeterministicCommandEvaluator({
      evaluator,
      target,
      candidateWorkspace: "/tmp/kouro-copy-candidate",
      candidateTreeDigest: "tree-sha",
      resolveCandidateTreeDigest: () => "tree-sha",
      verifierWorkspace: "/tmp/kouro-copy-verifier",
      acceptanceSource: new Uint8Array(),
      executable: "true",
      process: {
        async execute(input) {
          writeFileSync(`${input.cwd}/file.txt`, "mutated");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            spawnError: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          };
        },
      },
    });
    expect(readFileSync("/tmp/kouro-copy-candidate/file.txt", "utf8")).toBe("original");
  });

  test("persists evidence idempotently without changing the run projection", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kouro-evidence-journal-"));
    const journal = new Journal({ dataDir });
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
      const created = journal.createRun({
        workflowId: "fixture",
        bundle,
        idempotencyKey: "evidence-run",
      });
      journal.append({
        runId: created.run.runId,
        type: "run.started",
        payload: { rootDefinitionId: "root" },
      });
      const before = journal.getView(created.run.runId)!.revision;
      const evidence = await makeEvidence({
        id: "ev-1",
        evaluator,
        evidenceClass: "deterministic",
        target: { runId: created.run.runId, revision: 1 },
        name: "test",
        status: "passed",
      });
      expect(journal.recordEvaluationEvidence(evidence)).toEqual(evidence);
      expect(journal.recordEvaluationEvidence(evidence)).toEqual(evidence);
      expect(journal.getView(created.run.runId)!.revision).toBe(before);
      expect(
        journal
          .getEvaluationEvidence(created.run.runId, { revision: target.revision })
          .map((item) => item.id),
      ).toEqual([]);
      expect(
        journal.getEvaluationEvidence(created.run.runId, { revision: 1 }).map((item) => item.id),
      ).toEqual(["ev-1"]);
      expect(() =>
        journal.recordEvaluationEvidence({ ...evidence, explanation: "tampered" }),
      ).toThrow();
    } finally {
      journal.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
