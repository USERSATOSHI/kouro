import type { Journal } from "./journal.ts";

export type RecoveryCase = {
  boundary: string;
  durableFact: string;
  restartAction: string;
  replaySafe: boolean;
};

/** The operator-facing crash matrix. Unknown external effects are never replayed. */
export const crashMatrix: readonly RecoveryCase[] = [
  {
    boundary: "command claim",
    durableFact: "effect reserved/claimed",
    restartAction: "resume reserved; reconcile claimed/unknown",
    replaySafe: false,
  },
  {
    boundary: "approval",
    durableFact: "approval binding in projection",
    restartAction: "re-request pending approval with fresh decision",
    replaySafe: false,
  },
  {
    boundary: "branch workspace integration",
    durableFact: "workspace effect and verification result",
    restartAction: "inspect/reconcile; never blindly repeat an unverified integration",
    replaySafe: false,
  },
  {
    boundary: "collaboration batch",
    durableFact: "batch provider_state and message reservations",
    restartAction: "resume not_sent; reconcile uncertain",
    replaySafe: false,
  },
  {
    boundary: "experiment cell",
    durableFact: "cell reservation and run id",
    restartAction: "reuse bound run; release only stale reservation",
    replaySafe: true,
  },
  {
    boundary: "checkpoint/fork",
    durableFact: "idempotent capture/preparation request",
    restartAction: "resume the same request key after validating retained roots",
    replaySafe: true,
  },
];

export type RunRecoveryDiagnostic = {
  runId: string;
  unresolvedEffects: Array<{ id: string; state: string }>;
  pendingOutbox: Array<{ id: string; state: string }>;
  status: string | null;
  action: "none" | "resume-reserved" | "reconcile-claimed";
};

/** Cheap diagnostic query: it deliberately does not load events or full history. */
export function diagnoseRun(journal: Journal, runId: string): RunRecoveryDiagnostic {
  const unresolved = journal.unresolvedEffects().filter((effect) => effect.runId === runId);
  const outbox = journal.checkpointOutbox(runId).filter((effect) => effect.state !== "completed");
  const hasClaimed = unresolved.some((effect) => effect.state === "claimed");
  const hasReserved = unresolved.some((effect) => effect.state === "reserved");
  return {
    runId,
    unresolvedEffects: unresolved,
    pendingOutbox: outbox,
    status: journal.getRunSummary(runId)?.status ?? null,
    action: hasClaimed ? "reconcile-claimed" : hasReserved ? "resume-reserved" : "none",
  };
}
