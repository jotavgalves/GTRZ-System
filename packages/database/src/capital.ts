import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getSessionState } from './control';
import type { DatabasePaymentMethod } from './operation-types';
import type { DatabaseContext } from './types';

export type DatabaseCapitalContributionKind = 'cash' | 'inventory';

export interface DatabaseCapitalContribution {
  readonly id: string;
  readonly eventId: string;
  readonly contributorName: string;
  readonly kind: DatabaseCapitalContributionKind;
  readonly amountCents: number;
  readonly remainingStockValueCents: number;
  readonly reimbursedCents: number;
  readonly recoverableCents: number;
  readonly recoveryPriority: number;
  readonly note: string | null;
  readonly status: 'active' | 'cancelled';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DatabaseCapitalState {
  readonly activeEventId: string | null;
  readonly contributions: readonly DatabaseCapitalContribution[];
  readonly contributedCents: number;
  readonly reimbursedCents: number;
  readonly recoverableCents: number;
  readonly remainingStockAssetCents: number;
  readonly cashReimbursementsCents: number;
}

function requireProductionEvent(database: DatabaseContext): string {
  const session = getSessionState(database);
  if (session.profile !== 'production')
    throw new Error('A gestão de aportes exige o perfil Produção.');
  if (session.activeEvent === null)
    throw new Error('Selecione um evento aberto antes de registrar aportes.');
  return session.activeEvent.id;
}

function note(value?: string): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? null : normalized;
}

