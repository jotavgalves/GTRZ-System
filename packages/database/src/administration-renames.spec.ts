import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  configureFood,
  createCombo,
  createEvent,
  createFoodSupplier,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  createTicketLot,
  openDatabase,
  renameEvent,
  renameServicePoint,
  updateCombo,
  updateFoodSupplier,
  updateInventoryProduct,
  updateProductCategory,
  updateTicketLot,
  type DatabaseContext,
} from './index';
import { createManagedVoucher, updateManagedVoucher } from './voucher-management';

let temporaryDirectory: string | null = null;
let databaseToClose: DatabaseContext | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-renames-'));
  databaseToClose = openDatabase(path.join(temporaryDirectory, 'renames.sqlite'));
  return databaseToClose;
}

afterEach(async () => {
  databaseToClose?.close();
  databaseToClose = null;
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

describe('administration renames', () => {
  it('persists all primary names without changing their relationships', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento original', startsAt: Date.now() });
    const category = createProductCategory(database, 'Bebidas originais');
    const product = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Produto original',
      kind: 'drink',
      costCents: 300,
      salePriceCents: 1000,
      lowStockThreshold: 1,
    });
    const table = createServicePoint(database, { label: 'Mesa original', type: 'table' });
    const voucher = createManagedVoucher(database, {
      code: 'ORIG-001',
      label: 'Voucher original',
      initialBalanceCents: 1000,
      servicePointId: table.id,
    });
    const combo = createCombo(database, {
      name: 'Combo original',
      salePriceCents: 1500,
      components: [{ productId: product.id, quantity: 1 }],
    });
    const lot = createTicketLot(database, { name: 'Lote original', priceCents: 2000, capacity: 10 });
    configureFood(database, { supplierMode: 'external' });
    const supplier = createFoodSupplier(database, { name: 'Fornecedor original' });

    expect(renameEvent(database, { eventId: event.id, name: 'Evento renomeado' })).toMatchObject({
      id: event.id,
      name: 'Evento renomeado',
    });
    expect(updateProductCategory(database, { categoryId: category.id, name: 'Bebidas premium' })).toMatchObject({
      id: category.id,
      name: 'Bebidas premium',
    });
    expect(
      updateInventoryProduct(database, {
        productId: product.id,
        categoryId: category.id,
        name: 'Produto renomeado',
        kind: 'drink',
        costCents: 300,
        salePriceCents: 1000,
        lowStockThreshold: 1,
        comboOnly: false,
        active: true,
      }),
    ).toMatchObject({ id: product.id, name: 'Produto renomeado', categoryName: 'Bebidas premium' });
    expect(renameServicePoint(database, { servicePointId: table.id, label: 'Mesa VIP' })).toMatchObject({
      id: table.id,
      label: 'Mesa VIP',
    });
    expect(
      updateManagedVoucher(database, {
        voucherId: voucher.id,
        code: 'VIP-001',
        label: 'Voucher VIP',
        servicePointId: table.id,
      }),
    ).toMatchObject({ id: voucher.id, code: 'VIP-001', label: 'Voucher VIP', servicePointId: table.id });
    expect(
      updateCombo(database, {
        comboId: combo.id,
        name: 'Combo renomeado',
        salePriceCents: 1500,
        active: true,
        components: [{ productId: product.id, quantity: 1 }],
      }),
    ).toMatchObject({ id: combo.id, name: 'Combo renomeado' });
    expect(
      updateTicketLot(database, {
        lotId: lot.id,
        name: 'Lote VIP',
        priceCents: 2500,
        capacity: 10,
        active: true,
      }),
    ).toMatchObject({ id: lot.id, name: 'Lote VIP', priceCents: 2500 });
    expect(updateFoodSupplier(database, { supplierId: supplier.id, name: 'Fornecedor VIP' })).toMatchObject({
      id: supplier.id,
      name: 'Fornecedor VIP',
    });
    database.close();
  });
});
