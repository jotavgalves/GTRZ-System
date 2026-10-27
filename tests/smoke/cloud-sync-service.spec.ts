import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  addOrderItem,
  closeOrder,
  createCombo,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  ensureControlDefaults,
  getOrder,
  getSessionState,
  openDatabase,
  openOrder,
  recordStockMovement,
  renameEvent,
  setActiveEvent,
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
  vi.mocked(readFile).mockImplementation((filePath) =>
    Promise.resolve(filePath === 'audit-key' ? 'isolated-audit-key' : 'audit-pc'),
  );
  vi.mocked(writeFile).mockImplementation((): Promise<void> => Promise.resolve());
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
  it('parses the canonical monitor when the local print queue has no error', async () => {
    const canonical = new CloudSyncService(
      'audit-key',
      'audit-device',
      (): void => undefined,
      'https://audit.supabase.co/functions/v1/gtrz-sync-fallback',
    );
    request.mockImplementation(
      (url: string): Response =>
        new Response(
          JSON.stringify(url.includes('/snapshot') ? { activeDevices: [] } : { accepted: true }),
          { status: 200 },
        ),
    );

    await expect(canonical.getMonitor(null)).resolves.toMatchObject({
      localQueue: { printQueueError: null },
    });
  });

  it('requires a one-time code for a new desktop without contacting the cloud', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('not enrolled'));

    await expect(service.verifyOrEnrollDesktop()).resolves.toBe('code-required');
    expect(request).not.toHaveBeenCalled();
  });

  it('exchanges the code once and confirms the new desktop with a heartbeat', async () => {
    let storedCredential: string | null = null;
    vi.mocked(readFile).mockImplementation((filePath) => {
      if (filePath === 'audit-device') return Promise.resolve('audit-pc');
      if (filePath === 'gtrz-cloud-device-credential.json' && storedCredential !== null) {
        return Promise.resolve(storedCredential);
      }
      return Promise.reject(new Error('not enrolled'));
    });
    vi.mocked(writeFile).mockImplementation((_filePath, contents) => {
      if (typeof contents === 'string') storedCredential = contents;
      return Promise.resolve();
    });
    request.mockImplementation((url: string): Response => {
      if (url.endsWith('/v1/desktop/enrollment/exchange')) {
        return new Response(JSON.stringify({ token: `gtrz-device-${'a'.repeat(64)}` }), {
          status: 200,
        });
      }
      if (url.includes('/v1/monitor/global-control')) {
        return new Response(JSON.stringify({ commands: [], cursor: 0 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    await expect(service.verifyOrEnrollDesktop('one-time-code')).resolves.toBe('connected');
    expect(request).toHaveBeenCalledWith(
      'https://audit.invalid/v1/monitor/heartbeat',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-GTRZ-Key': `gtrz-device-${'a'.repeat(64)}` }),
      }),
    );
    expect(request.mock.calls[2]?.[0]).toBe(
      'https://audit.invalid/v1/monitor/global-control?after=0',
    );
  });

  it('does not claim a successful installation when shared event control is unavailable', async () => {
    request.mockImplementation(
      (url: string): Response =>
        new Response('{}', { status: url.includes('/v1/monitor/global-control') ? 503 : 200 }),
    );

    await expect(service.verifyOrEnrollDesktop()).rejects.toThrow(
      'A central não liberou o estado compartilhado dos eventos.',
    );
  });

  it('keeps an existing desktop credential and rejects a failed cloud verification', async () => {
    request.mockImplementation((): Response => new Response('{}', { status: 401 }));

    await expect(service.verifyOrEnrollDesktop()).rejects.toThrow(
      'A central recusou a credencial deste computador.',
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('https://audit.invalid/v1/monitor/heartbeat');
  });

  it('does not poll global control on every local outbox interval once a control stream exists', async () => {
    await service.flushOutbox(db, null);
    const initialReads = request.mock.calls.filter(([url]) =>
      String(url).includes('/global-control'),
    );

    await service.flushOutbox(db, null);

    expect(
      request.mock.calls.filter(([url]) => String(url).includes('/global-control')),
    ).toHaveLength(initialReads.length);
  });

  it('sends a sale-triggered audit immediately after a busy flush, without a timer tick', async () => {
    let releaseSnapshot: ((response: Response) => void) | undefined;
    let snapshotRequested: (() => void) | undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      snapshotRequested = resolve;
    });
    let delayFirstSnapshot = true;
    request = vi.fn((url: string): Response | Promise<Response> => {
      if (url.includes('/_catalog/snapshot') && delayFirstSnapshot) {
        delayFirstSnapshot = false;
        snapshotRequested?.();
        return new Promise<Response>((resolve) => {
          releaseSnapshot = resolve;
        });
      }
      if (url.includes('/global-control')) {
        return new Response(JSON.stringify({ commands: [], pendingReset: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ currentSequence: 0, stock: [], events: [] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', request);

    const firstFlush = service.flushOutbox(db, null);
    await snapshotStarted;
    const event = createEvent(db, { name: 'Sale during sync', startsAt: Date.now() });
    const category = createProductCategory(db, 'Drinks');
    const product = createInventoryProduct(db, {
      categoryId: category.id,
      name: 'Water',
      kind: 'drink',
      costCents: 100,
      salePriceCents: 500,
      lowStockThreshold: 0,
    });
    recordStockMovement(db, { productId: product.id, type: 'purchase', quantity: 1 });
    const table = createServicePoint(db, { label: 'Table 1', type: 'table' });
    const order = openOrder(db, table.id);
    addOrderItem(db, { orderId: order.id, itemKind: 'product', itemId: product.id, quantity: 1 });
    closeOrder(db, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    service.requestImmediateFlush(
      () => db,
      () => event.id,
    );
    releaseSnapshot?.(
      new Response(JSON.stringify({ currentSequence: 0, stock: [], events: [] }), {
        status: 200,
      }),
    );
    await firstFlush;
    const paidWasSent = (): boolean =>
      request.mock.calls.some(([url, init]) => {
        const body: unknown = (init as RequestInit | undefined)?.body;
        return (
          String(url).includes('/journal') &&
          typeof body === 'string' &&
          body.includes('operations.order-paid')
        );
      });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (paidWasSent()) break;
      await settle();
    }

    expect(paidWasSent()).toBe(true);
    expect(actions()).toContain('operations.order-paid');
  });

  it('applies a complete control WebSocket frame without an extra control read', async () => {
    await service.flushOutbox(db, null);
    const control = requireSocket('/monitor/');
    control.open();
    const readsBefore = request.mock.calls.filter(([url]) =>
      String(url).includes('/global-control'),
    ).length;

    control.message({
      type: 'global.sync',
      activeEventId: null,
      activeEventName: null,
      revision: 0,
      commands: [],
      pendingReset: null,
    });
    await settle();

    expect(
      request.mock.calls.filter(([url]) => String(url).includes('/global-control')),
    ).toHaveLength(readsBefore);
  });

  it('does not use the legacy key for desktop enrollment administration', async () => {
    request.mockImplementation((url: string): Response => {
      if (url.endsWith('/v1/desktop/enrollment')) {
        return new Response(
          JSON.stringify({ enrollmentCode: 'gtrz-enroll-code', expiresAt: 123 }),
          {
            status: 200,
          },
        );
      }
      return new Response(JSON.stringify({ currentSequence: 0, stock: [], events: [] }), {
        status: 200,
      });
    });

    await expect(service.createDesktopEnrollment()).rejects.toThrow('conta proprietária');
    expect(request).not.toHaveBeenCalledWith(
      'https://audit.invalid/v1/desktop/enrollment',
      expect.anything(),
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
      db.sqlite.prepare("SELECT value FROM sync_state WHERE key = 'inbox.sequence:_catalog'").get(),
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
        .prepare(
          "SELECT COUNT(*) AS amount FROM product_categories WHERE id LIKE 'remote-category-%'",
        )
        .get(),
    ).toEqual({ amount: 41 });
    expect(
      db.sqlite.prepare("SELECT value FROM sync_state WHERE key = 'inbox.sequence:_catalog'").get(),
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
        .prepare(
          "SELECT COUNT(*) AS amount FROM product_categories WHERE id LIKE 'socket-category-%'",
        )
        .get(),
    ).toEqual({ amount: 41 });
    expect(catalog.readyState).toBe(WebSocket.OPEN);
  });

  it('retries a locally committed operation with the same idempotency key after a network failure', async () => {
    vi.useFakeTimers();
    const sentCommands: string[] = [];
    let centralAvailable = false;
    request.mockImplementation((url: string, init?: RequestInit): Response => {
      if (url.includes('/journal')) {
        sentCommands.push(typeof init?.body === 'string' ? init.body : '');
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
    await vi.advanceTimersByTimeAsync(3_000);
    await service.flushOutbox(db, event.id);

    expect(
      db.sqlite.prepare("SELECT status FROM sync_outbox WHERE status = 'accepted'").get(),
    ).toEqual({ status: 'accepted' });
    expect(sentCommands).toHaveLength(2);
    expect(sentCommands[1]).toBe(sentCommands[0]);
  });

  it('reconciles an offline sale from a cold-started PC into a second SQLite database', async () => {
    vi.useFakeTimers();
    let cloudAvailable = false;
    let dropPaidAcknowledgement = true;
    const journalByEvent = new Map<string, AuditJournalEvent[]>();
    const acceptedCommands = new Set<string>();
    request.mockImplementation((url: string, init?: RequestInit): Response => {
      if (!cloudAvailable) return new Response('{}', { status: 503 });
      if (url.includes('/global-control')) {
        return new Response(JSON.stringify({ commands: globalCommands, pendingReset: null }));
      }
      const journalRoute = /\/v1\/events\/([^/]+)\/journal$/u.exec(url);
      if (journalRoute !== null) {
        const eventId = decodeURIComponent(journalRoute[1] ?? '');
        if (typeof init?.body !== 'string') throw new Error('Missing journal payload.');
        const payload = JSON.parse(init.body) as AuditJournalEvent['payload'] & {
          commandId: string;
        };
        if (
          payload.action === 'inventory.stock-moved' &&
          typeof payload.details.quantity !== 'number'
        ) {
          return new Response('{}', { status: 422 });
        }
        if (!acceptedCommands.has(payload.commandId)) {
          acceptedCommands.add(payload.commandId);
          const events = journalByEvent.get(eventId) ?? [];
          events.push({
            sequence: events.length + 1,
            commandId: payload.commandId,
            type: payload.action,
            payload,
          });
          journalByEvent.set(eventId, events);
        }
        if (payload.action === 'operations.order-paid' && dropPaidAcknowledgement) {
          dropPaidAcknowledgement = false;
          return new Response('{}', { status: 503 });
        }
        return new Response('{}');
      }
      const snapshotRoute = /\/v1\/events\/([^/]+)\/snapshot\?after=(\d+)$/u.exec(url);
      if (snapshotRoute !== null) {
        const eventId = decodeURIComponent(snapshotRoute[1] ?? '');
        const events = journalByEvent.get(eventId) ?? [];
        const after = Number(snapshotRoute[2]);
        return new Response(
          JSON.stringify({
            currentSequence: events.length,
            events: events.filter((item) => item.sequence > after),
          }),
        );
      }
      return new Response('{}');
    });

    await service.flushOutbox(db, null);
    expect(
      db.sqlite.prepare("SELECT value FROM sync_state WHERE key = 'outbox.audit-floor'").get(),
    ).toEqual({ value: '0' });

    const event = createEvent(db, { name: 'Offline reconciliation', startsAt: Date.now() });
    const category = createProductCategory(db, 'Drinks');
    const product = createInventoryProduct(db, {
      categoryId: category.id,
      name: 'Water',
      kind: 'drink',
      costCents: 100,
      salePriceCents: 500,
      lowStockThreshold: 0,
    });
    recordStockMovement(db, { productId: product.id, type: 'purchase', quantity: 3 });
    const table = createServicePoint(db, { label: 'Table offline', type: 'table' });
    const order = openOrder(db, table.id);
    addOrderItem(db, { orderId: order.id, itemKind: 'product', itemId: product.id, quantity: 1 });
    closeOrder(db, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    const secondOrder = openOrder(db, table.id);
    addOrderItem(db, {
      orderId: secondOrder.id,
      itemKind: 'product',
      itemId: product.id,
      quantity: 1,
    });
    closeOrder(db, {
      orderId: secondOrder.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 500 }],
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await service.flushOutbox(db, event.id);
    expect(getOrder(db, order.id).status).toBe('paid');
    expect(getOrder(db, secondOrder.id).status).toBe('paid');
    const queued = db.sqlite
      .prepare("SELECT COUNT(*) AS amount FROM sync_outbox WHERE status = 'pending'")
      .get() as { amount: number };
    expect(queued.amount).toBeGreaterThan(0);
    expect(acceptedCommands.size).toBe(0);
    const oldStockOutbox = db.sqlite
      .prepare(
        "SELECT audit_id, payload_json FROM sync_outbox WHERE json_extract(payload_json, '$.action') = 'inventory.stock-moved'",
      )
      .get() as { readonly audit_id: number; readonly payload_json: string };
    const oldStockPayload = JSON.parse(oldStockOutbox.payload_json) as {
      details: Record<string, unknown>;
    };
    delete oldStockPayload.details.quantity;
    db.sqlite
      .prepare('UPDATE sync_outbox SET payload_json = ? WHERE audit_id = ?')
      .run(JSON.stringify(oldStockPayload), oldStockOutbox.audit_id);

    globalCommands = [
      {
        sequence: 1,
        commandId: 'activate-offline-reconciliation',
        type: 'event.activated',
        eventId: event.id,
        eventName: event.name,
        createdAt: Date.now(),
      },
    ];
    cloudAvailable = true;
    await vi.advanceTimersByTimeAsync(6_000);
    await service.flushOutbox(db, event.id);
    expect(dropPaidAcknowledgement).toBe(false);
    expect(
      db.sqlite.prepare("SELECT COUNT(*) AS amount FROM sync_outbox WHERE status = 'failed'").get(),
    ).toEqual({ amount: 1 });
    await vi.advanceTimersByTimeAsync(6_000);
    await service.flushOutbox(db, event.id);
    expect(
      db.sqlite
        .prepare("SELECT COUNT(*) AS amount FROM sync_outbox WHERE status = 'accepted'")
        .get(),
    ).toMatchObject({ amount: acceptedCommands.size });
    expect(
      [...journalByEvent.values()]
        .flat()
        .filter((item) => item.payload.action === 'operations.order-paid'),
    ).toHaveLength(2);
    const stockEvent = [...journalByEvent.values()]
      .flat()
      .find((item) => item.payload.action === 'inventory.stock-moved');
    expect(stockEvent?.payload.details.quantity).toBe(3);
    if (stockEvent !== undefined) delete stockEvent.payload.details.quantity;

    const secondDatabase = openDatabase(':memory:');
    ensureControlDefaults(secondDatabase);
    vi.mocked(readFile).mockImplementation(
      (file): Promise<string> =>
        Promise.resolve(
          file === 'receiver-device'
            ? 'receiver-pc'
            : file === 'receiver-key'
              ? 'isolated-audit-key'
              : 'audit-pc',
        ),
    );
    const secondService = new CloudSyncService(
      'receiver-key',
      'receiver-device',
      () => undefined,
      'https://audit.invalid',
    );
    try {
      await secondService.flushOutbox(secondDatabase, null);
      expect(getSessionState(secondDatabase).activeEvent?.id).toBe(event.id);
      expect(
        secondDatabase.sqlite.prepare('SELECT action, reason FROM sync_conflicts').all(),
      ).toEqual([]);
      const receivedCashOrder = getOrder(secondDatabase, order.id);
      const receivedPixOrder = getOrder(secondDatabase, secondOrder.id);
      expect(receivedCashOrder.status).toBe('paid');
      expect(receivedCashOrder.payments).toMatchObject([{ method: 'cash', amountCents: 500 }]);
      expect(receivedPixOrder.status).toBe('paid');
      expect(receivedPixOrder.payments).toMatchObject([{ method: 'pix', amountCents: 500 }]);
      expect(
        secondDatabase.sqlite
          .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
          .get(event.id, product.id),
      ).toEqual({ quantity: 1 });

      await secondService.flushOutbox(secondDatabase, event.id);
      expect(
        secondDatabase.sqlite
          .prepare('SELECT COUNT(*) AS amount FROM orders WHERE id = ?')
          .get(order.id),
      ).toEqual({ amount: 1 });
      expect(
        secondDatabase.sqlite
          .prepare('SELECT COUNT(*) AS amount FROM orders WHERE id = ?')
          .get(secondOrder.id),
      ).toEqual({ amount: 1 });
    } finally {
      secondService.stop();
      secondDatabase.close();
      vi.mocked(readFile).mockImplementation(
        (file): Promise<string> =>
          Promise.resolve(file === 'audit-key' ? 'isolated-audit-key' : 'audit-pc'),
      );
    }
  });

  it('restores a verified database copy before a fresh paired PC consumes event sales', async () => {
    const snapshot = Buffer.from('verified SQLite replica');
    const checksum = createHash('sha256').update(snapshot).digest('hex');
    const replaceWith = vi.fn((): Promise<void> => Promise.resolve());
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
            'X-GTRZ-Snapshot-Size': String(snapshot.byteLength),
          },
        });
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

  it('chooses the newest verified cloud copy instead of the stale activation copy', async () => {
    const snapshot = Buffer.from('newest verified SQLite replica');
    const checksum = createHash('sha256').update(snapshot).digest('hex');
    const replaceWith = vi.fn((): Promise<void> => Promise.resolve());
    service.stop();
    service = new CloudSyncService(
      'audit-key',
      'audit-device',
      (): void => undefined,
      'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback',
      (): string => 'Audit PC',
      { get: (): ReturnType<typeof openDatabase> => db, replaceWith } as never,
    );
    request.mockImplementation((url: string): Response => {
      if (url.endsWith('/replica-snapshot/latest')) {
        return new Response(
          JSON.stringify({
            snapshotId: 'new-copy',
            eventId: 'remote-event',
            sourceDeviceId: 'source-device',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/replica-snapshot/new-copy')) {
        return new Response(snapshot, {
          status: 200,
          headers: {
            'X-GTRZ-Snapshot-Event': 'remote-event',
            'X-GTRZ-Snapshot-Sha256': checksum,
            'X-GTRZ-Snapshot-Size': String(snapshot.byteLength),
          },
        });
      }
      if (url.includes('/global-control')) {
        return new Response(
          JSON.stringify({
            commands: [
              {
                sequence: 47,
                commandId: 'old-activation',
                type: 'event.activated',
                eventId: 'remote-event',
                eventName: 'Remote event',
                bootstrapSnapshotId: 'old-copy',
                snapshotSourceDeviceId: 'source-device',
                createdAt: Date.now(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ currentSequence: 0, events: [], stock: [] }), {
        status: 200,
      });
    });

    await service.flushOutbox(db, null);

    expect(replaceWith).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('/replica-snapshot/new-copy'),
      expect.anything(),
    );
    expect(
      request.mock.calls.some(([url]) => String(url).endsWith('/replica-snapshot/old-copy')),
    ).toBe(false);
  });

  it('settles a legacy rejected stock entry already present in the source database', async () => {
    const event = createEvent(db, { name: 'Stock event', startsAt: Date.now() });
    setActiveEvent(db, event.id);
    const category = createProductCategory(db, 'Food');
    const product = createInventoryProduct(db, {
      categoryId: category.id,
      name: 'Arepa',
      kind: 'food',
      costCents: 100,
      salePriceCents: 300,
      lowStockThreshold: 0,
    });
    recordStockMovement(db, {
      productId: product.id,
      type: 'correction-positive',
      quantity: 50,
      note: 'Legacy entry',
    });
    const movement = db.sqlite
      .prepare('SELECT id FROM stock_movements WHERE note = ?')
      .get('Legacy entry') as { readonly id: string };
    db.sqlite
      .prepare(
        `INSERT INTO sync_inbox
       (event_id, sequence, command_id, payload_json, received_at, applied_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        event.id,
        500,
        'old-rejection',
        JSON.stringify({
          action: 'inventory.stock-rejected',
          deviceId: 'cloud-audit',
          entityId: 'cloud-reject:old-rejection',
          createdAt: Date.now(),
          details: {
            originalMovementId: movement.id,
            rejectedDeviceId: 'audit-pc',
            delta: 50,
            reason: 'O movimento de estoque não contém uma quantidade válida.',
          },
        }),
        Date.now(),
      );

    await service.flushOutbox(db, event.id);

    expect(
      db.sqlite
        .prepare('SELECT applied_at FROM sync_inbox WHERE command_id = ?')
        .get('old-rejection'),
    ).toMatchObject({ applied_at: expect.any(Number) });
    expect(
      db.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(event.id, product.id),
    ).toEqual({ quantity: 50 });
  });

  it('repairs a paired PC with partial catalog and stock but no local orders', async () => {
    const snapshot = Buffer.from('verified source database');
    const replaceWith = vi.fn((): Promise<void> => Promise.resolve());
    const now = Date.now();
    db.sqlite
      .prepare(
        `INSERT INTO events (id, name, status, starts_at, ends_at, created_at, updated_at)
       VALUES ('remote-event', 'Remote event', 'open', ?, NULL, ?, ?)`,
      )
      .run(now, now, now);
    setActiveEvent(db, 'remote-event');
    const category = createProductCategory(db, 'Partial catalog');
    const product = createInventoryProduct(db, {
      categoryId: category.id,
      name: 'Partial product',
      kind: 'drink',
      costCents: 100,
      salePriceCents: 300,
      lowStockThreshold: 0,
    });
    recordStockMovement(db, {
      productId: product.id,
      type: 'correction-positive',
      quantity: 3,
    });
    createServicePoint(db, { label: 'Partial table', type: 'table' });
    db.sqlite
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at)
       VALUES ('global.event-control.cursor', '47', ?)`,
      )
      .run(now);
    service.stop();
    service = new CloudSyncService(
      'audit-key',
      'audit-device',
      (): void => undefined,
      'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback',
      (): string => 'Audit PC',
      { get: (): ReturnType<typeof openDatabase> => db, replaceWith } as never,
    );
    request.mockImplementation((url: string): Response => {
      if (url.endsWith('/replica-snapshot/latest'))
        return new Response(
          JSON.stringify({
            snapshotId: 'verified-copy',
            eventId: 'remote-event',
            sourceDeviceId: 'source-device',
          }),
        );
      if (url.endsWith('/replica-snapshot/verified-copy'))
        return new Response(snapshot, {
          headers: {
            'X-GTRZ-Snapshot-Event': 'remote-event',
            'X-GTRZ-Snapshot-Sha256': createHash('sha256').update(snapshot).digest('hex'),
            'X-GTRZ-Snapshot-Size': String(snapshot.length),
          },
        });
      if (url.includes('/global-control')) return new Response(JSON.stringify({ commands: [] }));
      return new Response(JSON.stringify({ currentSequence: 0, events: [], stock: [] }));
    });

    await service.flushOutbox(db, 'remote-event');

    expect(replaceWith).toHaveBeenCalledTimes(1);
    expect(
      db.sqlite
        .prepare("SELECT value FROM sync_state WHERE key = 'replica.baseline.snapshotId'")
        .get(),
    ).toEqual({ value: 'verified-copy' });
  });

  it('does not replace a PC that has a local order', async () => {
    const event = createEvent(db, { name: 'Local order', startsAt: Date.now() });
    setActiveEvent(db, event.id);
    const table = createServicePoint(db, { label: 'Local table', type: 'table' });
    openOrder(db, table.id);
    const replaceWith = vi.fn((): Promise<void> => Promise.resolve());
    service.stop();
    service = new CloudSyncService(
      'audit-key',
      'audit-device',
      (): void => undefined,
      'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback',
      (): string => 'Audit PC',
      { get: (): ReturnType<typeof openDatabase> => db, replaceWith } as never,
    );
    request.mockImplementation(
      (url: string): Response =>
        new Response(JSON.stringify(url.includes('/global-control') ? { commands: [] } : {})),
    );

    await service.flushOutbox(db, event.id);

    expect(replaceWith).not.toHaveBeenCalled();
    expect(
      db.sqlite.prepare('SELECT COUNT(*) AS n FROM orders WHERE event_id = ?').get(event.id),
    ).toEqual({ n: 1 });
  });

  it('uploads a verified cloud replica but blocks global activation without owner login', async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'gtrz-replica-test-'));
    const databaseRuntime = {
      get: (): ReturnType<typeof openDatabase> => db,
      replaceWith: vi.fn((): Promise<void> => Promise.resolve()),
    };
    service.stop();
    service = new CloudSyncService(
      'audit-key',
      'audit-device',
      (): void => undefined,
      'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback',
      (): string => 'Audit PC',
      databaseRuntime as never,
    );
    vi.mocked(mkdtemp).mockResolvedValue(temporaryDirectory);
    vi.mocked(readFile).mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath.endsWith('database.sqlite')) {
        return Promise.resolve(Buffer.from('verified SQLite replica'));
      }
      return Promise.resolve(filePath === 'audit-key' ? 'isolated-audit-key' : 'audit-pc');
    });
    request.mockImplementation((url: string): Response => {
      if (url.endsWith('/v1/monitor/heartbeat')) return new Response('{}', { status: 200 });
      if (url.endsWith('/replica-snapshot')) {
        return new Response(JSON.stringify({ snapshotId: 'snapshot-1', eventId: event.id }), {
          status: 200,
        });
      }
      if (url.endsWith('/v1/monitor/global-event')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const event = createEvent(db, { name: 'Replica event', startsAt: Date.now() });

    try {
      await expect(service.setGlobalEvent(db, event.id)).rejects.toThrow('conta proprietária');

      const urls = request.mock.calls.map(([url]) => String(url));
      expect(urls).toEqual(
        expect.arrayContaining([
          expect.stringContaining('/v1/monitor/heartbeat'),
          expect.stringContaining(`/v1/events/${event.id}/replica-snapshot`),
        ]),
      );
      expect(urls.some((url) => url.endsWith('/v1/monitor/global-event'))).toBe(false);
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining(`/v1/events/${event.id}/replica-snapshot`),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-GTRZ-Snapshot-Size': '23',
          }),
        }),
      );
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
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
