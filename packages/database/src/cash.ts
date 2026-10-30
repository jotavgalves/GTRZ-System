import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getCapitalState } from './capital';
import { getSessionState } from './control';
import { getTicketSalesByMethod } from './ticket-finance';
import type { DatabaseContext } from './types';

export type DatabaseCashRegisterStatus = 'open' | 'closed';
export type DatabaseCashMovementType = 'opening' | 'supply' | 'withdrawal';

export interface DatabaseCashRegister {
  readonly id: string;
  readonly eventId: string;
  readonly status: DatabaseCashRegisterStatus;
  readonly openingCashCents: number;
  readonly expectedCashCents: number;
  readonly countedCashCents: number | null;
  readonly varianceCents: number | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly updatedAt: number;
}

export interface DatabaseCashMovement {
  readonly id: string;
  readonly eventId: string;
  readonly cashRegisterId: string;
  readonly type: DatabaseCashMovementType;
  readonly amountCents: number;
  readonly note: string | null;
  readonly createdAt: number;
}

export interface DatabaseSalesByMethod {
  readonly cashCents: number;
  readonly pixCents: number;
  readonly creditCardCents: number;
  readonly debitCardCents: number;
  readonly voucherCents: number;
}

export interface DatabaseCashState {
  readonly activeEventId: string | null;
  readonly register: DatabaseCashRegister | null;
  readonly movements: readonly DatabaseCashMovement[];
  readonly salesByMethod: DatabaseSalesByMethod;
  readonly grossSalesCents: number;
  readonly activeExpensesCents: number;
  readonly paidExpensesCents: number;
  readonly outstandingExpensesCents: number;
  readonly cashExpensesCents: number;
  readonly cashRefundsCents: number;
  readonly cashCapitalReimbursementsCents: number;
  readonly recoverableCapitalCents: number;
  readonly remainingStockAssetCents: number;
  readonly expectedCashCents: number;
  readonly projectedResultCents: number;
}

interface CashRegisterRow {
  readonly id: string;
  readonly event_id: string;
  readonly status: DatabaseCashRegisterStatus;
  readonly opening_cash_cents: number;
  readonly expected_cash_cents: number;
  readonly counted_cash_cents: number | null;
  readonly variance_cents: number | null;
  readonly opened_at: number;
  readonly closed_at: number | null;
  readonly updated_at: number;
}

interface CashMovementRow {
  readonly id: string;
  readonly event_id: string;
  readonly cash_register_id: string;
  readonly type: DatabaseCashMovementType;
  readonly amount_cents: number;
  readonly note: string | null;
  readonly created_at: number;
}

interface PaymentSummaryRow {
  readonly method: 'cash' | 'pix' | 'credit-card' | 'debit-card';
  readonly amount_cents: number;
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('A administração do caixa exige o perfil Produção.');
  }
}

function requireActiveEvent(database: DatabaseContext): string {
  const eventId = getSessionState(database).activeEvent?.id;

  if (eventId === undefined) {
    throw new Error('Selecione um evento aberto antes de administrar o caixa.');
  }

  return eventId;
}

function normalizeOptionalText(value?: string): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function mapMovement(row: CashMovementRow): DatabaseCashMovement {
  return {
    id: row.id,
    eventId: row.event_id,
    cashRegisterId: row.cash_register_id,
    type: row.type,
    amountCents: row.amount_cents,
    note: row.note,
    createdAt: row.created_at,
  };
}

function getRegisterRow(database: DatabaseContext, eventId: string): CashRegisterRow | null {
  const row = database.sqlite
    .prepare(
      `SELECT id, event_id, status, opening_cash_cents, expected_cash_cents,
              counted_cash_cents, variance_cents, opened_at, closed_at, updated_at
       FROM cash_registers WHERE event_id = ?`,
    )
    .get(eventId) as CashRegisterRow | undefined;
  return row ?? null;
}

