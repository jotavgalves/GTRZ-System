export const syncInboxMigration = {
  version: 15,
  name: 'offline-sync-inbox',
  sql: `
    CREATE TABLE sync_inbox (
      event_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      applied_at INTEGER,
      PRIMARY KEY (event_id, sequence),
      UNIQUE (command_id)
    );

    CREATE INDEX sync_inbox_event_applied_sequence_idx
      ON sync_inbox (event_id, applied_at, sequence);
  `,
} as const;
