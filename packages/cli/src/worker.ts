import { randomUUID } from 'node:crypto';

import type { RunAggregate } from '@kouro/executors';
import type { SqliteEventStore } from '@kouro/persistence-sqlite';

export interface WorkerRunServices {
  coordinatorFor(aggregate: RunAggregate): import('@kouro/executors').RunCoordinator;
  prepareDelivery(aggregate: RunAggregate): Promise<void>;
  finalize(aggregate: RunAggregate): Promise<void>;
}

export interface WorkerClock {
  nowMs(): number;
}

function waitingDue(aggregate: RunAggregate, nowMs: number): boolean {
  return aggregate.state.invocations.some(({ state, wait }) => {
    if (state !== 'waiting' || wait?.dueAt === undefined) return false;
    const due = Date.parse(wait.dueAt);
    return !Number.isNaN(due) && nowMs >= due;
  });
}

function runDurationDue(aggregate: RunAggregate, nowMs: number): boolean {
  const limit = aggregate.artifact.bundle.runLimits?.maxDurationMs;
  if (limit === undefined || aggregate.state.startedAt === undefined) return false;
  const startedAt = Date.parse(aggregate.state.startedAt);
  return !Number.isNaN(startedAt) && nowMs - startedAt >= limit;
}

function stableBoundary(aggregate: RunAggregate, nowMs: number): boolean {
  return (
    (aggregate.state.status !== 'running' &&
      !(
        aggregate.state.status === 'waiting' &&
        (waitingDue(aggregate, nowMs) || runDurationDue(aggregate, nowMs))
      )) ||
    aggregate.state.invocations.some(
      ({ state }) => state === 'waiting_for_approval' || state === 'interrupted',
    )
  );
}

export class LocalWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private advancing = false;
  private ownsLease = false;
  private recoveredLease = false;
  private renewAfterMs = 0;
  private ownershipCheck: Promise<boolean> | undefined;
  private readonly blockedAtSequence = new Map<string, number>();

  constructor(
    private readonly store: SqliteEventStore,
    private readonly services: WorkerRunServices,
    private readonly intervalMs = 250,
    private readonly leaseDurationMs = 10_000,
    private readonly ownerId = randomUUID(),
    private readonly clock: WorkerClock = { nowMs: () => Date.now() },
  ) {}

  async recover(): Promise<void> {
    if (!(await this.ensureOwnership())) return;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.maintain(), this.intervalMs);
    void this.maintain();
  }

  async runUntilStable(runId: string): Promise<RunAggregate> {
    this.start();
    for (;;) {
      const loaded = this.store.loadRun(runId);
      if (loaded.isErr()) throw new Error(`Run ${runId} could not be loaded`);
      if (stableBoundary(loaded.unwrap(), this.clock.nowMs())) return loaded.unwrap();
      if ((await this.ensureOwnership()) && !this.advancing) {
        this.advancing = true;
        try {
          return await this.advanceUntilStable(runId);
        } finally {
          this.advancing = false;
        }
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, this.intervalMs));
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.ownsLease) this.store.releaseWorkerLease(this.ownerId);
    this.ownsLease = false;
    this.recoveredLease = false;
  }

  private async recoverOwnedRuns(): Promise<void> {
    const listed = this.store.listRuns();
    if (listed.isErr()) throw new Error('Could not list runs during startup recovery');
    for (const aggregate of listed.unwrap()) {
      if (aggregate.state.status !== 'running') continue;
      const recovered = this.services.coordinatorFor(aggregate).recoverRun(aggregate.runId);
      if (recovered.isErr()) throw new Error(`Could not recover run ${aggregate.runId}`);
    }
  }

  private async advanceUntilStable(runId: string): Promise<RunAggregate> {
    for (;;) {
      const loaded = this.store.loadRun(runId);
      if (loaded.isErr()) throw new Error(`Run ${runId} could not be loaded`);
      const aggregate = loaded.unwrap();
      if (stableBoundary(aggregate, this.clock.nowMs())) return aggregate;
      const pendingDelivery = aggregate.state.invocations.find(({ state, nodeId }) => {
        const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === nodeId);
        return state === 'pending' && definition?.type === 'delivery_review';
      });
      if (pendingDelivery && !aggregate.state.delivery?.proposal) {
        await this.services.prepareDelivery(aggregate);
        continue;
      }
      const pendingComplete = aggregate.state.invocations.find(({ state, nodeId }) => {
        const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === nodeId);
        return (
          state === 'pending' && definition?.type === 'complete' && definition.result !== 'failed'
        );
      });
      if (pendingComplete) await this.services.finalize(aggregate);
      const advanced = await this.services.coordinatorFor(aggregate).advanceAvailable(runId);
      if (advanced.isErr()) {
        this.blockedAtSequence.set(runId, aggregate.nextEventSequence);
        return aggregate;
      }
      if (advanced.unwrap().nextEventSequence === aggregate.nextEventSequence) return aggregate;
    }
  }

  private async maintain(): Promise<void> {
    if (!(await this.ensureOwnership()) || this.advancing) return;
    this.advancing = true;
    try {
      const listed = this.store.listRuns();
      if (listed.isErr()) return;
      for (const aggregate of listed.unwrap()) {
        const blockedAt = this.blockedAtSequence.get(aggregate.runId);
        if (blockedAt !== undefined && blockedAt === aggregate.nextEventSequence) continue;
        this.blockedAtSequence.delete(aggregate.runId);
        if (
          aggregate.state.status === 'running' ||
          (aggregate.state.status === 'waiting' &&
            (waitingDue(aggregate, this.clock.nowMs()) ||
              runDurationDue(aggregate, this.clock.nowMs())))
        ) {
          await this.advanceUntilStable(aggregate.runId);
        }
      }
    } finally {
      this.advancing = false;
    }
  }

  private async ensureOwnership(): Promise<boolean> {
    if (this.ownershipCheck) return this.ownershipCheck;
    this.ownershipCheck = this.checkOwnership();
    try {
      return await this.ownershipCheck;
    } finally {
      this.ownershipCheck = undefined;
    }
  }

  private async checkOwnership(): Promise<boolean> {
    const nowMs = this.clock.nowMs();
    if (this.ownsLease && nowMs < this.renewAfterMs) return true;
    const acquired = this.store.tryAcquireWorkerLease(
      this.ownerId,
      nowMs,
      nowMs + this.leaseDurationMs,
    );
    if (acquired.isErr() || !acquired.unwrap()) {
      this.ownsLease = false;
      this.recoveredLease = false;
      return false;
    }
    this.ownsLease = true;
    this.renewAfterMs = nowMs + Math.floor(this.leaseDurationMs / 3);
    if (!this.recoveredLease) {
      await this.recoverOwnedRuns();
      this.recoveredLease = true;
    }
    return true;
  }
}
