import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  cancelOrder,
  closeOrder,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  getInventoryState,
  getOrder,
  openDatabase,
  openOrder,
  recordStockMovement,
  type DatabaseContext,
} from './index';
import {
  deleteInventoryProduct,
  getProductEconomics,
  previewProductDeletion,
} from './product-administration';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-product-admin-'));
  return openDatabase(path.join(temporaryDirectory, 'product-admin.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

function seedProduct(database: DatabaseContext, name: string): string {
  const category = createProductCategory(database, `Categoria ${name}`);
  return createInventoryProduct(database, {
    categoryId: category.id,
    name,
    kind: 'drink',
    costCents: 500,
    salePriceCents: 1000,
    lowStockThreshold: 1,
    fallbackIcon: 'beer',
  }).id;
}

function sellOne(database: DatabaseContext, productId: string, tableName: string): string {
  const table = createServicePoint(database, { label: tableName, type: 'table' });
  const order = openOrder(database, table.id);
  addOrderItem(database, {
    orderId: order.id,
    itemKind: 'product',
    itemId: productId,
    quantity: 1,
  });
  return closeOrder(database, {
    orderId: order.id,
    discountCents: 0,
    payments: [{ method: 'pix', amountCents: 1000 }],
  }).id;
}

describe('product administration', () => {
  it('correção negativa reduz estoque e também desfaz aporte líquido', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento correção', startsAt: Date.now() });
    const productId = seedProduct(database, 'Produto correção');
    recordStockMovement(database, { productId, type: 'purchase', quantity: 10 });
    recordStockMovement(database, { productId, type: 'correction-negative', quantity: 2 });

    expect(getProductEconomics(database, productId, event.id)).toEqual({
      currentStockValueCents: 4000,
      contributedCostCents: 4000,
    });
    expect(getInventoryState(database).products[0]).toMatchObject({ quantity: 8 });
    database.close();
  });

  it('perda reduz valor atual, mas preserva dinheiro realmente aportado', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento perda', startsAt: Date.now() });
    const productId = seedProduct(database, 'Produto perda');
    recordStockMovement(database, { productId, type: 'purchase', quantity: 10 });
    recordStockMovement(database, { productId, type: 'loss', quantity: 2 });

    expect(getProductEconomics(database, productId, event.id)).toEqual({
      currentStockValueCents: 4000,
      contributedCostCents: 5000,
    });
    database.close();
  });

  it('exclui produto vendido mantendo a venda histórica legível', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento histórico', startsAt: Date.now() });
    const productId = seedProduct(database, 'Produto histórico');
    recordStockMovement(database, { productId, type: 'purchase', quantity: 2 });
    const orderId = sellOne(database, productId, 'Mesa histórico');

    const impact = previewProductDeletion(database, productId);
    expect(impact).toMatchObject({
      openOrdersCount: 0,
      paidOrdersInActiveEventCount: 1,
      paidOrdersHistoricalCount: 1,
    });
    expect(
      deleteInventoryProduct(database, {
        productId,
        mode: 'keep-sales-history',
        reason: 'Produto duplicado no cadastro',
      }),
    ).toMatchObject({
      deleted: true,
      refundedOrdersCount: 0,
      preservedHistoricalOrdersCount: 1,
    });
    expect(getOrder(database, orderId)).toMatchObject({
      status: 'paid',
      items: [{ itemName: 'Produto histórico', quantity: 1, unitPriceCents: 1000 }],
    });
    expect(
      database.sqlite.prepare('SELECT id FROM products WHERE id = ?').get(productId),
    ).toBeUndefined();

    cancelOrder(database, { orderId, reason: 'Cancelamento posterior da venda histórica' });
    expect(getOrder(database, orderId).status).toBe('cancelled');
    expect(
      database.sqlite.prepare('SELECT id FROM products WHERE id = ?').get(productId),
    ).toBeUndefined();
    database.close();
  });

  it('estorna vendas do evento antes de excluir quando essa opção é escolhida', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento estorno produto', startsAt: Date.now() });
    const productId = seedProduct(database, 'Produto estorno');
    recordStockMovement(database, { productId, type: 'purchase', quantity: 2 });
    const orderId = sellOne(database, productId, 'Mesa estorno');

    expect(
      deleteInventoryProduct(database, {
        productId,
        mode: 'refund-active-event-sales',
        reason: 'Produto criado incorretamente',
      }),
    ).toMatchObject({ deleted: true, refundedOrdersCount: 1, preservedHistoricalOrdersCount: 0 });
    expect(getOrder(database, orderId).status).toBe('cancelled');
    expect(
      database.sqlite.prepare('SELECT id FROM products WHERE id = ?').get(productId),
    ).toBeUndefined();
    database.close();
  });

  it('bloqueia exclusão enquanto o produto está em comanda aberta', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento comanda produto', startsAt: Date.now() });
    const productId = seedProduct(database, 'Produto aberto');
    recordStockMovement(database, { productId, type: 'purchase', quantity: 2 });
    const table = createServicePoint(database, { label: 'Mesa aberta', type: 'table' });
    const order = openOrder(database, table.id);
    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: productId,
      quantity: 1,
    });

    expect(() =>
      deleteInventoryProduct(database, {
        productId,
        mode: 'keep-sales-history',
        reason: 'Tentativa com comanda aberta',
      }),
    ).toThrow('comanda(s) aberta(s)');
    database.close();
  });
});
