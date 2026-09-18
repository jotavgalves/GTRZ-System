export const stockPurchaseLotVoidsMigration = {
  version: 20,
  name: 'stock-purchase-lot-voids',
  sql: `
    CREATE TABLE IF NOT EXISTS stock_purchase_lot_voids (
      movement_id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (movement_id) REFERENCES stock_purchase_lots(movement_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
  `,
} as const;
