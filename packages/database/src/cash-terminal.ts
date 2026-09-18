import {
  closeCashRegister as closeBaseCashRegister,
  getCashState as getBaseCashState,
  openCashRegister as openBaseCashRegister,
  recordCashMovement as recordBaseCashMovement,
  type DatabaseCashState,
} from './cash';
import { getEventStockCostCents } from './event-stock-cost';
import { calculatePaymentTerminalFees } from './payment-terminal';
import type { DatabaseContext } from './types';

export * from './cash';

export interface DatabaseCashStateWithTerminal extends DatabaseCashState {
  readonly terminalFeesCents: number;
  readonly stockCostCents: number;
}

function applyOperatingCosts(
  database: DatabaseContext,
  state: DatabaseCashState,
): DatabaseCashStateWithTerminal {
  if (state.activeEventId === null) {
    return { ...state, terminalFeesCents: 0, stockCostCents: 0 };
  }

  const saved = database.sqlite.prepare(`SELECT COALESCE(SUM(p.fee_cents), 0) AS saved_cents, COALESCE(SUM(CASE WHEN p.fee_cents IS NULL AND p.method = 'debit-card' THEN p.amount_cents ELSE 0 END), 0) AS legacy_debit_cents, COALESCE(SUM(CASE WHEN p.fee_cents IS NULL AND p.method = 'credit-card' THEN p.amount_cents ELSE 0 END), 0) AS legacy_credit_cents FROM payments p INNER JOIN orders o ON o.id = p.order_id WHERE o.event_id = ? AND o.status = 'paid'`).get(state.activeEventId) as {saved_cents:number;legacy_debit_cents:number;legacy_credit_cents:number};
  const fees = calculatePaymentTerminalFees(database, state.activeEventId, {
    debitCardCents: saved.legacy_debit_cents,
    creditCardCents: saved.legacy_credit_cents,
  });
  const stockCostCents = getEventStockCostCents(database, state.activeEventId);

  return {
    ...state,
    terminalFeesCents: saved.saved_cents + fees.totalFeeCents,
    stockCostCents,
    projectedResultCents: state.projectedResultCents - stockCostCents - saved.saved_cents - fees.totalFeeCents,
  };
}

export function getCashState(database: DatabaseContext): DatabaseCashStateWithTerminal {
  return applyOperatingCosts(database, getBaseCashState(database));
}

export function openCashRegister(
  database: DatabaseContext,
  openingCashCents: number,
): DatabaseCashStateWithTerminal {
  return applyOperatingCosts(database, openBaseCashRegister(database, openingCashCents));
}

export function recordCashMovement(
  database: DatabaseContext,
  input: Parameters<typeof recordBaseCashMovement>[1],
): DatabaseCashStateWithTerminal {
  return applyOperatingCosts(database, recordBaseCashMovement(database, input));
}

export function closeCashRegister(
  database: DatabaseContext,
  countedCashCents: number,
): DatabaseCashStateWithTerminal {
  return applyOperatingCosts(database, closeBaseCashRegister(database, countedCashCents));
}
