import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL UNIQUE,
      bundle_json TEXT NOT NULL,
      input_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_updated_idx ON runs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL REFERENCES runs(id),
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      type TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      causation_id TEXT,
      command_id TEXT,
      payload_json TEXT NOT NULL,
      PRIMARY KEY(run_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS run_events_type_idx ON run_events(run_id, type, sequence);

    CREATE TABLE IF NOT EXISTS projection_frames (
      run_id TEXT NOT NULL REFERENCES runs(id),
      revision INTEGER NOT NULL,
      frame_json TEXT NOT NULL,
      PRIMARY KEY(run_id, revision)
    );

    CREATE TABLE IF NOT EXISTS run_projections (
      run_id TEXT PRIMARY KEY REFERENCES runs(id),
      revision INTEGER NOT NULL,
      view_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invocations (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      output_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS invocations_run_idx ON invocations(run_id, ordinal);

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      invocation_id TEXT NOT NULL REFERENCES invocations(id),
      operation_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      recovery_class TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      artifact_ids_json TEXT NOT NULL DEFAULT '[]',
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS effects (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      operation_key TEXT NOT NULL UNIQUE,
      recovery_class TEXT NOT NULL,
      state TEXT NOT NULL,
      claimed_epoch INTEGER,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      effect_id TEXT PRIMARY KEY REFERENCES effects(id),
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS command_receipts (
      idempotency_key TEXT PRIMARY KEY NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES runs(id),
      result_json TEXT NOT NULL,
      request_digest TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      digest TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_datasets (
      id TEXT PRIMARY KEY NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      cases_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY NOT NULL,
      dataset_id TEXT NOT NULL REFERENCES eval_datasets(id),
      status TEXT NOT NULL,
      variants_json TEXT NOT NULL,
      repetitions INTEGER NOT NULL,
      max_concurrent INTEGER NOT NULL,
      repository_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experiment_cells (
      experiment_id TEXT NOT NULL REFERENCES experiments(id),
      cell_key TEXT NOT NULL,
      case_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      repetition INTEGER NOT NULL,
      status TEXT NOT NULL,
      reservation_token TEXT,
      run_id TEXT REFERENCES runs(id),
      error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(experiment_id, cell_key)
    );
    CREATE INDEX IF NOT EXISTS experiment_cells_status_idx ON experiment_cells(experiment_id, status);

    CREATE TABLE IF NOT EXISTS evaluation_evidence (
      evidence_id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      revision INTEGER NOT NULL,
      tree_digest TEXT,
      evaluator_id TEXT NOT NULL,
      evaluator_version TEXT NOT NULL,
      evidence_class TEXT NOT NULL,
      status TEXT NOT NULL,
      experiment_id TEXT,
      cell_key TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evaluation_evidence_target_idx
      ON evaluation_evidence(run_id, revision, evaluator_id);

    CREATE TABLE IF NOT EXISTS run_comparisons (
      id TEXT PRIMARY KEY NOT NULL,
      runs_json TEXT NOT NULL,
      anchors_json TEXT NOT NULL,
      evidence_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairwise_assignments (
      id TEXT PRIMARY KEY NOT NULL,
      comparison_id TEXT NOT NULL REFERENCES run_comparisons(id),
      run_a_json TEXT NOT NULL,
      run_b_json TEXT NOT NULL,
      side_a TEXT NOT NULL,
      side_b TEXT NOT NULL,
      rubric_json TEXT NOT NULL,
      eligible_actor TEXT NOT NULL,
      evidence_revision INTEGER NOT NULL,
      leakage_risk_json TEXT NOT NULL,
      evidence_a_json TEXT NOT NULL DEFAULT '[]',
      evidence_b_json TEXT NOT NULL DEFAULT '[]',
      assigned_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS pairwise_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      assignment_id TEXT NOT NULL REFERENCES pairwise_assignments(id),
      choice TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      recorded_at TEXT NOT NULL,
      correction_of TEXT REFERENCES pairwise_decisions(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS pairwise_decisions_assignment_idx ON pairwise_decisions(assignment_id, recorded_at);

    CREATE TABLE IF NOT EXISTS collaboration_grants (
      id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
      attempt_id TEXT NOT NULL, participant_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS collaboration_grants_attempt_idx ON collaboration_grants(run_id, attempt_id);
    CREATE TABLE IF NOT EXISTS collaboration_participants (
      run_id TEXT NOT NULL REFERENCES runs(id), participant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY(run_id, participant_id)
    );
    CREATE TABLE IF NOT EXISTS collaboration_channels (
      run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL,
      participants_json TEXT NOT NULL, max_body_bytes INTEGER, PRIMARY KEY(run_id, name)
    );
    CREATE TABLE IF NOT EXISTS collaboration_messages (
      id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
      sender_participant_id TEXT NOT NULL, sender_attempt_id TEXT NOT NULL,
      recipient_participant_id TEXT, channel TEXT, body_json TEXT NOT NULL,
      reply_to TEXT, idempotency_key TEXT NOT NULL, body_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT,
      UNIQUE(run_id, sender_attempt_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS collaboration_messages_recipient_idx
      ON collaboration_messages(run_id, recipient_participant_id, created_at);
    CREATE TABLE IF NOT EXISTS collaboration_usage (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), messages INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0, invocations INTEGER NOT NULL DEFAULT 0,
      concurrent INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_waits (
      id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
      participant_id TEXT NOT NULL, attempt_id TEXT NOT NULL, max_messages INTEGER NOT NULL,
      idle_deadline TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'waiting'
    );
    CREATE TABLE IF NOT EXISTS collaboration_batches (
      id TEXT PRIMARY KEY NOT NULL, wait_id TEXT NOT NULL UNIQUE REFERENCES collaboration_waits(id),
      message_ids_json TEXT NOT NULL, manifest_json TEXT NOT NULL, context_manifest_ids_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL,
      provider_state TEXT NOT NULL DEFAULT 'not_sent', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_message_reservations (
      message_id TEXT PRIMARY KEY NOT NULL REFERENCES collaboration_messages(id),
      batch_id TEXT NOT NULL REFERENCES collaboration_batches(id)
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY NOT NULL,
      source_run_id TEXT NOT NULL REFERENCES runs(id),
      source_revision INTEGER NOT NULL,
      certificate_json TEXT NOT NULL,
      certificate_digest TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS checkpoints_source_idx ON checkpoints(source_run_id, source_revision);
    CREATE TABLE IF NOT EXISTS checkpoint_records (
      id TEXT PRIMARY KEY NOT NULL,
      checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
      kind TEXT NOT NULL,
      request_key TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  try {
    db.exec(
      "ALTER TABLE collaboration_batches ADD COLUMN context_manifest_ids_json TEXT NOT NULL DEFAULT '[]'",
    );
  } catch {
    /* already migrated */
  }
  db.exec(
    "UPDATE collaboration_batches SET state='uncertain', provider_state='uncertain' WHERE state='reserved'",
  );
  try {
    db.exec("ALTER TABLE command_receipts ADD COLUMN request_digest TEXT NOT NULL DEFAULT ''");
  } catch {
    /* already migrated */
  }
  try {
    db.exec("ALTER TABLE pairwise_decisions ADD COLUMN request_digest TEXT NOT NULL DEFAULT ''");
  } catch {
    /* already migrated */
  }
  for (const statement of [
    "ALTER TABLE evaluation_evidence ADD COLUMN experiment_id TEXT",
    "ALTER TABLE evaluation_evidence ADD COLUMN cell_key TEXT",
    "ALTER TABLE experiments ADD COLUMN repository_path TEXT",
  ]) {
    try {
      db.exec(statement);
    } catch {
      /* already migrated */
    }
  }
}
