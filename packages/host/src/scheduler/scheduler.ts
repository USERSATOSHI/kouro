/**
 * Host-side ready-set scheduler for M4.
 *
 * The scheduler owns admission and ordering only. Effects remain owned by the
 * coordinator; a task is an injected async operation and every durable fact is
 * sent to the coordinator's journal through SchedulerJournal.
 */

export type JoinMode = "all-settled" | "fail-fast";
export type BranchTerminal = "succeeded" | "failed" | "cancelled" | "skipped";

export interface ScopeInstance {
  readonly scopeId: string;
  readonly parentScopeId: string | null;
  readonly definitionId: string;
  readonly activationOrdinal: number;
  readonly controlLineage: readonly string[];
  readonly forkGroupId?: string;
}

export interface SchedulerTask<T = unknown> {
  readonly id: string;
  readonly branchId: string;
  readonly ordinal?: number;
  readonly scope: ScopeInstance;
  readonly resources?: Readonly<Record<string, number>>;
  readonly run?: (signal: AbortSignal) => Promise<T>;
}

export interface JoinGroup {
  readonly id: string;
  readonly expectedBranchIds: readonly string[];
  readonly mode: JoinMode;
}

export interface BranchTerminalRecord {
  readonly groupId: string;
  readonly branchId: string;
  readonly ordinal: number;
  readonly status: BranchTerminal;
  readonly value?: unknown;
  readonly error?: unknown;
}

export type SchedulerRecord =
  | { readonly type: "scope.created"; readonly scope: ScopeInstance }
  | { readonly type: "fork.created"; readonly group: JoinGroup; readonly scopeId: string }
  | {
      readonly type: "invocation.ready";
      readonly taskId: string;
      readonly scopeId: string;
      readonly branchId: string;
    }
  | {
      readonly type: "resource.acquired";
      readonly taskId: string;
      readonly resources: Readonly<Record<string, number>>;
    }
  | { readonly type: "invocation.started"; readonly taskId: string }
  | { readonly type: "branch.terminal"; readonly terminal: BranchTerminalRecord }
  | {
      readonly type: "resource.released";
      readonly taskId: string;
      readonly resources: Readonly<Record<string, number>>;
    }
  | { readonly type: "invocation.cancelled"; readonly taskId: string; readonly reason: string }
  | {
      readonly type: "join.completed";
      readonly groupId: string;
      readonly branches: readonly BranchTerminalRecord[];
    };

export interface SchedulerJournal {
  append(record: SchedulerRecord): void;
}

export interface SchedulerOptions {
  readonly maxConcurrency: number;
  readonly resourceCaps?: Readonly<Record<string, number>>;
  readonly maxScopes?: number;
  readonly maxInvocations?: number;
  readonly journal?: SchedulerJournal;
}

export interface JoinResult {
  readonly groupId: string;
  /** Always sorted by expectedBranchIds, never by completion time. */
  readonly branches: readonly BranchTerminalRecord[];
  readonly status: "succeeded" | "failed" | "cancelled";
}

export interface ScheduleResult {
  readonly joins: Readonly<Record<string, JoinResult>>;
  readonly cancelled: boolean;
}

const noopJournal: SchedulerJournal = { append: () => undefined };

export class ReadySetScheduler {
  private readonly journal: SchedulerJournal;
  private readonly caps: Readonly<Record<string, number>>;
  private readonly active = new Map<string, { task: SchedulerTask; controller: AbortController }>();
  private readonly held = new Map<string, number>();
  private readonly cancelledGroups = new Set<string>();
  private cancelled = false;

