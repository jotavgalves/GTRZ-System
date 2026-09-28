import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getSessionState } from './control';
import { cancelOrder } from './operation-cancellation';
import type { DatabaseContext } from './types';
import {
  clearVoucherServicePointBinding,
  getVoucherServicePointBinding,
  listVoucherServicePoints,
  setVoucherServicePointBinding,
  type DatabaseVoucherServicePoint,
} from './voucher-service-point';
import {
  changeVoucherStatus,
  createVoucher,
  getVoucherState,
  type DatabaseVoucher,
  type DatabaseVoucherState,
} from './vouchers';

export interface DatabaseManagedVoucher extends DatabaseVoucher {
  readonly servicePointId: string | null;
  readonly servicePointLabel: string | null;
  readonly servicePointActive: boolean;
  readonly deletedAt: number | null;
}

export interface DatabaseManagedVoucherState {
  readonly activeEventId: string | null;
  readonly vouchers: readonly DatabaseManagedVoucher[];
  readonly deletedVouchers: readonly DatabaseManagedVoucher[];
  readonly servicePoints: readonly DatabaseVoucherServicePoint[];
  readonly transactions: DatabaseVoucherState['transactions'];
}

export interface DatabaseCreateManagedVoucherInput {
  readonly code?: string;
  readonly label: string;
  readonly initialBalanceCents: number;
  readonly servicePointId: string;
}

export interface DatabaseUpdateManagedVoucherInput {
  readonly voucherId: string;
  readonly code: string;
  readonly label: string;
  readonly servicePointId: string;
}

function deletedKey(voucherId: string): string {
  return `voucher.deleted-at:${voucherId}`;
}

function normalizeCode(code: string): string {
  return code.trim().toLocaleUpperCase('pt-BR').replaceAll(/\s+/gu, '-');
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('A administração de vouchers exige o perfil Produção.');
  }
}

function requireActiveEvent(database: DatabaseContext): string {
  const eventId = getSessionState(database).activeEvent?.id;
  if (eventId === undefined) {
    throw new Error('Selecione um evento aberto antes de administrar vouchers.');
  }
  return eventId;
}

