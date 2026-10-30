export const legacyFoodComboClassificationMigration = {
  version: 29,
  name: 'classify-legacy-food-combos',
  sql: `
    UPDATE combos
    SET kind = 'food'
    WHERE kind = 'drink'
      AND EXISTS (
        SELECT 1
        FROM combo_components components
        WHERE components.combo_id = combos.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM combo_components components
        INNER JOIN products product ON product.id = components.product_id
        WHERE components.combo_id = combos.id
          AND product.kind <> 'food'
      );
  `,
} as const;
