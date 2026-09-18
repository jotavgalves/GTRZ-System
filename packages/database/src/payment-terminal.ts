import { getSessionState } from './control';
import type { DatabaseContext } from './types';

export interface PaymentTerminalSettings {
  readonly activeEventId: string | null;
  readonly debitRateBasisPoints: number;
  readonly creditRateBasisPoints: number;
}

export interface UpdatePaymentTerminalSettingsInput {
  readonly debitRateBasisPoints: number;
  readonly creditRateBasisPoints: number;
}

export interface PaymentTerminalFees {
  readonly debitFeeCents: number;
  readonly creditFeeCents: number;
  readonly totalFeeCents: number;
}

function metaKey(eventId: string, kind: 'debit' | 'credit'): string {
  return `payment_terminal.${kind}_rate_basis_points:${eventId}`;
}

function readRate(database: DatabaseContext, eventId: string, kind: 'debit' | 'credit'): number {
  const row = database.sqlite
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(metaKey(eventId, kind)) as { readonly value: string } | undefined;
  const value = Number(row?.value ?? '0');
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : 0;
}

function writeRate(
  database: DatabaseContext,
  eventId: string,
  kind: 'debit' | 'credit',
  value: number,
): void {
  database.sqlite
    .prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(metaKey(eventId, kind), String(value), Date.now());
}

function validateRate(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error('A taxa da maquininha deve estar entre 0% e 100%.');
  }
}

function calculateFee(amountCents: number, rateBasisPoints: number): number {
  return Math.round((amountCents * rateBasisPoints) / 10_000);
}

export function getPaymentFeeSnapshot(database: DatabaseContext, eventId: string, method: 'cash' | 'pix' | 'credit-card' | 'debit-card', amountCents: number): { readonly rateBasisPoints: number | null; readonly feeCents: number | null } {
  if (method !== 'credit-card' && method !== 'debit-card') return { rateBasisPoints: null, feeCents: null };
  const rateBasisPoints = readRate(database, eventId, method === 'credit-card' ? 'credit' : 'debit');
  return { rateBasisPoints, feeCents: calculateFee(amountCents, rateBasisPoints) };
}

export function calculatePaymentTerminalFees(
  database: DatabaseContext,
  eventId: string,
  input: { readonly debitCardCents: number; readonly creditCardCents: number },
): PaymentTerminalFees {
  const debitFeeCents = calculateFee(input.debitCardCents, readRate(database, eventId, 'debit'));
  const creditFeeCents = calculateFee(input.creditCardCents, readRate(database, eventId, 'credit'));

  return {
    debitFeeCents,
    creditFeeCents,
    totalFeeCents: debitFeeCents + creditFeeCents,
  };
}

export function getPaymentTerminalSettings(database: DatabaseContext): PaymentTerminalSettings {
  const session = getSessionState(database);
  const eventId = session.activeEvent?.id ?? null;

  if (eventId === null) {
    return {
      activeEventId: null,
      debitRateBasisPoints: 0,
      creditRateBasisPoints: 0,
    };
  }

  return {
    activeEventId: eventId,
    debitRateBasisPoints: readRate(database, eventId, 'debit'),
    creditRateBasisPoints: readRate(database, eventId, 'credit'),
  };
}

export function updatePaymentTerminalSettings(
  database: DatabaseContext,
  input: UpdatePaymentTerminalSettingsInput,
): PaymentTerminalSettings {
  const session = getSessionState(database);

  if (session.profile !== 'production') {
    throw new Error('Esta operação exige o perfil Produção.');
  }

  const event = session.activeEvent;
  if (event === null) {
    throw new Error('Selecione um evento aberto para configurar a maquininha.');
  }

  validateRate(input.debitRateBasisPoints);
  validateRate(input.creditRateBasisPoints);

  database.sqlite.transaction(() => {
    writeRate(database, event.id, 'debit', input.debitRateBasisPoints);
    writeRate(database, event.id, 'credit', input.creditRateBasisPoints);
    database.sqlite
      .prepare(
        `INSERT INTO audit_log
         (event_id, profile, action, entity_type, entity_id, details_json, created_at)
         VALUES (?, 'production', 'settings.payment-terminal-updated', 'settings', ?, ?, ?)`,
      )
      .run(
        event.id,
        event.id,
        JSON.stringify({
          debitRateBasisPoints: input.debitRateBasisPoints,
          creditRateBasisPoints: input.creditRateBasisPoints,
        }),
        Date.now(),
      );
  })();

  return getPaymentTerminalSettings(database);
}
