export const foodFinanceMigration = {
  version: 22,
  name: 'food-external-supplier-finance',
  sql: `
    CREATE TABLE IF NOT EXISTS food_product_terms (
      product_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      supplier_unit_cents INTEGER NOT NULL CHECK (supplier_unit_cents >= 0),
      commission_unit_cents INTEGER NOT NULL CHECK (commission_unit_cents >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (supplier_id) REFERENCES food_suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      PRIMARY KEY (product_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS food_sale_settlements (
      id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      received_cents INTEGER NOT NULL CHECK (received_cents >= 0),
      supplier_cents INTEGER NOT NULL CHECK (supplier_cents >= 0),
      commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS food_sale_settlements_order_product_idx
      ON food_sale_settlements (order_id, product_id);
    CREATE INDEX IF NOT EXISTS food_sale_settlements_event_created_idx
      ON food_sale_settlements (event_id, created_at DESC);
  `,
} as const;
