import { Database } from 'bun:sqlite';

import { canonicalJson, sha256 } from '@kouro/adw';
import type {
  ApprovalBinding,
  ArtifactReference,
  CompiledWorkflowArtifact,
  CompiledWorkflowBundle,
  JsonValue,
  NodeAttempt,
  NodeDefinition,
  NodeInvocation,
  RunEvent,
  RunState,
  SkipBinding,
} from '@kouro/domain';
import {
  RunStoreErrorKind,
  type AppendRunEventInput,
  type CreateRunInput,
  type RunAggregate,
  type RunStore,
  type RunStoreError,
} from '@kouro/executors';
import { reduceRun } from '@kouro/runtime';
import { err, ok, safeCall, type Result } from '@usersatoshi/results';

interface RunRow {
  readonly artifact_canonical: string;
  readonly artifact_checksum: string;
  readonly next_sequence: number;
  readonly state_json: string;
}

interface EventRow {
  readonly event_json: string;
}

interface RunIdRow {
  readonly run_id: string;
}

interface IdempotencyRow {
  readonly request_json: string;
}

interface ColumnRow {
  readonly name: string;
}

interface WorkerLeaseRow {
  readonly owner_id: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, toJsonValue(child)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? 'symbol';
  if (typeof value === 'function') return value.name || 'function';
  return null;
}

function canonicalValue(value: unknown): string {
  return canonicalJson(toJsonValue(value));
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'SQLite operation failed';
}

function databaseError(operation: string, error: unknown): RunStoreError {
  return {
    kind: RunStoreErrorKind.DatabaseFailure,
    operation,
    message: messageFor(error),
  };
}

function isNodeDefinition(value: unknown): value is NodeDefinition {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    ['agent', 'approval', 'command', 'complete', 'delivery_review'].includes(String(value.type)) &&
    typeof value.ordinal === 'number' &&
    typeof value.priority === 'number'
  );
}

function isCompiledWorkflowBundle(value: unknown): value is CompiledWorkflowBundle {
  if (!isRecord(value)) return false;
  const manifest = value.manifest;
  const semanticVersions = value.semanticVersions;
  return (
    isRecord(manifest) &&
    typeof manifest.id === 'string' &&
    typeof manifest.version === 'string' &&
    isRecord(semanticVersions) &&
    typeof semanticVersions.compiler === 'string' &&
    typeof semanticVersions.ir === 'string' &&
    typeof semanticVersions.expressions === 'string' &&
    typeof value.entryNodeId === 'string' &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isNodeDefinition) &&
    Array.isArray(value.transitions) &&
    isRecord(value.counterLimits)
  );
}

function isApprovalBinding(value: unknown): value is ApprovalBinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.workflowChecksum === 'string' &&
    typeof value.invocationSequence === 'number' &&
    Array.isArray(value.artifactChecksums) &&
    value.artifactChecksums.every((checksum) => typeof checksum === 'string') &&
    typeof value.resolvedAction === 'string' &&
    typeof value.repositoryHead === 'string' &&
    (value.preparedTree === undefined || typeof value.preparedTree === 'string') &&
    (value.proposalChecksum === undefined || typeof value.proposalChecksum === 'string')
  );
}

function isSkipBinding(value: unknown): value is SkipBinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.workflowChecksum === 'string' &&
    typeof value.invocationSequence === 'number' &&
    Array.isArray(value.artifactChecksums) &&
    value.artifactChecksums.every((checksum) => typeof checksum === 'string') &&
    typeof value.selectedOutcome === 'string' &&
    typeof value.repositoryHead === 'string'
  );
}

function hasNumber(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return typeof record[key] === 'number';
}

