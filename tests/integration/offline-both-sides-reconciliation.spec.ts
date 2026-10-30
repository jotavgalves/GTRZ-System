import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
} from '@gtrz/database';
import { CloudSyncService } from '../../apps/desktop/src/main/cloud-sync-service';

const endpoint = process.env.GTRZ_LOCAL_WORKER_URL ?? '';
const key = process.env.GTRZ_LOCAL_WORKER_KEY ?? '';
const integration = endpoint && key ? it : it.skip;

afterEach(() => vi.unstubAllGlobals());

integration(
  'reconciles sales made offline on the PC and online on the Worker with no loss or duplicate',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gtrz-both-sides-'));
    const pc = openDatabase(path.join(directory, 'pc.sqlite'));
    ensureControlDefaults(pc);
    const keyPath = path.join(directory, 'pairing-key.txt');
    await writeFile(keyPath, key, 'utf8');
    const service = new CloudSyncService(
      keyPath,
      path.join(directory, 'pc-device'),
      () => undefined,
      endpoint,
    );
    const realFetch = globalThis.fetch;
    const pending = () =>
      pc.sqlite
        .prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE status IN ('pending','failed')")
        .get() as { n: number };
    const flush = async (eventId: string) => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await service.flushOutbox(pc, eventId);
        if (pending().n === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    };
    const worker = (pathname: string, init: RequestInit = {}) =>
      realFetch(`${endpoint}${pathname}`, {
        ...init,
        headers: { 'X-GTRZ-Key': key, 'Content-Type': 'application/json', ...init.headers },
      });

    try {
      await service.flushOutbox(pc, null);
      const runId = randomUUID();
      const event = createEvent(pc, { name: 'Both sides test', startsAt: Date.now() });
      const category = createProductCategory(pc, `Drinks ${runId}`);
      const product = createInventoryProduct(pc, {
        categoryId: category.id,
        name: `Water ${runId}`,
        kind: 'drink',
        costCents: 100,
        salePriceCents: 500,
        lowStockThreshold: 0,
      });
      recordStockMovement(pc, { productId: product.id, type: 'purchase', quantity: 10 });
      const table = createServicePoint(pc, { label: 'Table', type: 'table' });
      await flush(event.id);
      expect(pending().n).toBe(0);

      // PC loses the internet.
      vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 503 })));
      const offlineOrders: string[] = [];
      for (const method of ['cash', 'pix'] as const) {
        const order = openOrder(pc, table.id);
        addOrderItem(pc, {
          orderId: order.id,
          itemKind: 'product',
          itemId: product.id,
          quantity: 1,
        });
        closeOrder(pc, {
          orderId: order.id,
          discountCents: 0,
          payments: [{ method, amountCents: 500 }],
        });
        offlineOrders.push(order.id);
      }
      await service.flushOutbox(pc, event.id);
      expect(pending().n).toBeGreaterThan(0);

      // Meanwhile the cloud (mobile cashier) sells, and retries the same sale once.
      const sale = {
        commandId: randomUUID(),
        saleId: randomUUID(),
        items: [{ productId: product.id, itemKind: 'product', quantity: 1 }],
        servicePointId: table.id,
        paymentMethod: 'pix',
        receivedCents: null,
      };
      const saleInit = {
        method: 'POST',
        body: JSON.stringify(sale),
        headers: {
          'X-GTRZ-Cashier-Device': 'mobile:test:device',
          'X-GTRZ-Cashier-Label': 'Mobile test',
        },
      };
      const first = await worker(`/v1/events/${event.id}/cashier/sales`, saleInit);
      expect(first.status, await first.clone().text()).toBe(200);
      const retry = await worker(`/v1/events/${event.id}/cashier/sales`, saleInit);
      expect(retry.status, await retry.clone().text()).toBe(200);

      // Internet returns: both sides must converge.
      vi.stubGlobal('fetch', realFetch);
      await flush(event.id);
      await service.flushOutbox(pc, event.id);
      await service.flushOutbox(pc, event.id);

      expect(pending().n).toBe(0);
      expect(pc.sqlite.prepare('SELECT action, reason FROM sync_conflicts').all()).toEqual([]);
      expect(
        pc.sqlite
          .prepare("SELECT COUNT(*) AS n FROM orders WHERE event_id = ? AND status = 'paid'")
          .get(event.id),
      ).toEqual({ n: 3 });
      expect(
        pc.sqlite
          .prepare('SELECT id FROM orders WHERE id = ?')
          .get(sale.saleId),
      ).toEqual({ id: sale.saleId });
      expect(
        pc.sqlite
          .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
          .get(event.id, product.id),
      ).toEqual({ quantity: 7 });

      const catalog = (await (
        await worker(`/v1/events/${event.id}/cashier/catalog`)
      ).json()) as { products: { productId: string; quantity: number }[] };
      expect(catalog.products.find((p) => p.productId === product.id)?.quantity).toBe(7);
      for (const id of offlineOrders) {
        expect(pc.sqlite.prepare('SELECT status FROM orders WHERE id = ?').get(id)).toEqual({
          status: 'paid',
        });
      }
    } finally {
      service.stop();
      pc.close();
      vi.stubGlobal('fetch', realFetch);
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
