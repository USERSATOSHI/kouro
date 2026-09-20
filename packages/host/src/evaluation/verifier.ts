import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvaluationEvidence, EvaluationTarget, EvaluatorIdentity } from "@kouro/core";
import { makeEvidence } from "@kouro/core";

export interface VerifierProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface VerifierProcess {
  execute(input: {
    executable: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
  }): Promise<VerifierProcessResult>;
}

export class BunVerifierProcess implements VerifierProcess {
  async execute(input: {
    executable: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
  }): Promise<VerifierProcessResult> {
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([input.executable, ...input.args], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (cause) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: String(cause),
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
        new Response(child.stderr as ReadableStream<Uint8Array>).arrayBuffer(),
      ]);
      return {
        exitCode,
        signal: null,
        timedOut,
        spawnError: null,
        stdout: new Uint8Array(stdout),
        stderr: new Uint8Array(stderr),
      };
    } catch (cause) {
      return {
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: String(cause),
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface VerifierArtifactSink {
  put(runId: string, bytes: Uint8Array, mediaType: string): { id: string; digest: string };
}

export interface CommandEvaluatorInput {
  readonly evaluator: EvaluatorIdentity;
  readonly target: EvaluationTarget;
  /** Candidate workspace containing the pinned result tree. */
  readonly candidateWorkspace: string;
  /** Tree digest captured from the terminal workspace snapshot. */
  readonly candidateTreeDigest?: string;
  /** Re-observe the candidate immediately before evaluation. */
  readonly resolveCandidateTreeDigest?: () => Promise<string> | string;
  /** Verifier-owned directory; it must not be inside candidateWorkspace. */
  readonly verifierWorkspace: string;
  readonly acceptanceSource: Uint8Array;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly artifactSink?: VerifierArtifactSink;
  readonly process?: VerifierProcess;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Execute acceptance code outside the candidate tree. The evaluator cannot
 * mutate the candidate journal; it receives only a pinned workspace and a
 * verifier-owned acceptance file. Process failures are candidate evidence,
 * while evaluator infrastructure failures are `error`.
 */
export async function runDeterministicCommandEvaluator(input: CommandEvaluatorInput): Promise<{
  evidence: EvaluationEvidence;
  stdout: Uint8Array;
  stderr: Uint8Array;
}> {
  const candidate = resolve(input.candidateWorkspace);
  const verifier = resolve(input.verifierWorkspace);
  if (candidate === verifier || verifier.startsWith(`${candidate}/`)) {
    throw new Error("verifier workspace must be outside the candidate workspace");
  }
  if (!input.candidateTreeDigest || !input.resolveCandidateTreeDigest)
    throw new Error("candidate tree digest and resolver are required for deterministic evaluation");
  const observedTreeDigest = await input.resolveCandidateTreeDigest();
  if (observedTreeDigest !== input.candidateTreeDigest)
    throw new Error(
      `candidate tree digest mismatch: expected ${input.candidateTreeDigest}, observed ${observedTreeDigest}`,
    );
  mkdirSync(verifier, { recursive: true, mode: 0o700 });
  const runVerifier = mkdtempSync(join(verifier, "run-"));
  const acceptance = join(runVerifier, "acceptance-source");
  const isolatedCandidate = join(runVerifier, "candidate");
  cpSync(candidate, isolatedCandidate, { recursive: true, force: false, errorOnExist: true });
  writeFileSync(acceptance, input.acceptanceSource, { mode: 0o400 });
  chmodSync(acceptance, 0o400);
  const sourceDigest = digest(input.acceptanceSource);
  const process = input.process ?? new BunVerifierProcess();
  let result: VerifierProcessResult;
  try {
    result = await process.execute({
      executable: input.executable,
      args: input.args ?? [],
      cwd: isolatedCandidate,
      timeoutMs: input.timeoutMs ?? 120_000,
      env: {
        KOURO_ACCEPTANCE_SOURCE: acceptance,
        KOURO_ACCEPTANCE_SOURCE_DIGEST: sourceDigest,
        KOURO_CANDIDATE_TREE_DIGEST: input.candidateTreeDigest,
      },
    });
  } catch (cause) {
    return {
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      evidence: await makeEvidence({
        id: `${input.evaluator.id}:${input.target.runId}:${input.target.revision}:acceptance`,
        evaluator: input.evaluator,
        evidenceClass: "deterministic",
        target: input.target,
        name: "acceptance.command",
        status: "error",
        explanation: `Evaluator infrastructure failed: ${String(cause)}`,
        completeness: { complete: false, missing: ["process-result"] },
        provenance: [
          { kind: "evaluator", id: input.evaluator.id, producer: sourceDigest },
          {
            kind: "run",
            id: input.target.runId,
            revision: input.target.revision,
            producer: input.candidateTreeDigest,
          },
        ],
      }),
    };
  } finally {
    // The acceptance source is immutable during execution and removed after
    // collection, so a verifier cannot become a durable mutable workspace.
    rmSync(runVerifier, { recursive: true, force: true });
  }
  const stdoutRef = input.artifactSink?.put(input.target.runId, result.stdout, "text/plain");
  const stderrRef = input.artifactSink?.put(input.target.runId, result.stderr, "text/plain");
  const passed = result.exitCode === 0 && !result.timedOut && result.spawnError === null;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    evidence: await makeEvidence({
      id: `${input.evaluator.id}:${input.target.runId}:${input.target.revision}:acceptance`,
      evaluator: {
        ...input.evaluator,
        config: {
          ...(input.evaluator.config as Record<string, unknown> | undefined),
          acceptanceSourceDigest: sourceDigest,
          candidateTreeDigest: input.candidateTreeDigest,
        },
      },
      evidenceClass: "deterministic",
      target: input.target,
      name: "acceptance.command",
      status: passed ? "passed" : "failed",
      value: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        spawnError: result.spawnError,
      },
      supportingArtifactIds: [stdoutRef?.id, stderrRef?.id].filter((id): id is string =>
        Boolean(id),
      ),
      explanation: passed
        ? "Acceptance command passed."
        : "Acceptance command failed on the pinned candidate tree.",
      provenance: [
        { kind: "evaluator", id: input.evaluator.id, producer: sourceDigest },
        {
          kind: "run",
          id: input.target.runId,
          revision: input.target.revision,
          producer: input.candidateTreeDigest,
        },
      ],
    }),
  };
}
