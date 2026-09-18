import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  closeOrder,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  getInventoryState,
  openOrder,
  openDatabase,
  recordStockMovement,
  setActiveEvent,
  switchProfile,
  type DatabaseContext,
} from './index';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-inventory-'));
  return openDatabase(path.join(temporaryDirectory, 'inventory.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

function createCatalog(database: DatabaseContext): {
  readonly categoryId: string;
  readonly productId: string;
} {
  const category = createProductCategory(database, 'Cervejas');
  const product = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Budweiser lata',
    kind: 'drink',
    costCents: 600,
    salePriceCents: 1_000,
    lowStockThreshold: 3,
  });

  return { categoryId: category.id, productId: product.id };
}

describe('inventory database', () => {
  it('cadastra produto e calcula lucro e margem para Produção', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento Estoque', startsAt: Date.now() });
    const { productId } = createCatalog(database);
    const product = getInventoryState(database).products.find((item) => item.id === productId);

    expect(product).toMatchObject({
      name: 'Budweiser lata',
      quantity: 0,
      lowStock: true,
      financials: {
        costCents: 600,
        grossProfitCents: 400,
        marginPercent: 40,
        potentialGrossProfitCents: 0,
        potentialGrossRevenueCents: 0,
      },
    });
    database.close();
  });

  it('mostra potencial de lucro do saldo atual e vendido sem contar baixas excepcionais', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento venda por produto', startsAt: Date.now() });
    const { productId } = createCatalog(database);
    recordStockMovement(database, { productId, type: 'purchase', quantity: 10 });
    recordStockMovement(database, { productId, type: 'loss', quantity: 2 });
    recordStockMovement(database, { productId, type: 'courtesy', quantity: 1 });
    recordStockMovement(database, { productId, type: 'correction-negative', quantity: 1 });
    const table = createServicePoint(database, { label: 'Mesa venda', type: 'table' });
    const order = addOrderItem(database, {
      orderId: openOrder(database, table.id).id,
      itemKind: 'product',
      itemId: productId,
      quantity: 3,
    });
    closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 3_000 }],
    });

    const product = getInventoryState(database).products.find((item) => item.id === productId);

    expect(product).toMatchObject({
      quantity: 3,
      soldQuantity: 3,
      financials: {
        currentStockValueCents: 1_800,
        potentialGrossProfitCents: 1_200,
        potentialGrossRevenueCents: 3_000,
      },
    });
    database.close();
  });

  it('registra razão imutável e atualiza o saldo sem permitir quantidade negativa', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento Estoque', startsAt: Date.now() });
    const { productId } = createCatalog(database);

    recordStockMovement(database, {
      productId,
      type: 'purchase',
      quantity: 10,
      note: 'Compra inicial',
    });
    const afterLoss = recordStockMovement(database, {
      productId,
      type: 'loss',
      quantity: 3,
      note: 'Latas avariadas',
    });

    expect(afterLoss.quantity).toBe(7);
    expect(() =>
      recordStockMovement(database, { productId, type: 'breakage', quantity: 8 }),
    ).toThrow('Estoque insuficiente. Saldo atual: 7.');
    expect(
      getInventoryState(database).products.find((item) => item.id === productId)?.quantity,
    ).toBe(7);

    const movements = database.sqlite
      .prepare(
        `SELECT type, quantity, delta, note
         FROM stock_movements
         WHERE product_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(productId);

    expect(movements).toEqual([
      { type: 'purchase', quantity: 10, delta: 10, note: 'Compra inicial' },
      { type: 'loss', quantity: 3, delta: -3, note: 'Latas avariadas' },
    ]);
    database.close();
  });

  it('cria automaticamente um lote com o valor pago em cada compra', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento dos lotes', startsAt: Date.now() });
    const { productId } = createCatalog(database);

    recordStockMovement(database, {
      productId,
      type: 'purchase',
      quantity: 50,
      purchaseTotalCents: 45_000,
    });

    expect(
      database.sqlite
        .prepare(
          `SELECT quantity, total_cost_cents
           FROM stock_purchase_lots WHERE event_id = ? AND product_id = ?`,
        )
        .get(event.id, productId),
    ).toEqual({ quantity: 50, total_cost_cents: 45_000 });
    database.close();
  });

  it('mostra custo médio e aporte usando os valores reais dos lotes', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento de custos reais', startsAt: Date.now() });
    const { productId } = createCatalog(database);
    recordStockMovement(database, {
      productId,
      type: 'purchase',
      quantity: 10,
      purchaseTotalCents: 6_000,
    });
    recordStockMovement(database, {
      productId,
      type: 'purchase',
      quantity: 10,
      purchaseTotalCents: 8_000,
    });

    expect(getInventoryState(database).products.find((item) => item.id === productId)?.financials).toMatchObject({
      costCents: 700,
      currentStockValueCents: 14_000,
      contributedCostCents: 14_000,
      grossProfitCents: 300,
    });
    database.close();
  });

  it('mantém saldos independentes para o mesmo produto em eventos diferentes', async () => {
    const database = await createTemporaryDatabase();
    const firstEvent = createEvent(database, { name: 'Primeiro evento', startsAt: Date.now() });
    const { productId } = createCatalog(database);
    recordStockMovement(database, { productId, type: 'purchase', quantity: 5 });

    const secondEvent = createEvent(database, {
      name: 'Segundo evento',
      startsAt: Date.now() + 86_400_000,
    });
    setActiveEvent(database, secondEvent.id);
    recordStockMovement(database, { productId, type: 'purchase', quantity: 2 });
    expect(
      getInventoryState(database).products.find((item) => item.id === productId)?.quantity,
    ).toBe(2);

    setActiveEvent(database, firstEvent.id);
    expect(
      getInventoryState(database).products.find((item) => item.id === productId)?.quantity,
    ).toBe(5);
    database.close();
  });

  it('oculta custos para Caixa e bloqueia alterações administrativas', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento Caixa', startsAt: Date.now() });
    const { productId } = createCatalog(database);
    switchProfile(database, 'cashier');

    expect(
      getInventoryState(database).products.find((item) => item.id === productId)?.financials,
    ).toBe(null);
    expect(() => createProductCategory(database, 'Bloqueada')).toThrow(
      'Esta operação de estoque exige o perfil Produção.',
    );
    expect(() =>
      recordStockMovement(database, { productId, type: 'purchase', quantity: 1 }),
    ).toThrow('Esta operação de estoque exige o perfil Produção.');
    database.close();
  });
});
