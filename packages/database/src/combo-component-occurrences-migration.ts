export const comboComponentOccurrencesMigration = {
  version: 27,
  name: 'combo-component-occurrences-by-choice-group',
  sql: `
    CREATE TABLE combo_components_next (
      id TEXT PRIMARY KEY NOT NULL,
      combo_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      choice_group TEXT,
      choice_label TEXT,
      FOREIGN KEY (combo_id) REFERENCES combos(id) ON UPDATE CASCADE ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      UNIQUE (combo_id, product_id, choice_group)
    );

    INSERT INTO combo_components_next
      (id, combo_id, product_id, quantity, choice_group, choice_label)
    SELECT lower(hex(randomblob(16))), combo_id, product_id, quantity, choice_group, choice_label
    FROM combo_components;

    DROP TABLE combo_components;
    ALTER TABLE combo_components_next RENAME TO combo_components;
    CREATE INDEX combo_components_product_idx ON combo_components (product_id);
    CREATE INDEX combo_components_choice_idx ON combo_components (combo_id, choice_group);
  `,
} as const;
