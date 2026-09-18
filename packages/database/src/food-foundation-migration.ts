export const foodFoundationMigration = {
  version: 21,
  name: 'food-module-foundation',
  sql: `
    CREATE TABLE IF NOT EXISTS food_event_settings (
      event_id TEXT PRIMARY KEY NOT NULL,
      supplier_mode TEXT NOT NULL CHECK (supplier_mode IN ('gtrz', 'external')),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS food_suppliers (
      id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS food_suppliers_event_name_idx
      ON food_suppliers (event_id, name COLLATE NOCASE);
  `,
} as const;
