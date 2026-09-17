import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  cancelOrder,
  closeOrder,
  createCombo,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  deleteServicePoint,
  getOperationState,
  getOrder,
  openDatabase,
  openOrder,
  recordStockMovement,
  renameServicePoint,
  setActiveEvent,
  setServicePointPinned,
  switchProfile,
  type DatabaseContext,
} from './index';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-operations-'));
  return openDatabase(path.join(temporaryDirectory, 'operations.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

function seedCatalog(database: DatabaseContext): {
  readonly waterId: string;
  readonly iceId: string;
  readonly comboId: string;
} {
  const category = createProductCategory(database, 'Bebidas');
  const water = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Água',
    kind: 'drink',
    costCents: 100,
    salePriceCents: 500,
    lowStockThreshold: 2,
  });
  const ice = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Gelo',
    kind: 'drink',
    costCents: 50,
    salePriceCents: 200,
    lowStockThreshold: 2,
  });
  const combo = createCombo(database, {
    name: 'Água com gelo',
    salePriceCents: 600,
    components: [
      { productId: water.id, quantity: 1 },
      { productId: ice.id, quantity: 2 },
    ],
  });

  recordStockMovement(database, { productId: water.id, type: 'purchase', quantity: 10 });
  recordStockMovement(database, { productId: ice.id, type: 'purchase', quantity: 10 });
  return { waterId: water.id, iceId: ice.id, comboId: combo.id };
}

function getStock(database: DatabaseContext, eventId: string, productId: string): number {
  const row = database.sqlite
    .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
    .get(eventId, productId) as { readonly quantity: number } | undefined;
  return row?.quantity ?? 0;
}

