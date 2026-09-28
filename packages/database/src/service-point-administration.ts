import { appendAudit } from './audit';
import { getSessionState } from './control';
import { cancelOrder } from './operation-cancellation';
import { listServicePoints, requireActiveOperationEvent } from './operation-core';
import type { DatabaseServicePoint } from './operation-types';
import type { DatabaseContext } from './types';
import { deleteManagedVoucher } from './voucher-management';

export type DatabaseDeleteServicePointMode = 'delete-all' | 'keep-sales-history';

export interface DatabaseServicePointDeletionResult {
  readonly servicePointId: string;
  readonly deleted: true;
  readonly mode: DatabaseDeleteServicePointMode;
  readonly cancelledOrdersCount: number;
  readonly preservedOrdersCount: number;
  readonly affectedVouchersCount: number;
}

interface ServicePointRow {
  readonly id: string;
  readonly event_id: string;
  readonly label: string;
  readonly type: 'table' | 'counter';
  readonly active: number;
}

interface ServicePointOrderRow {
  readonly id: string;
  readonly status: 'open' | 'paid' | 'cancelled';
}

function pinnedKey(servicePointId: string): string {
  return `service-point.pinned:${servicePointId}`;
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('A administração de mesas exige o perfil Produção.');
  }
}

function requireActiveTable(
  database: DatabaseContext,
  eventId: string,
  servicePointId: string,
): ServicePointRow {
  const servicePoint = database.sqlite
    .prepare(
      `SELECT id, event_id, label, type, active
       FROM service_points
       WHERE id = ?`,
    )
    .get(servicePointId) as ServicePointRow | undefined;

  if (servicePoint?.event_id !== eventId || servicePoint.active !== 1) {
    throw new Error('A mesa informada não existe no evento ativo.');
  }

  if (servicePoint.type === 'counter') {
    throw new Error('O balcão permanente não pode ser excluído nem renomeado por aqui.');
  }

  return servicePoint;
}

function getActiveServicePoint(
  database: DatabaseContext,
  eventId: string,
  id: string,
): DatabaseServicePoint {
  const servicePoint = listServicePoints(database, eventId).find((item) => item.id === id);

  if (servicePoint === undefined) {
    throw new Error('A mesa foi atualizada, mas não pôde ser carregada.');
  }

  return servicePoint;
}

function listOrdersForServicePoint(
  database: DatabaseContext,
  eventId: string,
  servicePointId: string,
): readonly ServicePointOrderRow[] {
  return database.sqlite
    .prepare(
      `SELECT id, status
       FROM orders
       WHERE event_id = ? AND service_point_id = ?
       ORDER BY opened_at`,
    )
    .all(eventId, servicePointId) as ServicePointOrderRow[];
}

function listBoundVoucherIds(database: DatabaseContext, servicePointId: string): readonly string[] {
  const prefix = 'voucher.service-point:';
  const rows = database.sqlite
    .prepare(
      `SELECT SUBSTR(key, ?) AS voucher_id
       FROM app_meta
       WHERE key LIKE ? AND value = ?`,
    )
    .all(prefix.length + 1, `${prefix}%`, servicePointId) as { readonly voucher_id: string }[];
  return rows.map((row) => row.voucher_id);
}

export function renameServicePoint(
  database: DatabaseContext,
  input: { readonly servicePointId: string; readonly label: string },
): DatabaseServicePoint {
  requireProduction(database);
  const eventId = requireActiveOperationEvent(database);
  const servicePoint = requireActiveTable(database, eventId, input.servicePointId);
  const label = input.label.trim();
  const duplicate = database.sqlite
    .prepare(
      `SELECT id FROM service_points
       WHERE event_id = ? AND active = 1 AND label = ? COLLATE NOCASE AND id != ?`,
    )
    .get(eventId, label, servicePoint.id);

  if (duplicate !== undefined) {
    throw new Error('Já existe uma mesa ativa com esse nome.');
  }

  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare('UPDATE service_points SET label = ?, updated_at = ? WHERE id = ?')
      .run(label, now, servicePoint.id);
    database.sqlite
      .prepare(
        `UPDATE orders
         SET service_point_label = ?, updated_at = ?
         WHERE service_point_id = ? AND status = 'open'`,
      )
      .run(label, now, servicePoint.id);
    appendAudit(database, {
      action: 'operations.service-point-renamed',
      entityType: 'service-point',
      entityId: servicePoint.id,
      eventId,
      details: { previousLabel: servicePoint.label, label },
    });
  })();

  return getActiveServicePoint(database, eventId, servicePoint.id);
}