function hasOptionalTimestamp(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function isTokenUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const counts = [
    value.inputTokens,
    value.outputTokens,
    ...(value.cacheReadTokens === undefined ? [] : [value.cacheReadTokens]),
    ...(value.cacheWriteTokens === undefined ? [] : [value.cacheWriteTokens]),
    ...(value.reasoningTokens === undefined ? [] : [value.reasoningTokens]),
  ];
  return (
    counts.length >= 2 &&
    counts.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
  );
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isSubagentExecutionSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumber(value, 'sequence') &&
    typeof value.callId === 'string' &&
    typeof value.subagentId === 'string' &&
    typeof value.task === 'string' &&
    typeof value.harnessId === 'string' &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.reasoningEffort === undefined ||
      (typeof value.reasoningEffort === 'string' &&
        ['low', 'medium', 'high'].includes(value.reasoningEffort))) &&
    typeof value.state === 'string' &&
    ['succeeded', 'failed'].includes(value.state) &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.usage === undefined || isTokenUsage(value.usage)) &&
    (value.output === undefined || isJsonValue(value.output))
  );
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    [
      'agent_output',
      'harness_transcript',
      'command_output',
      'git_diff',
      'git_status',
      'delivery_proposal',
    ].includes(String(value.kind)) &&
    typeof value.mediaType === 'string' &&
    typeof value.checksum === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.checksum) &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  if (!isRecord(value) || !hasNumber(value, 'sequence') || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'run.created':
      return (
        typeof value.workflowChecksum === 'string' &&
        typeof value.startingCommit === 'string' &&
        isRecord(value.configuration) &&
        (value.startedAt === undefined || typeof value.startedAt === 'string')
      );
    case 'run.time_observed':
      return typeof value.observedAt === 'string';
    case 'run.paused':
    case 'run.resumed':
      return typeof value.actor === 'string';
    case 'run.cancelled':
      return (
        typeof value.actor === 'string' &&
        typeof value.reason === 'string' &&
        hasOptionalTimestamp(value, 'finishedAt')
      );
    case 'invocation.activated':
      return (
        hasNumber(value, 'invocationSequence') &&
        typeof value.nodeId === 'string' &&
        hasOptionalTimestamp(value, 'activatedAt')
      );
    case 'attempt.started':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        (value.harnessId === undefined || typeof value.harnessId === 'string') &&
        (value.model === undefined || typeof value.model === 'string') &&
        (value.resumeToken === undefined || typeof value.resumeToken === 'string')
      );
    case 'attempt.resumed':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        typeof value.harnessId === 'string' &&
        typeof value.resumeToken === 'string'
      );
    case 'attempt.resume_token_recorded':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        typeof value.resumeToken === 'string'
      );
    case 'attempt.artifact_published':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        isArtifactReference(value.artifact)
      );
    case 'attempt.usage_recorded':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        isTokenUsage(value.usage)
      );
    case 'attempt.subagents_recorded':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        Array.isArray(value.subagents) &&
        value.subagents.every(isSubagentExecutionSummary)
      );
    case 'run.artifact_published':
      return isArtifactReference(value.artifact);
    case 'delivery.proposed':
      return isRecord(value.proposal) && hasNumber(value.proposal, 'invocationSequence');
    case 'delivery.metadata_updated':
      return (
        hasNumber(value, 'invocationSequence') &&
        isRecord(value.metadata) &&
        typeof value.checksum === 'string' &&
        typeof value.actor === 'string'
      );
    case 'delivery.committed':
      return (
        hasNumber(value, 'invocationSequence') &&
        typeof value.preparedTree === 'string' &&
        typeof value.commit === 'string' &&
        typeof value.branch === 'string'
      );
    case 'delivery.publication_started':
      return (
        (value.provider === 'github' || value.provider === 'forgejo') &&
        typeof value.remote === 'string'
      );
    case 'delivery.publication_succeeded':
      return (
        (value.provider === 'github' || value.provider === 'forgejo') &&
        typeof value.remote === 'string' &&
        typeof value.number === 'number' &&
        typeof value.url === 'string'
      );
    case 'delivery.publication_failed':
      return (
        (value.provider === 'github' || value.provider === 'forgejo') &&
        typeof value.remote === 'string' &&
        typeof value.error === 'string'
      );
    case 'attempt.failed':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        isRecord(value.failure) &&
        typeof value.failure.kind === 'string' &&
        typeof value.failure.message === 'string' &&
        (value.retry === 'fallback' || value.retry === 'none') &&
        hasOptionalTimestamp(value, 'finishedAt')
      );
    case 'attempt.interrupted':
      return hasNumber(value, 'invocationSequence') && hasNumber(value, 'attemptNumber');
    case 'attempt.interrupt_requested':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        typeof value.actor === 'string' &&
        typeof value.reason === 'string'
      );
    case 'agent.steering_requested':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        typeof value.actor === 'string' &&
        typeof value.message === 'string'
      );
    case 'agent.steering_applied':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        hasNumber(value, 'requestSequence')
      );
    case 'agent.steering_rejected':
      return (
        hasNumber(value, 'invocationSequence') &&
        hasNumber(value, 'attemptNumber') &&
        hasNumber(value, 'requestSequence') &&
        typeof value.reason === 'string'
      );
    case 'invocation.retry_requested':
      return (
        hasNumber(value, 'invocationSequence') &&
        typeof value.actor === 'string' &&
        typeof value.reason === 'string'
      );
    case 'invocation.skipped':
      return (
        isSkipBinding(value.binding) &&
        typeof value.actor === 'string' &&
        typeof value.reason === 'string' &&
        hasOptionalTimestamp(value, 'finishedAt')
      );
    case 'invocation.completed':
      return (
        hasNumber(value, 'invocationSequence') &&
        typeof value.outcome === 'string' &&
        hasOptionalTimestamp(value, 'finishedAt')
      );
    case 'approval.requested':
      return isApprovalBinding(value.binding);
    case 'approval.granted':
    case 'approval.rejected':
    case 'approval.changes_requested':
      return (
        isApprovalBinding(value.binding) &&
        typeof value.actor === 'string' &&
        typeof value.reason === 'string' &&
        hasOptionalTimestamp(value, 'finishedAt')
      );
    case 'run.completed':
      return (
        (value.result === 'succeeded' || value.result === 'failed') &&
        hasOptionalTimestamp(value, 'finishedAt')
      );
    default:
      return false;
  }
}

