export const syncConflictMigration = {
  version: 17,
  name: 'offline-sync-conflicts',
  sql: `
    CREATE TABLE sync_conflicts (
      command_id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      action TEXT NOT NULL,
      entity_id TEXT,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX sync_conflicts_open_created_idx
      ON sync_conflicts (resolved_at, created_at DESC);
  `,
} as const;
