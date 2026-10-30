import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
export interface ReplicaIdBaseline {
  readonly snapshotId: string;
  readonly idsByEvent: ReadonlyMap<string, ReadonlySet<string>>;
}
/** IDs inside a checksum-verified cloud SQLite copy are also present in the cloud,
 * even when they predate the compact journal. Never infer that they were lost. */
export async function readReplicaIdBaseline(
  endpoint: string,
  eventId: string,
  headers: Record<string, string>,
  fetcher: typeof globalThis.fetch,
  cached: ReplicaIdBaseline | null,
): Promise<ReplicaIdBaseline | null> {
  const metadataResponse = await fetcher(
    `${endpoint}/v1/events/${encodeURIComponent(eventId)}/replica-snapshot/latest`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (metadataResponse.status === 404) return null;
  if (!metadataResponse.ok) throw new Error('Não foi possível conferir a base histórica de IDs.');
  const raw: unknown = await metadataResponse.json();
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('snapshotId' in raw) ||
    typeof raw.snapshotId !== 'string' ||
    !('sha256' in raw) ||
    typeof raw.sha256 !== 'string' ||
    !('sizeBytes' in raw) ||
    typeof raw.sizeBytes !== 'number' ||
    !('eventId' in raw) ||
    raw.eventId !== eventId
  )
    throw new Error('Metadados da base histórica inválidos.');
  if (cached?.snapshotId === raw.snapshotId) return cached;
  if (
    !/^[a-f0-9]{64}$/i.test(raw.sha256) ||
    !Number.isSafeInteger(raw.sizeBytes) ||
    raw.sizeBytes <= 0 ||
    raw.sizeBytes > 50 * 1024 * 1024
  )
    throw new Error('Integridade histórica inválida.');
  const response = await fetcher(
    `${endpoint}/v1/monitor/replica-snapshot/${encodeURIComponent(raw.snapshotId)}`,
    { headers, signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) throw new Error('Cópia histórica indisponível; reconciliação não confirmada.');
  const data = Buffer.from(await response.arrayBuffer());
  if (
    data.length !== raw.sizeBytes ||
    createHash('sha256').update(data).digest('hex') !== raw.sha256.toLowerCase() ||
    response.headers.get('X-GTRZ-Snapshot-Event') !== eventId
  )
    throw new Error('A cópia histórica não passou na conferência de integridade.');
  const dir = await mkdtemp(path.join(tmpdir(), 'gtrz-id-baseline-'));
  try {
    const file = path.join(dir, 'baseline.sqlite');
    await writeFile(file, data, { flag: 'wx' });
    const snapshot = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    try {
      const rows = snapshot
        .prepare(
          "SELECT event_id,operation_id AS command_id FROM sync_outbox WHERE status='accepted' UNION SELECT event_id,command_id FROM sync_inbox WHERE applied_at IS NOT NULL",
        )
        .all() as { event_id: string; command_id: string }[];
      const idsByEvent = new Map<string, Set<string>>();
      for (const row of rows) {
        let ids = idsByEvent.get(row.event_id);
        if (!ids) {
          ids = new Set();
          idsByEvent.set(row.event_id, ids);
        }
        ids.add(row.command_id);
      }
      return { snapshotId: raw.snapshotId, idsByEvent };
    } finally {
      snapshot.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
