export const financeLedgerMigration = {
  version: 18,
  name: 'finance-ledger-and-capital-recovery',
  sql: `
    CREATE TABLE IF NOT EXISTS expense_payments (
      id TEXT PRIMARY KEY NOT NULL,
      expense_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash', 'pix', 'credit-card', 'debit-card')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      cash_register_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (expense_id) REFERENCES expenses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS expense_payments_expense_created_idx ON expense_payments (expense_id, created_at);
    CREATE INDEX IF NOT EXISTS expense_payments_event_created_idx ON expense_payments (event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS capital_contributions (
      id TEXT PRIMARY KEY NOT NULL,
      event_id TEXT NOT NULL,
      contributor_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cash', 'inventory')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      remaining_stock_value_cents INTEGER NOT NULL DEFAULT 0 CHECK (remaining_stock_value_cents >= 0),
      recovery_priority INTEGER NOT NULL DEFAULT 1 CHECK (recovery_priority >= 1),
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS capital_contributions_event_created_idx ON capital_contributions (event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS capital_reimbursements (
      id TEXT PRIMARY KEY NOT NULL,
      contribution_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash', 'pix', 'credit-card', 'debit-card')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      cash_register_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (contribution_id) REFERENCES capital_contributions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS capital_reimbursements_contribution_created_idx ON capital_reimbursements (contribution_id, created_at);
    CREATE INDEX IF NOT EXISTS capital_reimbursements_event_created_idx ON capital_reimbursements (event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS order_refunds (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash', 'pix', 'credit-card', 'debit-card')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      cash_register_id TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      FOREIGN KEY (cash_register_id) REFERENCES cash_registers(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS order_refunds_order_created_idx ON order_refunds (order_id, created_at);
    CREATE INDEX IF NOT EXISTS order_refunds_event_created_idx ON order_refunds (event_id, created_at DESC);
  `,
} as const;
