export const comboChoiceLabelMigration = {
  version: 26,
  name: 'combo-choice-labels-on-order-allocation-snapshots',
  sql: `
    ALTER TABLE order_item_component_allocations ADD COLUMN choice_label TEXT;
  `,
} as const;
