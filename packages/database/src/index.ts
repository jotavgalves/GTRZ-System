import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { expensePaymentStatusMigration } from './expense-payment-status-migration';
import { financeMigration } from './finance-migration';
import { technicalSchema } from './schema';
import { stockSaleMigration } from './stock-sale-migration';
import { stockPurchaseLotsMigration } from './stock-purchase-lots-migration';
import { stockPurchaseLotVoidsMigration } from './stock-purchase-lot-voids-migration';
import { foodFoundationMigration } from './food-foundation-migration';
import { foodFinanceMigration } from './food-finance-migration';
import { foodCategoryMigration } from './food-category-migration';
import { categoryEngineMigration } from './category-engine-migration';
import { comboChoicesMigration } from './combo-choices-migration';
import { comboChoiceLabelMigration } from './combo-choice-label-migration';
import { comboComponentOccurrencesMigration } from './combo-component-occurrences-migration';
import { comboOrderAndFoodTermsMigration } from './combo-order-and-food-terms-migration';
import { legacyFoodComboClassificationMigration } from './legacy-food-combo-classification-migration';
import { syncMigration } from './sync-migration';
import { syncInboxMigration } from './sync-inbox-migration';
import { syncConflictMigration } from './sync-conflict-migration';
import { financeLedgerMigration } from './finance-ledger-migration';
import { syncRepairMigration } from './sync-repair-migration';
import { ticketMigration } from './ticket-migration';
import type { DatabaseContext } from './types';
import { voucherOrderMigration } from './voucher-order-migration';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'technical-foundation',
    sql: `
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'events-profiles-and-audit',
    sql: `
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'archived')),
        starts_at INTEGER NOT NULL,
        ends_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX events_status_starts_at_idx ON events (status, starts_at DESC);

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        event_id TEXT,
        profile TEXT NOT NULL CHECK (profile IN ('production', 'cashier')),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE INDEX audit_log_event_created_at_idx ON audit_log (event_id, created_at DESC);
      CREATE INDEX audit_log_action_created_at_idx ON audit_log (action, created_at DESC);
    `,
  },
  {
    version: 3,
    name: 'product-catalog-and-event-stock',
    sql: `
      CREATE TABLE product_categories (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE products (
        id TEXT PRIMARY KEY NOT NULL,
        category_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('food', 'drink')),
        cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
        sale_price_cents INTEGER NOT NULL CHECK (sale_price_cents >= 0),
        low_stock_threshold INTEGER NOT NULL CHECK (low_stock_threshold >= 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (category_id) REFERENCES product_categories(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE INDEX products_category_name_idx ON products (category_id, name COLLATE NOCASE);

      CREATE TABLE event_stock (
        event_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (event_id, product_id),
        FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE TABLE stock_movements (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'purchase', 'correction-positive', 'correction-negative', 'loss', 'breakage',
          'internal-consumption', 'courtesy', 'return'
        )),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        delta INTEGER NOT NULL CHECK (delta != 0),
        note TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE INDEX stock_movements_event_created_idx ON stock_movements (event_id, created_at DESC);
      CREATE INDEX stock_movements_product_created_idx ON stock_movements (product_id, created_at DESC);
    `,
  },
  {
    version: 4,
    name: 'product-combos',
    sql: `
      CREATE TABLE combos (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        sale_price_cents INTEGER NOT NULL CHECK (sale_price_cents >= 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE combo_components (
        combo_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        PRIMARY KEY (combo_id, product_id),
        FOREIGN KEY (combo_id) REFERENCES combos(id) ON UPDATE CASCADE ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE INDEX combo_components_product_idx ON combo_components (product_id);
    `,
  },
  {
    version: 5,
    name: 'stock-transfers-between-events',
    sql: `
      CREATE TABLE stock_transfers (
        id TEXT PRIMARY KEY NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_event_name TEXT NOT NULL,
        destination_event_id TEXT NOT NULL,
        destination_event_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        note TEXT,
        source_quantity_before INTEGER NOT NULL CHECK (source_quantity_before >= 0),
        source_quantity_after INTEGER NOT NULL CHECK (source_quantity_after >= 0),
        destination_quantity_before INTEGER NOT NULL CHECK (destination_quantity_before >= 0),
        destination_quantity_after INTEGER NOT NULL CHECK (destination_quantity_after >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (source_event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (destination_event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE INDEX stock_transfers_product_created_idx
        ON stock_transfers (product_id, created_at DESC);
      CREATE INDEX stock_transfers_source_created_idx
        ON stock_transfers (source_event_id, created_at DESC);
      CREATE INDEX stock_transfers_destination_created_idx
        ON stock_transfers (destination_event_id, created_at DESC);
    `,
  },
  {
    version: 6,
    name: 'operations-orders-and-payments',
    sql: `
      CREATE TABLE service_points (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL,
        label TEXT NOT NULL COLLATE NOCASE,
        type TEXT NOT NULL CHECK (type IN ('table', 'counter')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX service_points_event_label_active_idx
        ON service_points (event_id, label COLLATE NOCASE)
        WHERE active = 1;

      CREATE TABLE orders (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL,
        service_point_id TEXT NOT NULL,
        service_point_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'cancelled')),
        subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
        discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
        total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (service_point_id) REFERENCES service_points(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX orders_single_open_service_point_idx
        ON orders (service_point_id)
        WHERE status = 'open';
      CREATE INDEX orders_event_status_updated_idx
        ON orders (event_id, status, updated_at DESC);

      CREATE TABLE order_items (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL,
        item_kind TEXT NOT NULL CHECK (item_kind IN ('product', 'combo')),
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE CASCADE
      );

      CREATE INDEX order_items_order_created_idx ON order_items (order_id, created_at);

      CREATE TABLE payments (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('cash', 'pix', 'credit-card', 'debit-card')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        received_cents INTEGER,
        change_cents INTEGER NOT NULL DEFAULT 0 CHECK (change_cents >= 0),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE INDEX payments_order_created_idx ON payments (order_id, created_at);
    `,
  },
  {
    version: 7,
    name: 'vouchers',
    sql: `
      CREATE TABLE vouchers (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL,
        code TEXT NOT NULL COLLATE NOCASE,
        label TEXT NOT NULL,
        initial_balance_cents INTEGER NOT NULL CHECK (initial_balance_cents >= 0),
        remaining_balance_cents INTEGER NOT NULL CHECK (remaining_balance_cents >= 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'exhausted', 'cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX vouchers_event_code_idx ON vouchers (event_id, code COLLATE NOCASE);

      CREATE TABLE voucher_transactions (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL,
        voucher_id TEXT NOT NULL,
        voucher_code TEXT NOT NULL,
        order_id TEXT,
        type TEXT NOT NULL CHECK (type IN (
          'issue', 'redemption', 'cancellation', 'reactivation', 'refund'
        )),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        balance_before_cents INTEGER NOT NULL CHECK (balance_before_cents >= 0),
        balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
        note TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT
      );

      CREATE INDEX voucher_transactions_event_created_idx
        ON voucher_transactions (event_id, created_at DESC);
      CREATE INDEX voucher_transactions_voucher_created_idx
        ON voucher_transactions (voucher_id, created_at DESC);
      CREATE INDEX voucher_transactions_order_type_idx
        ON voucher_transactions (order_id, type);
    `,
  },
  financeMigration,
  ticketMigration,
  voucherOrderMigration,
  stockSaleMigration,
  expensePaymentStatusMigration,
  syncMigration,
  syncInboxMigration,
  syncRepairMigration,
  syncConflictMigration,
  financeLedgerMigration,
  stockPurchaseLotsMigration,
  stockPurchaseLotVoidsMigration,
  foodFoundationMigration,
  foodFinanceMigration,
  foodCategoryMigration,
  categoryEngineMigration,
  comboChoicesMigration,
  comboChoiceLabelMigration,
  comboComponentOccurrencesMigration,
  comboOrderAndFoodTermsMigration,
  legacyFoodComboClassificationMigration,
];

function ensureMigrationTable(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function applyMigrations(sqlite: BetterSqlite3.Database): void {
  ensureMigrationTable(sqlite);
  const hasMigration = sqlite.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const registerMigration = sqlite.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const migrate = sqlite.transaction(() => {
    for (const migration of migrations) {
      if (hasMigration.get(migration.version) !== undefined) {
        continue;
      }

      sqlite.exec(migration.sql);
      registerMigration.run(migration.version, migration.name, Date.now());
    }
  });

  migrate();
}

function ensureColumn(
  sqlite: BetterSqlite3.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = sqlite.pragma(`table_info(${table})`) as { readonly name: string }[];
  if (!columns.some((entry) => entry.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function tableColumns(sqlite: BetterSqlite3.Database, table: string): readonly string[] {
  return (sqlite.pragma(`table_info(${table})`) as { readonly name: string }[]).map(
    (entry) => entry.name,
  );
}

// A desktop can be interrupted while applying a schema update. These columns are
// repaired independently so a partially created ledger never blocks startup.
function repairFinanceLedgerColumns(sqlite: BetterSqlite3.Database): void {
  ensureColumn(sqlite, 'payments', 'fee_rate_basis_points', 'fee_rate_basis_points INTEGER');
  ensureColumn(sqlite, 'payments', 'fee_cents', 'fee_cents INTEGER');
  ensureColumn(sqlite, 'expense_payments', 'method', 'method TEXT');
  ensureColumn(sqlite, 'expense_payments', 'cash_register_id', 'cash_register_id TEXT');

  const expensePaymentColumns = tableColumns(sqlite, 'expense_payments');
  if (expensePaymentColumns.includes('payment_method')) {
    sqlite.exec(`
      UPDATE expense_payments
      SET method = payment_method
      WHERE method IS NULL OR method = ''
    `);
  }
  ensureColumn(sqlite, 'products', 'combo_only', 'combo_only INTEGER NOT NULL DEFAULT 0');
  ensureColumn(sqlite, 'combos', 'kind', "kind TEXT NOT NULL DEFAULT 'drink'");
  ensureColumn(sqlite, 'combo_components', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
}

export function openDatabase(filePath: string): DatabaseContext {
  const sqlite = new BetterSqlite3(filePath);

  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  applyMigrations(sqlite);
  repairFinanceLedgerColumns(sqlite);

  const orm = drizzle(sqlite, { schema: technicalSchema });

  return {
    sqlite,
    orm,
    filePath,
    close(): void {
      if (sqlite.open) {
        sqlite.close();
      }
    },
  };
}

export function verifyDatabaseIntegrity(database: DatabaseContext): boolean {
  const result = database.sqlite.pragma('quick_check', { simple: true });
  return result === 'ok';
}

export * from './audit';
export * from './backup';
export * from './cash-terminal';
export * from './combos';
export * from './control';
export * from './event-close';
export * from './event-deletion';
export * from './expenses';
export * from './food';
export * from './food-settlements';
export * from './capital';
export * from './insights';
export * from './inventory';
export * from './operations';
export * from './stock-transfers';
export * from './ticket-finance';
export * from './tickets';
export * from './vouchers';
export type { DatabaseContext } from './types';
