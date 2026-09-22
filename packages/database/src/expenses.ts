import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getSessionState } from './control';
import type { DatabasePaymentMethod } from './operation-types';
import type { DatabaseContext } from './types';

export type DatabaseExpenseStatus = 'active' | 'cancelled';
export type DatabaseExpensePaymentStatus = 'open' | 'partial' | 'paid';

export interface DatabaseExpense {
  readonly id: string;
  readonly eventId: string;
  readonly category: string;
  readonly description: string;
  readonly amountCents: number;
  readonly paymentMethod: DatabasePaymentMethod;
  readonly note: string | null;
  readonly status: DatabaseExpenseStatus;
  readonly paymentStatus: DatabaseExpensePaymentStatus;
  readonly createdAt: number;
  readonly cancelledAt: number | null;
  readonly updatedAt: number;
  readonly paidCents: number;
  readonly outstandingCents: number;
}

export interface DatabaseExpenseState {
  readonly activeEventId: string | null;
  readonly expenses: readonly DatabaseExpense[];
}

interface ExpenseRow {
  readonly id: string;
  readonly event_id: string;
  readonly category: string;
  readonly description: string;
  readonly amount_cents: number;
  readonly payment_method: DatabasePaymentMethod;
  readonly note: string | null;
  readonly status: DatabaseExpenseStatus;
  readonly payment_status: DatabaseExpensePaymentStatus;
  readonly created_at: number;
  readonly cancelled_at: number | null;
  readonly updated_at: number;
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('A administração de despesas exige o perfil Produção.');
  }
}

function requireActiveEvent(database: DatabaseContext): string {
  const eventId = getSessionState(database).activeEvent?.id;

  if (eventId === undefined) {
    throw new Error('Selecione um evento aberto antes de registrar despesas.');
  }

  return eventId;
}

function normalizeOptionalText(value?: string): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function paidCents(database: DatabaseContext, expenseId: string): number {
  const row = database.sqlite.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS value FROM expense_payments WHERE expense_id = ?').get(expenseId) as { value: number };
  return row.value;
}

function derivedStatus(amountCents: number, paid: number): DatabaseExpensePaymentStatus {
  return paid <= 0 ? 'open' : paid >= amountCents ? 'paid' : 'partial';
}

function mapExpense(database: DatabaseContext, row: ExpenseRow): DatabaseExpense {
  const paid = paidCents(database, row.id);
  return {
    id: row.id,
    eventId: row.event_id,
    category: row.category,
    description: row.description,
    amountCents: row.amount_cents,
    paymentMethod: row.payment_method,
    note: row.note,
    status: row.status,
    paymentStatus: derivedStatus(row.amount_cents, paid),
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    updatedAt: row.updated_at,
    paidCents: paid,
    outstandingCents: Math.max(row.amount_cents - paid, 0),
  };
}

function requireExpense(database: DatabaseContext, expenseId: string): ExpenseRow {
  const row = database.sqlite
    .prepare(
      `SELECT id, event_id, category, description, amount_cents, payment_method,
              note, status, payment_status, created_at, cancelled_at, updated_at
       FROM expenses WHERE id = ?`,
    )
    .get(expenseId) as ExpenseRow | undefined;

  if (row === undefined) {
    throw new Error('A despesa informada não existe.');
  }

  return row;
}

export function getExpenseState(database: DatabaseContext): DatabaseExpenseState {
  const eventId = getSessionState(database).activeEvent?.id ?? null;

  if (eventId === null) {
    return { activeEventId: null, expenses: [] };
  }

  const rows = database.sqlite
    .prepare(
      `SELECT id, event_id, category, description, amount_cents, payment_method,
              note, status, payment_status, created_at, cancelled_at, updated_at
       FROM expenses
       WHERE event_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
                CASE payment_status WHEN 'open' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,
                updated_at DESC`,
    )
    .all(eventId) as ExpenseRow[];
  return { activeEventId: eventId, expenses: rows.map((row) => mapExpense(database, row)) };
}