function requireOpenRegister(database: DatabaseContext, eventId: string): CashRegisterRow {
  const register = getRegisterRow(database, eventId);

  if (register === null) {
    throw new Error('Abra o caixa antes de registrar suprimentos ou retiradas.');
  }

  if (register.status !== 'open') {
    throw new Error('O caixa deste evento já foi fechado.');
  }

  return register;
}

function getSalesByMethod(database: DatabaseContext, eventId: string): DatabaseSalesByMethod {
  const rows = database.sqlite
    .prepare(
      `SELECT p.method, COALESCE(SUM(p.amount_cents), 0) AS amount_cents
       FROM payments p
       INNER JOIN orders o ON o.id = p.order_id
       WHERE o.event_id = ? AND o.status = 'paid'
       GROUP BY p.method`,
    )
    .all(eventId) as PaymentSummaryRow[];
  const ticketSales = getTicketSalesByMethod(database, eventId);
  let cashCents = 0;
  let pixCents = 0;
  let creditCardCents = 0;
  let debitCardCents = 0;

  for (const row of rows) {
    if (row.method === 'cash') {
      cashCents = row.amount_cents;
    } else if (row.method === 'pix') {
      pixCents = row.amount_cents;
    } else if (row.method === 'credit-card') {
      creditCardCents = row.amount_cents;
    } else {
      debitCardCents = row.amount_cents;
    }
  }

  const voucher = database.sqlite
    .prepare(
      `SELECT COALESCE(SUM(vt.amount_cents), 0) AS amount_cents
       FROM voucher_transactions vt
       INNER JOIN orders o ON o.id = vt.order_id
       WHERE o.event_id = ? AND o.status = 'paid' AND vt.type = 'redemption'`,
    )
    .get(eventId) as { readonly amount_cents: number };
  return {
    cashCents: cashCents + ticketSales.cashCents,
    pixCents: pixCents + ticketSales.pixCents,
    creditCardCents: creditCardCents + ticketSales.creditCardCents,
    debitCardCents: debitCardCents + ticketSales.debitCardCents,
    voucherCents: voucher.amount_cents,
  };
}

function getExpenseTotals(
  database: DatabaseContext,
  eventId: string,
): { readonly activeExpensesCents: number; readonly cashExpensesCents: number } {
  const row = database.sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(amount_cents), 0) AS active_expenses_cents,
         COALESCE(SUM((SELECT SUM(ep.amount_cents) FROM expense_payments ep WHERE ep.expense_id = expenses.id)), 0) AS paid_expenses_cents,
         COALESCE(SUM((SELECT SUM(ep.amount_cents) FROM expense_payments ep WHERE ep.expense_id = expenses.id AND ep.method = 'cash')), 0) AS cash_expenses_cents
       FROM expenses WHERE event_id = ? AND status = 'active'`,
    )
    .get(eventId) as {
    readonly active_expenses_cents: number;
    readonly paid_expenses_cents: number;
    readonly cash_expenses_cents: number;
  };
  return {
    activeExpensesCents: row.active_expenses_cents,
    cashExpensesCents: row.cash_expenses_cents,
  };
}

function getCashRefundsCents(database: DatabaseContext, eventId: string): number {
  return (
    database.sqlite
      .prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) AS value FROM order_refunds WHERE event_id = ? AND method = 'cash'",
      )
      .get(eventId) as { value: number }
  ).value;
}

function getMovementTotals(
  database: DatabaseContext,
  registerId: string | null,
): { readonly supplyCents: number; readonly withdrawalCents: number } {
  if (registerId === null) {
    return { supplyCents: 0, withdrawalCents: 0 };
  }

  const row = database.sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'supply' THEN amount_cents ELSE 0 END), 0)
           AS supply_cents,
         COALESCE(SUM(CASE WHEN type = 'withdrawal' THEN amount_cents ELSE 0 END), 0)
           AS withdrawal_cents
       FROM cash_movements
       WHERE cash_register_id = ?`,
    )
    .get(registerId) as { readonly supply_cents: number; readonly withdrawal_cents: number };
  return { supplyCents: row.supply_cents, withdrawalCents: row.withdrawal_cents };
}