function getDeletedAt(database: DatabaseContext, voucherId: string): number | null {
  const row = database.sqlite
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(deletedKey(voucherId)) as { readonly value: string } | undefined;
  if (row === undefined) {
    return null;
  }
  const value = Number(row.value);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function markDeleted(database: DatabaseContext, voucherId: string, deletedAt: number): void {
  database.sqlite
    .prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(deletedKey(voucherId), String(deletedAt), deletedAt);
}

function requireVoucher(database: DatabaseContext, voucherId: string): DatabaseVoucher {
  const voucher = getVoucherState(database).vouchers.find((item) => item.id === voucherId);
  if (voucher === undefined || getDeletedAt(database, voucherId) !== null) {
    throw new Error('O voucher informado não existe ou foi excluído.');
  }
  return voucher;
}

function enrichVoucher(
  database: DatabaseContext,
  voucher: DatabaseVoucher,
): DatabaseManagedVoucher {
  const binding = getVoucherServicePointBinding(database, voucher.id);
  return {
    ...voucher,
    servicePointId: binding?.servicePointId ?? null,
    servicePointLabel: binding?.servicePointLabel ?? null,
    servicePointActive: binding?.active ?? false,
    deletedAt: getDeletedAt(database, voucher.id),
  };
}

export function getManagedVoucherState(database: DatabaseContext): DatabaseManagedVoucherState {
  const state = getVoucherState(database);
  const vouchers = state.vouchers.map((voucher) => enrichVoucher(database, voucher));
  const activeEventId = state.activeEventId;

  return {
    activeEventId,
    vouchers: vouchers.filter((voucher) => voucher.deletedAt === null),
    deletedVouchers: vouchers.filter((voucher) => voucher.deletedAt !== null),
    servicePoints: activeEventId === null ? [] : listVoucherServicePoints(database, activeEventId),
    transactions: state.transactions,
  };
}

export function createManagedVoucher(
  database: DatabaseContext,
  input: DatabaseCreateManagedVoucherInput,
): DatabaseManagedVoucher {
  requireProduction(database);
  const eventId = requireActiveEvent(database);

  return database.sqlite.transaction(() => {
    const voucher = createVoucher(
      database,
      input.code === undefined
        ? { label: input.label, initialBalanceCents: input.initialBalanceCents }
        : {
            code: input.code,
            label: input.label,
            initialBalanceCents: input.initialBalanceCents,
          },
    );
    setVoucherServicePointBinding(database, {
      voucherId: voucher.id,
      eventId,
      servicePointId: input.servicePointId,
    });
    appendAudit(database, {
      action: 'voucher.service-point-bound',
      entityType: 'voucher',
      entityId: voucher.id,
      eventId,
      details: { servicePointId: input.servicePointId },
    });
    return enrichVoucher(database, voucher);
  })();
}

export function updateManagedVoucher(
  database: DatabaseContext,
  input: DatabaseUpdateManagedVoucherInput,
): DatabaseManagedVoucher {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const voucher = requireVoucher(database, input.voucherId);

  if (voucher.eventId !== eventId) {
    throw new Error('O voucher não pertence ao evento em operação.');
  }

  const code = normalizeCode(input.code);
  const label = input.label.trim();
  if (code.length < 4 || code.length > 32) {
    throw new Error('O código do voucher deve ter entre 4 e 32 caracteres.');
  }
  if (label.length < 2 || label.length > 100) {
    throw new Error('A identificação do voucher deve ter entre 2 e 100 caracteres.');
  }

  const duplicate = database.sqlite
    .prepare(
      `SELECT id FROM vouchers
       WHERE event_id = ? AND code = ? COLLATE NOCASE AND id != ?`,
    )
    .get(eventId, code, voucher.id);
  if (duplicate !== undefined) {
    throw new Error('Já existe outro voucher com esse código no evento.');
  }

  const previousBinding = getVoucherServicePointBinding(database, voucher.id);
  const now = Date.now();
  database.sqlite.transaction(() => {
    setVoucherServicePointBinding(database, {
      voucherId: voucher.id,
      eventId,
      servicePointId: input.servicePointId,
    });
    database.sqlite
      .prepare('UPDATE vouchers SET code = ?, label = ?, updated_at = ? WHERE id = ?')
      .run(code, label, now, voucher.id);
    appendAudit(database, {
      action: 'voucher.updated',
      entityType: 'voucher',
      entityId: voucher.id,
      eventId,
      details: {
        previousCode: voucher.code,
        previousLabel: voucher.label,
        previousServicePointId: previousBinding?.servicePointId ?? null,
        code,
        label,
        servicePointId: input.servicePointId,
      },
    });
  })();

  return enrichVoucher(
    database,
    getVoucherState(database).vouchers.find((item) => item.id === voucher.id) ?? voucher,
  );
}

export function addManagedVoucherBalance(
  database: DatabaseContext,
  input: { readonly voucherId: string; readonly amountCents: number },
): DatabaseManagedVoucher {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const voucher = requireVoucher(database, input.voucherId);

  if (voucher.eventId !== eventId) {
    throw new Error('O voucher não pertence ao evento em operação.');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('O valor de recarga do voucher deve ser positivo.');
  }

  const nextInitial = voucher.initialBalanceCents + input.amountCents;
  const nextRemaining = voucher.remainingBalanceCents + input.amountCents;
  const nextStatus = voucher.status === 'cancelled' ? 'cancelled' : 'active';
  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE vouchers
         SET initial_balance_cents = ?, remaining_balance_cents = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextInitial, nextRemaining, nextStatus, now, voucher.id);
    database.sqlite
      .prepare(
        `INSERT INTO voucher_transactions
         (id, event_id, voucher_id, voucher_code, order_id, type, amount_cents,
          balance_before_cents, balance_after_cents, note, created_at)
         VALUES (?, ?, ?, ?, NULL, 'issue', ?, ?, ?, 'Recarga de voucher', ?)`,
      )
      .run(
        randomUUID(),
        eventId,
        voucher.id,
        voucher.code,
        input.amountCents,
        voucher.remainingBalanceCents,
        nextRemaining,
        now,
      );
    appendAudit(database, {
      action: 'voucher.balance-added',
      entityType: 'voucher',
      entityId: voucher.id,
      eventId,
      details: {
        amountCents: input.amountCents,
        balanceBeforeCents: voucher.remainingBalanceCents,
        balanceAfterCents: nextRemaining,
      },
    });
  })();

  return enrichVoucher(
    database,
    getVoucherState(database).vouchers.find((item) => item.id === voucher.id) ?? voucher,
  );
}

