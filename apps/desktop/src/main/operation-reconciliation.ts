import { randomUUID } from 'node:crypto';
import type { DatabaseContext } from '@gtrz/database';

export interface ReconciliationEvent {
  readonly sequence: number;
  readonly commandId: string;
  readonly type: string;
  readonly payload: unknown;
}
interface JournalPage {
  readonly events: readonly ReconciliationEvent[];
}
export interface IdReconciliationResult {
  readonly received: number;
  readonly resent: number;
  readonly historicalGaps: number;
}

/** An incomplete network scan must never infer that an acknowledged ID is absent. */
export async function reconcileOperationIds(
  database: DatabaseContext,
  eventId: string,
  readPage: (after: number) => Promise<JournalPage>,
  accept: (events: readonly ReconciliationEvent[]) => void,
  baselineIds: ReadonlySet<string> = new Set(),
): Promise<IdReconciliationResult> {
  const scanId = randomUUID();
  const startedAt = Date.now();
  const cloud: ReconciliationEvent[] = [];
  let after = 0;
  let complete = false;
  for (let page = 0; page < 200; page++) {
    const result = await readPage(after);
    if (!Array.isArray(result.events)) throw new Error('Inventário remoto inválido.');
    if (result.events.length === 0) {
      complete = true;
      break;
    }
    for (const event of result.events as readonly ReconciliationEvent[]) {
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence <= after ||
        typeof event.commandId !== 'string' ||
        !event.commandId
      ) {
        throw new Error('Inventário remoto fora de ordem ou sem ID.');
      }
      after = event.sequence;
      cloud.push(event);
    }
  }
  if (!complete)
    throw new Error('Reconciliação por IDs ainda incompleta; nenhum reenvio foi inferido.');
  const sqlite = database.sqlite;
  let received = 0;
  let resent = 0;
  let historicalGaps = 0;
  sqlite.transaction(() => {
    const see =
      sqlite.prepare(`INSERT INTO sync_id_inventory(event_id,command_id,sequence,scan_id) VALUES(?,?,?,?)
      ON CONFLICT(event_id,command_id) DO UPDATE SET sequence=excluded.sequence,scan_id=excluded.scan_id`);
    const known = sqlite.prepare(
      'SELECT applied_at FROM sync_inbox WHERE event_id=? AND command_id=?',
    );
    const outgoing = sqlite.prepare(
      'SELECT operation_id FROM sync_outbox WHERE event_id=? AND operation_id=?',
    );
    const slot = sqlite.prepare(
      'SELECT command_id FROM sync_inbox WHERE event_id=? AND sequence=?',
    );
    const cursor = Number(
      (
        sqlite
          .prepare('SELECT value FROM sync_state WHERE key=?')
          .get('inbox.sequence:' + eventId) as { value: string } | undefined
      )?.value ?? '0',
    );
    const gap =
      sqlite.prepare(`INSERT OR IGNORE INTO sync_conflicts(command_id,event_id,sequence,action,entity_id,reason,payload_json,created_at,resolved_at)
      VALUES(?,?,?,'sync.identity-gap',NULL,?,?,?,NULL)`);
    for (const commandId of baselineIds) see.run(eventId, commandId, 0, scanId);
    const provenDeletedEvents = new Set(
      cloud
        .filter((event) => {
          const p = event.payload as { action?: string; entityId?: string } | null;
          const applied = known.get(eventId, event.commandId) as
            | { applied_at: number | null }
            | undefined;
          return (
            p?.action === 'event.deleted-permanently' &&
            (applied?.applied_at != null || baselineIds.has(event.commandId))
          );
        })
        .map((event) => (event.payload as { entityId: string }).entityId),
    );
    for (const event of cloud) {
      see.run(eventId, event.commandId, event.sequence, scanId);
      if (
        known.get(eventId, event.commandId) ||
        baselineIds.has(event.commandId) ||
        sqlite
          .prepare('SELECT 1 FROM sync_operation_tombstones WHERE event_id=? AND command_id=?')
          .get(eventId, event.commandId)
      )
        continue;
      const payload = event.payload as { action?: string; entityId?: string } | null;
      if (
        payload?.action === 'event.created' &&
        payload.entityId &&
        provenDeletedEvents.has(payload.entityId) &&
        !sqlite.prepare('SELECT id FROM events WHERE id=?').get(payload.entityId)
      )
        continue;
      const collision = slot.get(eventId, event.sequence) as { command_id: string } | undefined;
      if (collision || (event.sequence <= cursor && !outgoing.get(eventId, event.commandId))) {
        gap.run(
          event.commandId,
          eventId,
          event.sequence,
          'ID remoto ausente no histórico local ou associado a outra sequência; exige reconciliação da réplica.',
          JSON.stringify(event.payload),
          startedAt,
        );
        historicalGaps++;
        continue;
      }
      accept([event]);
      received++;
    }
    // Durable IDs can be safely replayed. Historical IDs may predate a restore/reset;
    // never resurrect old business operations by assuming an absent historical ID is new.
    const missing = sqlite
      .prepare(
        `SELECT o.audit_id,o.operation_id,ids.operation_id AS durable_id FROM sync_outbox o
      LEFT JOIN local_operation_ids ids ON ids.audit_id=o.audit_id
      WHERE o.event_id=? AND o.status='accepted' AND o.accepted_at<=?
      AND NOT EXISTS(SELECT 1 FROM sync_id_inventory i WHERE i.event_id=o.event_id AND i.command_id=o.operation_id AND i.scan_id=?)`,
      )
      .all(eventId, startedAt, scanId) as {
      audit_id: number;
      operation_id: string;
      durable_id: string | null;
    }[];
    for (const row of missing) {
      if (row.durable_id === row.operation_id) {
        sqlite
          .prepare(
            "UPDATE sync_outbox SET status='pending',accepted_at=NULL,last_error=NULL,updated_at=? WHERE audit_id=?",
          )
          .run(startedAt, row.audit_id);
        resent++;
      } else {
        gap.run(
          row.operation_id,
          eventId,
          0,
          'ID legado confirmado localmente não consta no inventário da central; não será reenviado sem auditoria.',
          JSON.stringify({ operationId: row.operation_id }),
          startedAt,
        );
        historicalGaps++;
      }
    }
    sqlite
      .prepare(
        `INSERT INTO sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      )
      .run(
        'ids.reconciled:' + eventId,
        JSON.stringify({ scanId, received, resent, historicalGaps, cloudIds: cloud.length }),
        startedAt,
      );
  })();
  return { received, resent, historicalGaps };
}
