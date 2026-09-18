export const stockPurchaseLotsMigration = {
  version: 19,
  name: 'stock-purchase-lots',
  sql: `
    CREATE TABLE IF NOT EXISTS stock_purchase_lots (
      movement_id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      total_cost_cents INTEGER NOT NULL CHECK (total_cost_cents > 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (movement_id) REFERENCES stock_movements(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS stock_purchase_lots_event_product_created_idx
      ON stock_purchase_lots (event_id, product_id, created_at DESC);
  `,
} as const;
