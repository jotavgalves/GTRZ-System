import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
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
  mkdtemp: vi.fn((): Promise<string> => Promise.resolve('audit-temporary-directory')),
  readFile: vi.fn(
    (path: string): Promise<string> =>
      Promise.resolve(path === 'audit-key' ? 'isolated-audit-key' : 'audit-pc'),
  ),
  rm: vi.fn((): Promise<void> => Promise.resolve()),
  writeFile: vi.fn((): Promise<void> => Promise.resolve()),
}));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static sockets: Socket[] = [];
    readyState = 0;
    readonly sent: string[] = [];
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
    send(payload: string): void {
      this.sent.push(payload);
    }
  }
  return { WebSocket: Socket };
});

type TestSocket = WebSocket & {
  url: string;
  sent: readonly string[];
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
  vi.mocked(writeFile).mockClear();
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
          url.includes('/global-control')
            ? { commands: globalCommands, pendingReset: null }
            : { currentSequence: 0, stock: [], events: [] },
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
  it('uses the legacy administrator key only to mint a one-time desktop enrollment code', async () => {
    request.mockImplementation((url: string): Response => {
      if (url.endsWith('/v1/desktop/enrollment')) {
        return new Response(JSON.stringify({ enrollmentCode: 'gtrz-enroll-code', expiresAt: 123 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ currentSequence: 0, stock: [], events: [] }), {
        status: 200,
      });
    });

    await expect(service.createDesktopEnrollment()).resolves.toEqual({
      enrollmentCode: 'gtrz-enroll-code',
      expiresAt: 123,
    });
    expect(request).toHaveBeenCalledWith(
      'https://audit.invalid/v1/desktop/enrollment',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-GTRZ-Key': 'isolated-audit-key',
          'X-GTRZ-Device-Id': 'audit-pc',
        }),
      }),
    );
  });

  it('exchanges a temporary code without sending the administrator key and stores only a device token', async () => {
    request.mockImplementation((url: string): Response => {
      if (url.endsWith('/v1/desktop/enrollment/exchange')) {
        return new Response(JSON.stringify({ token: `gtrz-device-${'a'.repeat(64)}` }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ currentSequence: 0, stock: [], events: [] }), {
        status: 200,
      });
    });

    await service.exchangeDesktopEnrollment(`gtrz-enroll-${'b'.repeat(40)}`);

    expect(request).toHaveBeenCalledWith(
      'https://audit.invalid/v1/desktop/enrollment/exchange',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
    expect(writeFile).toHaveBeenCalledWith(
      'gtrz-cloud-device-credential.json',
      expect.stringContaining('gtrz-device-'),
      expect.objectContaining({ mode: 0o600 }),
    );
  });

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

  it('hydrates a newly paired PC from the ordered journal before applying event stock', async () => {
    const catalogEvents = [
      journal(1, 'inventory.category-created', 'remote-category', {
        name: 'Remote drinks',
        engine: 'catalog',
      }),
      journal(2, 'inventory.product-created', 'remote-product', {
        categoryId: 'remote-category',
        name: 'Remote product',
        kind: 'drink',
        costCents: 100,
        salePriceCents: 200,
        lowStockThreshold: 0,
      }),
    ];
    const eventEvents = [
      {
        ...journal(1, 'inventory.stock-moved', 'remote-stock-entry', {
          productId: 'remote-product',
          type: 'purchase',
          quantity: 12,
          delta: 12,
          purchaseTotalCents: 1200,
          note: 'Initial replica stock',
        }),
        commandId: 'other-pc:event-stock-entry',
      },
    ];
    globalCommands = [
      {
        sequence: 1,
        commandId: 'activate-remote-event',
        type: 'event.activated',
        eventId: 'remote-event',
        eventName: 'Remote event',
        createdAt: Date.now(),
      },
    ];
    request.mockImplementation((url: string): Response => {
      if (url.includes('/global-control')) {
        return new Response(JSON.stringify({ commands: globalCommands, pendingReset: null }), {
          status: 200,
        });
      }
      if (url.includes('/events/_catalog/snapshot')) {
        return new Response(
          JSON.stringify({ currentSequence: 2, stock: [], events: catalogEvents }),
          { status: 200 },
        );
      }
      if (url.includes('/events/remote-event/snapshot')) {
        return new Response(
          JSON.stringify({ currentSequence: 1, stock: [], events: eventEvents }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await service.flushOutbox(db, null);

    expect(getSessionState(db).activeEvent?.id).toBe('remote-event');
    expect(db.sqlite.prepare('SELECT action, reason FROM sync_conflicts').all()).toEqual([]);
    expect(
      db.sqlite.prepare("SELECT id FROM products WHERE id = 'remote-product'").get(),
    ).toBeDefined();
    expect(
      db.sqlite
        .prepare(
          "SELECT quantity FROM event_stock WHERE event_id = 'remote-event' AND product_id = 'remote-product'",
        )
        .get(),
    ).toEqual({ quantity: 12 });
    expect(
      db.sqlite
        .prepare("SELECT value FROM sync_state WHERE key = 'inbox.sequence:_catalog'")
        .get(),
    ).toEqual({ value: '2' });
    expect(
      db.sqlite
        .prepare("SELECT value FROM sync_state WHERE key = 'inbox.sequence:remote-event'")
        .get(),
    ).toEqual({ value: '1' });

    await service.flushOutbox(db, null);

    expect(
      db.sqlite
        .prepare(
          "SELECT quantity FROM event_stock WHERE event_id = 'remote-event' AND product_id = 'remote-product'",
        )
        .get(),
    ).toEqual({ quantity: 12 });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS amount FROM stock_movements').get()).toEqual({
      amount: 1,
    });
  });

  it('continues journal recovery across the Worker page boundary without skipping commands', async () => {
    const catalogEvents = Array.from({ length: 41 }, (_, index) =>
      journal(index + 1, 'inventory.category-created', `remote-category-${String(index + 1)}`, {
        name: `Remote category ${String(index + 1)}`,
        engine: 'catalog',
      }),
    );
    globalCommands = [
      {
        sequence: 1,
        commandId: 'activate-paged-event',
        type: 'event.activated',
        eventId: 'remote-event',
        eventName: 'Remote event',
        createdAt: Date.now(),
      },
    ];
    request.mockImplementation((url: string): Response => {
      if (url.includes('/global-control')) {
        return new Response(JSON.stringify({ commands: globalCommands, pendingReset: null }), {
          status: 200,
        });
      }
      if (url.includes('/events/_catalog/snapshot?after=0')) {
        return new Response(
          JSON.stringify({ currentSequence: 41, stock: [], events: catalogEvents.slice(0, 40) }),
          { status: 200 },
        );
      }
      if (url.includes('/events/_catalog/snapshot?after=40')) {
        return new Response(
          JSON.stringify({ currentSequence: 41, stock: [], events: catalogEvents.slice(40) }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ currentSequence: 0, stock: [], events: [] }), {
        status: 200,
      });
    });

    await service.flushOutbox(db, null);

    expect(
      db.sqlite
        .prepare("SELECT COUNT(*) AS amount FROM product_categories WHERE id LIKE 'remote-category-%'")
        .get(),
    ).toEqual({ amount: 41 });
    expect(
      db.sqlite
        .prepare("SELECT value FROM sync_state WHERE key = 'inbox.sequence:_catalog'")
        .get(),
    ).toEqual({ value: '41' });
  });

  it('asks the same WebSocket for the next journal page instead of backing off', async () => {
    await service.flushOutbox(db, null);
    const catalog = requireSocket('/_catalog/');
    catalog.open();
    const events = Array.from({ length: 41 }, (_, index) =>
      journal(index + 1, 'inventory.category-created', `socket-category-${String(index + 1)}`, {
        name: `Socket category ${String(index + 1)}`,
        engine: 'catalog',
      }),
    );

    catalog.message({ type: 'sync', currentSequence: 41, events: events.slice(0, 40) });

    expect(catalog.sent).toContain(JSON.stringify({ type: 'sync', after: 40 }));
    expect(catalog.readyState).toBe(WebSocket.OPEN);

    catalog.message({ type: 'sync', currentSequence: 41, events: events.slice(40) });

    expect(
      db.sqlite
        .prepare("SELECT COUNT(*) AS amount FROM product_categories WHERE id LIKE 'socket-category-%'")
        .get(),
    ).toEqual({ amount: 41 });
    expect(catalog.readyState).toBe(WebSocket.OPEN);
  });

  it('retries a locally committed operation with the same idempotency key after a network failure', async () => {
    const sentCommands: string[] = [];
    let centralAvailable = false;
    request.mockImplementation((url: string, init?: RequestInit): Response => {
      if (url.includes('/journal')) {
        sentCommands.push(String(init?.body));
        return new Response(JSON.stringify({}), { status: centralAvailable ? 200 : 503 });
      }
      if (url.includes('/global-control')) {
        return new Response(JSON.stringify({ commands: globalCommands, pendingReset: null }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ currentSequence: 0, stock: [], events: [] }), {
        status: 200,
      });
    });
    await service.flushOutbox(db, null);
    const event = createEvent(db, { name: 'Offline event', startsAt: Date.now() });

    await service.flushOutbox(db, event.id);

    expect(
      db.sqlite.prepare("SELECT status FROM sync_outbox WHERE status = 'failed'").get(),
    ).toEqual({ status: 'failed' });
    expect(sentCommands).toHaveLength(1);

    centralAvailable = true;
    await service.flushOutbox(db, event.id);

    expect(
      db.sqlite.prepare("SELECT status FROM sync_outbox WHERE status = 'accepted'").get(),
    ).toEqual({ status: 'accepted' });
    expect(sentCommands).toHaveLength(2);
    expect(sentCommands[1]).toBe(sentCommands[0]);
  });

  it('restores a verified database copy before a fresh paired PC consumes event sales', async () => {
    const snapshot = Buffer.from('verified SQLite replica');
    const checksum = createHash('sha256').update(snapshot).digest('hex');
    const replaceWith = vi.fn(async (): Promise<void> => undefined);
    const databaseRuntime = {
      get: (): ReturnType<typeof openDatabase> => db,
      replaceWith,
    };
    service.stop();
    service = new CloudSyncService(
      'audit-key',
      'audit-device',
      (): void => undefined,
      'https://audit.invalid',
      (): string => 'Audit PC',
      databaseRuntime as never,
    );
    request.mockImplementation((url: string): Response => {
      if (url.includes('/replica-snapshot/')) {
        return new Response(snapshot, {
          status: 200,
          headers: {
            'X-GTRZ-Snapshot-Event': 'remote-event',
            'X-GTRZ-Snapshot-Sha256': checksum,
          },
        });
      }
      if (url.includes('/global-control')) {
        return new Response(JSON.stringify({ commands: globalCommands, pendingReset: null }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ currentSequence: 0, stock: [], events: [] }),
        { status: 200 },
      );
    });

    await service.flushOutbox(db, null);
    globalCommands = [
      {
        sequence: 1,
        commandId: 'activate-with-bootstrap',
        type: 'event.activated',
        eventId: 'remote-event',
        eventName: 'Remote event',
        bootstrapSnapshotId: 'snapshot-1',
        snapshotSourceDeviceId: 'source-device',
        createdAt: Date.now(),
      },
    ];
    const control = requireSocket('/monitor/');
    control.open();
    control.message({ type: 'global.sync' });
    await settle();

    expect(replaceWith).not.toHaveBeenCalled();
    await service.flushOutbox(db, null);

    expect(replaceWith).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('/replica-snapshot/snapshot-1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-GTRZ-Key': 'isolated-audit-key',
          'X-GTRZ-Device-Id': 'audit-pc',
        }),
      }),
    );
    expect(getSessionState(db).activeEvent?.id).toBe('remote-event');
    expect(
      db.sqlite
        .prepare(
          "SELECT value FROM sync_state WHERE key = 'global.bootstrap:activate-with-bootstrap'",
        )
        .get(),
    ).toEqual({ value: 'applied' });
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
            : url.includes('/global-control')
              ? { commands: globalCommands, pendingReset: null }
              : { currentSequence: 0, stock: [], events: [] },
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
