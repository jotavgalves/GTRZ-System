export const comboOrderAndFoodTermsMigration = {
  version: 28,
  name: 'combo-order-configurations-and-external-food-terms',
  sql: `
    ALTER TABLE combos ADD COLUMN kind TEXT NOT NULL DEFAULT 'drink'
      CHECK (kind IN ('food', 'drink'));
    ALTER TABLE combo_components ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE food_combo_terms (
      combo_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      supplier_unit_cents INTEGER NOT NULL CHECK (supplier_unit_cents >= 0),
      commission_unit_cents INTEGER NOT NULL CHECK (commission_unit_cents >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (combo_id, event_id),
      FOREIGN KEY (combo_id) REFERENCES combos(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (supplier_id) REFERENCES food_suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE TABLE food_combo_sale_settlements (
      id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      combo_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      received_cents INTEGER NOT NULL CHECK (received_cents >= 0),
      supplier_cents INTEGER NOT NULL CHECK (supplier_cents >= 0),
      commission_cents INTEGER NOT NULL CHECK (commission_cents >= 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (combo_id) REFERENCES combos(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX food_combo_sale_settlements_order_combo_idx
      ON food_combo_sale_settlements (order_id, combo_id);
    CREATE INDEX food_combo_sale_settlements_event_created_idx
      ON food_combo_sale_settlements (event_id, created_at DESC);

    ALTER TABLE order_item_component_allocations RENAME TO order_item_component_allocations_legacy;
    ALTER TABLE order_items RENAME TO order_items_legacy;
    DROP INDEX order_items_order_created_idx;
    DROP INDEX order_item_component_allocations_order_idx;
    CREATE TABLE order_items (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL,
      item_kind TEXT NOT NULL CHECK (item_kind IN ('product', 'combo')),
      item_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      configuration_key TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
      UNIQUE (order_id, item_kind, item_id, configuration_key)
    );
    INSERT INTO order_items
      (id, order_id, item_kind, item_id, item_name, configuration_key, quantity, unit_price_cents, total_cents, created_at)
    SELECT id, order_id, item_kind, item_id, item_name, '', quantity, unit_price_cents, total_cents, created_at
    FROM order_items_legacy;
    CREATE INDEX order_items_order_created_idx ON order_items (order_id, created_at);

    CREATE TABLE order_item_component_allocations (
      id TEXT PRIMARY KEY NOT NULL,
      order_item_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      choice_group TEXT,
      choice_label TEXT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    INSERT INTO order_item_component_allocations
      (id, order_item_id, product_id, choice_group, choice_label, quantity, created_at)
    SELECT id, order_item_id, product_id, choice_group, choice_label, quantity, created_at
    FROM order_item_component_allocations_legacy;
    CREATE INDEX order_item_component_allocations_order_idx
      ON order_item_component_allocations (order_item_id, choice_group);
    DROP TABLE order_item_component_allocations_legacy;
    DROP TABLE order_items_legacy;
  `,
} as const;
