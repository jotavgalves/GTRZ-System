import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  createCombo,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  ensureControlDefaults,
  getSessionState,
  openDatabase,
  renameEvent,
  updateInventoryProduct,
} from '@gtrz/database';
import { CloudSyncService } from '../../apps/desktop/src/main/cloud-sync-service';

// No real sockets, credentials, printers, database files, or cloud requests are used.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(
    (path: string): Promise<string> =>
      Promise.resolve(path === 'audit-key' ? 'isolated-audit-key' : 'audit-pc'),
  ),
  writeFile: vi.fn((): Promise<void> => Promise.resolve()),
}));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static sockets: Socket[] = [];
    readyState = 0;
    constructor(public url: string) {
      super();
      Socket.sockets.push(this);
    }
    close(): void {
      this.readyState = 3;
    }
    open(): void {
      this.readyState = 1;
      this.emit('open');
    }
    remoteClose(): void {
      this.readyState = 3;
      this.emit('close');
    }
    message(payload: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(payload)));
    }
  }
  return { WebSocket: Socket };
});

type TestSocket = WebSocket & {
  url: string;
  open(): void;
  remoteClose(): void;
  message(payload: unknown): void;
};

interface AuditJournalEvent {
  readonly sequence: number;
  readonly commandId: string;
  readonly type: string;
  readonly payload: {
    readonly action: string;
    readonly entityId: string;
    readonly details: Record<string, unknown>;
    readonly deviceId: string;
    readonly createdAt: number;
  };
}

const sockets = (): TestSocket[] => (WebSocket as unknown as { sockets: TestSocket[] }).sockets;
let db: ReturnType<typeof openDatabase>;
let service: CloudSyncService;
let request: ReturnType<typeof vi.fn>;
let globalCommands: unknown[];
const settle = async (): Promise<void> => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
};
const journal = (
  sequence: number,
  action: string,
  entityId: string,
  details: Record<string, unknown>,
): AuditJournalEvent => ({
  sequence,
  commandId: `other-pc:${String(sequence)}`,
  type: action,
  payload: { action, entityId, details, deviceId: 'other-pc', createdAt: Date.now() },
});
const requireSocket = (urlFragment: string): TestSocket => {
  const socket = sockets().find((candidate) => candidate.url.includes(urlFragment));
  if (socket === undefined) throw new Error(`Socket not opened for ${urlFragment}.`);
  return socket;
};
const deliver = (event: AuditJournalEvent): void => {
  requireSocket('/_catalog/').message({ type: 'event', event });
};
const actions = (): string[] =>
  (
    db.sqlite.prepare('SELECT payload_json FROM sync_outbox').all() as readonly {
      payload_json: string;
    }[]
  ).map((row) => {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('action' in parsed) ||
      typeof parsed.action !== 'string'
    ) {
      throw new Error('Outbox audit payload is invalid.');
    }
    return parsed.action;
  });