export function createExpense(
  database: DatabaseContext,
  input: {
    readonly category: string;
    readonly description: string;
    readonly amountCents: number;
    readonly paymentMethod: DatabasePaymentMethod;
    readonly paymentStatus?: DatabaseExpensePaymentStatus;
    readonly note?: string;
  },
): DatabaseExpense {
  requireProduction(database);
  const eventId = requireActiveEvent(database);

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('O valor da despesa deve ser positivo.');
  }

  const expenseId = randomUUID();
  const category = input.category.trim();
  const description = input.description.trim();
  const note = normalizeOptionalText(input.note);
  const paymentStatus = 'open';
  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO expenses
         (id, event_id, category, description, amount_cents, payment_method,
          note, status, payment_status, created_at, cancelled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?)`,
      )
      .run(
        expenseId,
        eventId,
        category,
        description,
        input.amountCents,
        input.paymentMethod,
        note,
        paymentStatus,
        now,
        now,
      );
    appendAudit(database, {
      action: 'expense.created',
      entityType: 'expense',
      entityId: expenseId,
      eventId,
      details: {
        amountCents: input.amountCents,
        category,
        description,
        note,
        paymentMethod: input.paymentMethod,
        paymentStatus,
      },
    });
  })();

  return mapExpense(database, requireExpense(database, expenseId));
}

export function updateExpensePaymentStatus(
  database: DatabaseContext,
  input: { readonly expenseId: string; readonly paymentStatus: DatabaseExpensePaymentStatus },
): DatabaseExpense {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const expense = requireExpense(database, input.expenseId);

  if (expense.event_id !== eventId) {
    throw new Error('A despesa não pertence ao evento ativo.');
  }

  if (expense.status === 'cancelled') {
    throw new Error('Não é possível alterar o pagamento de uma despesa cancelada.');
  }

  const actual = derivedStatus(expense.amount_cents, paidCents(database, expense.id));
  if (actual !== input.paymentStatus) throw new Error('A situação é calculada pelos pagamentos registrados. Registre um pagamento real para alterá-la.');
  return mapExpense(database, expense);
}

export function recordExpensePayment(database: DatabaseContext, input: { readonly expenseId: string; readonly method: DatabasePaymentMethod; readonly amountCents: number; readonly note?: string }): DatabaseExpense {
  requireProduction(database); const eventId = requireActiveEvent(database); const expense = requireExpense(database, input.expenseId);
  if (expense.event_id !== eventId || expense.status === 'cancelled') throw new Error('A despesa informada não está disponível para pagamento.');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error('O pagamento deve ser positivo.');
  const current = paidCents(database, expense.id); if (current + input.amountCents > expense.amount_cents) throw new Error('O pagamento não pode superar o valor pendente da despesa.');
  const register = input.method === 'cash' ? database.sqlite.prepare("SELECT id FROM cash_registers WHERE event_id = ? AND status = 'open'").get(eventId) as { id: string } | undefined : undefined;
  if (input.method === 'cash' && register === undefined) throw new Error('Abra o caixa antes de registrar uma despesa em dinheiro.');
  const id=randomUUID(), now=Date.now(), normalizedNote=normalizeOptionalText(input.note);
  database.sqlite.transaction(() => {
    database.sqlite.prepare('INSERT INTO expense_payments (id, expense_id, event_id, method, amount_cents, cash_register_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id,expense.id,eventId,input.method,input.amountCents,register?.id ?? null,normalizedNote,now);
    const after=derivedStatus(expense.amount_cents,current + input.amountCents);
    database.sqlite.prepare('UPDATE expenses SET payment_status = ?, updated_at = ? WHERE id = ?').run(after,now,expense.id);
    appendAudit(database,{action:'expense.payment-recorded',entityType:'expense-payment',entityId:id,eventId,details:{expenseId:expense.id,description:expense.description,method:input.method,amountCents:input.amountCents,note:normalizedNote,cashRegisterId:register?.id ?? null,paymentStatus:after}});
  })();
  return mapExpense(database, requireExpense(database, expense.id));
}

export function updateExpense(
  database: DatabaseContext,
  input: {
    readonly expenseId: string;
    readonly category: string;
    readonly description: string;
    readonly amountCents: number;
    readonly paymentMethod: DatabasePaymentMethod;
    readonly paymentStatus: DatabaseExpensePaymentStatus;
    readonly note?: string;
  },
): DatabaseExpense {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const expense = requireExpense(database, input.expenseId);

  if (expense.event_id !== eventId) {
    throw new Error('A despesa não pertence ao evento ativo.');
  }

  if (expense.status === 'cancelled') {
    throw new Error('Não é possível editar uma despesa cancelada.');
  }

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('O valor da despesa deve ser positivo.');
  }

  const category = input.category.trim();
  const description = input.description.trim();
  const note = normalizeOptionalText(input.note);
  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE expenses
         SET category = ?, description = ?, amount_cents = ?, payment_method = ?,
             payment_status = ?, note = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        category,
        description,
        input.amountCents,
        input.paymentMethod,
        input.paymentStatus,
        note,
        now,
        expense.id,
      );
    appendAudit(database, {
      action: 'expense.updated',
      entityType: 'expense',
      entityId: expense.id,
      eventId,
      details: {
        before: {
          amountCents: expense.amount_cents,
          category: expense.category,
          description: expense.description,
          note: expense.note,
          paymentMethod: expense.payment_method,
          paymentStatus: expense.payment_status,
        },
        after: {
          amountCents: input.amountCents,
          category,
          description,
          note,
          paymentMethod: input.paymentMethod,
          paymentStatus: input.paymentStatus,
        },
      },
    });
  })();

  return mapExpense(database, requireExpense(database, expense.id));
}

export function cancelExpense(
  database: DatabaseContext,
  input: { readonly expenseId: string; readonly reason: string },
): DatabaseExpense {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const expense = requireExpense(database, input.expenseId);

  if (expense.event_id !== eventId) {
    throw new Error('A despesa não pertence ao evento ativo.');
  }

  if (expense.status === 'cancelled') {
    throw new Error('Esta despesa já foi cancelada.');
  }

  const reason = input.reason.trim();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE expenses
         SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, now, expense.id);
    appendAudit(database, {
      action: 'expense.cancelled',
      entityType: 'expense',
      entityId: expense.id,
      eventId,
      details: {
        amountCents: expense.amount_cents,
        description: expense.description,
        reason,
      },
    });
  })();

  return mapExpense(database, requireExpense(database, expense.id));
}

export function deleteExpense(
  database: DatabaseContext,
  input: { readonly expenseId: string; readonly reason: string },
): { readonly expenseId: string; readonly deleted: true } {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const expense = requireExpense(database, input.expenseId);

  if (expense.event_id !== eventId) {
    throw new Error('A despesa não pertence ao evento ativo.');
  }

  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new Error('Informe o motivo da exclusão da despesa.');
  }

  database.sqlite.transaction(() => {
    appendAudit(database, {
      action: 'expense.deleted',
      entityType: 'expense',
      entityId: expense.id,
      eventId,
      details: {
        amountCents: expense.amount_cents,
        category: expense.category,
        description: expense.description,
        note: expense.note,
        paymentMethod: expense.payment_method,
        paymentStatus: expense.payment_status,
        previousStatus: expense.status,
        reason,
      },
    });
    database.sqlite.prepare('DELETE FROM expense_payments WHERE expense_id = ?').run(expense.id);
    database.sqlite.prepare('DELETE FROM expenses WHERE id = ?').run(expense.id);
  })();

  return { expenseId: expense.id, deleted: true };
}