export function setManagedVoucherTotal(
  database: DatabaseContext,
  input: {
    readonly voucherId: string;
    readonly initialBalanceCents: number;
    readonly reason: string;
  },
): DatabaseManagedVoucher {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const voucher = requireVoucher(database, input.voucherId);
  const reason = input.reason.trim();

  if (voucher.eventId !== eventId) {
    throw new Error('O voucher não pertence ao evento em operação.');
  }
  if (!Number.isInteger(input.initialBalanceCents) || input.initialBalanceCents <= 0) {
    throw new Error('O valor total do voucher deve ser positivo.');
  }
  if (reason.length < 2 || reason.length > 250) {
    throw new Error('Informe um motivo entre 2 e 250 caracteres para corrigir o valor.');
  }

  const redeemedCents = voucher.initialBalanceCents - voucher.remainingBalanceCents;
  if (input.initialBalanceCents < redeemedCents) {
    throw new Error(
      `O novo total não pode ser menor que o valor já utilizado (${redeemedCents} centavos).`,
    );
  }

  const nextRemaining = input.initialBalanceCents - redeemedCents;
  const nextStatus =
    voucher.status === 'cancelled' ? 'cancelled' : nextRemaining === 0 ? 'exhausted' : 'active';
  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE vouchers
         SET initial_balance_cents = ?, remaining_balance_cents = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.initialBalanceCents, nextRemaining, nextStatus, now, voucher.id);
    appendAudit(database, {
      action: 'voucher.value-updated',
      entityType: 'voucher',
      entityId: voucher.id,
      eventId,
      details: {
        code: voucher.code,
        reason,
        previousInitialBalanceCents: voucher.initialBalanceCents,
        previousRemainingBalanceCents: voucher.remainingBalanceCents,
        initialBalanceCents: input.initialBalanceCents,
        remainingBalanceCents: nextRemaining,
        redeemedCents,
        status: nextStatus,
      },
    });
  })();

  return enrichVoucher(
    database,
    getVoucherState(database).vouchers.find((item) => item.id === voucher.id) ?? voucher,
  );
}

export function changeManagedVoucherStatus(
  database: DatabaseContext,
  input: { readonly voucherId: string; readonly status: 'active' | 'cancelled' },
): DatabaseManagedVoucher {
  requireVoucher(database, input.voucherId);
  return enrichVoucher(database, changeVoucherStatus(database, input));
}

export function deleteManagedVoucher(
  database: DatabaseContext,
  input: { readonly voucherId: string; readonly reason: string },
): { readonly mode: 'deleted' | 'reversed-and-hidden' } {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const voucher = requireVoucher(database, input.voucherId);

  if (voucher.eventId !== eventId) {
    throw new Error('O voucher não pertence ao evento em operação.');
  }

  const reason = input.reason.trim();
  if (reason.length < 2) {
    throw new Error('Informe o motivo da exclusão do voucher.');
  }

  const redemptionCount = database.sqlite
    .prepare(
      `SELECT COUNT(*) AS value
       FROM voucher_transactions
       WHERE voucher_id = ? AND type = 'redemption'`,
    )
    .get(voucher.id) as { readonly value: number };

  if (redemptionCount.value === 0) {
    database.sqlite.transaction(() => {
      database.sqlite
        .prepare('DELETE FROM order_voucher_allocations WHERE voucher_id = ?')
        .run(voucher.id);
      database.sqlite
        .prepare('DELETE FROM voucher_transactions WHERE voucher_id = ?')
        .run(voucher.id);
      clearVoucherServicePointBinding(database, voucher.id);
      database.sqlite.prepare('DELETE FROM app_meta WHERE key = ?').run(deletedKey(voucher.id));
      database.sqlite.prepare('DELETE FROM vouchers WHERE id = ?').run(voucher.id);
      appendAudit(database, {
        action: 'voucher.deleted',
        entityType: 'voucher',
        entityId: voucher.id,
        eventId,
        details: { code: voucher.code, reason, mode: 'permanent' },
      });
    })();
    return { mode: 'deleted' };
  }

  const paidOrders = database.sqlite
    .prepare(
      `SELECT DISTINCT o.id
       FROM voucher_transactions vt
       INNER JOIN orders o ON o.id = vt.order_id
       WHERE vt.voucher_id = ? AND vt.type = 'redemption' AND o.status = 'paid'`,
    )
    .all(voucher.id) as { readonly id: string }[];

  database.sqlite.transaction(() => {
    for (const order of paidOrders) {
      cancelOrder(database, {
        orderId: order.id,
        reason: `Exclusão do voucher ${voucher.code}: ${reason}`,
      });
    }

    database.sqlite
      .prepare('DELETE FROM order_voucher_allocations WHERE voucher_id = ?')
      .run(voucher.id);
    database.sqlite
      .prepare("UPDATE vouchers SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(Date.now(), voucher.id);
    clearVoucherServicePointBinding(database, voucher.id);
    const deletedAt = Date.now();
    markDeleted(database, voucher.id, deletedAt);
    appendAudit(database, {
      action: 'voucher.deleted-with-reversal',
      entityType: 'voucher',
      entityId: voucher.id,
      eventId,
      details: {
        code: voucher.code,
        reason,
        reversedOrderIds: paidOrders.map((order) => order.id),
      },
    });
  })();

  return { mode: 'reversed-and-hidden' };
}
