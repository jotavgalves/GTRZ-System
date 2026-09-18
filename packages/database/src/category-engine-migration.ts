export const categoryEngineMigration = {
  version: 24,
  name: 'category-domain-engine',
  sql: `
    ALTER TABLE product_categories ADD COLUMN engine TEXT NOT NULL DEFAULT 'catalog' CHECK (engine IN ('catalog', 'food'));
    UPDATE product_categories SET engine = 'food' WHERE name = 'Comida' COLLATE NOCASE;
  `,
} as const;
