import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  ensureControlDefaults,
  openDatabase,
  recordStockMovement,
} from '@gtrz/database';
import { CloudSyncService } from '../../apps/desktop/src/main/cloud-sync-service';

const endpoint = process.env.GTRZ_LOCAL_WORKER_URL ?? '';
const key = process.env.GTRZ_LOCAL_WORKER_KEY ?? '';
const integration = endpoint && key ? it : it.skip;

interface PrintJob {
  readonly jobId: string;
  readonly claimToken: string;
  readonly document: {
    readonly orderId: string;
    readonly referenceCode: string;
    readonly operatorName: string;
  };
}

integration(
  'numbers and delivers notes from concurrent devices exactly once each',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gtrz-print-concurrency-'));
    const pc = openDatabase(path.join(directory, 'pc.sqlite'));
    ensureControlDefaults(pc);
    const keyPath = path.join(directory, 'pairing-key.txt');
    await writeFile(keyPath, key, 'utf8');
    const service = new CloudSyncService(
      keyPath,
      path.join(directory, 'device'),
      () => undefined,
      endpoint,
    );
    const sockets: WebSocket[] = [];
    const call = (
      pathname: string,
      init: { method?: string; body?: string; headers?: Record<string, string> } = {},
    ): Promise<Response> =>
      fetch(`${endpoint}${pathname}`, {
        ...init,
        headers: { 'X-GTRZ-Key': key, 'Content-Type': 'application/json', ...init.headers },
      });

    try {
      await service.flushOutbox(pc, null);
      const event = createEvent(pc, { name: 'Print concurrency', startsAt: Date.now() });
      const category = createProductCategory(pc, `Drinks ${randomUUID()}`);
      const product = createInventoryProduct(pc, {
        categoryId: category.id,
        name: `Water ${randomUUID()}`,
        kind: 'drink',
        costCents: 100,
        salePriceCents: 500,
        lowStockThreshold: 0,
      });
      recordStockMovement(pc, { productId: product.id, type: 'purchase', quantity: 50 });
      const table = createServicePoint(pc, { label: 'Table', type: 'table' });
      for (let attempt = 0; attempt < 6; attempt += 1) await service.flushOutbox(pc, event.id);

      for (const printer of ['pc-a', 'pc-b']) {
        const registered = await call(`/v1/events/${event.id}/print/printers`, {
          method: 'POST',
          body: JSON.stringify({
            deviceId: printer,
            deviceLabel: printer,
            printerName: 'POS-80',
            paperWidthMm: 80,
            enabled: true,
          }),
        });
        expect(registered.ok, await registered.clone().text()).toBe(true);
      }

      // A PC may only claim notes while it holds its live event connection, as the app does.
      sockets.push(
        ...(await Promise.all(
          ['pc-a', 'pc-b'].map(
            (deviceId) =>
              new Promise<WebSocket>((resolve, reject) => {
                const socket = new WebSocket(
                  `${endpoint.replace(/^http/u, 'ws')}/v1/events/${event.id}/stream?deviceId=${deviceId}&after=0`,
                  { headers: { 'X-GTRZ-Key': key, 'X-GTRZ-Device-Id': deviceId } },
                );
                socket.once('open', () => {
                  resolve(socket);
                });
                socket.once('error', reject);
              }),
          ),
        )),
      );

      // Three phones sell at the same moment; one of them repeats its request (bad network).
      const sales = ['Joao', 'Maria', 'Pedro'].flatMap((name) =>
        [1, 2].map((n) => ({ name, saleId: randomUUID(), commandId: randomUUID(), n })),
      );
      const send = (sale: (typeof sales)[number]): Promise<Response> =>
        call(`/v1/events/${event.id}/cashier/sales`, {
          method: 'POST',
          headers: {
            'X-GTRZ-Cashier-Device': `mobile:${sale.name}:device`,
            'X-GTRZ-Cashier-Label': `Mobile ${sale.name}`,
          },
          body: JSON.stringify({
            commandId: sale.commandId,
            saleId: sale.saleId,
            items: [{ productId: product.id, itemKind: 'product', quantity: 1 }],
            servicePointId: table.id,
            paymentMethod: 'pix',
            receivedCents: null,
          }),
        });
      const responses = await Promise.all([...sales.map(send), send(sales[0] as never)]);
      for (const response of responses) {
        expect(response.status, await response.clone().text()).toBe(200);
      }

      // Both PCs drain the queue concurrently.
      const claimed: PrintJob[] = [];
      const drain = async (deviceId: string): Promise<void> => {
        for (;;) {
          const response = await call(`/v1/events/${event.id}/print/claim`, {
            method: 'POST',
            body: JSON.stringify({ deviceId }),
          });
          const payload = (await response.json()) as { job: PrintJob | null };
          const job = payload.job;
          if (job === null) return;
          claimed.push(job);
          const done = await call(`/v1/events/${event.id}/print/complete`, {
            method: 'POST',
            body: JSON.stringify({
              jobId: job.jobId,
              claimToken: job.claimToken,
              deviceId,
              result: 'printed',
            }),
          });
          expect(done.ok).toBe(true);
        }
      };
      await Promise.all([drain('pc-a'), drain('pc-b')]);

      expect(claimed).toHaveLength(sales.length);
      expect(new Set(claimed.map((job) => job.jobId)).size).toBe(sales.length);
      expect(new Set(claimed.map((job) => job.document.orderId))).toEqual(
        new Set(sales.map((sale) => sale.saleId)),
      );
      const codes = claimed.map((job) => job.document.referenceCode);
      expect(new Set(codes).size).toBe(sales.length);
      expect(codes.every((code) => /-\d{4}$/u.test(code))).toBe(true);
      expect(new Set(claimed.map((job) => job.document.operatorName))).toEqual(
        new Set(['Mobile Joao', 'Mobile Maria', 'Mobile Pedro']),
      );

      const jobs = (await (await call(`/v1/events/${event.id}/print/jobs`)).json()) as {
        jobs: { status: string }[];
      };
      expect(jobs.jobs).toHaveLength(sales.length);
      expect(jobs.jobs.every((job) => job.status === 'printed')).toBe(true);
    } finally {
      for (const socket of sockets) socket.close();
      service.stop();
      pc.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