function calculateState(database: DatabaseContext, eventId: string): DatabaseCashState {
  const registerRow = getRegisterRow(database, eventId);
  const movements =
    registerRow === null
      ? []
      : (
          database.sqlite
            .prepare(
              `SELECT id, event_id, cash_register_id, type, amount_cents, note, created_at
             FROM cash_movements
             WHERE cash_register_id = ?
             ORDER BY created_at DESC, id DESC`,
            )
            .all(registerRow.id) as CashMovementRow[]
        ).map(mapMovement);
  const salesByMethod = getSalesByMethod(database, eventId);
  const expenses = getExpenseTotals(database, eventId);
  const capital = getCapitalState(database);
  const cashRefundsCents = getCashRefundsCents(database, eventId);
  const paidExpensesCents = (
    database.sqlite
      .prepare(
        `SELECT COALESCE(SUM(ep.amount_cents), 0) AS value FROM expense_payments ep INNER JOIN expenses e ON e.id = ep.expense_id WHERE e.event_id = ? AND e.status = 'active'`,
      )
      .get(eventId) as { value: number }
  ).value;
  const movementTotals = getMovementTotals(database, registerRow?.id ?? null);
  const openingCashCents = registerRow?.opening_cash_cents ?? 0;
  const expectedCashCents =
    openingCashCents +
    salesByMethod.cashCents +
    movementTotals.supplyCents -
    movementTotals.withdrawalCents -
    expenses.cashExpensesCents -
    capital.cashReimbursementsCents;
  const grossSalesCents =
    salesByMethod.cashCents +
    salesByMethod.pixCents +
    salesByMethod.creditCardCents +
    salesByMethod.debitCardCents +
    salesByMethod.voucherCents;
  const register =
    registerRow === null
      ? null
      : {
          id: registerRow.id,
          eventId: registerRow.event_id,
          status: registerRow.status,
          openingCashCents: registerRow.opening_cash_cents,
          expectedCashCents:
            registerRow.status === 'open' ? expectedCashCents : registerRow.expected_cash_cents,
          countedCashCents: registerRow.counted_cash_cents,
          varianceCents: registerRow.variance_cents,
          openedAt: registerRow.opened_at,
          closedAt: registerRow.closed_at,
          updatedAt: registerRow.updated_at,
        };

  return {
    activeEventId: eventId,
    register,
    movements,
    salesByMethod,
    grossSalesCents,
    activeExpensesCents: expenses.activeExpensesCents,
    paidExpensesCents,
    outstandingExpensesCents: Math.max(expenses.activeExpensesCents - paidExpensesCents, 0),
    cashExpensesCents: expenses.cashExpensesCents,
    cashRefundsCents,
    cashCapitalReimbursementsCents: capital.cashReimbursementsCents,
    recoverableCapitalCents: capital.recoverableCents,
    remainingStockAssetCents: capital.remainingStockAssetCents,
    expectedCashCents,
    projectedResultCents: grossSalesCents - expenses.activeExpensesCents,
  };
}

export function getCashState(database: DatabaseContext): DatabaseCashState {
  const eventId = getSessionState(database).activeEvent?.id ?? null;

  if (eventId === null) {
    return {
      activeEventId: null,
      register: null,
      movements: [],
      salesByMethod: {
        cashCents: 0,
        pixCents: 0,
        creditCardCents: 0,
        debitCardCents: 0,
        voucherCents: 0,
      },
      grossSalesCents: 0,
      activeExpensesCents: 0,
      paidExpensesCents: 0,
      outstandingExpensesCents: 0,
      cashExpensesCents: 0,
      cashRefundsCents: 0,
      cashCapitalReimbursementsCents: 0,
      recoverableCapitalCents: 0,
      remainingStockAssetCents: 0,
      expectedCashCents: 0,
      projectedResultCents: 0,
    };
  }

  return calculateState(database, eventId);
}

