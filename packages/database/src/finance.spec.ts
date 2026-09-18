import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  bindOrderVoucher,
  cancelExpense,
  closeCashRegister,
  closeOrder,
  createEvent,
  createExpense,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  getCashState,
  getExpenseState,
  getOperationState,
  openCashRegister,
  openDatabase,
  openOrder,
  recordCashMovement,
  recordExpensePayment,
  recordStockMovement,
  switchProfile,
  updateExpense,
  type DatabaseContext,
} from './index';
import { createManagedVoucher } from './voucher-management';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-finance-'));
  return openDatabase(path.join(temporaryDirectory, 'finance.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

function seedProduct(database: DatabaseContext): string {
  const category = createProductCategory(database, 'Financeiro');
  const product = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Produto financeiro',
    kind: 'drink',
    costCents: 200,
    salePriceCents: 1000,
    lowStockThreshold: 1,
  });
  recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 10 });
  return product.id;
}

function createOrder(
  database: DatabaseContext,
  productId: string,
  servicePointId?: string,
): string {
  const pointId = servicePointId ?? getOperationState(database).servicePoints[0]?.id;

  if (pointId === undefined) {
    throw new Error('Ponto de atendimento não criado.');
  }

  const order = openOrder(database, pointId);
  return addOrderItem(database, {
    orderId: order.id,
    itemKind: 'product',
    itemId: productId,
    quantity: 1,
  }).id;
}

