import {
  FORCE_WIPE_CONFIRMATION,
  forceWipeResultSchema,
  type ForceWipeGlobalEventInput,
  type ForceWipeResult,
} from '@gtrz/contracts';
import { resetEventData, type DatabaseContext } from '@gtrz/database';

const FORCE_WIPE_TIMEOUT_MS = 60_000;

type CloudCounts = ForceWipeResult['cloud'];
type LocalCounts = ForceWipeResult['local'];

interface ForceWipeDependencies {
  readonly database: DatabaseContext;
  readonly input: ForceWipeGlobalEventInput;
  readonly endpoint: string;
  /** Owner credentials, resolved only when the cloud is about to be called. */
  readonly headers: () => Promise<Record<string, string>>;
  /** Called once the local copy was cleared, so open screens reload. */
  readonly onLocalCleared: () => void;
}

function amount(database: DatabaseContext, sql: string, eventId: string): number {
  const row = database.sqlite.prepare(sql).get(eventId) as { readonly n: number };
  return row.n;
}

/** What this computer holds for the event, in the same terms as the cloud counts. */
function countLocalEventData(database: DatabaseContext, eventId: string): LocalCounts {
  return {
    orders: amount(database, 'SELECT COUNT(*) AS n FROM orders WHERE event_id = ?', eventId),
    paidOrders: amount(
      database,
      "SELECT COUNT(*) AS n FROM orders WHERE event_id = ? AND status = 'paid'",
      eventId,
    ),
    paidCents: amount(
      database,
      "SELECT COALESCE(SUM(total_cents), 0) AS n FROM orders WHERE event_id = ? AND status = 'paid'",
      eventId,
    ),
    tables: amount(
      database,
      'SELECT COUNT(*) AS n FROM service_points WHERE event_id = ?',
      eventId,
    ),
    expenses: amount(database, 'SELECT COUNT(*) AS n FROM expenses WHERE event_id = ?', eventId),
    vouchers: amount(database, 'SELECT COUNT(*) AS n FROM vouchers WHERE event_id = ?', eventId),
    ticketSales: amount(
      database,
      'SELECT COUNT(*) AS n FROM ticket_sales WHERE event_id = ?',
      eventId,
    ),
    stockMovements: amount(
      database,
      'SELECT COUNT(*) AS n FROM stock_movements WHERE event_id = ?',
      eventId,
    ),
    cashMovements: amount(
      database,
      'SELECT COUNT(*) AS n FROM cash_movements WHERE event_id = ?',
      eventId,
    ),
  };
}

function refusalMessage(status: number, payload: unknown): string {
  if (status === 404) {
    return 'A nuvem ainda não tem a limpeza forçada instalada. Publique a migração e a função de borda antes de usar.';
  }
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { readonly error: unknown }).error;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { readonly message: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return 'A nuvem recusou a limpeza forçada.';
}

async function callCloud(
  dependencies: ForceWipeDependencies,
  eventName: string,
): Promise<CloudCounts> {
  const { input, endpoint } = dependencies;
  const response = await fetch(`${endpoint}/v1/monitor/global-event/force-wipe`, {
    method: 'POST',
    headers: await dependencies.headers(),
    body: JSON.stringify({
      eventId: input.eventId,
      eventName,
      reason: input.reason,
      dryRun: input.dryRun,
      ...(input.dryRun ? {} : { confirmation: input.confirmation }),
    }),
    signal: AbortSignal.timeout(FORCE_WIPE_TIMEOUT_MS),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(refusalMessage(response.status, payload));
  const counts =
    typeof payload === 'object' && payload !== null && 'counts' in payload ? payload.counts : null;
  return forceWipeResultSchema.shape.cloud.parse(counts);
}

/**
 * Administrator-only forced wipe of one event. A simulation only counts. A real wipe empties the
 * cloud FIRST, so a computer that clears itself cannot rebuild the sales from the cloud journal,
 * and clears this computer's SQLite only after the cloud confirmed. If the cloud refuses, nothing
 * local is touched. Other computers clear themselves when they receive the `event.reset` command.
 */
export async function runForceWipe(dependencies: ForceWipeDependencies): Promise<ForceWipeResult> {
  const { database, input } = dependencies;
  const event = database.sqlite
    .prepare('SELECT id, name FROM events WHERE id = ?')
    .get(input.eventId) as { readonly id: string; readonly name: string } | undefined;
  if (event === undefined) throw new Error('O evento informado não existe neste computador.');
  if (input.confirmationName.trim() !== event.name) {
    throw new Error('Digite exatamente o nome do evento para confirmar a limpeza.');
  }
  if (!input.dryRun && input.confirmation?.trim() !== FORCE_WIPE_CONFIRMATION) {
    throw new Error(`Digite ${FORCE_WIPE_CONFIRMATION} para confirmar a limpeza forçada.`);
  }

  const local = countLocalEventData(database, event.id);
  const cloud = await callCloud(dependencies, event.name);
  if (!input.dryRun) {
    resetEventData(database, {
      eventId: event.id,
      confirmationName: event.name,
      reason: input.reason,
      system: true,
    });
    dependencies.onLocalCleared();
  }
  return { dryRun: input.dryRun, eventId: event.id, eventName: event.name, cloud, local };
}