function parseArtifact(
  runId: string,
  canonical: string,
  checksum: string,
): Result<CompiledWorkflowArtifact, RunStoreError> {
  if (sha256(canonical) !== checksum) {
    return err({
      kind: RunStoreErrorKind.CorruptData,
      runId,
      reason: 'compiled workflow checksum does not match its canonical bytes',
    });
  }
  const parsed: unknown = JSON.parse(canonical);
  if (!isCompiledWorkflowBundle(parsed) || canonicalValue(parsed) !== canonical) {
    return err({
      kind: RunStoreErrorKind.CorruptData,
      runId,
      reason: 'compiled workflow is malformed or non-canonical',
    });
  }
  return ok({
    bundle: parsed,
    canonical,
    checksum,
  });
}

function parseEvent(runId: string, serialized: string): Result<RunEvent, RunStoreError> {
  const parsed: unknown = JSON.parse(serialized);
  return isRunEvent(parsed)
    ? ok(parsed)
    : err({
        kind: RunStoreErrorKind.CorruptData,
        runId,
        reason: 'event history contains a malformed event',
      });
}

function stateError(runId: string, error: unknown): RunStoreError {
  return {
    kind: RunStoreErrorKind.InvalidEvent,
    runId,
    error: toJsonValue(error),
  };
}

