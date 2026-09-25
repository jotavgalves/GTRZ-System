import { getSessionState } from './control';
import type { DatabaseContext } from './types';

export interface DatabaseEventDeletionResult {
  readonly eventId: string;
  readonly eventName: string;
  readonly deleted: true;
  readonly removedOrdersCount: number;
  readonly removedOpenOrdersCount: number;
  readonly removedExpensesCount: number;
  readonly removedVouchersCount: number;
  readonly removedTicketSalesCount: number;
  readonly removedStockMovementsCount: number;
  readonly removedStockTransfersCount: number;
}

export interface DatabaseEventResetResult {
  readonly eventId: string;
  readonly eventName: string;
  readonly reset: true;
  readonly removedOrdersCount: number;
  readonly removedExpensesCount: number;
  readonly removedVouchersCount: number;
  readonly removedTicketSalesCount: number;
  readonly removedStockMovementsCount: number;
}

interface EventRow {
  readonly id: string;
  readonly name: string;
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('A exclusão definitiva de eventos exige o perfil Produção.');
  }
}

function requireEvent(database: DatabaseContext, eventId: string): EventRow {
  const event = database.sqlite.prepare('SELECT id, name FROM events WHERE id = ?').get(eventId) as
    | EventRow
    | undefined;

  if (event === undefined) {
    throw new Error('O evento informado não existe.');
  }

  return event;
}

function count(database: DatabaseContext, sql: string, ...params: unknown[]): number {
  const row = database.sqlite.prepare(sql).get(...params) as { readonly amount: number };
  return row.amount;
}

