import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getSessionState } from './control';
import { listOperationCatalog } from './operation-stock';
import type {
  DatabaseOperationState,
  DatabaseOrder,
  DatabaseOrderItem,
  DatabaseOrderItemKind,
  DatabaseOrderStatus,
  DatabasePayment,
  DatabasePaymentMethod,
  DatabaseServicePoint,
  DatabaseServicePointType,
} from './operation-types';
import { getOrderVoucherAllocation } from './operation-vouchers';
import type { DatabaseContext } from './types';
import { listOrderVoucherRedemptions } from './vouchers';

interface ServicePointRow {
  readonly id: string;
  readonly event_id: string;
  readonly label: string;
  readonly type: DatabaseServicePointType;
  readonly pinned: number;
  readonly active_order_id: string | null;
  readonly active_order_total_cents: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface OperationOrderRow {
  readonly id: string;
  readonly event_id: string;
  readonly service_point_id: string;
  readonly service_point_label: string;
  readonly status: DatabaseOrderStatus;
  readonly subtotal_cents: number;
  readonly discount_cents: number;
  readonly total_cents: number;
  readonly opened_at: number;
  readonly closed_at: number | null;
  readonly updated_at: number;
}

interface OrderItemRow {
  readonly id: string;
  readonly order_id: string;
  readonly item_kind: DatabaseOrderItemKind;
  readonly item_id: string;
  readonly item_name: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
  readonly total_cents: number;
  readonly created_at: number;
}

interface PaymentRow {
  readonly id: string;
  readonly order_id: string;
  readonly method: DatabasePaymentMethod;
  readonly amount_cents: number;
  readonly received_cents: number | null;
  readonly change_cents: number;
  readonly fee_rate_basis_points: number | null;
  readonly fee_cents: number | null;
  readonly created_at: number;
}

export function requireActiveOperationEvent(database: DatabaseContext): string {
  const event = getSessionState(database).activeEvent;

  if (event === null) {
    throw new Error('Selecione um evento aberto antes de operar mesas e vendas.');
  }

  return event.id;
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('O cadastro de mesas exige o perfil Produção.');
  }
}

function mapServicePoint(row: ServicePointRow): DatabaseServicePoint {
  return {
    id: row.id,
    eventId: row.event_id,
    label: row.label,
    type: row.type,
    pinned: row.pinned === 1,
    status: row.active_order_id === null ? 'available' : 'open',
    activeOrderId: row.active_order_id,
    activeOrderTotalCents: row.active_order_total_cents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrderItem(row: OrderItemRow): DatabaseOrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    itemKind: row.item_kind,
    itemId: row.item_id,
    itemName: row.item_name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    totalCents: row.total_cents,
    createdAt: row.created_at,
  };
}

function mapPayment(row: PaymentRow): DatabasePayment {
  return {
    id: row.id,
    orderId: row.order_id,
    method: row.method,
    amountCents: row.amount_cents,
    receivedCents: row.received_cents,
    changeCents: row.change_cents,
    feeRateBasisPoints: row.fee_rate_basis_points,
    feeCents: row.fee_cents,
    createdAt: row.created_at,
  };
}

export function listOrderItems(
  database: DatabaseContext,
  orderId: string,
): readonly DatabaseOrderItem[] {
  const rows = database.sqlite
    .prepare(
      `SELECT id, order_id, item_kind, item_id, item_name, quantity,
              unit_price_cents, total_cents, created_at
       FROM order_items
       WHERE order_id = ?
       ORDER BY created_at, item_name COLLATE NOCASE`,
    )
    .all(orderId) as OrderItemRow[];
  return rows.map(mapOrderItem);
}

function listPayments(database: DatabaseContext, orderId: string): readonly DatabasePayment[] {
  const rows = database.sqlite
    .prepare(
      `SELECT id, order_id, method, amount_cents, received_cents, change_cents, fee_rate_basis_points, fee_cents, created_at
       FROM payments
       WHERE order_id = ?
       ORDER BY created_at, id`,
    )
    .all(orderId) as PaymentRow[];
  return rows.map(mapPayment);
}