export function openCashRegister(
  database: DatabaseContext,
  openingCashCents: number,
): DatabaseCashState {
  requireProduction(database);
  const eventId = requireActiveEvent(database);

  if (getRegisterRow(database, eventId) !== null) {
    throw new Error('O evento já possui um caixa registrado.');
  }

  if (!Number.isInteger(openingCashCents) || openingCashCents < 0) {
    throw new Error('O valor de abertura deve ser um inteiro não negativo.');
  }

  const registerId = randomUUID();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO cash_registers
         (id, event_id, status, opening_cash_cents, expected_cash_cents,
          counted_cash_cents, variance_cents, opened_at, closed_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, NULL, NULL, ?, NULL, ?)`,
      )
      .run(registerId, eventId, openingCashCents, openingCashCents, now, now);

    if (openingCashCents > 0) {
      database.sqlite
        .prepare(
          `INSERT INTO cash_movements
           (id, event_id, cash_register_id, type, amount_cents, note, created_at)
           VALUES (?, ?, ?, 'opening', ?, 'Saldo de abertura', ?)`,
        )
        .run(randomUUID(), eventId, registerId, openingCashCents, now);
    }

    appendAudit(database, {
      action: 'cash.opened',
      entityType: 'cash-register',
      entityId: registerId,
      eventId,
      details: { openingCashCents },
    });
  })();

  return calculateState(database, eventId);
}

export function recordCashMovement(
  database: DatabaseContext,
  input: {
    readonly type: 'supply' | 'withdrawal';
    readonly amountCents: number;
    readonly note?: string;
  },
): DatabaseCashState {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const register = requireOpenRegister(database, eventId);

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('O valor da movimentação deve ser positivo.');
  }

  const movementId = randomUUID();
  const note = normalizeOptionalText(input.note);
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO cash_movements
         (id, event_id, cash_register_id, type, amount_cents, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(movementId, eventId, register.id, input.type, input.amountCents, note, now);
    database.sqlite
      .prepare('UPDATE cash_registers SET updated_at = ? WHERE id = ?')
      .run(now, register.id);
    appendAudit(database, {
      action: `cash.${input.type}`,
      entityType: 'cash-movement',
      entityId: movementId,
      eventId,
      details: { amountCents: input.amountCents, note, registerId: register.id },
    });
  })();

  return calculateState(database, eventId);
}

export function closeCashRegister(
  database: DatabaseContext,
  countedCashCents: number,
): DatabaseCashState {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const register = requireOpenRegister(database, eventId);

  if (!Number.isInteger(countedCashCents) || countedCashCents < 0) {
    throw new Error('O valor contado deve ser um inteiro não negativo.');
  }

  const openOrders = database.sqlite
    .prepare(
      `SELECT COUNT(*) AS value
       FROM orders
       WHERE event_id = ?
         AND status = 'open'
         AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = orders.id)`,
    )
    .get(eventId) as { readonly value: number };

  if (openOrders.value > 0) {
    throw new Error(`Existem ${String(openOrders.value)} comandas abertas no evento.`);
  }

  const current = calculateState(database, eventId);
  const varianceCents = countedCashCents - current.expectedCashCents;
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE cash_registers
         SET status = 'closed', expected_cash_cents = ?, counted_cash_cents = ?,
             variance_cents = ?, closed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(current.expectedCashCents, countedCashCents, varianceCents, now, now, register.id);
    appendAudit(database, {
      action: 'cash.closed',
      entityType: 'cash-register',
      entityId: register.id,
      eventId,
      details: { countedCashCents, expectedCashCents: current.expectedCashCents, varianceCents },
    });
  })();

  return calculateState(database, eventId);
}
