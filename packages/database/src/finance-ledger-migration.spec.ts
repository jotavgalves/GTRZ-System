import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from './index';

let directory: string | null = null;

afterEach(async () => {
  if (directory !== null) await rm(directory, { force: true, recursive: true });
  directory = null;
});

describe('finance ledger migration recovery', () => {
  it('recovers when ledger tables exist but the migration was not marked complete', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gtrz-ledger-migration-'));
    const filePath = path.join(directory, 'ledger.sqlite');
    const first = openDatabase(filePath);
    first.sqlite.prepare('DELETE FROM schema_migrations WHERE version = 18').run();
    first.close();

    const recovered = openDatabase(filePath);
    const migration = recovered.sqlite
      .prepare('SELECT version FROM schema_migrations WHERE version = 18')
      .get() as { readonly version: number } | undefined;
    const columns = recovered.sqlite.pragma('table_info(payments)') as {
      readonly name: string;
    }[];

    expect(migration?.version).toBe(18);
    expect(columns.map((column) => column.name)).toContain('fee_cents');
    expect(columns.map((column) => column.name)).toContain('fee_rate_basis_points');
    recovered.close();
  });

  it('upgrades the first expense payment layout without losing its payment method', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gtrz-ledger-legacy-'));
    const filePath = path.join(directory, 'legacy.sqlite');
    const first = openDatabase(filePath);
    first.sqlite.exec('DROP TABLE expense_payments');
    first.sqlite.exec(`
      CREATE TABLE expense_payments (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL,
        expense_id TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        note TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        refunded_at INTEGER
      );
      INSERT INTO expense_payments
      (id, event_id, expense_id, payment_method, amount_cents, note, status, created_at, refunded_at)
      VALUES ('legacy-payment', 'event', 'expense', 'pix', 1250, NULL, 'confirmed', 1, NULL);
    `);
    first.close();

    const recovered = openDatabase(filePath);
    const payment = recovered.sqlite
      .prepare('SELECT method, cash_register_id FROM expense_payments WHERE id = ?')
      .get('legacy-payment') as {
      readonly method: string;
      readonly cash_register_id: string | null;
    };

    expect(payment).toEqual({ method: 'pix', cash_register_id: null });
    recovered.close();
  });
});