export function requireOrderRow(database: DatabaseContext, orderId: string): OperationOrderRow {
  const row = database.sqlite
    .prepare(
      `SELECT id, event_id, service_point_id, service_point_label, status,
              subtotal_cents, discount_cents, total_cents, opened_at, closed_at, updated_at
       FROM orders
       WHERE id = ?`,
    )
    .get(orderId) as OperationOrderRow | undefined;

  if (row === undefined) {
    throw new Error('A comanda informada não existe.');
  }

  return row;
}

export function requireOpenOrderRow(database: DatabaseContext, orderId: string): OperationOrderRow {
  const order = requireOrderRow(database, orderId);

  if (order.status !== 'open') {
    throw new Error('Somente comandas abertas podem ser alteradas.');
  }

  if (order.event_id !== requireActiveOperationEvent(database)) {
    throw new Error('A comanda não pertence ao evento ativo.');
  }

  return order;
}

function mapOrder(database: DatabaseContext, row: OperationOrderRow): DatabaseOrder {
  const items = listOrderItems(database, row.id);
  const payments = listPayments(database, row.id);
  const voucherAllocation = getOrderVoucherAllocation(database, row.id);
  const voucherRedemptions = listOrderVoucherRedemptions(database, row.id);
  const paidCents =
    payments.reduce((total, payment) => total + payment.amountCents, 0) +
    voucherRedemptions.reduce((total, redemption) => total + redemption.amountCents, 0);

  return {
    id: row.id,
    eventId: row.event_id,
    servicePointId: row.service_point_id,
    servicePointLabel: row.service_point_label,
    status: row.status,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    paidCents,
    remainingCents: Math.max(row.total_cents - paidCents, 0),
    items,
    payments,
    voucherAllocation,
    voucherRedemptions,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
  };
}

function listRecentOrders(database: DatabaseContext, eventId: string): readonly DatabaseOrder[] {
  const rows = database.sqlite
    .prepare(
      `SELECT id, event_id, service_point_id, service_point_label, status,
              subtotal_cents, discount_cents, total_cents, opened_at, closed_at, updated_at
       FROM orders
       WHERE event_id = ? AND status IN ('paid', 'cancelled')
       ORDER BY updated_at DESC`,
    )
    .all(eventId) as OperationOrderRow[];
  return rows.map((row) => mapOrder(database, row));
}

function ensureCounter(database: DatabaseContext, eventId: string): void {
  const existing = database.sqlite
    .prepare(
      `SELECT id FROM service_points
       WHERE event_id = ? AND type = 'counter' AND active = 1`,
    )
    .get(eventId);

  if (existing !== undefined) {
    return;
  }

  const id = randomUUID();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO service_points
         (id, event_id, label, type, active, created_at, updated_at)
         VALUES (?, ?, 'Balcão', 'counter', 1, ?, ?)`,
      )
      .run(id, eventId, now, now);
    appendAudit(database, {
      action: 'operations.counter-created',
      entityType: 'service-point',
      entityId: id,
      eventId,
      details: { label: 'Balcão' },
    });
  })();
}

export function listServicePoints(
  database: DatabaseContext,
  eventId: string,
): readonly DatabaseServicePoint[] {
  const rows = database.sqlite
    .prepare(
      `SELECT
         sp.id,
         sp.event_id,
         sp.label,
         sp.type,
         CASE WHEN pinned.value = '1' THEN 1 ELSE 0 END AS pinned,
         o.id AS active_order_id,
         COALESCE(o.total_cents, 0) AS active_order_total_cents,
         sp.created_at,
         sp.updated_at
       FROM service_points sp
       LEFT JOIN app_meta pinned
         ON pinned.key = 'service-point.pinned:' || sp.id
       LEFT JOIN orders o
         ON o.service_point_id = sp.id
        AND o.status = 'open'
       WHERE sp.event_id = ? AND sp.active = 1
       ORDER BY CASE sp.type WHEN 'counter' THEN 0 ELSE 1 END,
                pinned DESC,
                sp.label COLLATE NOCASE`,
    )
    .all(eventId) as ServicePointRow[];
  return rows.map(mapServicePoint);
}

export function recomputeOpenOrder(database: DatabaseContext, orderId: string, now: number): void {
  const total = database.sqlite
    .prepare('SELECT COALESCE(SUM(total_cents), 0) AS value FROM order_items WHERE order_id = ?')
    .get(orderId) as { readonly value: number };
  database.sqlite
    .prepare(
      `UPDATE orders
       SET subtotal_cents = ?, discount_cents = 0, total_cents = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(total.value, total.value, now, orderId);
}

