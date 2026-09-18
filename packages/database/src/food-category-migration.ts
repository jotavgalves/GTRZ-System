export const foodCategoryMigration = {
  version: 23,
  name: 'default-food-category',
  sql: `
    INSERT OR IGNORE INTO product_categories (id, name, active, created_at, updated_at)
    VALUES ('c0a5d4d0-4c01-4a0a-9000-000000000023', 'Comida', 1, unixepoch() * 1000, unixepoch() * 1000);
  `,
} as const;