export class SqliteEventStore implements RunStore {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, {
      create: true,
      strict: true,
    });
  }

  initialize(): Result<void, RunStoreError> {
    return safeCall(
      () => {
        this.database.exec('PRAGMA foreign_keys = ON');
        this.database.exec('PRAGMA journal_mode = WAL');
        this.database.exec('PRAGMA busy_timeout = 5000');
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            artifact_canonical TEXT NOT NULL,
            artifact_checksum TEXT NOT NULL,
            next_sequence INTEGER NOT NULL,
            state_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS events (
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            event_json TEXT NOT NULL,
            PRIMARY KEY (run_id, sequence),
            FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS idempotency_records (
            run_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_json TEXT NOT NULL,
            event_sequence INTEGER NOT NULL,
            PRIMARY KEY (run_id, idempotency_key),
            FOREIGN KEY (run_id, event_sequence)
              REFERENCES events(run_id, sequence) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS run_projections (
            run_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            next_invocation_sequence INTEGER NOT NULL,
            state_json TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS invocation_projections (
            run_id TEXT NOT NULL,
            invocation_sequence INTEGER NOT NULL,
            node_id TEXT NOT NULL,
            state TEXT NOT NULL,
            outcome TEXT,
            selected_transition_id TEXT,
            PRIMARY KEY (run_id, invocation_sequence),
            FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS attempt_projections (
            run_id TEXT NOT NULL,
            invocation_sequence INTEGER NOT NULL,
            attempt_number INTEGER NOT NULL,
            state TEXT NOT NULL,
            harness_id TEXT,
            model TEXT,
            resume_token TEXT,
            failure_json TEXT,
            PRIMARY KEY (run_id, invocation_sequence, attempt_number),
            FOREIGN KEY (run_id, invocation_sequence)
              REFERENCES invocation_projections(run_id, invocation_sequence)
              ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS approval_projections (
            run_id TEXT NOT NULL,
            invocation_sequence INTEGER NOT NULL,
            state TEXT NOT NULL,
            binding_json TEXT NOT NULL,
            PRIMARY KEY (run_id, invocation_sequence),
            FOREIGN KEY (run_id, invocation_sequence)
              REFERENCES invocation_projections(run_id, invocation_sequence)
              ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS artifact_projections (
            run_id TEXT NOT NULL,
            invocation_sequence INTEGER NOT NULL,
            attempt_number INTEGER NOT NULL,
            artifact_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            media_type TEXT NOT NULL,
            checksum TEXT NOT NULL,
            size INTEGER NOT NULL,
            PRIMARY KEY (run_id, invocation_sequence, attempt_number, artifact_id),
            FOREIGN KEY (run_id, invocation_sequence, attempt_number)
              REFERENCES attempt_projections(run_id, invocation_sequence, attempt_number)
              ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS run_artifact_projections (
            run_id TEXT NOT NULL,
            artifact_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            media_type TEXT NOT NULL,
            checksum TEXT NOT NULL,
            size INTEGER NOT NULL,
            PRIMARY KEY (run_id, artifact_id),
            FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS worker_leases (
            lease_name TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            expires_at_ms INTEGER NOT NULL
          );
        `);
        const attemptColumns = new Set(
          this.database
            .query<ColumnRow, []>('SELECT name FROM pragma_table_info("attempt_projections")')
            .all()
            .map(({ name }) => name),
        );
        if (!attemptColumns.has('harness_id')) {
          this.database.exec('ALTER TABLE attempt_projections ADD COLUMN harness_id TEXT');
        }
        if (!attemptColumns.has('model')) {
          this.database.exec('ALTER TABLE attempt_projections ADD COLUMN model TEXT');
        }
        if (!attemptColumns.has('failure_json')) {
          this.database.exec('ALTER TABLE attempt_projections ADD COLUMN failure_json TEXT');
        }
      },
      (error) => databaseError('initialize', error),
    );
  }

  dispose(): void {
    this.database.close();
  }

  createRun(input: CreateRunInput): Result<RunAggregate, RunStoreError> {
    return this.executeTransaction('createRun', () => {
      const validatedArtifact = parseArtifact(
        input.runId,
        input.artifact.canonical,
        input.artifact.checksum,
      );
      if (
        validatedArtifact.isErr() ||
        canonicalValue(input.artifact.bundle) !== input.artifact.canonical
      ) {
        return err({
          kind: RunStoreErrorKind.InvalidArtifact,
          runId: input.runId,
          reason: validatedArtifact.isErr()
            ? canonicalValue(validatedArtifact.error)
            : 'compiled workflow bundle does not match its canonical bytes',
        });
      }

      const existing = this.readRunRow(input.runId);
      const event: RunEvent = {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: input.artifact.checksum,
        startingCommit: input.startingCommit,
        configuration: input.configuration,
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      };
      const requestJson = canonicalValue({
        artifactChecksum: input.artifact.checksum,
        event,
      });

      if (existing) {
        const idempotency = this.readIdempotency(input.runId, input.idempotencyKey);
        if (idempotency?.request_json === requestJson) {
          return this.loadRunUnsafe(input.runId);
        }
        return idempotency
          ? err({
              kind: RunStoreErrorKind.IdempotencyConflict,
              runId: input.runId,
              idempotencyKey: input.idempotencyKey,
            })
          : err({
              kind: RunStoreErrorKind.RunAlreadyExists,
              runId: input.runId,
            });
      }

      const reduced = reduceRun(input.artifact, [event]);
      if (reduced.isErr()) return err(stateError(input.runId, reduced.error));
      const state = reduced.unwrap();

      const stateJson = canonicalValue(state);
      this.database
        .query(
          `INSERT INTO runs (
            run_id, artifact_canonical, artifact_checksum, next_sequence, state_json
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.runId, input.artifact.canonical, input.artifact.checksum, 2, stateJson);
      this.insertEvent(input.runId, input.idempotencyKey, event, requestJson);
      this.replaceProjections(input.runId, state);
      return ok({
        runId: input.runId,
        artifact: input.artifact,
        events: [event],
        state,
        nextEventSequence: 2,
      });
    });
  }

  loadRun(runId: string): Result<RunAggregate, RunStoreError> {
    const loaded = safeCall(
      () => this.loadRunUnsafe(runId),
      (error) => databaseError('loadRun', error),
    );
    return loaded.isErr() ? loaded : loaded.unwrap();
  }

  listRuns(): Result<readonly RunAggregate[], RunStoreError> {
    const listed = safeCall(
      () =>
        this.database
          .query<RunIdRow, []>('SELECT run_id FROM runs ORDER BY run_id')
          .all()
          .map(({ run_id }) => this.loadRunUnsafe(run_id)),
      (error) => databaseError('listRuns', error),
    );
    if (listed.isErr()) return listed;
    const aggregates: RunAggregate[] = [];
    for (const aggregate of listed.unwrap()) {
      if (aggregate.isErr()) return aggregate;
      aggregates.push(aggregate.unwrap());
    }
    return ok(aggregates);
  }

  /**
   * Acquires or renews the single local-worker lease when it is available.
   *
   * Lease timestamps are supplied by the infrastructure caller so this
   * coordination state never becomes a hidden workflow decision input.
   */
  tryAcquireWorkerLease(
    ownerId: string,
    nowMs: number,
    expiresAtMs: number,
  ): Result<boolean, RunStoreError> {
    return this.executeTransaction('tryAcquireWorkerLease', () => {
      this.database
        .query(
          `INSERT INTO worker_leases (lease_name, owner_id, expires_at_ms)
           VALUES ('local-worker', ?, ?)
           ON CONFLICT(lease_name) DO UPDATE SET
             owner_id = excluded.owner_id,
             expires_at_ms = excluded.expires_at_ms
           WHERE worker_leases.owner_id = excluded.owner_id
              OR worker_leases.expires_at_ms <= ?`,
        )
        .run(ownerId, expiresAtMs, nowMs);
      const lease = this.database
        .query<WorkerLeaseRow, []>(
          `SELECT owner_id FROM worker_leases WHERE lease_name = 'local-worker'`,
        )
        .get();
      return ok(lease?.owner_id === ownerId);
    });
  }

  /** Releases the local-worker lease only when this caller still owns it. */
  releaseWorkerLease(ownerId: string): Result<void, RunStoreError> {
    return safeCall(
      () => {
        this.database
          .query(`DELETE FROM worker_leases WHERE lease_name = 'local-worker' AND owner_id = ?`)
          .run(ownerId);
      },
      (error) => databaseError('releaseWorkerLease', error),
    );
  }

  /** Permanently removes one run and all SQLite-owned dependent records. */
  deleteRun(runId: string): Result<void, RunStoreError> {
    return this.executeTransaction('deleteRun', () => {
      if (!this.readRunRow(runId)) {
        return err({ kind: RunStoreErrorKind.RunNotFound, runId });
      }
      this.database.query('DELETE FROM runs WHERE run_id = ?').run(runId);
      return ok(undefined);
    });
  }

  appendEvent(input: AppendRunEventInput): Result<RunAggregate, RunStoreError> {
    return this.executeTransaction('appendEvent', () => {
      const existing = this.readIdempotency(input.runId, input.idempotencyKey);
      const requestJson = canonicalValue(input.event);
      if (existing) {
        return existing.request_json === requestJson
          ? this.loadRunUnsafe(input.runId)
          : err({
              kind: RunStoreErrorKind.IdempotencyConflict,
              runId: input.runId,
              idempotencyKey: input.idempotencyKey,
            });
      }

      const aggregate = this.loadRunUnsafe(input.runId);
      if (aggregate.isErr()) return aggregate;
      const current = aggregate.unwrap();
      if (current.nextEventSequence !== input.expectedSequence) {
        return err({
          kind: RunStoreErrorKind.EventSequenceConflict,
          runId: input.runId,
          expected: current.nextEventSequence,
          received: input.expectedSequence,
        });
      }

      const event: RunEvent = {
        sequence: input.expectedSequence,
        ...input.event,
      };
      const events = [...current.events, event];
      const reduced = reduceRun(current.artifact, events);
      if (reduced.isErr()) return err(stateError(input.runId, reduced.error));
      const state = reduced.unwrap();

      this.insertEvent(input.runId, input.idempotencyKey, event, requestJson);
      const nextEventSequence = input.expectedSequence + 1;
      this.database
        .query('UPDATE runs SET next_sequence = ?, state_json = ? WHERE run_id = ?')
        .run(nextEventSequence, canonicalValue(state), input.runId);
      this.replaceProjections(input.runId, state);
      return ok({
        ...current,
        events,
        state,
        nextEventSequence,
      });
    });
  }

  private executeTransaction<T>(
    operation: string,
    callback: () => Result<T, RunStoreError>,
  ): Result<T, RunStoreError> {
    const transaction = this.database.transaction(callback);
    const executed = safeCall(
      () => transaction(),
      (error) => databaseError(operation, error),
    );
    return executed.isErr() ? executed : executed.unwrap();
  }

  private readRunRow(runId: string): RunRow | null {
    return this.database
      .query<RunRow, [string]>(
        `SELECT artifact_canonical, artifact_checksum, next_sequence, state_json
         FROM runs WHERE run_id = ?`,
      )
      .get(runId);
  }

  private readIdempotency(runId: string, idempotencyKey: string): IdempotencyRow | null {
    return this.database
      .query<IdempotencyRow, [string, string]>(
        `SELECT request_json FROM idempotency_records
         WHERE run_id = ? AND idempotency_key = ?`,
      )
      .get(runId, idempotencyKey);
  }

  private loadRunUnsafe(runId: string): Result<RunAggregate, RunStoreError> {
    const row = this.readRunRow(runId);
    if (!row) {
      return err({
        kind: RunStoreErrorKind.RunNotFound,
        runId,
      });
    }

    const artifact = parseArtifact(runId, row.artifact_canonical, row.artifact_checksum);
    if (artifact.isErr()) return artifact;

    const eventRows = this.database
      .query<EventRow, [string]>('SELECT event_json FROM events WHERE run_id = ? ORDER BY sequence')
      .all(runId);
    const events: RunEvent[] = [];
    for (const eventRow of eventRows) {
      const event = parseEvent(runId, eventRow.event_json);
      if (event.isErr()) return event;
      events.push(event.unwrap());
    }

    const compiledArtifact = artifact.unwrap();
    const reduced = reduceRun(compiledArtifact, events);
    if (reduced.isErr()) {
      return err({
        kind: RunStoreErrorKind.CorruptData,
        runId,
        reason: `persisted event history is invalid: ${canonicalValue(reduced.error)}`,
      });
    }
    if (
      row.next_sequence !== events.length + 1 ||
      row.state_json !== canonicalValue(reduced.unwrap())
    ) {
      return err({
        kind: RunStoreErrorKind.CorruptData,
        runId,
        reason: 'run projection does not match its event history',
      });
    }

    return ok({
      runId,
      artifact: compiledArtifact,
      events,
      state: reduced.unwrap(),
      nextEventSequence: row.next_sequence,
    });
  }

  private insertEvent(
    runId: string,
    idempotencyKey: string,
    event: RunEvent,
    requestJson: string,
  ): void {
    this.database
      .query(
        `INSERT INTO events (run_id, sequence, event_type, event_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runId, event.sequence, event.type, canonicalValue(event));
    this.database
      .query(
        `INSERT INTO idempotency_records (
          run_id, idempotency_key, request_json, event_sequence
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(runId, idempotencyKey, requestJson, event.sequence);
  }

  private replaceProjections(runId: string, state: RunState): void {
    this.database
      .query(
        `INSERT INTO run_projections (
          run_id, status, next_invocation_sequence, state_json
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          next_invocation_sequence = excluded.next_invocation_sequence,
          state_json = excluded.state_json`,
      )
      .run(runId, state.status, state.nextInvocationSequence, canonicalValue(state));

    this.database.query('DELETE FROM approval_projections WHERE run_id = ?').run(runId);
    this.database.query('DELETE FROM artifact_projections WHERE run_id = ?').run(runId);
    this.database.query('DELETE FROM run_artifact_projections WHERE run_id = ?').run(runId);
    this.database.query('DELETE FROM attempt_projections WHERE run_id = ?').run(runId);
    this.database.query('DELETE FROM invocation_projections WHERE run_id = ?').run(runId);

    for (const invocation of state.invocations) {
      this.insertInvocationProjection(runId, invocation);
      for (const attempt of invocation.attempts) {
        this.insertAttemptProjection(runId, invocation.sequence, attempt);
        for (const artifact of attempt.artifacts ?? []) {
          this.insertArtifactProjection(runId, invocation.sequence, attempt.number, artifact);
        }
      }
      if (invocation.approval) {
        this.insertApprovalProjection(runId, invocation);
      }
    }
    for (const artifact of state.artifacts ?? []) {
      this.insertRunArtifactProjection(runId, artifact);
    }
  }

  private insertInvocationProjection(runId: string, invocation: NodeInvocation): void {
    this.database
      .query(
        `INSERT INTO invocation_projections (
          run_id, invocation_sequence, node_id, state, outcome, selected_transition_id
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        invocation.sequence,
        invocation.nodeId,
        invocation.state,
        invocation.outcome ?? null,
        invocation.selectedTransitionId ?? null,
      );
  }

  private insertAttemptProjection(
    runId: string,
    invocationSequence: number,
    attempt: NodeAttempt,
  ): void {
    this.database
      .query(
        `INSERT INTO attempt_projections (
          run_id, invocation_sequence, attempt_number, state,
          harness_id, model, resume_token, failure_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        invocationSequence,
        attempt.number,
        attempt.state,
        attempt.harnessId ?? null,
        attempt.model ?? null,
        attempt.resumeToken ?? null,
        attempt.failure ? canonicalValue(attempt.failure) : null,
      );
  }

  private insertApprovalProjection(runId: string, invocation: NodeInvocation): void {
    if (!invocation.approval) return;
    this.database
      .query(
        `INSERT INTO approval_projections (
          run_id, invocation_sequence, state, binding_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(runId, invocation.sequence, invocation.state, canonicalValue(invocation.approval));
  }

  private insertArtifactProjection(
    runId: string,
    invocationSequence: number,
    attemptNumber: number,
    artifact: ArtifactReference,
  ): void {
    this.database
      .query(
        `INSERT INTO artifact_projections (
          run_id, invocation_sequence, attempt_number, artifact_id,
          kind, media_type, checksum, size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        invocationSequence,
        attemptNumber,
        artifact.id,
        artifact.kind,
        artifact.mediaType,
        artifact.checksum,
        artifact.size,
      );
  }

  private insertRunArtifactProjection(runId: string, artifact: ArtifactReference): void {
    this.database
      .query(
        `INSERT INTO run_artifact_projections (
          run_id, artifact_id, kind, media_type, checksum, size
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, artifact.id, artifact.kind, artifact.mediaType, artifact.checksum, artifact.size);
  }
}
