import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addOrderItem,
  closeOrder,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  ensureControlDefaults,
  openDatabase,
  openOrder,
  recordStockMovement,
  type DatabaseContext,
} from '@gtrz/database';
import {
  FORCE_WIPE_CONFIRMATION,
  type ForceWipeGlobalEventInput,
} from '../../packages/contracts/src/force-wipe';
import { runForceWipe } from '../../apps/desktop/src/main/force-wipe';

const cloudCounts = {
  journal: 40,
  commands: 12,
  projections: 2,
  state: 1,
  printJobs: 9,
  printAttempts: 7,
  snapshots: 1,
  pendingResets: 1,
};

let db: DatabaseContext;
let eventId: string;
let onLocalCleared: ReturnType<typeof vi.fn>;
let calls: { url: string; body: Record<string, unknown>; ordersAtCall: number }[];

function orders(): number {
  return (db.sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
}

function stubCloud(respond: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(init.body as string) as Record<string, unknown>,
        ordersAtCall: orders(),
      });
      return Promise.resolve(respond());
    }),
  );
}

function input(overrides: Partial<ForceWipeGlobalEventInput> = {}): ForceWipeGlobalEventInput {
  return {
    eventId,
    confirmationName: 'MACABRA',
    reason: 'limpeza para teste',
    dryRun: true,
    ...overrides,
  };
}

function run(overrides: Partial<ForceWipeGlobalEventInput> = {}): ReturnType<typeof runForceWipe> {
  return runForceWipe({
    database: db,
    input: input(overrides),
    endpoint: 'https://cloud.example/functions/v1/gtrz',
    headers: () => Promise.resolve({ Authorization: 'Bearer owner-token' }),
    onLocalCleared: onLocalCleared as () => void,
  });
}

beforeEach(() => {
  calls = [];
  onLocalCleared = vi.fn();
  db = openDatabase(':memory:');
  ensureControlDefaults(db);
  eventId = createEvent(db, { name: 'MACABRA', startsAt: Date.now() }).id;
  const category = createProductCategory(db, 'Bebidas');
  const product = createInventoryProduct(db, {
    categoryId: category.id,
    name: 'Agua',
    kind: 'drink',
    costCents: 100,
    salePriceCents: 500,
    lowStockThreshold: 0,
  });
  recordStockMovement(db, { productId: product.id, type: 'purchase', quantity: 10 });
  const table = createServicePoint(db, { label: 'Mesa 1', type: 'table' });
  for (let sale = 0; sale < 2; sale += 1) {
    const order = openOrder(db, table.id);
    addOrderItem(db, { orderId: order.id, itemKind: 'product', itemId: product.id, quantity: 1 });
    closeOrder(db, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'cash', amountCents: 500 }],
    });
  }
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe('administrator forced wipe', () => {
  it('refuses a wrong event name before touching the cloud or the data', async () => {
    stubCloud(() => Response.json({ counts: cloudCounts }));
    await expect(run({ confirmationName: 'OUTRO' })).rejects.toThrow('nome do evento');
    expect(calls).toHaveLength(0);
    expect(orders()).toBe(2);
  });

  it('refuses a real wipe without the typed phrase', async () => {
    stubCloud(() => Response.json({ counts: cloudCounts }));
    await expect(run({ dryRun: false })).rejects.toThrow(FORCE_WIPE_CONFIRMATION);
    await expect(run({ dryRun: false, confirmation: 'apagar' })).rejects.toThrow(
      FORCE_WIPE_CONFIRMATION,
    );
    expect(calls).toHaveLength(0);
    expect(orders()).toBe(2);
  });

  it('a simulation counts the cloud and this computer and deletes nothing', async () => {
    stubCloud(() => Response.json({ counts: cloudCounts }));
    const result = await run({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.cloud).toEqual(cloudCounts);
    expect(result.local).toMatchObject({
      orders: 2,
      paidOrders: 2,
      paidCents: 1000,
      tables: 1,
      stockMovements: 3,
    });
    expect(calls[0]?.url).toBe(
      'https://cloud.example/functions/v1/gtrz/v1/monitor/global-event/force-wipe',
    );
    expect(calls[0]?.body).toMatchObject({ dryRun: true, eventName: 'MACABRA' });
    expect(calls[0]?.body).not.toHaveProperty('confirmation');
    expect(orders()).toBe(2);
    expect(onLocalCleared).not.toHaveBeenCalled();
  });

  it('a real wipe empties the cloud FIRST and only then clears this computer', async () => {
    stubCloud(() => Response.json({ counts: cloudCounts }));
    const result = await run({ dryRun: false, confirmation: FORCE_WIPE_CONFIRMATION });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ dryRun: false, confirmation: FORCE_WIPE_CONFIRMATION });
    // When the cloud was asked, this computer still had every sale; afterwards it has none.
    expect(calls[0]?.ordersAtCall).toBe(2);
    expect(orders()).toBe(0);
    expect(result.local.paidCents).toBe(1000);
    expect(onLocalCleared).toHaveBeenCalledOnce();
  });

  it('keeps the product catalogue and zeroes the stock', async () => {
    stubCloud(() => Response.json({ counts: cloudCounts }));
    await run({ dryRun: false, confirmation: FORCE_WIPE_CONFIRMATION });
    const row = (sql: string): number => (db.sqlite.prepare(sql).get() as { n: number }).n;
    expect(row('SELECT COUNT(*) AS n FROM products')).toBe(1);
    expect(row('SELECT COUNT(*) AS n FROM product_categories')).toBeGreaterThan(0);
    expect(row('SELECT COUNT(*) AS n FROM event_stock')).toBe(0);
    expect(row('SELECT COUNT(*) AS n FROM service_points')).toBe(0);
    expect(row('SELECT COUNT(*) AS n FROM events')).toBe(1);
  });

  it('leaves this computer untouched when the cloud refuses', async () => {
    stubCloud(() =>
      Response.json(
        { error: { code: 'OWNER_FORBIDDEN', message: 'Conta não é proprietária.' } },
        { status: 403 },
      ),
    );
    await expect(run({ dryRun: false, confirmation: FORCE_WIPE_CONFIRMATION })).rejects.toThrow(
      'Conta não é proprietária.',
    );
    expect(orders()).toBe(2);
    expect(onLocalCleared).not.toHaveBeenCalled();
  });

  it('explains that the cloud function is missing and changes nothing', async () => {
    stubCloud(() => new Response('not found', { status: 404 }));
    await expect(run({ dryRun: false, confirmation: FORCE_WIPE_CONFIRMATION })).rejects.toThrow(
      'ainda não tem a limpeza forçada',
    );
    expect(orders()).toBe(2);
  });

  it('rejects a malformed cloud answer instead of wiping on a guess', async () => {
    stubCloud(() => Response.json({ counts: { journal: 'many' } }));
    await expect(run({ dryRun: false, confirmation: FORCE_WIPE_CONFIRMATION })).rejects.toThrow();
    expect(orders()).toBe(2);
    expect(onLocalCleared).not.toHaveBeenCalled();
  });
});
