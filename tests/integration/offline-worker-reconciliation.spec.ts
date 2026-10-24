import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  addOrderItem,
  closeOrder,
  createDatabaseSnapshot,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  ensureControlDefaults,
  getOrder,
  openDatabase,
  openOrder,
  recordStockMovement,
} from '@gtrz/database';
import { CloudSyncService } from '../../apps/desktop/src/main/cloud-sync-service';

const endpoint = process.env.GTRZ_LOCAL_WORKER_URL ?? '';
const key = process.env.GTRZ_LOCAL_WORKER_KEY ?? '';
const integration = endpoint && key ? it : it.skip;

afterEach(() => vi.unstubAllGlobals());

integration(
  'reconciles real HTTP Worker sales after the first PC was offline',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gtrz-offline-worker-'));
    const source = openDatabase(path.join(directory, 'source.sqlite'));
    let receiver: ReturnType<typeof openDatabase> | null = null;
    ensureControlDefaults(source);
    const keyPath = path.join(directory, 'pairing-key.txt');
    await writeFile(keyPath, key, 'utf8');
    const sourceService = new CloudSyncService(
      keyPath,
      path.join(directory, 'source-device'),
      () => undefined,
      endpoint,
    );
    const receiverService = new CloudSyncService(
      keyPath,
      path.join(directory, 'receiver-device'),
      () => undefined,
      endpoint,
    );
    const realFetch = globalThis.fetch;

    try {
      await sourceService.flushOutbox(source, null);

      const runId = randomUUID();
      const event = createEvent(source, {
        name: 'Isolated offline Worker test',
        startsAt: Date.now(),
      });
      const category = createProductCategory(source, `Drinks ${runId}`);
      const product = createInventoryProduct(source, {
        categoryId: category.id,
        name: `Water ${runId}`,
        kind: 'drink',
        costCents: 100,
        salePriceCents: 500,
        lowStockThreshold: 0,
      });
      recordStockMovement(source, { productId: product.id, type: 'purchase', quantity: 3 });
      const table = createServicePoint(source, { label: 'Offline table', type: 'table' });
      await sourceService.flushOutbox(source, event.id);
      expect(
        source.sqlite
          .prepare(
            "SELECT COUNT(*) AS amount FROM sync_outbox WHERE status IN ('pending', 'failed')",
          )
          .get(),
      ).toEqual({ amount: 0 });
      sourceService.stop();
      await createDatabaseSnapshot(source, path.join(directory, 'receiver.sqlite'));
      receiver = openDatabase(path.join(directory, 'receiver.sqlite'));
      ensureControlDefaults(receiver);

    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 503 })));
      const cashOrder = openOrder(source, table.id);
      addOrderItem(source, {
        orderId: cashOrder.id,
        itemKind: 'product',
        itemId: product.id,
        quantity: 1,
      });
      closeOrder(source, {
        orderId: cashOrder.id,
        discountCents: 0,
        payments: [{ method: 'cash', amountCents: 500 }],
      });
      const pixOrder = openOrder(source, table.id);
      addOrderItem(source, {
        orderId: pixOrder.id,
        itemKind: 'product',
        itemId: product.id,
        quantity: 1,
      });
      closeOrder(source, {
        orderId: pixOrder.id,
        discountCents: 0,
        payments: [{ method: 'pix', amountCents: 500 }],
      });
      await sourceService.flushOutbox(source, event.id);
      expect(getOrder(source, cashOrder.id).status).toBe('paid');
      expect(getOrder(source, pixOrder.id).status).toBe('paid');
      const queued = source.sqlite
        .prepare("SELECT COUNT(*) AS amount FROM sync_outbox WHERE status = 'pending'")
        .get() as { readonly amount: number };
      expect(queued.amount).toBeGreaterThan(0);

      vi.stubGlobal('fetch', realFetch);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await sourceService.flushOutbox(source, event.id);
        const pending = source.sqlite
          .prepare(
            "SELECT COUNT(*) AS amount FROM sync_outbox WHERE status IN ('pending', 'failed')",
          )
          .get() as { readonly amount: number };
        if (pending.amount === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      expect(
        source.sqlite
          .prepare(
            "SELECT COUNT(*) AS amount FROM sync_outbox WHERE status IN ('pending', 'failed')",
          )
          .get(),
      ).toEqual({ amount: 0 });
      const cloudCatalogResponse = await realFetch(
        `${endpoint}/v1/events/${encodeURIComponent(event.id)}/cashier/catalog`,
        { headers: { 'X-GTRZ-Key': key } },
      );
      expect(cloudCatalogResponse.ok).toBe(true);
      const cloudCatalog = (await cloudCatalogResponse.json()) as {
        readonly products: readonly { readonly productId: string; readonly quantity: number }[];
      };
      expect(cloudCatalog.products.find((item) => item.productId === product.id)?.quantity).toBe(1);

      await receiverService.flushOutbox(receiver, event.id);
      expect(receiver.sqlite.prepare('SELECT action, reason FROM sync_conflicts').all()).toEqual(
        [],
      );
      expect(getOrder(receiver, cashOrder.id).payments).toMatchObject([
        { method: 'cash', amountCents: 500 },
      ]);
      expect(getOrder(receiver, pixOrder.id).payments).toMatchObject([
        { method: 'pix', amountCents: 500 },
      ]);
      expect(
        receiver.sqlite
          .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
          .get(event.id, product.id),
      ).toEqual({ quantity: 1 });
      await receiverService.flushOutbox(receiver, event.id);
      expect(
        receiver.sqlite
          .prepare('SELECT COUNT(*) AS amount FROM orders WHERE event_id = ?')
          .get(event.id),
      ).toEqual({ amount: 2 });
    } finally {
      sourceService.stop();
      receiverService.stop();
      source.close();
      receiver?.close();
      vi.stubGlobal('fetch', realFetch);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
