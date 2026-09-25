import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  closeOrder,
  configureFood,
  createCombo,
  createEvent,
  createExternalFoodItem,
  createFoodSupplier,
  createProductCategory,
  deleteFoodSupplier,
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

  it('concentra repasse e comissão no combo de comida externa, sem atribuir valor ao ingrediente', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento de combo externo', startsAt: Date.now() });
    const category = createProductCategory(database, 'Cozinha externa');
    configureFood(database, { supplierMode: 'external' });
    const supplier = createFoodSupplier(database, { name: 'Cozinha parceira' });
    createExternalFoodItem(database, {
      categoryId: category.id,
      name: 'Tequeño de queijo',
      initialQuantity: 8,
      comboOnly: true,
    });
    const ingredient = getOperationState(database).catalog.find((item) => item.name === 'Tequeño de queijo');
    expect(ingredient).toBeUndefined();
    const productId = database.sqlite
      .prepare("SELECT id FROM products WHERE name = 'Tequeño de queijo'")
      .get() as { readonly id: string };
    const combo = createCombo(database, {
      name: 'Tequefest parceiro',
      kind: 'food',
      salePriceCents: 2_400,
      components: [{ productId: productId.id, quantity: 2 }],
      externalFoodTerms: {
        supplierId: supplier.id,
        supplierUnitCents: 1_700,
        commissionUnitCents: 700,
      },
    });
    expect(combo).toMatchObject({
      kind: 'food',
      salePriceCents: 2_400,
      externalFoodTerms: {
        supplierName: 'Cozinha parceira',
        supplierUnitCents: 1_700,
        commissionUnitCents: 700,
      },
      financials: { costCents: 1_700, grossProfitCents: 700 },
    });
    const counter = getOperationState(database).servicePoints.find((point) => point.type === 'counter');
    if (counter === undefined) throw new Error('Balcão não encontrado.');
    const order = openOrder(database, counter.id);
    addOrderItem(database, { orderId: order.id, itemKind: 'combo', itemId: combo.id, quantity: 2 });
    closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 4_800 }],
    });
    expect(getFoodState(database)).toMatchObject({
      summary: { soldQuantity: 2, receivedCents: 4_800, supplierCents: 3_400, commissionCents: 1_400 },
      items: [
        expect.objectContaining({
          name: 'Tequefest parceiro',
          supplierName: 'Cozinha parceira',
          commissionCents: 1_400,
        }),
      ],
    });
  });

  it('exclui fornecedor externo de combo sem deixar o prato ativo sem regra de repasse', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento de exclusão de fornecedor', startsAt: Date.now() });
    const category = createProductCategory(database, 'Cozinha externa');
    configureFood(database, { supplierMode: 'external' });
    const supplier = createFoodSupplier(database, { name: 'Fornecedor removido' });
    createExternalFoodItem(database, {
      categoryId: category.id,
      name: 'Ingrediente exclusivo',
      initialQuantity: 4,
      comboOnly: true,
    });
    const ingredient = database.sqlite
      .prepare("SELECT id FROM products WHERE name = 'Ingrediente exclusivo'")
      .get() as { readonly id: string };
    const combo = createCombo(database, {
      name: 'Prato do fornecedor removido',
      kind: 'food',
      salePriceCents: 2_000,
      components: [{ productId: ingredient.id, quantity: 1 }],
      externalFoodTerms: {
        supplierId: supplier.id,
        supplierUnitCents: 1_500,
        commissionUnitCents: 500,
      },
    });

    deleteFoodSupplier(database, {
      supplierId: supplier.id,
      deleteLinkedSales: false,
      reason: 'Fornecedor cadastrado incorretamente',
    });

    expect(
      database.sqlite.prepare('SELECT active FROM combos WHERE id = ?').get(combo.id),
    ).toEqual({ active: 0 });
    expect(
      database.sqlite
        .prepare('SELECT 1 FROM food_combo_terms WHERE combo_id = ?')
        .get(combo.id),
    ).toBeUndefined();
  });
});