export function getOperationState(database: DatabaseContext): DatabaseOperationState {
  const eventId = getSessionState(database).activeEvent?.id ?? null;

  if (eventId === null) {
    return { activeEventId: null, servicePoints: [], catalog: [], recentOrders: [] };
  }

  ensureCounter(database, eventId);
  return {
    activeEventId: eventId,
    servicePoints: listServicePoints(database, eventId),
    catalog: listOperationCatalog(database, eventId),
    recentOrders: listRecentOrders(database, eventId),
  };
}

export function createServicePoint(
  database: DatabaseContext,
  input: { readonly label: string; readonly type: DatabaseServicePointType },
): DatabaseServicePoint {
  requireProduction(database);
  const eventId = requireActiveOperationEvent(database);
  const label = input.label.trim();
  const duplicate = database.sqlite
    .prepare(
      `SELECT id FROM service_points
       WHERE event_id = ? AND label = ? COLLATE NOCASE AND active = 1`,
    )
    .get(eventId, label);

  if (duplicate !== undefined) {
    throw new Error('Já existe uma mesa ou balcão com esse nome.');
  }

  if (
    input.type === 'counter' &&
    database.sqlite
      .prepare(
        `SELECT id FROM service_points
         WHERE event_id = ? AND type = 'counter' AND active = 1`,
      )
      .get(eventId) !== undefined
  ) {
    throw new Error('O evento já possui um balcão ativo.');
  }

  const id = randomUUID();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO service_points
         (id, event_id, label, type, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, eventId, label, input.type, now, now);
    appendAudit(database, {
      action: 'operations.service-point-created',
      entityType: 'service-point',
      entityId: id,
      eventId,
      details: { label, type: input.type },
    });
  })();

  const servicePoint = listServicePoints(database, eventId).find((item) => item.id === id);

  if (servicePoint === undefined) {
    throw new Error('A mesa foi criada, mas não pôde ser carregada.');
  }

  return servicePoint;
}

export function openOrder(database: DatabaseContext, servicePointId: string): DatabaseOrder {
  const eventId = requireActiveOperationEvent(database);
  const servicePoint = listServicePoints(database, eventId).find(
    (item) => item.id === servicePointId,
  );

  if (servicePoint === undefined) {
    throw new Error('A mesa ou balcão informado não existe no evento ativo.');
  }

  if (servicePoint.activeOrderId !== null) {
    return getOrder(database, servicePoint.activeOrderId);
  }

  const orderId = randomUUID();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO orders
         (id, event_id, service_point_id, service_point_label, status,
          subtotal_cents, discount_cents, total_cents, opened_at, closed_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', 0, 0, 0, ?, NULL, ?)`,
      )
      .run(orderId, eventId, servicePoint.id, servicePoint.label, now, now);
    appendAudit(database, {
      action: 'operations.order-opened',
      entityType: 'order',
      entityId: orderId,
      eventId,
      details: { servicePointId, servicePointLabel: servicePoint.label },
    });
  })();

  return getOrder(database, orderId);
}

export function getOrder(database: DatabaseContext, orderId: string): DatabaseOrder {
  return mapOrder(database, requireOrderRow(database, orderId));
}
