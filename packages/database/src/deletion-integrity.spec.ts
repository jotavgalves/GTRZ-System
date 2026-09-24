import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  bindOrderVoucher,
  cancelOrder,
  closeOrder,
  configureFood,
  createCapitalContribution,
  createEvent,
  createExpense,
  createExternalFoodItem,
  createFoodSupplier,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  createTicketLot,
  createTicketSale,
  deleteEventPermanently,
  deleteExpense,
  getOrder,
  openDatabase,
  openOrder,
  recordCapitalReimbursement,
  recordExpensePayment,
  recordStockMovement,
  resetEventData,
  verifyDatabaseIntegrity,
  type DatabaseContext,
} from './index';
import { deleteFoodSupplier } from './food';
import { deleteInventoryProduct } from './product-administration';
import { deleteServicePoint } from './service-point-administration';
import {
  createManagedVoucher,
  getManagedVoucherState,
  updateManagedVoucher,
} from './voucher-management';

let temporaryDirectory: string | null = null;
let databaseToClose: DatabaseContext | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-deletion-integrity-'));
  databaseToClose = openDatabase(path.join(temporaryDirectory, 'integrity.sqlite'));
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

function count(database: DatabaseContext, table: string, eventId: string): number {
  const eventPredicate =
    table === 'order_items'
      ? 'order_id IN (SELECT id FROM orders WHERE event_id = ?)'
      : table === 'payments'
        ? 'order_id IN (SELECT id FROM orders WHERE event_id = ?)'
        : 'event_id = ?';
  return (
    database.sqlite
      .prepare(`SELECT COUNT(*) AS amount FROM ${table} WHERE ${eventPredicate}`)
      .get(eventId) as {
      readonly amount: number;
    }
  ).amount;
}

