import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getOrder, listOrderItems, requireOpenOrderRow } from './operation-core';
import { deductOrderStock } from './operation-stock';
import type {
  DatabaseCloseOrderPaymentInput,
  DatabaseOrder,
  DatabasePayment,
} from './operation-types';
import { releaseOrderVoucher, validateOrderVoucherUses } from './operation-vouchers';
import type { DatabaseContext } from './types';
import { redeemVouchers, type DatabaseVoucherUseInput } from './vouchers';
import { getPaymentFeeSnapshot } from './payment-terminal';

function normalizePayments(
  payments: readonly DatabaseCloseOrderPaymentInput[],
): readonly DatabasePayment[] {
  return payments.map((payment) => {
    if (!Number.isInteger(payment.amountCents) || payment.amountCents <= 0) {
      throw new Error('Os valores de pagamento devem ser positivos.');
    }

    if (payment.method !== 'cash' && payment.receivedCents !== undefined) {
      throw new Error('Valor recebido e troco só podem ser informados para pagamento em dinheiro.');
    }

    const receivedCents =
      payment.method === 'cash' ? (payment.receivedCents ?? payment.amountCents) : null;

    if (receivedCents !== null && receivedCents < payment.amountCents) {
      throw new Error('O valor recebido em dinheiro é menor que o valor aplicado.');
    }

    return {
      id: randomUUID(),
      orderId: '',
      method: payment.method,
      amountCents: payment.amountCents,
      receivedCents,
      changeCents: receivedCents === null ? 0 : receivedCents - payment.amountCents,
      feeRateBasisPoints: null,
      feeCents: null,
      createdAt: 0,
    };
  });
}

export function closeOrder(
  database: DatabaseContext,
  input: {
    readonly orderId: string;
    readonly discountCents: number;
    readonly payments: readonly DatabaseCloseOrderPaymentInput[];
    readonly voucherUses?: readonly DatabaseVoucherUseInput[];
  },
): DatabaseOrder {
  const order = requireOpenOrderRow(database, input.orderId);
  const items = listOrderItems(database, input.orderId);

  if (items.length === 0) {
    throw new Error('Inclua pelo menos um item antes de fechar a comanda.');
  }

  if (input.discountCents > order.subtotal_cents) {
    throw new Error('O desconto não pode ser maior que o subtotal.');
  }

  const totalCents = order.subtotal_cents - input.discountCents;

  if (totalCents <= 0) {
    throw new Error('O total da comanda precisa ser maior que zero.');
  }

  const voucherUses = validateOrderVoucherUses(database, order.id, input.voucherUses ?? []);
  const payments = normalizePayments(input.payments);
  const paymentCents = payments.reduce((total, payment) => total + payment.amountCents, 0);
  const voucherCents = voucherUses.reduce((total, use) => total + use.amountCents, 0);

  if (paymentCents + voucherCents !== totalCents) {
    throw new Error('A soma dos pagamentos e do voucher deve ser igual ao total da comanda.');
  }

  const now = Date.now();
  database.sqlite.transaction(() => {
    deductOrderStock(database, order.event_id, order.id, items, now);
    const redemptions = redeemVouchers(database, order.event_id, order.id, voucherUses, now);
    const insertPayment = database.sqlite.prepare(
      `INSERT INTO payments
       (id, order_id, method, amount_cents, received_cents, change_cents, fee_rate_basis_points, fee_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const payment of payments) {
      const fee = getPaymentFeeSnapshot(database, order.event_id, payment.method, payment.amountCents);
      insertPayment.run(
        payment.id,
        order.id,
        payment.method,
        payment.amountCents,
        payment.receivedCents,
        payment.changeCents,
        fee.rateBasisPoints,
        fee.feeCents,
        now,
      );
    }

    database.sqlite
      .prepare(
        `UPDATE orders
         SET status = 'paid', discount_cents = ?, total_cents = ?,
             closed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.discountCents, totalCents, now, now, order.id);
    database.sqlite
      .prepare('UPDATE service_points SET updated_at = ? WHERE id = ?')
      .run(now, order.service_point_id);
    releaseOrderVoucher(database, order.id);
    appendAudit(database, {
      action: 'operations.order-paid',
      entityType: 'order',
      entityId: order.id,
      eventId: order.event_id,
      details: {
        discountCents: input.discountCents,
        order: {
          id: order.id,
          openedAt: order.opened_at,
          servicePointId: order.service_point_id,
          servicePointLabel: order.service_point_label,
        },
        items: items.map((item) => ({
          id: item.id,
          itemId: item.itemId,
          itemKind: item.itemKind,
          itemName: item.itemName,
          quantity: item.quantity,
          totalCents: item.totalCents,
          unitPriceCents: item.unitPriceCents,
        })),
        payments: payments.map((payment) => ({
          id: payment.id,
          amountCents: payment.amountCents,
          changeCents: payment.changeCents,
          method: payment.method,
          receivedCents: payment.receivedCents,
          feeRateBasisPoints: getPaymentFeeSnapshot(database, order.event_id, payment.method, payment.amountCents).rateBasisPoints,
          feeCents: getPaymentFeeSnapshot(database, order.event_id, payment.method, payment.amountCents).feeCents,
        })),
        subtotalCents: order.subtotal_cents,
        totalCents,
        totalChangeCents: payments.reduce((total, payment) => total + payment.changeCents, 0),
        stockMovements: database.sqlite
          .prepare(
            `SELECT id, product_id, quantity, delta, note, created_at
             FROM stock_movements
             WHERE event_id = ? AND type = 'sale' AND note = ? ORDER BY id`,
          )
          .all(order.event_id, `Venda da comanda ${order.id}`),
        vouchers: redemptions,
      },
    });
  })();

  return getOrder(database, order.id);
}
