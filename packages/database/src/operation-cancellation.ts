import { randomUUID } from 'node:crypto';
import { appendAudit } from './audit';
import { getSessionState } from './control';
import { getOrder, requireActiveOperationEvent, requireOrderRow } from './operation-core';
import { restoreOrderStock } from './operation-stock';
import { clearExternalFoodSettlements } from './food';
import type { DatabaseOrder, DatabasePaymentMethod } from './operation-types';
import { releaseOrderVoucher } from './operation-vouchers';
import type { DatabaseContext } from './types';
import { refundOrderVouchers } from './vouchers';

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('O cancelamento de comandas exige o perfil Produção.');
  }
}

export function cancelOrder(
  database: DatabaseContext,
  input: {
    readonly orderId: string;
    readonly reason: string;
    readonly refunds?: readonly {
      readonly method: DatabasePaymentMethod;
      readonly amountCents: number;
    }[];
  },
): DatabaseOrder {
  requireProduction(database);
  const eventId = requireActiveOperationEvent(database);
  const order = requireOrderRow(database, input.orderId);

  if (order.event_id !== eventId) {
    throw new Error('A comanda não pertence ao evento ativo.');
  }

  if (order.status === 'cancelled') {
    throw new Error('Esta comanda já foi cancelada.');
  }

  const reason = input.reason.trim();
  const now = Date.now();
  let restoredUnits = 0;
  let refundedVoucherCents = 0;
  const paymentRows = database.sqlite
    .prepare('SELECT method, amount_cents FROM payments WHERE order_id = ? ORDER BY created_at, id')
    .all(order.id) as Array<{ method: DatabasePaymentMethod; amount_cents: number }>;
  const refunds =
    input.refunds ??
    paymentRows.map((payment) => ({ method: payment.method, amountCents: payment.amount_cents }));
  const expectedRefundCents = paymentRows.reduce(
    (total, payment) => total + payment.amount_cents,
    0,
  );
  const actualRefundCents = refunds.reduce((total, refund) => total + refund.amountCents, 0);
  if (order.status === 'paid' && actualRefundCents !== expectedRefundCents)
    throw new Error('Informe a devolução completa da venda, separada por meio de pagamento.');

  database.sqlite.transaction(() => {
    if (order.status === 'paid') {
      restoredUnits = restoreOrderStock(database, eventId, order.id, now);
      clearExternalFoodSettlements(database, order.id);
      refundedVoucherCents = refundOrderVouchers(database, eventId, order.id, now);
      const register = database.sqlite
        .prepare("SELECT id FROM cash_registers WHERE event_id = ? AND status = 'open'")
        .get(eventId) as { id: string } | undefined;
      const insertRefund = database.sqlite.prepare(
        'INSERT INTO order_refunds (id, order_id, event_id, method, amount_cents, cash_register_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const refund of refunds) {
        const cashRegisterId = refund.method === 'cash' ? (register?.id ?? null) : null;
        insertRefund.run(
          randomUUID(),
          order.id,
          eventId,
          refund.method,
          refund.amountCents,
          cashRegisterId,
          reason,
          now,
        );
      }
    } else {
      releaseOrderVoucher(database, order.id);
    }

    database.sqlite
      .prepare(
        `UPDATE orders
         SET status = 'cancelled', closed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, order.id);
    appendAudit(database, {
      action: 'operations.order-cancelled',
      entityType: 'order',
      entityId: order.id,
      eventId,
      details: {
        previousStatus: order.status,
        reason,
        refundedVoucherCents,
        refunds,
        restoredUnits,
        totalCents: order.total_cents,
      },
    });
  })();

  return getOrder(database, order.id);
}