function getStock(database: DatabaseContext, eventId: string, productId: string): number {
  const row = database.sqlite
    .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
    .get(eventId, productId) as { readonly quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function createCatalogProduct(database: DatabaseContext, name: string): string {
  const category = createProductCategory(database, `${name} categoria`);
  const product = createInventoryProduct(database, {
    categoryId: category.id,
    name,
    kind: 'drink',
    costCents: 250,
    salePriceCents: 1000,
    lowStockThreshold: 1,
  });
  recordStockMovement(database, {
    productId: product.id,
    type: 'purchase',
    quantity: 8,
    purchaseTotalCents: 2000,
  });
  return product.id;
}

describe('deletion integrity', () => {
  it('enforces voucher-to-table compatibility and restores the exact balance and stock on cancellation', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Voucher e mesa', startsAt: Date.now() });
    const productId = createCatalogProduct(database, 'Produto voucher íntegro');
    const tableA = createServicePoint(database, { label: 'Mesa Voucher A', type: 'table' });
    const tableB = createServicePoint(database, { label: 'Mesa Voucher B', type: 'table' });
    const voucher = createManagedVoucher(database, {
      code: 'INTEGRIDADE-01',
      label: 'Voucher da mesa A',
      initialBalanceCents: 1000,
      servicePointId: tableA.id,
    });

    const wrongOrder = openOrder(database, tableB.id);
    addOrderItem(database, {
      orderId: wrongOrder.id,
      itemKind: 'product',
      itemId: productId,
      quantity: 1,
    });
    expect(() =>
      bindOrderVoucher(database, { orderId: wrongOrder.id, code: voucher.code }),
    ).toThrow('só pode ser utilizado em Mesa Voucher A');

    const paidOrder = openOrder(database, tableA.id);
    addOrderItem(database, {
      orderId: paidOrder.id,
      itemKind: 'product',
      itemId: productId,
      quantity: 1,
    });
    bindOrderVoucher(database, { orderId: paidOrder.id, code: voucher.code });
    closeOrder(database, {
      orderId: paidOrder.id,
      discountCents: 0,
      payments: [],
      voucherUses: [{ code: voucher.code, amountCents: 1000 }],
    });

    expect(getStock(database, event.id, productId)).toBe(7);
    expect(getManagedVoucherState(database).vouchers[0]).toMatchObject({
      remainingBalanceCents: 0,
      status: 'exhausted',
    });

    cancelOrder(database, { orderId: paidOrder.id, reason: 'Teste de estorno total' });
    expect(getOrder(database, paidOrder.id).status).toBe('cancelled');
    expect(getStock(database, event.id, productId)).toBe(8);
    expect(getManagedVoucherState(database).vouchers[0]).toMatchObject({
      remainingBalanceCents: 1000,
      status: 'active',
    });
    expect(verifyDatabaseIntegrity(database)).toBe(true);
  });

  it('deleting a table either preserves paid sales or reverses sales and its bound voucher explicitly', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Mesa removível', startsAt: Date.now() });
    const productId = createCatalogProduct(database, 'Produto mesa removível');
    const table = createServicePoint(database, { label: 'Mesa a excluir', type: 'table' });
    const replacement = createServicePoint(database, { label: 'Mesa substituta', type: 'table' });
    const preservedVoucher = createManagedVoucher(database, {
      code: 'MESA-PRESERVADA',
      label: 'Voucher preservado',
      initialBalanceCents: 1000,
      servicePointId: table.id,
    });

    const paidOrder = openOrder(database, table.id);
    addOrderItem(database, {
      orderId: paidOrder.id,
      itemKind: 'product',
      itemId: productId,
      quantity: 1,
    });
    closeOrder(database, {
      orderId: paidOrder.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 1000 }],
    });
    const openOrderAtTable = openOrder(database, table.id);
    addOrderItem(database, {
      orderId: openOrderAtTable.id,
      itemKind: 'product',
      itemId: productId,
      quantity: 1,
    });

    expect(
      deleteServicePoint(database, {
        servicePointId: table.id,
        mode: 'keep-sales-history',
        reason: 'Mesa cadastrada em duplicidade',
      }),
    ).toMatchObject({ cancelledOrdersCount: 1, preservedOrdersCount: 1, affectedVouchersCount: 0 });
    expect(getOrder(database, paidOrder.id).status).toBe('paid');
    expect(getOrder(database, openOrderAtTable.id).status).toBe('cancelled');
    expect(getManagedVoucherState(database).vouchers[0]).toMatchObject({
      id: preservedVoucher.id,
      servicePointActive: false,
    });
    expect(
      updateManagedVoucher(database, {
        voucherId: preservedVoucher.id,
        code: preservedVoucher.code,
        label: preservedVoucher.label,
        servicePointId: replacement.id,
      }),
    ).toMatchObject({ servicePointId: replacement.id, servicePointActive: true });

    const tableToReverse = createServicePoint(database, {
      label: 'Mesa com estorno',
      type: 'table',
    });
    const reversalVoucher = createManagedVoucher(database, {
      code: 'MESA-ESTORNO',
      label: 'Voucher a estornar',
      initialBalanceCents: 1000,
      servicePointId: tableToReverse.id,
    });
    const orderToReverse = openOrder(database, tableToReverse.id);
    addOrderItem(database, {
      orderId: orderToReverse.id,
      itemKind: 'product',
      itemId: productId,
      quantity: 1,
    });
    bindOrderVoucher(database, { orderId: orderToReverse.id, code: reversalVoucher.code });
    closeOrder(database, {
      orderId: orderToReverse.id,
      discountCents: 0,
      payments: [],
      voucherUses: [{ code: reversalVoucher.code, amountCents: 1000 }],
    });
    const stockBeforeDelete = getStock(database, event.id, productId);

    expect(
      deleteServicePoint(database, {
        servicePointId: tableToReverse.id,
        mode: 'delete-all',
        reason: 'Encerramento da mesa de teste',
      }),
    ).toMatchObject({ cancelledOrdersCount: 1, preservedOrdersCount: 0, affectedVouchersCount: 1 });
    expect(getOrder(database, orderToReverse.id).status).toBe('cancelled');
    expect(getStock(database, event.id, productId)).toBe(stockBeforeDelete + 1);
    expect(getManagedVoucherState(database).deletedVouchers).toContainEqual(
      expect.objectContaining({ id: reversalVoucher.id, remainingBalanceCents: 1000 }),
    );
    expect(verifyDatabaseIntegrity(database)).toBe(true);
  });

  it('does not silently remove payment rows when deleting a paid expense', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Despesa removível', startsAt: Date.now() });
    const expense = createExpense(database, {
      category: 'Estrutura',
      description: 'Despesa com pagamento registrado',
      amountCents: 1200,
      paymentMethod: 'pix',
    });
    recordExpensePayment(database, { expenseId: expense.id, method: 'pix', amountCents: 1200 });

    expect(() =>
      deleteExpense(database, { expenseId: expense.id, reason: 'Lançamento duplicado' }),
    ).toThrow('Registre o estorno financeiro antes');
    expect(
      database.sqlite
        .prepare('SELECT id FROM expense_payments WHERE expense_id = ?')
        .all(expense.id),
    ).toHaveLength(1);
    expect(verifyDatabaseIntegrity(database)).toBe(true);
  });

  it('blocks a supplier deletion with sales until its linked sale is explicitly reversed', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Fornecedor removível', startsAt: Date.now() });
    const category = createProductCategory(database, 'Comida externa removível', 'food');
    configureFood(database, { supplierMode: 'external' });
    const supplier = createFoodSupplier(database, { name: 'Fornecedor de teste' });
    const food = createExternalFoodItem(database, {
      categoryId: category.id,
      supplierId: supplier.id,
      name: 'Prato removível',
      supplierUnitCents: 800,
      commissionUnitCents: 200,
      initialQuantity: 2,
      comboOnly: false,
    });
    const productId = food.items[0]?.productId;
    if (productId === undefined) throw new Error('Produto externo não foi criado.');
    const table = createServicePoint(database, { label: 'Mesa fornecedor', type: 'table' });
    const order = openOrder(database, table.id);
    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: productId,
      quantity: 1,
    });
    closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 1000 }],
    });

    expect(() => {
      deleteFoodSupplier(database, {
        supplierId: supplier.id,
        deleteLinkedSales: false,
        reason: 'Fornecedor cadastrado em duplicidade',
      });
    }).toThrow('Confirme a exclusão das vendas');

    deleteFoodSupplier(database, {
      supplierId: supplier.id,
      deleteLinkedSales: true,
      reason: 'Fornecedor cadastrado em duplicidade',
    });
    expect(getOrder(database, order.id).status).toBe('cancelled');
    expect(getStock(database, event.id, productId)).toBe(0);
    expect(
      database.sqlite.prepare('SELECT id FROM products WHERE id = ?').get(productId),
    ).toBeUndefined();
    expect(
      database.sqlite.prepare('SELECT id FROM food_suppliers WHERE id = ?').get(supplier.id),
    ).toBeUndefined();
    expect(
      database.sqlite
        .prepare('SELECT id FROM food_sale_settlements WHERE order_id = ?')
        .all(order.id),
    ).toHaveLength(0);
    expect(verifyDatabaseIntegrity(database)).toBe(true);
  });

  it('requires products to be removed before their category and leaves no orphaned stock data', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Categoria removível', startsAt: Date.now() });
    const category = createProductCategory(database, 'Categoria a remover');
    const product = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Produto de categoria a remover',
      kind: 'drink',
      costCents: 100,
      salePriceCents: 500,
      lowStockThreshold: 1,
    });
    recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 2 });

    const { deleteProductCategory } = await import('./inventory');
    expect(() => {
      deleteProductCategory(database, category.id);
    }).toThrow('Mova ou exclua os produtos');
    deleteInventoryProduct(database, {
      productId: product.id,
      mode: 'keep-sales-history',
      reason: 'Produto de teste removido',
    });
    deleteProductCategory(database, category.id);
    expect(
      database.sqlite.prepare('SELECT id FROM products WHERE id = ?').get(product.id),
    ).toBeUndefined();
    expect(
      database.sqlite.prepare('SELECT id FROM product_categories WHERE id = ?').get(category.id),
    ).toBeUndefined();
    expect(verifyDatabaseIntegrity(database)).toBe(true);
  });

  it('fully resets and permanently deletes an event containing vouchers, food, tickets and financial ledger data', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, {
      name: 'Evento completo removível',
      startsAt: Date.now(),
    });
    const foodCategory = createProductCategory(database, 'Categoria comida removível', 'food');
    configureFood(database, { supplierMode: 'external' });
    const supplier = createFoodSupplier(database, { name: 'Fornecedor removível' });
    const food = createExternalFoodItem(database, {
      categoryId: foodCategory.id,
      supplierId: supplier.id,
      name: 'Comida removível',
      supplierUnitCents: 700,
      commissionUnitCents: 300,
      initialQuantity: 3,
      comboOnly: false,
    });
    const foodProductId = food.items[0]?.productId;
    if (foodProductId === undefined) throw new Error('Produto de comida não foi criado.');
    const table = createServicePoint(database, { label: 'Mesa evento completo', type: 'table' });
    const voucher = createManagedVoucher(database, {
      code: 'EVENTO-COMPLETO',
      label: 'Voucher evento completo',
      initialBalanceCents: 1000,
      servicePointId: table.id,
    });
    const order = openOrder(database, table.id);
    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: foodProductId,
      quantity: 1,
    });
    bindOrderVoucher(database, { orderId: order.id, code: voucher.code });
    closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [],
      voucherUses: [{ code: voucher.code, amountCents: 1000 }],
    });
    const expense = createExpense(database, {
      category: 'Operação',
      description: 'Despesa do evento completo',
      amountCents: 1000,
      paymentMethod: 'pix',
    });
    recordExpensePayment(database, { expenseId: expense.id, method: 'pix', amountCents: 1000 });
    const contribution = createCapitalContribution(database, {
      contributorName: 'Aporte de teste',
      kind: 'cash',
      amountCents: 500,
    });
    recordCapitalReimbursement(database, {
      contributionId: contribution.id,
      method: 'pix',
      amountCents: 200,
    });
    const lot = createTicketLot(database, {
      name: 'Lote removível',
      priceCents: 1500,
      capacity: 4,
    });
    createTicketSale(database, {
      lotId: lot.id,
      attendeeName: 'Cliente de teste',
      source: 'door',
      quantity: 1,
      paymentMethod: 'pix',
    });

    resetEventData(database, {
      eventId: event.id,
      confirmationName: event.name,
      reason: 'Teste completo de reinicialização',
    });
    for (const tableName of [
      'orders',
      'order_items',
      'payments',
      'order_refunds',
      'vouchers',
      'voucher_transactions',
      'service_points',
      'expenses',
      'expense_payments',
      'capital_contributions',
      'capital_reimbursements',
      'ticket_lots',
      'ticket_sales',
      'ticket_codes',
      'food_suppliers',
      'food_product_terms',
      'food_sale_settlements',
      'event_stock',
      'stock_movements',
      'stock_purchase_lots',
    ]) {
      expect(count(database, tableName, event.id)).toBe(0);
    }
    expect(
      database.sqlite.prepare("SELECT key FROM app_meta WHERE key LIKE 'voucher.%'").all(),
    ).toHaveLength(0);
    expect(verifyDatabaseIntegrity(database)).toBe(true);

    const secondEvent = createEvent(database, {
      name: 'Evento exclusão completa',
      startsAt: Date.now() + 1,
    });
    const secondExpense = createExpense(database, {
      category: 'Operação',
      description: 'Despesa com vínculo financeiro',
      amountCents: 500,
      paymentMethod: 'pix',
    });
    recordExpensePayment(database, {
      expenseId: secondExpense.id,
      method: 'pix',
      amountCents: 500,
    });
    const secondContribution = createCapitalContribution(database, {
      contributorName: 'Aporte para exclusão',
      kind: 'cash',
      amountCents: 500,
    });
    recordCapitalReimbursement(database, {
      contributionId: secondContribution.id,
      method: 'pix',
      amountCents: 100,
    });

    deleteEventPermanently(database, {
      eventId: secondEvent.id,
      confirmationName: secondEvent.name,
      reason: 'Teste de exclusão completa com dependências',
    });
    expect(
      database.sqlite.prepare('SELECT id FROM events WHERE id = ?').get(secondEvent.id),
    ).toBeUndefined();
    for (const tableName of [
      'expenses',
      'expense_payments',
      'capital_contributions',
      'capital_reimbursements',
    ]) {
      expect(count(database, tableName, secondEvent.id)).toBe(0);
    }
    expect(verifyDatabaseIntegrity(database)).toBe(true);
  });
});
