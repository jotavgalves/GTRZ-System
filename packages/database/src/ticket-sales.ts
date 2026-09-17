import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import type { DatabasePaymentMethod } from './operation-types';
import type { DatabaseTicketSale, DatabaseTicketSaleSource } from './ticket-model';
import {
  ensureUniqueTicketCodes,
  generateTicketCode,
  mapTicketSale,
  normalizeTicketCode,
  requireTicketEvent,
  requireTicketLot,
  requireTicketProduction,
  requireTicketSale,
} from './ticket-repository';
import type { DatabaseContext } from './types';

export function createTicketSale(
  database: DatabaseContext,
  input: {
    readonly lotId: string;
    readonly attendeeName: string;
    readonly source: DatabaseTicketSaleSource;
    readonly quantity: number;
    readonly paymentMethod?: DatabasePaymentMethod;
    readonly manualCodes?: readonly string[];
  },
): DatabaseTicketSale {
  requireTicketProduction(database);
  const eventId = requireTicketEvent(database);
  const lot = requireTicketLot(database, eventId, input.lotId);

  if (!lot.active) {
    throw new Error('O lote está inativo e não aceita novas vendas.');
  }

  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error('A quantidade de ingressos deve ser positiva.');
  }

  if (lot.availableQuantity < input.quantity) {
    throw new Error(`Capacidade insuficiente. Disponível: ${String(lot.availableQuantity)}.`);
  }

  if (input.source === 'courtesy' && input.paymentMethod !== undefined) {
    throw new Error('Cortesias não possuem forma de pagamento.');
  }

  if (input.source !== 'courtesy' && input.paymentMethod === undefined) {
    throw new Error('Informe a forma de pagamento da venda.');
  }

  if (input.manualCodes !== undefined && input.manualCodes.length !== input.quantity) {
    throw new Error('A quantidade de códigos deve ser igual à quantidade de ingressos.');
  }

  const codes = (
    input.manualCodes ?? Array.from({ length: input.quantity }, generateTicketCode)
  ).map(normalizeTicketCode);
  ensureUniqueTicketCodes(database, eventId, codes);
  const saleId = randomUUID();
  const attendeeName = input.attendeeName.trim();
  const unitPriceCents = input.source === 'courtesy' ? 0 : lot.priceCents;
  const totalCents = unitPriceCents * input.quantity;
  const now = Date.now();
  const ticketCodes = codes.map((code) => ({ id: randomUUID(), code }));

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO ticket_sales
         (id, event_id, lot_id, lot_name, attendee_name, source, quantity,
          unit_price_cents, total_cents, payment_method, status,
          created_at, cancelled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)`,
      )
      .run(
        saleId,
        eventId,
        lot.id,
        lot.name,
        attendeeName,
        input.source,
        input.quantity,
        unitPriceCents,
        totalCents,
        input.paymentMethod ?? null,
        now,
        now,
      );
    const insertCode = database.sqlite.prepare(
      `INSERT INTO ticket_codes (id, event_id, sale_id, code, status, created_at)
       VALUES (?, ?, ?, ?, 'valid', ?)`,
    );

    for (const code of ticketCodes) {
      insertCode.run(code.id, eventId, saleId, code.code, now);
    }

    appendAudit(database, {
      action: input.source === 'courtesy' ? 'ticket.courtesy-created' : 'ticket.sale-created',
      entityType: 'ticket-sale',
      entityId: saleId,
      eventId,
      details: {
        attendeeName,
        codes: ticketCodes,
        lotId: lot.id,
        lotName: lot.name,
        paymentMethod: input.paymentMethod ?? null,
        quantity: input.quantity,
        source: input.source,
        totalCents,
        unitPriceCents,
      },
    });
  })();

  return mapTicketSale(database, requireTicketSale(database, saleId));
}

export function cancelTicketSale(
  database: DatabaseContext,
  input: { readonly saleId: string; readonly reason: string },
): DatabaseTicketSale {
  requireTicketProduction(database);
  const eventId = requireTicketEvent(database);
  const sale = requireTicketSale(database, input.saleId);

  if (sale.event_id !== eventId) {
    throw new Error('A venda não pertence ao evento ativo.');
  }

  if (sale.status === 'cancelled') {
    throw new Error('Esta venda de ingresso já foi cancelada.');
  }

  const reason = input.reason.trim();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE ticket_sales
         SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, sale.id);
    database.sqlite
      .prepare("UPDATE ticket_codes SET status = 'cancelled' WHERE sale_id = ?")
      .run(sale.id);
    appendAudit(database, {
      action: 'ticket.sale-cancelled',
      entityType: 'ticket-sale',
      entityId: sale.id,
      eventId,
      details: {
        attendeeName: sale.attendee_name,
        quantity: sale.quantity,
        reason,
        totalCents: sale.total_cents,
      },
    });
  })();

  return mapTicketSale(database, requireTicketSale(database, sale.id));
}

export function deleteTicketSale(
  database: DatabaseContext,
  input: { readonly saleId: string; readonly reason: string },
): { readonly saleId: string; readonly deleted: true; readonly wasCancelledFirst: boolean } {
  requireTicketProduction(database);
  const eventId = requireTicketEvent(database);
  let sale = requireTicketSale(database, input.saleId);

  if (sale.event_id !== eventId) {
    throw new Error('A venda não pertence ao evento ativo.');
  }

  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new Error('Informe o motivo da exclusão da venda de ingresso.');
  }

  const wasCancelledFirst = sale.status === 'active';
  if (wasCancelledFirst) {
    cancelTicketSale(database, { saleId: sale.id, reason });
    sale = requireTicketSale(database, sale.id);
  }

  const codes = database.sqlite
    .prepare('SELECT code FROM ticket_codes WHERE sale_id = ? ORDER BY created_at')
    .all(sale.id) as { readonly code: string }[];

  database.sqlite.transaction(() => {
    appendAudit(database, {
      action: 'ticket.sale-deleted',
      entityType: 'ticket-sale',
      entityId: sale.id,
      eventId,
      details: {
        attendeeName: sale.attendee_name,
        codes: codes.map((item) => item.code),
        lotId: sale.lot_id,
        previousStatus: sale.status,
        quantity: sale.quantity,
        reason,
        source: sale.source,
        totalCents: sale.total_cents,
        wasCancelledFirst,
      },
    });
    database.sqlite.prepare('DELETE FROM ticket_codes WHERE sale_id = ?').run(sale.id);
    database.sqlite.prepare('DELETE FROM ticket_sales WHERE id = ?').run(sale.id);
  })();

  return { saleId: sale.id, deleted: true, wasCancelledFirst };
}