describe('cash and expenses database', () => {
  it('concilia vendas, despesas, estoque e movimentações físicas', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento financeiro', startsAt: Date.now() });
    const productId = seedProduct(database);
    const voucherTable = createServicePoint(database, { label: 'Mesa financeiro', type: 'table' });
    const voucher = createManagedVoucher(database, {
      code: 'FIN-001',
      label: 'Crédito financeiro',
      initialBalanceCents: 500,
      servicePointId: voucherTable.id,
    });
    openCashRegister(database, 1000);

    closeOrder(database, {
      orderId: createOrder(database, productId),
      discountCents: 0,
      payments: [{ method: 'cash', amountCents: 1000, receivedCents: 1500 }],
    });
    const voucherOrderId = createOrder(database, productId, voucherTable.id);
    bindOrderVoucher(database, { orderId: voucherOrderId, code: voucher.code });
    closeOrder(database, {
      orderId: voucherOrderId,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 500 }],
      voucherUses: [{ code: voucher.code, amountCents: 500 }],
    });
    createExpense(database, {
      category: 'Operação',
      description: 'Gelo emergencial',
      amountCents: 300,
      paymentMethod: 'cash',
    });
    const cashExpense = getExpenseState(database).expenses.find((expense) => expense.description === 'Gelo emergencial');
    if (cashExpense === undefined) throw new Error('Despesa não criada.');
    recordExpensePayment(database, { expenseId: cashExpense.id, method: 'cash', amountCents: 300 });
    createExpense(database, {
      category: 'Mídia',
      description: 'Impulsionamento',
      amountCents: 200,
      paymentMethod: 'credit-card',
    });
    recordCashMovement(database, { type: 'supply', amountCents: 400, note: 'Troco' });
    recordCashMovement(database, { type: 'withdrawal', amountCents: 250, note: 'Sangria' });

    expect(getCashState(database)).toMatchObject({
      salesByMethod: {
        cashCents: 1000,
        pixCents: 500,
        creditCardCents: 0,
        debitCardCents: 0,
        voucherCents: 500,
      },
      grossSalesCents: 2000,
      activeExpensesCents: 500,
      stockCostCents: 2000,
      cashExpensesCents: 300,
      expectedCashCents: 1850,
      projectedResultCents: -500,
    });
    database.close();
  });

  it('mantém a despesa no resultado ao registrar pagamentos parciais e totais', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento situação despesa', startsAt: Date.now() });
    const expense = createExpense(database, {
      category: 'Estrutura',
      description: 'Locação de equipamento',
      amountCents: 1200,
      paymentMethod: 'pix',
    });

    expect(expense.paymentStatus).toBe('open');
    expect(getCashState(database).projectedResultCents).toBe(-1200);

    const partial = recordExpensePayment(database, { expenseId: expense.id, method: 'pix', amountCents: 400 });
    expect(partial.paymentStatus).toBe('partial');
    expect(getCashState(database).projectedResultCents).toBe(-1200);

    const paid = recordExpensePayment(database, { expenseId: expense.id, method: 'pix', amountCents: 800 });
    expect(paid.paymentStatus).toBe('paid');
    expect(getCashState(database).projectedResultCents).toBe(-1200);
    database.close();
  });

  it('edita dados principais da despesa e recalcula o resultado', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento edição despesa', startsAt: Date.now() });
    const expense = createExpense(database, {
      category: 'Estrutura',
      description: 'Locação de equipamento',
      amountCents: 1200,
      paymentMethod: 'pix',
      note: 'Primeiro orçamento',
    });

    const updated = updateExpense(database, {
      expenseId: expense.id,
      category: 'Operação',
      description: 'Locação de gerador',
      amountCents: 1800,
      paymentMethod: 'credit-card',
      paymentStatus: 'open',
      note: 'Valor revisado',
    });

    expect(updated).toMatchObject({
      id: expense.id,
      category: 'Operação',
      description: 'Locação de gerador',
      amountCents: 1800,
      paymentMethod: 'credit-card',
      paymentStatus: 'open',
      note: 'Valor revisado',
      status: 'active',
    });
    expect(getCashState(database).activeExpensesCents).toBe(1800);
    expect(getCashState(database).projectedResultCents).toBe(-1800);
    database.close();
  });

  it('não trata baixa excepcional de estoque como venda ou custo financeiro vendido', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento exceções de estoque', startsAt: Date.now() });
    const productId = seedProduct(database);

    recordStockMovement(database, { productId, type: 'loss', quantity: 2 });
    recordStockMovement(database, { productId, type: 'breakage', quantity: 1 });
    recordStockMovement(database, { productId, type: 'internal-consumption', quantity: 1 });
    recordStockMovement(database, { productId, type: 'courtesy', quantity: 1 });

    expect(getCashState(database)).toMatchObject({
      grossSalesCents: 0,
      stockCostCents: 1000,
      projectedResultCents: -1000,
    });
    database.close();
  });

  it('fecha com diferença e preserva os valores apurados', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento fechamento', startsAt: Date.now() });
    openCashRegister(database, 500);
    recordCashMovement(database, { type: 'supply', amountCents: 200 });
    const closed = closeCashRegister(database, 650);

    expect(closed.register).toMatchObject({
      status: 'closed',
      expectedCashCents: 700,
      countedCashCents: 650,
      varianceCents: -50,
    });
    expect(() => recordCashMovement(database, { type: 'withdrawal', amountCents: 50 })).toThrow(
      'O caixa deste evento já foi fechado.',
    );
    database.close();
  });

  it('bloqueia fechamento enquanto houver comanda aberta', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento comanda aberta', startsAt: Date.now() });
    const productId = seedProduct(database);
    openCashRegister(database, 0);
    createOrder(database, productId);

    expect(() => closeCashRegister(database, 0)).toThrow('Existem 1 comandas abertas no evento.');
    expect(getCashState(database).register?.status).toBe('open');
    database.close();
  });

  it('retira despesa cancelada dos totais e preserva o histórico', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento despesa', startsAt: Date.now() });
    const expense = createExpense(database, {
      category: 'Equipe',
      description: 'Alimentação',
      amountCents: 800,
      paymentMethod: 'pix',
      note: 'Plantão',
    });
    expect(getCashState(database).activeExpensesCents).toBe(800);

    cancelExpense(database, { expenseId: expense.id, reason: 'Fornecedor devolveu o valor' });
    expect(getCashState(database).activeExpensesCents).toBe(0);
    expect(getExpenseState(database).expenses[0]).toMatchObject({
      id: expense.id,
      status: 'cancelled',
    });
    database.close();
  });

  it('restringe toda a administração financeira no perfil Caixa', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento perfil Caixa', startsAt: Date.now() });
    switchProfile(database, 'cashier');

    expect(() => openCashRegister(database, 0)).toThrow(
      'A administração do caixa exige o perfil Produção.',
    );
    expect(() =>
      createExpense(database, {
        category: 'Proibida',
        description: 'Despesa proibida',
        amountCents: 100,
        paymentMethod: 'cash',
      }),
    ).toThrow('A administração de despesas exige o perfil Produção.');
    database.close();
  });
});