export function setServicePointPinned(
  database: DatabaseContext,
  input: { readonly servicePointId: string; readonly pinned: boolean },
): DatabaseServicePoint {
  requireProduction(database);
  const eventId = requireActiveOperationEvent(database);
  const servicePoint = requireActiveTable(database, eventId, input.servicePointId);
  const now = Date.now();

  database.sqlite.transaction(() => {
    if (input.pinned) {
      database.sqlite
        .prepare(
          `INSERT INTO app_meta (key, value, updated_at)
           VALUES (?, '1', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(pinnedKey(servicePoint.id), now);
    } else {
      database.sqlite.prepare('DELETE FROM app_meta WHERE key = ?').run(pinnedKey(servicePoint.id));
    }

    appendAudit(database, {
      action: 'operations.service-point-pinned',
      entityType: 'service-point',
      entityId: servicePoint.id,
      eventId,
      details: { label: servicePoint.label, pinned: input.pinned },
    });
  })();

  return getActiveServicePoint(database, eventId, servicePoint.id);
}

export function deleteServicePoint(
  database: DatabaseContext,
  input: {
    readonly servicePointId: string;
    readonly mode: DatabaseDeleteServicePointMode;
    readonly reason: string;
  },
): DatabaseServicePointDeletionResult {
  requireProduction(database);
  const eventId = requireActiveOperationEvent(database);
  const servicePoint = requireActiveTable(database, eventId, input.servicePointId);
  const reason = input.reason.trim();

  if (reason.length < 3) {
    throw new Error('Informe o motivo da exclusão da mesa.');
  }

  const orders = listOrdersForServicePoint(database, eventId, servicePoint.id);
  const cancellableOrders =
    input.mode === 'delete-all'
      ? orders.filter((order) => order.status !== 'cancelled')
      : orders.filter((order) => order.status === 'open');
  const preservedOrdersCount = orders.filter(
    (order) => !cancellableOrders.some((candidate) => candidate.id === order.id),
  ).length;
  const voucherIds =
    input.mode === 'delete-all' ? listBoundVoucherIds(database, servicePoint.id) : [];

  for (const order of cancellableOrders) {
    cancelOrder(database, {
      orderId: order.id,
      reason: `Exclusão da mesa ${servicePoint.label}: ${reason}`,
    });
  }

  for (const voucherId of voucherIds) {
    deleteManagedVoucher(database, {
      voucherId,
      reason: `Exclusão da mesa ${servicePoint.label}: ${reason}`,
    });
  }

  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare('UPDATE service_points SET active = 0, updated_at = ? WHERE id = ?')
      .run(now, servicePoint.id);
    database.sqlite.prepare('DELETE FROM app_meta WHERE key = ?').run(pinnedKey(servicePoint.id));
    appendAudit(database, {
      action: 'operations.service-point-deleted',
      entityType: 'service-point',
      entityId: servicePoint.id,
      eventId,
      details: {
        affectedVouchersCount: voucherIds.length,
        cancelledOrdersCount: cancellableOrders.length,
        label: servicePoint.label,
        mode: input.mode,
        preservedOrdersCount,
        reason,
      },
    });
  })();

  return {
    servicePointId: servicePoint.id,
    deleted: true,
    mode: input.mode,
    cancelledOrdersCount: cancellableOrders.length,
    preservedOrdersCount,
    affectedVouchersCount: voucherIds.length,
  };
}
