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
    const columns = recovered.sqlite.pragma('table_info(payments)') as Array<{ readonly name: string }>;

    expect(migration?.version).toBe(18);
    expect(columns.map((column) => column.name)).toContain('fee_cents');
    expect(columns.map((column) => column.name)).toContain('fee_rate_basis_points');
    recovered.close();
  });
});
