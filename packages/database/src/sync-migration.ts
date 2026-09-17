export const syncMigration = {
  version: 14,
  name: 'offline-sync-outbox',
  sql: `
    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE sync_outbox (
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

    CREATE INDEX sync_outbox_status_audit_idx ON sync_outbox (status, audit_id);
  `,
} as const;
