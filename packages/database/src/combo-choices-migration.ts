export const comboChoicesMigration = {
  version: 25,
  name: 'combo-choice-groups-and-order-allocation-snapshots',
  sql: `
    ALTER TABLE combo_components ADD COLUMN choice_group TEXT;
    ALTER TABLE combo_components ADD COLUMN choice_label TEXT;

    CREATE TABLE order_item_component_allocations (
      id TEXT PRIMARY KEY NOT NULL,
      order_item_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      choice_group TEXT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE INDEX order_item_component_allocations_order_idx
      ON order_item_component_allocations (order_item_id, choice_group);
  `,
} as const;