describe('event operations database', () => {
  it('cria balcão, mesa e comanda com produtos e combos', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento operacional', startsAt: Date.now() });
    const catalog = seedCatalog(database);

    const initialState = getOperationState(database);
    expect(initialState.servicePoints).toHaveLength(1);
    expect(initialState.servicePoints[0]).toMatchObject({ label: 'Balcão', type: 'counter' });
    expect(initialState.recentOrders).toHaveLength(0);

    const table = createServicePoint(database, { label: 'Mesa 01', type: 'table' });
    let order = openOrder(database, table.id);
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: catalog.waterId,
      quantity: 2,
    });
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: catalog.comboId,
      quantity: 1,
    });

    expect(order).toMatchObject({
      status: 'open',
      subtotalCents: 1600,
      totalCents: 1600,
      paidCents: 0,
      remainingCents: 1600,
    });
    expect(order.items).toHaveLength(2);
    database.close();
  });

  it('fecha com pagamento misto, calcula troco e baixa componentes atomicamente', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento pagamento', startsAt: Date.now() });
    const catalog = seedCatalog(database);
    const counter = getOperationState(database).servicePoints[0];

    if (counter === undefined) {
      throw new Error('Balcão não criado.');
    }

    let order = openOrder(database, counter.id);
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: catalog.waterId,
      quantity: 1,
    });
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: catalog.comboId,
      quantity: 2,
    });
    const paidOrder = closeOrder(database, {
      orderId: order.id,
      discountCents: 100,
      payments: [
        { method: 'pix', amountCents: 800 },
        { method: 'cash', amountCents: 800, receivedCents: 1000 },
      ],
    });

    expect(paidOrder).toMatchObject({
      status: 'paid',
      subtotalCents: 1700,
      discountCents: 100,
      totalCents: 1600,
      paidCents: 1600,
      remainingCents: 0,
    });
    expect(paidOrder.payments).toHaveLength(2);
    expect(paidOrder.payments.find((payment) => payment.method === 'cash')).toMatchObject({
      receivedCents: 1000,
      changeCents: 200,
    });
    expect(getStock(database, event.id, catalog.waterId)).toBe(7);
    expect(getStock(database, event.id, catalog.iceId)).toBe(6);
    expect(getOperationState(database).servicePoints[0]?.status).toBe('available');
    expect(getOperationState(database).recentOrders[0]?.id).toBe(paidOrder.id);

    const paymentAudit = database.sqlite
      .prepare("SELECT details_json FROM audit_log WHERE action = 'operations.order-paid'")
      .get() as { readonly details_json: string };
    const paymentAuditDetails = JSON.parse(paymentAudit.details_json) as {
      readonly stockMovements: readonly unknown[];
    };
    expect(paymentAuditDetails).toMatchObject({
      order: { id: paidOrder.id, servicePointId: counter.id },
      items: [
        { itemId: catalog.waterId, quantity: 1 },
        { itemId: catalog.comboId, quantity: 2 },
      ],
      payments: [
        { method: 'pix', amountCents: 800 },
        { method: 'cash', amountCents: 800, receivedCents: 1000 },
      ],
    });

    const saleMovements = database.sqlite
      .prepare("SELECT product_id, quantity, delta FROM stock_movements WHERE type = 'sale'")
      .all();
    expect(saleMovements).toHaveLength(2);
    expect(paymentAuditDetails.stockMovements).toHaveLength(2);
    database.close();
  });

  it('cancela comanda aberta sem alterar o estoque e registra o motivo', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento cancelamento', startsAt: Date.now() });
    const catalog = seedCatalog(database);
    const table = createServicePoint(database, { label: 'Mesa cancelada', type: 'table' });
    let order = openOrder(database, table.id);
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: catalog.waterId,
      quantity: 2,
    });

    const cancelled = cancelOrder(database, {
      orderId: order.id,
      reason: 'Pedido lançado em mesa incorreta',
    });

    expect(cancelled.status).toBe('cancelled');
    expect(getStock(database, event.id, catalog.waterId)).toBe(10);
    expect(
      getOperationState(database).servicePoints.find((item) => item.id === table.id)?.status,
    ).toBe('available');
    expect(getOperationState(database).recentOrders[0]?.id).toBe(order.id);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) AS value FROM stock_movements WHERE type = 'return'")
        .get(),
    ).toEqual({ value: 0 });

    const audit = database.sqlite
      .prepare("SELECT details_json FROM audit_log WHERE action = 'operations.order-cancelled'")
      .get() as { readonly details_json: string };
    expect(JSON.parse(audit.details_json)).toMatchObject({
      previousStatus: 'open',
      reason: 'Pedido lançado em mesa incorreta',
      restoredUnits: 0,
    });
    database.close();
  });

  it('estorna venda paga pelas movimentações originais mesmo após alterar o combo', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento estorno', startsAt: Date.now() });
    const catalog = seedCatalog(database);
    const counter = getOperationState(database).servicePoints[0];

    if (counter === undefined) {
      throw new Error('Balcão não criado.');
    }

    let order = openOrder(database, counter.id);
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: catalog.comboId,
      quantity: 2,
    });
    const paidOrder = closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 1200 }],
    });

    expect(getStock(database, event.id, catalog.waterId)).toBe(8);
    expect(getStock(database, event.id, catalog.iceId)).toBe(6);
    database.sqlite
      .prepare('UPDATE combo_components SET quantity = 9 WHERE combo_id = ?')
      .run(catalog.comboId);

    const cancelled = cancelOrder(database, {
      orderId: paidOrder.id,
      reason: 'Pagamento duplicado no terminal',
    });

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.paidCents).toBe(1200);
    expect(getStock(database, event.id, catalog.waterId)).toBe(10);
    expect(getStock(database, event.id, catalog.iceId)).toBe(10);
    expect(
      database.sqlite
        .prepare(
          "SELECT product_id, quantity, delta FROM stock_movements WHERE type = 'return' ORDER BY product_id",
        )
        .all(),
    ).toHaveLength(2);
    expect(() =>
      cancelOrder(database, { orderId: paidOrder.id, reason: 'Segundo cancelamento' }),
    ).toThrow('Esta comanda já foi cancelada.');
    database.close();
  });

  it('mantém comanda, pagamentos e estoque intactos quando falta saldo', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento rollback', startsAt: Date.now() });
    const catalog = seedCatalog(database);
    const table = createServicePoint(database, { label: 'Mesa crítica', type: 'table' });
    let order = openOrder(database, table.id);
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: catalog.comboId,
      quantity: 5,
    });

    database.sqlite
      .prepare('UPDATE event_stock SET quantity = 1 WHERE event_id = ? AND product_id = ?')
      .run(event.id, catalog.iceId);

    expect(() =>
      closeOrder(database, {
        orderId: order.id,
        discountCents: 0,
        payments: [{ method: 'credit-card', amountCents: 3000 }],
      }),
    ).toThrow('Estoque insuficiente para Gelo. Disponível: 1.');
    expect(getOrder(database, order.id)).toMatchObject({ status: 'open', paidCents: 0 });
    expect(getStock(database, event.id, catalog.waterId)).toBe(10);
    expect(getStock(database, event.id, catalog.iceId)).toBe(1);
    expect(database.sqlite.prepare('SELECT COUNT(*) AS value FROM payments').get()).toEqual({
      value: 0,
    });
    database.close();
  });

  it('permite operação no Caixa, mas restringe mesas e cancelamentos', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento Caixa', startsAt: Date.now() });
    seedCatalog(database);
    const counter = getOperationState(database).servicePoints[0];

    if (counter === undefined) {
      throw new Error('Balcão não criado.');
    }

    const order = openOrder(database, counter.id);
    switchProfile(database, 'cashier');
    expect(() => createServicePoint(database, { label: 'Mesa proibida', type: 'table' })).toThrow(
      'O cadastro de mesas exige o perfil Produção.',
    );
    expect(() => cancelOrder(database, { orderId: order.id, reason: 'Tentativa Caixa' })).toThrow(
      'O cancelamento de comandas exige o perfil Produção.',
    );
    database.close();
  });

  it('renomeia e fixa mesa ativa na grade operacional', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento mesa fixa', startsAt: Date.now() });
    const mesaA = createServicePoint(database, { label: 'Mesa A', type: 'table' });
    const mesaB = createServicePoint(database, { label: 'Mesa B', type: 'table' });

    expect(renameServicePoint(database, { servicePointId: mesaB.id, label: 'Mesa VIP' })).toMatchObject({
      id: mesaB.id,
      label: 'Mesa VIP',
    });
    expect(setServicePointPinned(database, { servicePointId: mesaB.id, pinned: true })).toMatchObject({
      id: mesaB.id,
      pinned: true,
    });

    const tables = getOperationState(database).servicePoints.filter((point) => point.type === 'table');
    expect(tables.map((point) => point.id)).toEqual([mesaB.id, mesaA.id]);
    database.close();
  });

  it('não herda catálogo operacional de outro evento sem estoque puxado', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento origem estoque', startsAt: Date.now() });
    const catalog = seedCatalog(database);

    expect(new Set(getOperationState(database).catalog.map((item) => item.name))).toEqual(
      new Set(['Água', 'Água com gelo', 'Gelo']),
    );

    const emptyEvent = createEvent(database, { name: 'Evento novo vazio', startsAt: Date.now() });
    setActiveEvent(database, emptyEvent.id);
    expect(getOperationState(database).catalog).toHaveLength(0);

    recordStockMovement(database, { productId: catalog.waterId, type: 'purchase', quantity: 1 });
    expect(getOperationState(database).catalog.map((item) => item.name)).toEqual(['Água']);
    database.close();
  });

  it('exclui mesa mantendo vendas pagas e removendo comandas abertas', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento manter vendas', startsAt: Date.now() });
    const catalog = seedCatalog(database);
    const table = createServicePoint(database, { label: 'Mesa histórico', type: 'table' });
    let paidOrder = openOrder(database, table.id);
    paidOrder = addOrderItem(database, {
      orderId: paidOrder.id,
      itemKind: 'product',
      itemId: catalog.waterId,
      quantity: 1,
    });
    paidOrder = closeOrder(database, {
      orderId: paidOrder.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 500 }],
    });
    let openTableOrder = openOrder(database, table.id);
    openTableOrder = addOrderItem(database, {
      orderId: openTableOrder.id,
      itemKind: 'product',
      itemId: catalog.waterId,
      quantity: 1,
    });

    expect(
      deleteServicePoint(database, {
        servicePointId: table.id,
        mode: 'keep-sales-history',
        reason: 'Mesa duplicada',
      }),
    ).toMatchObject({
      cancelledOrdersCount: 1,
      preservedOrdersCount: 1,
    });

    expect(getOperationState(database).servicePoints.some((point) => point.id === table.id)).toBe(
      false,
    );
    expect(getOrder(database, paidOrder.id).status).toBe('paid');
    expect(getOrder(database, openTableOrder.id).status).toBe('cancelled');
    expect(getStock(database, event.id, catalog.waterId)).toBe(9);
    database.close();
  });

  it('exclui mesa estornando vendas pagas para o estoque', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento excluir tudo', startsAt: Date.now() });
    const catalog = seedCatalog(database);
    const table = createServicePoint(database, { label: 'Mesa estorno', type: 'table' });
    let order = openOrder(database, table.id);
    order = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: catalog.waterId,
      quantity: 2,
    });
    order = closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'cash', amountCents: 1000, receivedCents: 1000 }],
    });

    expect(getStock(database, event.id, catalog.waterId)).toBe(8);
    expect(
      deleteServicePoint(database, {
        servicePointId: table.id,
        mode: 'delete-all',
        reason: 'Excluir toda operação da mesa',
      }),
    ).toMatchObject({
      cancelledOrdersCount: 1,
      preservedOrdersCount: 0,
    });
    expect(getOrder(database, order.id).status).toBe('cancelled');
    expect(getStock(database, event.id, catalog.waterId)).toBe(10);
    database.close();
  });
});
