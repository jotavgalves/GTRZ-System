export const syncRepairMigration = {
  version: 16,
  name: 'offline-sync-foundation-repair',
  sql: `
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      audit_id INTEGER PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      accepted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (audit_id) REFERENCES audit_log(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS sync_inbox (
      event_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      applied_at INTEGER,
      PRIMARY KEY (event_id, sequence),
      UNIQUE (command_id)
    );

    CREATE INDEX IF NOT EXISTS sync_outbox_status_audit_idx
      ON sync_outbox (status, audit_id);
    CREATE INDEX IF NOT EXISTS sync_inbox_event_applied_sequence_idx
      ON sync_inbox (event_id, applied_at, sequence);
  `,
} as const;