beforeEach((): void => {
  sockets().length = 0;
  globalCommands = [];
  db = openDatabase(':memory:');
  ensureControlDefaults(db);
  service = new CloudSyncService(
    'audit-key',
    'audit-device',
    (): void => undefined,
    'https://audit.invalid',
  );
  request = vi.fn(
    (url: string): Response =>
      new Response(
        JSON.stringify(
          url.includes('/global-control') ? { commands: globalCommands, pendingReset: null } : {},
        ),
        {
          status: 200,
        },
      ),
  );
  vi.stubGlobal('fetch', request);
});
afterEach((): void => {
  service.stop();
  db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cloud replication invariants', () => {
  it('creates the globally active event on a fresh PC instead of discarding its activation', async () => {
    await service.flushOutbox(db, null);
    globalCommands = [
      {
        sequence: 1,
        commandId: 'activate-event',
        type: 'event.activated',
        eventId: 'remote-event',
        eventName: 'Remote event',
        createdAt: Date.now(),
      },
    ];
    const control = requireSocket('/monitor/');
    control.open();
    control.message({ type: 'global.sync' });
    await settle();
    await service.flushOutbox(db, null);
    expect(
      db.sqlite
        .prepare("SELECT value FROM sync_state WHERE key = 'global.event-command:activate-event'")
        .get(),
    ).toEqual({ value: 'applied' });
    expect(getSessionState(db).activeEvent?.id).toBe('remote-event');
  });

  it('puts event renames and combo creation into the shared journal', async () => {
    await service.flushOutbox(db, null);
    const event = createEvent(db, { name: 'Original', startsAt: Date.now() });
    renameEvent(db, { eventId: event.id, name: 'Renamed' });
    const category = createProductCategory(db, 'Audit drinks');
    const product = createInventoryProduct(db, {
      categoryId: category.id,
      name: 'Audit product',
      kind: 'drink',
      costCents: 100,
      salePriceCents: 200,
      lowStockThreshold: 0,
    });
    createCombo(db, {
      name: 'Audit combo',
      salePriceCents: 300,
      components: [{ productId: product.id, quantity: 2 }],
    });
    await service.flushOutbox(db, event.id);
    expect(actions()).toEqual(
      expect.arrayContaining(['event.created', 'event.renamed', 'combo.created']),
    );
  });

  it('retries a dependent catalog command after its category arrives', async () => {
    await service.flushOutbox(db, null);
    deliver(
      journal(1, 'inventory.product-created', 'remote-product', {
        categoryId: 'remote-category',
        name: 'Remote product',
        kind: 'drink',
        costCents: 100,
        salePriceCents: 200,
        lowStockThreshold: 0,
        fallbackIcon: 'beer',
        imageDataUrl: 'data:image/png;base64,YXVkaXQ=',
      }),
    );
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_conflicts').get()).toEqual({ n: 1 });
    deliver(
      journal(2, 'inventory.category-created', 'remote-category', {
        name: 'Remote category',
        engine: 'catalog',
      }),
    );
    await settle();
    await service.flushOutbox(db, null);
    expect(
      db.sqlite.prepare("SELECT id FROM product_categories WHERE id = 'remote-category'").get(),
    ).toBeDefined();
    expect(
      db.sqlite.prepare("SELECT id FROM products WHERE id = 'remote-product'").get(),
    ).toBeDefined();
    expect(
      db.sqlite
        .prepare("SELECT value FROM app_meta WHERE key = 'product.image:remote-product'")
        .get(),
    ).toEqual({ value: 'data:image/png;base64,YXVkaXQ=' });
  });

  it('applies a received combo with fixed components on the second PC', async () => {
    await service.flushOutbox(db, null);
    deliver(
      journal(1, 'inventory.category-created', 'remote-category', {
        name: 'Remote category',
        engine: 'catalog',
      }),
    );
    deliver(
      journal(2, 'inventory.product-created', 'remote-product', {
        categoryId: 'remote-category',
        name: 'Remote product',
        kind: 'drink',
        costCents: 100,
        salePriceCents: 200,
        lowStockThreshold: 0,
      }),
    );
    deliver(
      journal(3, 'combo.created', 'remote-combo', {
        name: 'Remote combo',
        salePriceCents: 300,
        components: [
          { productId: 'remote-product', quantity: 2, choiceGroup: null, choiceLabel: null },
        ],
      }),
    );
    await settle();
    expect(db.sqlite.prepare("SELECT name FROM combos WHERE id = 'remote-combo'").get()).toEqual({
      name: 'Remote combo',
    });
    expect(
      db.sqlite
        .prepare("SELECT quantity FROM combo_components WHERE combo_id = 'remote-combo'")
        .get(),
    ).toEqual({ quantity: 2 });
  });

  it('does not bypass an already scheduled reconnect backoff', async () => {
    vi.useFakeTimers();
    await service.flushOutbox(db, null);
    const control = requireSocket('/monitor/');
    control.remoteClose();
    const before = sockets().filter((socket) => socket.url.includes('/monitor/')).length;
    await service.flushOutbox(db, null);
    expect(sockets().filter((socket) => socket.url.includes('/monitor/')).length).toBe(before);
  });

  it('drains every already queued receipt when a printer reconnects', async () => {
    const event = createEvent(db, { name: 'Print event', startsAt: Date.now() });
    db.sqlite
      .prepare('INSERT INTO app_meta(key,value,updated_at) VALUES (?,?,?)')
      .run('printing.automatic', '1', Date.now());
    const pending = ['job-1', 'job-2'];
    request.mockImplementation((url: string): Response => {
      const jobId = url.endsWith('/claim') ? pending.shift() : undefined;
      return new Response(
        JSON.stringify(
          jobId
            ? {
                job: {
                  jobId,
                  claimToken: 'isolated-claim',
                  printerLabel: 'Fake printer',
                  document: {},
                },
              }
            : {},
        ),
        { status: 200 },
      );
    });
    const print = vi.fn(
      (): Promise<{ success: boolean; message: string }> =>
        Promise.resolve({ success: true, message: 'simulated' }),
    );
    service.setPrintAgent(print);
    await service.flushOutbox(db, event.id);
    requireSocket(`/${event.id}/stream`).open();
    await settle();
    expect(print).toHaveBeenCalledTimes(2);
  });

  it('replicates product photos rather than just a flag saying the photo exists', async () => {
    await service.flushOutbox(db, null);
    const category = createProductCategory(db, 'Photos');
    const product = createInventoryProduct(db, {
      categoryId: category.id,
      name: 'Photo product',
      kind: 'drink',
      costCents: 100,
      salePriceCents: 200,
      lowStockThreshold: 0,
    });
    const image = 'data:image/png;base64,YXVkaXQ=';
    updateInventoryProduct(db, {
      productId: product.id,
      categoryId: category.id,
      name: product.name,
      kind: product.kind,
      costCents: 100,
      salePriceCents: product.salePriceCents,
      lowStockThreshold: product.lowStockThreshold,
      comboOnly: product.comboOnly,
      active: true,
      imageDataUrl: image,
      fallbackIcon: 'beer',
    });
    await service.flushOutbox(db, null);
    expect(
      JSON.stringify(db.sqlite.prepare('SELECT payload_json FROM sync_outbox').all()),
    ).toContain(image);
  });
});