function getOpenRegisterId(database: DatabaseContext, eventId: string): string | null {
  const row = database.sqlite
    .prepare("SELECT id FROM cash_registers WHERE event_id = ? AND status = 'open'")
    .get(eventId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function getCapitalState(database: DatabaseContext): DatabaseCapitalState {
  const eventId = getSessionState(database).activeEvent?.id ?? null;
  if (eventId === null)
    return {
      activeEventId: null,
      contributions: [],
      contributedCents: 0,
      reimbursedCents: 0,
      recoverableCents: 0,
      remainingStockAssetCents: 0,
      cashReimbursementsCents: 0,
    };
  const rows = database.sqlite
    .prepare(
      `
    SELECT c.*, COALESCE(SUM(r.amount_cents), 0) AS reimbursed_cents
    FROM capital_contributions c
    LEFT JOIN capital_reimbursements r ON r.contribution_id = c.id
    WHERE c.event_id = ?
    GROUP BY c.id
    ORDER BY c.recovery_priority, c.created_at
  `,
    )
    .all(eventId) as Record<string, unknown>[];
  const contributions = rows.map((row) => ({
    id: String(row.id),
    eventId: String(row.event_id),
    contributorName: String(row.contributor_name),
    kind: row.kind as DatabaseCapitalContributionKind,
    amountCents: Number(row.amount_cents),
    remainingStockValueCents: Number(row.remaining_stock_value_cents),
    reimbursedCents: Number(row.reimbursed_cents),
    recoverableCents: Math.max(Number(row.amount_cents) - Number(row.reimbursed_cents), 0),
    recoveryPriority: Number(row.recovery_priority),
    note: typeof row.note === 'string' ? row.note : null,
    status: row.status as 'active' | 'cancelled',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
  const active = contributions.filter((item) => item.status === 'active');
  const cashReimbursements = database.sqlite
    .prepare(
      `SELECT COALESCE(SUM(r.amount_cents), 0) AS value FROM capital_reimbursements r WHERE r.event_id = ? AND r.method = 'cash'`,
    )
    .get(eventId) as { value: number };
  return {
    activeEventId: eventId,
    contributions,
    contributedCents: active.reduce((total, item) => total + item.amountCents, 0),
    reimbursedCents: active.reduce((total, item) => total + item.reimbursedCents, 0),
    recoverableCents: active.reduce((total, item) => total + item.recoverableCents, 0),
    remainingStockAssetCents: active
      .filter((item) => item.kind === 'inventory')
      .reduce((total, item) => total + item.remainingStockValueCents, 0),
    cashReimbursementsCents: cashReimbursements.value,
  };
}

export function createCapitalContribution(
  database: DatabaseContext,
  input: {
    contributorName: string;
    kind: DatabaseCapitalContributionKind;
    amountCents: number;
    remainingStockValueCents?: number;
    recoveryPriority?: number;
    note?: string;
  },
): DatabaseCapitalContribution {
  const eventId = requireProductionEvent(database);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    throw new Error('O valor do aporte deve ser positivo.');
  const remaining =
    input.kind === 'inventory' ? (input.remainingStockValueCents ?? input.amountCents) : 0;
  if (!Number.isInteger(remaining) || remaining < 0)
    throw new Error('O valor do estoque remanescente é inválido.');
  const id = randomUUID();
  const now = Date.now();
  const contributorName = input.contributorName.trim();
  if (contributorName.length < 2) throw new Error('Informe quem fez o aporte.');
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO capital_contributions (id,event_id,contributor_name,kind,amount_cents,remaining_stock_value_cents,recovery_priority,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?)`,
      )
      .run(
        id,
        eventId,
        contributorName,
        input.kind,
        input.amountCents,
        remaining,
        input.recoveryPriority ?? 1,
        note(input.note),
        now,
        now,
      );
    appendAudit(database, {
      action: 'capital.contribution-created',
      entityType: 'capital-contribution',
      entityId: id,
      eventId,
      details: {
        contributorName,
        kind: input.kind,
        amountCents: input.amountCents,
        remainingStockValueCents: remaining,
        recoveryPriority: input.recoveryPriority ?? 1,
        note: note(input.note),
      },
    });
  })();
  const contribution = getCapitalState(database).contributions.find((item) => item.id === id);
  if (contribution === undefined) throw new Error('O aporte criado não pôde ser localizado.');
  return contribution;
}

export function updateCapitalContribution(
  database: DatabaseContext,
  input: { contributionId: string; remainingStockValueCents: number; note?: string },
): DatabaseCapitalContribution {
  const eventId = requireProductionEvent(database);
  if (!Number.isInteger(input.remainingStockValueCents) || input.remainingStockValueCents < 0)
    throw new Error('O valor do estoque remanescente é inválido.');
  const row = database.sqlite
    .prepare('SELECT id, event_id, kind, status FROM capital_contributions WHERE id = ?')
    .get(input.contributionId) as
    | { id: string; event_id: string; kind: DatabaseCapitalContributionKind; status: string }
    | undefined;
  if (row?.event_id !== eventId || row.status !== 'active')
    throw new Error('O aporte informado não está disponível.');
  if (row.kind !== 'inventory')
    throw new Error('Somente aportes em estoque possuem saldo de material.');
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        'UPDATE capital_contributions SET remaining_stock_value_cents = ?, note = ?, updated_at = ? WHERE id = ?',
      )
      .run(input.remainingStockValueCents, note(input.note), now, row.id);
    appendAudit(database, {
      action: 'capital.contribution-updated',
      entityType: 'capital-contribution',
      entityId: row.id,
      eventId,
      details: { remainingStockValueCents: input.remainingStockValueCents, note: note(input.note) },
    });
  })();
  const contribution = getCapitalState(database).contributions.find((item) => item.id === row.id);
  if (contribution === undefined) throw new Error('O aporte atualizado não pôde ser localizado.');
  return contribution;
}

export function recordCapitalReimbursement(
  database: DatabaseContext,
  input: {
    contributionId: string;
    method: DatabasePaymentMethod;
    amountCents: number;
    note?: string;
  },
): DatabaseCapitalState {
  const eventId = requireProductionEvent(database);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    throw new Error('O reembolso deve ser positivo.');
  const contribution = getCapitalState(database).contributions.find(
    (item) => item.id === input.contributionId && item.status === 'active',
  );
  if (contribution?.eventId !== eventId) throw new Error('O aporte informado não está disponível.');
  if (input.amountCents > contribution.recoverableCents)
    throw new Error('O reembolso não pode superar o saldo recuperável do aporte.');
  const id = randomUUID(),
    now = Date.now(),
    registerId = input.method === 'cash' ? getOpenRegisterId(database, eventId) : null;
  if (input.method === 'cash' && registerId === null)
    throw new Error('Abra o caixa antes de registrar um reembolso em dinheiro.');
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        'INSERT INTO capital_reimbursements (id,contribution_id,event_id,method,amount_cents,cash_register_id,note,created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        contribution.id,
        eventId,
        input.method,
        input.amountCents,
        registerId,
        note(input.note),
        now,
      );
    appendAudit(database, {
      action: 'capital.reimbursed',
      entityType: 'capital-reimbursement',
      entityId: id,
      eventId,
      details: {
        contributionId: contribution.id,
        contributorName: contribution.contributorName,
        method: input.method,
        amountCents: input.amountCents,
        note: note(input.note),
        cashRegisterId: registerId,
      },
    });
  })();
  return getCapitalState(database);
}
