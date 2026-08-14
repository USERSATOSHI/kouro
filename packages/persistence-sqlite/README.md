# `@kouro/persistence-sqlite` — SQLite Event Store

SQLite-backed event-sourcing persistence for Kouro runs. Implements the `RunStore` port from `@kouro/executors` with append-only event storage, transactional materialized projections, idempotency tracking, and restart-safe loading with corruption detection.

The package also implements `EvaluationStore` with additive tables for bound
evaluation reports, human annotations, pairwise preferences, and evaluation
idempotency records. Evaluation writes never modify the run event stream.

## Architecture

```
RunCoordinator (executors)
    ↓
RunStore (port interface)
    ↓
SqliteEventStore (this package)
    ├── runs table — one row per run with compiled artifact + current state
    ├── events table — append-only event log
    ├── idempotency_records — deduplication for safe retries
    ├── run_projections — denormalized run-level view
    ├── invocation_projections — per-invocation rows
    ├── attempt_projections — per-attempt rows
    ├── approval_projections — per-invocation approval state
    ├── artifact_projections — per-attempt artifacts
    └── run_artifact_projections — run-level artifacts
```

## Usage

```typescript
import { SqliteEventStore } from '@kouro/persistence-sqlite';

const store = new SqliteEventStore('/path/to/kouro.db');

// Initialize (create tables, run migrations)
const initResult = store.initialize();
if (initResult.isErr()) { /* handle database error */ }

// Create a run
const createResult = store.createRun({
  runId: 'run-abc',
  artifact: { bundle, canonical, checksum },
  startingCommit: 'abc123def456',
  configuration: { agentHarnesses: ['codex'] },
  idempotencyKey: 'create-run-abc-v1',
});

// Append an event
const appendResult = store.appendEvent({
  runId: 'run-abc',
  expectedSequence: 2,
  idempotencyKey: 'event-002',
  event: {
    type: 'invocation.activated',
    invocationSequence: 1,
    nodeId: 'start',
  },
});

// Load a run (replays all events through reduceRun)
const loadResult = store.loadRun('run-abc');
// RunAggregate { runId, artifact, events, state, nextEventSequence }

// List all runs
const allRuns = store.listRuns();

// Clean up
store.dispose();
```

## Database Schema

### Table: `runs`

| Column | Type | Description |
|--------|------|-------------|
| `run_id` | `TEXT PRIMARY KEY` | Unique run identifier |
| `artifact_canonical` | `TEXT NOT NULL` | Canonical workflow JSON |
| `artifact_checksum` | `TEXT NOT NULL` | SHA-256 checksum of canonical |
| `next_sequence` | `INTEGER NOT NULL` | Next event sequence number |
| `state_canonical` | `TEXT NOT NULL` | Current run state as canonical JSON |

### Table: `events`

| Column | Type | Description |
|--------|------|-------------|
| `run_id` | `TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE` | Parent run |
| `sequence` | `INTEGER NOT NULL` | Monotonic event sequence number |
| `event_type` | `TEXT NOT NULL` | Discriminant of RunEvent |
| `event_json` | `TEXT NOT NULL` | Canonical JSON of the event |

### Table: `idempotency_records`

| Column | Type | Description |
|--------|------|-------------|
| `run_id` | `TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE` | Parent run |
| `idempotency_key` | `TEXT NOT NULL` | Client-provided dedup key |
| `event_type` | `TEXT NOT NULL` | Event type that was written |
| `request_json` | `TEXT NOT NULL` | Canonical JSON of the request |
| `created_sequence` | `INTEGER NOT NULL` | Event sequence this key produced |

### Projection Tables

All projection tables use `ON DELETE CASCADE` foreign keys to their parent, so deleting a run cleans up everything.

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `run_projections` | `run_id` | `status`, `next_invocation_sequence`, `state_json` |
| `invocation_projections` | `run_id`, `sequence` | `node_id`, `state`, `outcome` |
| `attempt_projections` | `run_id`, `invocation_seq`, `number` | `state`, `harness_id`, `model`, `resume_token`, `failure_json` |
| `approval_projections` | `run_id`, `invocation_seq` | `state`, `binding_json` |
| `artifact_projections` | `run_id`, `invocation_seq`, `attempt_number`, `artifact_id` | `kind`, `media_type`, `checksum`, `size` |
| `run_artifact_projections` | `run_id`, `artifact_id` | `kind`, `media_type`, `checksum`, `size` |

## Key Design Decisions

### Canonical JSON everywhere

Events, state, and bindings are stored as canonical JSON (deterministic key ordering, no whitespace). This enables reliable checksumming and comparison.

### Full projection replacement

`replaceProjections` deletes all projection rows for a run and re-inserts them from scratch. This is simple and correct (avoids incremental update complexity).

### Validation on read and write

- **Artifacts**: Checksum verified on both `createRun` and `loadRun`
- **Events**: Shape-validated with type guards after parsing
- **State**: Replayed from raw events on `loadRun` and compared against persisted state (corruption detection)

### Idempotency via request fingerprinting

Each write operation (`createRun`, `appendEvent`) stores the canonical request JSON keyed by `(run_id, idempotency_key)`:
- Same key + same request → no-op (returns current state)
- Same key + different request → `IdempotencyConflict` error
- New key → proceeds normally

### Schema migration

`initialize()` checks for columns that may have been added after initial table creation and adds them via `ALTER TABLE ADD COLUMN` if missing. No migration framework required.

### WAL mode

`PRAGMA journal_mode = WAL` is enabled for better concurrent read performance.

## Error Handling

| Error Kind | Code | Meaning |
|------------|------|---------|
| `DatabaseFailure` | 0 | SQLite operation failure |
| `RunNotFound` | 1 | Run ID does not exist |
| `RunAlreadyExists` | 2 | Run ID already registered |
| `EventSequenceConflict` | 3 | Expected sequence doesn't match next sequence |
| `IdempotencyConflict` | 4 | Same idempotency key with different request |
| `InvalidEvent` | 5 | Event failed state machine validation |
| `CorruptData` | 6 | State mismatch between replay and persisted value |
| `InvalidArtifact` | 7 | Compiled artifact fails parsing or checksum |

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `SqliteEventStore` | class | `sqlite-event-store.ts` |
| `SqliteEvaluationStore` | class | `sqlite-evaluation-store.ts` |

```typescript
class SqliteEventStore implements RunStore {
  constructor(path: string);
  initialize(): Result<void, RunStoreError>;
  dispose(): void;
  createRun(input: CreateRunInput): Result<RunAggregate, RunStoreError>;
  loadRun(runId: string): Result<RunAggregate, RunStoreError>;
  listRuns(): Result<readonly RunAggregate[], RunStoreError>;
  appendEvent(input: AppendRunEventInput): Result<RunAggregate, RunStoreError>;
}
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@kouro/adw` | `canonicalJson`, `sha256` for canonical serialization |
| `@kouro/domain` | Domain types for events, state, bindings |
| `@kouro/executors` | `RunStore` port interface, `RunAggregate`, `RunStoreError` |
| `@kouro/runtime` | `reduceRun` — pure state machine for event replay |
| `@usersatoshi/results` | `Result<T, E>` type |
