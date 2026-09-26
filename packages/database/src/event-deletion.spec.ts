import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getEventStockCostCents } from './event-stock-cost';
import {
  createEvent,
  createExpense,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  deleteEventPermanently,
  getSessionState,
  listEvents,
  openDatabase,
  openOrder,
  recordStockMovement,
  resetEventData,
  transferStockBetweenEvents,
  verifyDatabaseIntegrity,
  type DatabaseContext,
} from './index';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-event-delete-'));
  return openDatabase(path.join(temporaryDirectory, 'event-delete.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

describe('permanent event deletion', () => {
  it('zera os dados operacionais sem apagar o evento nem o catálogo', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento limpo', startsAt: Date.now() });
    const category = createProductCategory(database, 'Limpeza');
    const product = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Produto preservado',
      kind: 'drink',
      costCents: 300,
      salePriceCents: 900,
      lowStockThreshold: 1,
    });
    recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 8 });
    createExpense(database, {
      category: 'Equipe',
      description: 'Despesa removida',
      amountCents: 1500,
      paymentMethod: 'pix',
    });
    const table = createServicePoint(database, { label: 'Mesa limpa', type: 'table' });
    openOrder(database, table.id);

    const result = resetEventData(database, {
      eventId: event.id,
      confirmationName: event.name,
      reason: 'Preparação para um novo dia de evento',
    });

    expect(result).toMatchObject({ eventId: event.id, reset: true, removedOrdersCount: 1 });
    expect(listEvents(database)).toHaveLength(1);
    expect(getSessionState(database).activeEvent?.id).toBe(event.id);
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS amount FROM products WHERE id = ?')
        .get(product.id),
    ).toEqual({ amount: 1 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS amount FROM event_stock WHERE event_id = ?')
        .get(event.id),
    ).toEqual({ amount: 0 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS amount FROM orders WHERE event_id = ?')
        .get(event.id),
    ).toEqual({ amount: 0 });
    expect(verifyDatabaseIntegrity(database)).toBe(true);
    database.close();
  });

  it('remove evento ativo mesmo com comanda aberta, despesa e estoque', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento descartável', startsAt: Date.now() });
    const category = createProductCategory(database, 'Exclusão');
    const product = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Produto descartável',
      kind: 'drink',
      costCents: 300,
      salePriceCents: 900,
      lowStockThreshold: 1,
    });
    recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 8 });
    createExpense(database, {
      category: 'Equipe',
      description: 'Despesa do evento descartável',
      amountCents: 1500,
      paymentMethod: 'pix',
    });
    const table = createServicePoint(database, { label: 'Mesa exclusão', type: 'table' });
    openOrder(database, table.id);

    const result = deleteEventPermanently(database, {
      eventId: event.id,
      confirmationName: event.name,
      reason: 'Evento criado apenas para teste',
    });

    expect(result).toMatchObject({
      eventId: event.id,
      deleted: true,
      removedOpenOrdersCount: 1,
      removedOrdersCount: 1,
      removedExpensesCount: 1,
      removedStockMovementsCount: 1,
    });
    expect(listEvents(database)).toHaveLength(0);
    expect(getSessionState(database).activeEvent).toBeNull();
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS amount FROM events WHERE id = ?').get(event.id),
    ).toEqual({ amount: 0 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS amount FROM orders WHERE event_id = ?')
        .get(event.id),
    ).toEqual({ amount: 0 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS amount FROM expenses WHERE event_id = ?')
        .get(event.id),
    ).toEqual({ amount: 0 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS amount FROM stock_movements WHERE event_id = ?')
        .get(event.id),
    ).toEqual({ amount: 0 });
    expect(verifyDatabaseIntegrity(database)).toBe(true);

    const audit = database.sqlite
      .prepare(
        `SELECT event_id, action, entity_id
         FROM audit_log
         WHERE action = 'event.deleted-permanently' AND entity_id = ?`,
      )
      .get(event.id) as
      | { readonly event_id: string | null; readonly action: string; readonly entity_id: string }
      | undefined;
    expect(audit).toEqual({
      event_id: null,
      action: 'event.deleted-permanently',
      entity_id: event.id,
    });
    database.close();
  });

  it('mantém o custo da compra no evento de origem após transferir o estoque', async () => {
    const database = await createTemporaryDatabase();
    const source = createEvent(database, { name: 'Origem removível', startsAt: Date.now() });
    const category = createProductCategory(database, 'Transferência preservada');
    const product = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Produto transferido',
      kind: 'drink',
      costCents: 200,
      salePriceCents: 600,
      lowStockThreshold: 1,
    });
    recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 10 });
    const destination = createEvent(database, {
      name: 'Destino preservado',
      startsAt: Date.now() + 86_400_000,
    });
    transferStockBetweenEvents(database, {
      productId: product.id,
      sourceEventId: source.id,
      destinationEventId: destination.id,
      quantity: 4,
    });

    expect(getEventStockCostCents(database, source.id)).toBe(2000);
    expect(getEventStockCostCents(database, destination.id)).toBe(0);

    deleteEventPermanently(database, {
      eventId: source.id,
      confirmationName: source.name,
      reason: 'Origem não será mais utilizada',
    });

    expect(listEvents(database).map((event) => event.id)).toEqual([destination.id]);
    expect(
      database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(destination.id, product.id),
    ).toEqual({ quantity: 4 });
    expect(getEventStockCostCents(database, destination.id)).toBe(0);
    expect(verifyDatabaseIntegrity(database)).toBe(true);
    database.close();
  });

  it('exige nome exato antes de iniciar qualquer exclusão', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento protegido', startsAt: Date.now() });

    expect(() =>
      deleteEventPermanently(database, {
        eventId: event.id,
        confirmationName: 'Evento errado',
        reason: 'Teste de proteção',
      }),
    ).toThrow('Digite exatamente o nome do evento para confirmar a exclusão.');
    expect(listEvents(database)).toHaveLength(1);
    expect(verifyDatabaseIntegrity(database)).toBe(true);
    database.close();
  });
});