  constructor(private readonly options: SchedulerOptions) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1)
      throw new Error("maxConcurrency must be a positive integer");
    this.journal = options.journal ?? noopJournal;
    this.caps = options.resourceCaps ?? {};
    for (const [name, cap] of Object.entries(this.caps))
      if (!Number.isSafeInteger(cap) || cap < 1)
        throw new Error(`resource cap ${name} must be positive`);
  }

  cancel(reason = "scheduler cancelled"): void {
    this.cancelled = true;
    for (const { controller } of this.active.values()) controller.abort(reason);
  }

  async run(
    tasks: readonly SchedulerTask[],
    groups: readonly JoinGroup[],
  ): Promise<ScheduleResult> {
    this.validate(tasks, groups);
    const sorted = [...tasks].sort(
      (a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.id.localeCompare(b.id),
    );
    const groupByBranch = new Map<string, JoinGroup>();
    for (const group of groups)
      for (const branch of group.expectedBranchIds) groupByBranch.set(branch, group);
    for (const task of sorted) {
      this.journal.append({ type: "scope.created", scope: task.scope });
      this.journal.append({
        type: "invocation.ready",
        taskId: task.id,
        scopeId: task.scope.scopeId,
        branchId: task.branchId,
      });
    }
    for (const group of groups) {
      const scopeId =
        sorted.find((task) => group.expectedBranchIds.includes(task.branchId))?.scope
          .parentScopeId ?? "root";
      this.journal.append({ type: "fork.created", group, scopeId });
    }

    const terminals = new Map<string, BranchTerminalRecord>();
    const pending = [...sorted];
    const settle = (task: SchedulerTask, terminal: BranchTerminalRecord) => {
      terminals.set(task.branchId, terminal);
      this.journal.append({ type: "branch.terminal", terminal });
    };

    while (pending.length || this.active.size) {
      if (!this.cancelled) {
        for (
          let index = 0;
          index < pending.length && this.active.size < this.options.maxConcurrency;
        ) {
          const task = pending[index]!;
          const group = groupByBranch.get(task.branchId);
          if (group && this.cancelledGroups.has(group.id)) {
            pending.splice(index, 1);
            settle(task, {
              groupId: group.id,
              branchId: task.branchId,
              ordinal: task.ordinal ?? 0,
              status: "cancelled",
              error: "fail-fast branch failure",
            });
            this.journal.append({
              type: "invocation.cancelled",
              taskId: task.id,
              reason: "fail-fast branch failure",
            });
            continue;
          }
          if (!this.canAcquire(task)) {
            index += 1;
            continue;
          }
          pending.splice(index, 1);
          if (!task.run) {
            settle(task, {
              groupId: groupByBranch.get(task.branchId)?.id ?? "",
              branchId: task.branchId,
              ordinal: task.ordinal ?? 0,
              status: "skipped",
            });
            continue;
          }
          this.acquire(task);
          const controller = new AbortController();
          this.active.set(task.id, { task, controller });
          this.journal.append({ type: "invocation.started", taskId: task.id });
          void task
            .run(controller.signal)
            .then(
              (value) =>
                settle(task, {
                  groupId: groupByBranch.get(task.branchId)?.id ?? "",
                  branchId: task.branchId,
                  ordinal: task.ordinal ?? 0,
                  status: "succeeded",
                  value,
                }),
              (error) =>
                settle(task, {
                  groupId: groupByBranch.get(task.branchId)?.id ?? "",
                  branchId: task.branchId,
                  ordinal: task.ordinal ?? 0,
                  status: this.cancelled || controller.signal.aborted ? "cancelled" : "failed",
                  error,
                }),
            )
            .finally(() => {
              this.release(task);
              this.active.delete(task.id);
              const group = groupByBranch.get(task.branchId);
              if (
                group?.mode === "fail-fast" &&
                terminals.get(task.branchId)?.status === "failed"
              ) {
                this.cancelledGroups.add(group.id);
                for (const active of this.active.values())
                  if (group.expectedBranchIds.includes(active.task.branchId))
                    active.controller.abort("fail-fast branch failure");
              }
            });
        }
      }
      if (this.active.size)
        await Promise.race(
          [...this.active.values()].map(({ task }) => this.waitForTask(task, terminals)),
        );
      else if (pending.length) {
        for (const task of pending.splice(0)) {
          settle(task, {
            groupId: groupByBranch.get(task.branchId)?.id ?? "",
            branchId: task.branchId,
            ordinal: task.ordinal ?? 0,
            status: this.cancelled ? "cancelled" : "failed",
            error: this.cancelled ? "cancelled" : "resource limit prevents admission",
          });
          this.journal.append({
            type: "invocation.cancelled",
            taskId: task.id,
            reason: this.cancelled ? "scheduler cancelled" : "resource limit prevents admission",
          });
        }
      }
    }

    const joins: Record<string, JoinResult> = {};
    for (const group of groups) {
      const branchRecords = group.expectedBranchIds.map(
        (branchId, ordinal) =>
          terminals.get(branchId) ?? {
            groupId: group.id,
            branchId,
            ordinal,
            status: "skipped" as const,
          },
      );
      const status = branchRecords.some((branch) => branch.status === "failed")
        ? "failed"
        : branchRecords.some((branch) => branch.status === "cancelled")
          ? "cancelled"
          : "succeeded";
      joins[group.id] = { groupId: group.id, branches: branchRecords, status };
      this.journal.append({ type: "join.completed", groupId: group.id, branches: branchRecords });
    }
    return { joins, cancelled: this.cancelled };
  }

  private async waitForTask(
    task: SchedulerTask,
    terminals: Map<string, BranchTerminalRecord>,
  ): Promise<void> {
    while (!terminals.has(task.branchId) && this.active.has(task.id))
      await new Promise((resolve) => setTimeout(resolve, 0));
  }

  private validate(tasks: readonly SchedulerTask[], groups: readonly JoinGroup[]): void {
    const taskIds = new Set<string>();
    const branchIds = new Set<string>();
    for (const task of tasks) {
      if (taskIds.has(task.id)) throw new Error(`duplicate task ${task.id}`);
      if (branchIds.has(task.branchId)) throw new Error(`duplicate branch ${task.branchId}`);
      taskIds.add(task.id);
      branchIds.add(task.branchId);
      if (
        task.resources &&
        Object.values(task.resources).some((value) => !Number.isSafeInteger(value) || value < 1)
      )
        throw new Error(`invalid resource claim for ${task.id}`);
      for (const [name, amount] of Object.entries(task.resources ?? {}))
        if (amount > (this.caps[name] ?? amount))
          throw new Error(`resource limit exceeded for ${name}`);
    }
    const expected = groups.flatMap((group) => group.expectedBranchIds);
    if (new Set(expected).size !== expected.length)
      throw new Error("branch belongs to multiple join groups");
    if (expected.some((branch) => !branchIds.has(branch)))
      throw new Error("join references unknown branch");
    if (this.options.maxScopes !== undefined && tasks.length > this.options.maxScopes)
      throw new Error("scope limit exceeded");
    if (this.options.maxInvocations !== undefined && tasks.length > this.options.maxInvocations)
      throw new Error("invocation limit exceeded");
  }

  private canAcquire(task: SchedulerTask): boolean {
    for (const [name, amount] of Object.entries(task.resources ?? {}))
      if ((this.held.get(name) ?? 0) + amount > (this.caps[name] ?? amount)) return false;
    return true;
  }
  private acquire(task: SchedulerTask): void {
    const resources = task.resources ?? {};
    for (const [name, amount] of Object.entries(resources))
      this.held.set(name, (this.held.get(name) ?? 0) + amount);
    this.journal.append({ type: "resource.acquired", taskId: task.id, resources });
  }
  private release(task: SchedulerTask): void {
    const resources = task.resources ?? {};
    for (const [name, amount] of Object.entries(resources))
      this.held.set(name, (this.held.get(name) ?? 0) - amount);
    this.journal.append({ type: "resource.released", taskId: task.id, resources });
  }
}