/** Clears operational data while retaining the event and reusable product catalog. */
export function resetEventData(
  database: DatabaseContext,
  input: {
    readonly eventId: string;
    readonly confirmationName: string;
    readonly reason: string;
    readonly system?: boolean;
  },
): DatabaseEventResetResult {
  if (input.system !== true) requireProduction(database);
  const event = requireEvent(database, input.eventId);
  const confirmationName = input.confirmationName.trim();
  const reason = input.reason.trim();
  if (confirmationName !== event.name) {
    throw new Error('Digite exatamente o nome do evento para confirmar a limpeza.');
  }
  if (reason.length < 3) {
    throw new Error('Informe o motivo da limpeza do evento.');
  }

  const result: DatabaseEventResetResult = {
    eventId: event.id,
    eventName: event.name,
    reset: true,
    removedOrdersCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM orders WHERE event_id = ?',
      event.id,
    ),
    removedExpensesCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM expenses WHERE event_id = ?',
      event.id,
    ),
    removedVouchersCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM vouchers WHERE event_id = ?',
      event.id,
    ),
    removedTicketSalesCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM ticket_sales WHERE event_id = ?',
      event.id,
    ),
    removedStockMovementsCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM stock_movements WHERE event_id = ?',
      event.id,
    ),
  };

  database.sqlite.transaction(() => {
    database.sqlite.prepare('DELETE FROM ticket_codes WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM ticket_sales WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM ticket_lots WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_sale_settlements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_combo_sale_settlements WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare(
        `DELETE FROM app_meta
         WHERE key IN (SELECT 'voucher.service-point:' || id FROM vouchers WHERE event_id = ?)
            OR key IN (SELECT 'voucher.deleted-at:' || id FROM vouchers WHERE event_id = ?)
            OR key IN (SELECT 'service-point.pinned:' || id FROM service_points WHERE event_id = ?)`,
      )
      .run(event.id, event.id, event.id);
    database.sqlite
      .prepare('DELETE FROM order_voucher_allocations WHERE event_id = ?')
      .run(event.id);
    database.sqlite.prepare('DELETE FROM voucher_transactions WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM vouchers WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM order_refunds WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?)')
      .run(event.id);
    database.sqlite
      .prepare(
        'DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?)',
      )
      .run(event.id);
    database.sqlite.prepare('DELETE FROM orders WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM service_points WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM expense_payments WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM expenses WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM capital_reimbursements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM capital_contributions WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_product_terms WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_combo_terms WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_suppliers WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_event_settings WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM cash_movements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM cash_registers WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare('DELETE FROM stock_purchase_lot_voids WHERE event_id = ?')
      .run(event.id);
    database.sqlite.prepare('DELETE FROM stock_purchase_lots WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM stock_movements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM event_stock WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare('DELETE FROM stock_transfers WHERE source_event_id = ? OR destination_event_id = ?')
      .run(event.id, event.id);
    database.sqlite.prepare('DELETE FROM sync_outbox WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM sync_inbox WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM sync_conflicts WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM audit_log WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare('DELETE FROM sync_state WHERE key LIKE ? OR key LIKE ?')
      .run(`%:${event.id}`, `inbox.cursor:${event.id}`);
    database.sqlite
      .prepare('DELETE FROM app_meta WHERE key = ? OR key LIKE ?')
      .run(`payment_terminal.debit_rate_basis_points:${event.id}`, `%:${event.id}`);
    database.sqlite
      .prepare(
        `INSERT INTO audit_log (event_id, profile, action, entity_type, entity_id, details_json, created_at)
       VALUES (NULL, 'production', 'event.reset-globally', 'event', ?, ?, ?)`,
      )
      .run(event.id, JSON.stringify({ reason, ...result }), Date.now());
  })();
  return result;
}

export function deleteEventPermanently(
  database: DatabaseContext,
  input: {
    readonly eventId: string;
    readonly confirmationName: string;
    readonly reason: string;
  },
): DatabaseEventDeletionResult {
  requireProduction(database);
  const event = requireEvent(database, input.eventId);
  const confirmationName = input.confirmationName.trim();
  const reason = input.reason.trim();

  if (confirmationName !== event.name) {
    throw new Error('Digite exatamente o nome do evento para confirmar a exclusão.');
  }

  if (reason.length < 3) {
    throw new Error('Informe o motivo da exclusão definitiva do evento.');
  }

  const result: DatabaseEventDeletionResult = {
    eventId: event.id,
    eventName: event.name,
    deleted: true,
    removedOrdersCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM orders WHERE event_id = ?',
      event.id,
    ),
    removedOpenOrdersCount: count(
      database,
      "SELECT COUNT(*) AS amount FROM orders WHERE event_id = ? AND status = 'open'",
      event.id,
    ),
    removedExpensesCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM expenses WHERE event_id = ?',
      event.id,
    ),
    removedVouchersCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM vouchers WHERE event_id = ?',
      event.id,
    ),
    removedTicketSalesCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM ticket_sales WHERE event_id = ?',
      event.id,
    ),
    removedStockMovementsCount: count(
      database,
      'SELECT COUNT(*) AS amount FROM stock_movements WHERE event_id = ?',
      event.id,
    ),
    removedStockTransfersCount: count(
      database,
      `SELECT COUNT(*) AS amount FROM stock_transfers
       WHERE source_event_id = ? OR destination_event_id = ?`,
      event.id,
      event.id,
    ),
  };

  database.sqlite.transaction(() => {
    database.sqlite.prepare('DELETE FROM ticket_codes WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM ticket_sales WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM ticket_lots WHERE event_id = ?').run(event.id);

    database.sqlite.prepare('DELETE FROM food_sale_settlements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_combo_sale_settlements WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare(
        `DELETE FROM app_meta
         WHERE key IN (SELECT 'voucher.service-point:' || id FROM vouchers WHERE event_id = ?)
            OR key IN (SELECT 'voucher.deleted-at:' || id FROM vouchers WHERE event_id = ?)
            OR key IN (SELECT 'service-point.pinned:' || id FROM service_points WHERE event_id = ?)`,
      )
      .run(event.id, event.id, event.id);

    database.sqlite
      .prepare('DELETE FROM order_voucher_allocations WHERE event_id = ?')
      .run(event.id);
    database.sqlite.prepare('DELETE FROM voucher_transactions WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM vouchers WHERE event_id = ?').run(event.id);

    database.sqlite.prepare('DELETE FROM order_refunds WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?)')
      .run(event.id);
    database.sqlite
      .prepare(
        'DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id = ?)',
      )
      .run(event.id);
    database.sqlite.prepare('DELETE FROM orders WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM service_points WHERE event_id = ?').run(event.id);

    database.sqlite.prepare('DELETE FROM cash_movements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM cash_registers WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM expense_payments WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM expenses WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM capital_reimbursements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM capital_contributions WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_product_terms WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_combo_terms WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_suppliers WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM food_event_settings WHERE event_id = ?').run(event.id);

    database.sqlite
      .prepare('DELETE FROM stock_purchase_lot_voids WHERE event_id = ?')
      .run(event.id);
    database.sqlite.prepare('DELETE FROM stock_purchase_lots WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM stock_movements WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM event_stock WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare('DELETE FROM stock_transfers WHERE source_event_id = ? OR destination_event_id = ?')
      .run(event.id, event.id);

    database.sqlite.prepare('DELETE FROM sync_outbox WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM sync_inbox WHERE event_id = ?').run(event.id);
    database.sqlite.prepare('DELETE FROM sync_conflicts WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare('DELETE FROM sync_state WHERE key LIKE ? OR key LIKE ?')
      .run(`%:${event.id}`, `inbox.cursor:${event.id}`);

    database.sqlite.prepare('DELETE FROM audit_log WHERE event_id = ?').run(event.id);
    database.sqlite
      .prepare(
        `DELETE FROM app_meta
         WHERE (key = 'active_event_id' AND value = ?)
            OR key = ?
            OR key = ?`,
      )
      .run(
        event.id,
        `payment_terminal.debit_rate_basis_points:${event.id}`,
        `payment_terminal.credit_rate_basis_points:${event.id}`,
      );

    database.sqlite.prepare('DELETE FROM events WHERE id = ?').run(event.id);

    database.sqlite
      .prepare(
        `INSERT INTO audit_log
         (event_id, profile, action, entity_type, entity_id, details_json, created_at)
         VALUES (NULL, 'production', 'event.deleted-permanently', 'event', ?, ?, ?)`,
      )
      .run(
        event.id,
        JSON.stringify({
          eventName: event.name,
          reason,
          removedExpensesCount: result.removedExpensesCount,
          removedOpenOrdersCount: result.removedOpenOrdersCount,
          removedOrdersCount: result.removedOrdersCount,
          removedStockMovementsCount: result.removedStockMovementsCount,
          removedStockTransfersCount: result.removedStockTransfersCount,
          removedTicketSalesCount: result.removedTicketSalesCount,
          removedVouchersCount: result.removedVouchersCount,
        }),
        Date.now(),
      );
  })();

  return result;
}
