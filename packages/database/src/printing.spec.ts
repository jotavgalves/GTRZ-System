import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  closeOrder,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  openDatabase,
  openOrder,
  recordStockMovement,
  switchProfile,
  type DatabaseContext,
} from './index';
import { getOrderReceipt, getPrintingSettings, updatePrintingSettings } from './printing';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-printing-'));
  return openDatabase(path.join(temporaryDirectory, 'printing.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

function seedPaidOrder(database: DatabaseContext): string {
  createEvent(database, { name: 'Evento nota térmica', startsAt: Date.now() });
  const category = createProductCategory(database, 'Bebidas impressão');
  const product = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Água impressão',
    kind: 'drink',
    costCents: 200,
    salePriceCents: 1000,
    lowStockThreshold: 1,
  });
  recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 5 });
  const table = createServicePoint(database, { label: 'Mesa térmica', type: 'table' });
  const order = openOrder(database, table.id);
  addOrderItem(database, {
    orderId: order.id,
    itemKind: 'product',
    itemId: product.id,
    quantity: 1,
  });
  closeOrder(database, {
    orderId: order.id,
    discountCents: 0,
    payments: [{ method: 'cash', amountCents: 1000, receivedCents: 1500 }],
  });
  return order.id;
}

describe('thermal printing database', () => {
  it('persiste preferências em app_meta sem migração de schema', async () => {
    const database = await createTemporaryDatabase();
    expect(getPrintingSettings(database)).toEqual({
      automaticPrinting: false,
      deviceName: null,
      machineName: hostname(),
      paperWidthMm: 80,
    });

    expect(
      updatePrintingSettings(database, {
        automaticPrinting: true,
        deviceName: 'THERMAL-01',
        machineName: 'Caixa principal',
        paperWidthMm: 58,
      }),
    ).toEqual({
      automaticPrinting: true,
      deviceName: 'THERMAL-01',
      machineName: 'Caixa principal',
      paperWidthMm: 58,
    });

    expect(getPrintingSettings(database)).toEqual({
      automaticPrinting: true,
      deviceName: 'THERMAL-01',
      machineName: 'Caixa principal',
      paperWidthMm: 58,
    });
    database.close();
  });

  it('bloqueia alteração da impressora no perfil Caixa', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento impressão Caixa', startsAt: Date.now() });
    switchProfile(database, 'cashier');

    expect(() =>
      updatePrintingSettings(database, {
        automaticPrinting: true,
        deviceName: null,
        machineName: 'Caixa principal',
        paperWidthMm: 80,
      }),
    ).toThrow('A configuração de impressão exige o perfil Produção.');
    database.close();
  });

  it('gera a nota a partir do snapshot da venda paga e preserva troco', async () => {
    const database = await createTemporaryDatabase();
    const orderId = seedPaidOrder(database);
    const receipt = getOrderReceipt(database, orderId);

    expect(receipt).toMatchObject({
      orderId,
      eventName: 'Evento nota térmica',
      servicePointLabel: 'Mesa térmica',
      servicePointType: 'table',
      subtotalCents: 1000,
      discountCents: 0,
      totalCents: 1000,
    });
    expect(receipt.items).toEqual([
      { name: 'Água impressão', quantity: 1, unitPriceCents: 1000, totalCents: 1000 },
    ]);
    expect(receipt.payments).toEqual([
      { method: 'cash', amountCents: 1000, receivedCents: 1500, changeCents: 500 },
    ]);
    database.close();
  });
});
