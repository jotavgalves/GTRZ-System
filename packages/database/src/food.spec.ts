import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  closeOrder,
  configureFood,
  createEvent,
  createExternalFoodItem,
  createFoodSupplier,
  createProductCategory,
  getFoodState,
  getOperationState,
  openDatabase,
  openOrder,
  type DatabaseContext,
} from './index';

let temporaryDirectory: string | null = null;
let databaseToClose: DatabaseContext | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-food-'));
  databaseToClose = openDatabase(path.join(temporaryDirectory, 'food.sqlite'));
  return databaseToClose;
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    databaseToClose?.close();
    databaseToClose = null;
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

describe('food suppliers', () => {
  it('separa repasse e comissão quando uma comida externa é vendida', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento de comida', startsAt: Date.now() });
    const category = createProductCategory(database, 'Cozinha');
    configureFood(database, { supplierMode: 'external' });
    const supplier = createFoodSupplier(database, { name: 'Cozinha Latina' });
    createExternalFoodItem(database, {
      categoryId: category.id,
      supplierId: supplier.id,
      name: 'Arepa',
      supplierUnitCents: 1400,
      commissionUnitCents: 600,
      initialQuantity: 5,
      comboOnly: false,
    });
    const item = getFoodState(database).items[0];
    if (item === undefined) throw new Error('Item de fornecedor não encontrado.');
    const counter = getOperationState(database).servicePoints.find(
      (point) => point.type === 'counter',
    );
    if (counter === undefined) throw new Error('Balcão não encontrado.');
    const order = openOrder(database, counter.id);
    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: item.productId,
      quantity: 2,
    });
    closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 4000 }],
    });

    expect(getFoodState(database)).toMatchObject({
      summary: { soldQuantity: 2, receivedCents: 4000, supplierCents: 2800, commissionCents: 1200 },
      items: [
        { name: 'Arepa', supplierName: 'Cozinha Latina', soldQuantity: 2, commissionCents: 1200 },
      ],
    });
  });
});
