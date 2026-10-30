import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEvent,
  ensureControlDefaults,
  openDatabase,
  type DatabaseContext,
} from '@gtrz/database';
import { CloudSyncService } from '../../apps/desktop/src/main/cloud-sync-service';

// No real credentials, sockets or cloud requests: every call is answered here.
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn((): Promise<string> => Promise.resolve('status-temporary-directory')),
  readFile: vi.fn(
    (path: string): Promise<string> =>
      Promise.resolve(path === 'status-key' ? 'isolated-status-key' : 'status-pc'),
  ),
  rm: vi.fn((): Promise<void> => Promise.resolve()),
  writeFile: vi.fn((): Promise<void> => Promise.resolve()),
}));

const CANONICAL = 'https://status.supabase.co/functions/v1/gtrz-sync-fallback';

let db: DatabaseContext;
let service: CloudSyncService;

function newService(endpoint: string): CloudSyncService {
  return new CloudSyncService('status-key', 'status-device', (): void => undefined, endpoint);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  db = openDatabase(':memory:');
  ensureControlDefaults(db);
  service = newService(CANONICAL);
});

afterEach(() => {
  service.stop();
  db.close();
  vi.unstubAllGlobals();
});

describe('cloud connection indicator', () => {
  it('stays "connected" while the cloud answers, even with open reconciliation conflicts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ events: [] }))),
    );
    db.sqlite
      .prepare(
        `INSERT INTO sync_conflicts(command_id,event_id,sequence,action,entity_id,reason,payload_json,created_at,resolved_at)
         VALUES('old-sale','event',1,'sync.identity-gap',NULL,'gap','{}',1,NULL)`,
      )
      .run();
    service.startReplication(
      () => db,
      () => null,
    );
    await settle();
    const status = await service.getStatus();
    expect(status.connection).toBe('connected');
    expect(status.apiReachable).toBe(true);
  });

  it('reports "attention" when the cloud cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    service.startReplication(
      () => db,
      () => null,
    );
    await settle();
    const status = await service.getStatus();
    expect(status.connection).toBe('attention');
    expect(status.apiReachable).toBe(false);
  });

  it('does not treat a refused credential as a working connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))),
    );
    service.startReplication(
      () => db,
      () => null,
    );
    await settle();
    expect((await service.getStatus()).connection).toBe('attention');
  });
});

describe('send order', () => {
  it('sends a waiting operation before any housekeeping request', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return Promise.resolve(
          Response.json(
            url.includes('/global-control')
              ? { commands: [], pendingReset: null }
              : { currentSequence: 0, stock: [], events: [] },
          ),
        );
      }),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    await service.flushOutbox(db, null);
    // The first cycle may leave the cloud in a short retry wait; skip past it.
    vi.setSystemTime(Date.now() + 60_000);
    urls.length = 0;
    createEvent(db, { name: 'Venda pendente', startsAt: Date.now() });
    await service.flushOutbox(db, null);
    vi.useRealTimers();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toContain('/journal');
  });
});
