import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  openDatabase,
  createEvent,
  createProductCategory,
  createInventoryProduct,
  recordStockMovement,
  createServicePoint,
  type DatabaseContext,
} from '@gtrz/database';
import { LocalMobileHub } from '../../apps/desktop/src/main/local-mobile-hub';
const directories: string[] = [];
const databases: DatabaseContext[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gtrz-lan-'));
  directories.push(dir);
  const db = openDatabase(path.join(dir, 'db.sqlite'));
  databases.push(db);
  const event = createEvent(db, { name: 'Offline', startsAt: Date.now() });
  const category = createProductCategory(db, 'Teste');
  const product = createInventoryProduct(db, {
    categoryId: category.id,
    name: 'Água',
    kind: 'drink',
    costCents: 100,
    salePriceCents: 500,
    lowStockThreshold: 0,
  });
  recordStockMovement(db, { productId: product.id, type: 'purchase', quantity: 1 });
  const point = createServicePoint(db, { label: 'Mesa 1', type: 'table' });
  const authenticate = vi.fn(() =>
    Promise.resolve({
      token: 'cloud-token-not-saved',
      eventId: event.id,
      operator: {
        id: 'operator',
        name: 'Caixa',
        permissions: {
          sales: true,
          inventory: false,
          tickets: false,
          expenses: false,
          vouchers: false,
        },
      },
    }),
  );
  const print = vi.fn();
  let hub = new LocalMobileHub(() => db, authenticate, print);
  const login = await hub.handle(
    new Request('http://192.168.1.2:3210/cashier/api/v1/mobile/session', {
      method: 'POST',
      body: JSON.stringify({ password: 'test-password', deviceId: 'phone' }),
    }),
  );
  const session = (await login.json()) as { token: string };
  expect(login.status).toBe(200);
  const sale = () => ({
    commandId: randomUUID(),
    saleId: randomUUID(),
    servicePointId: point.id,
    items: [{ productId: product.id, itemKind: 'product', quantity: 1 }],
    paymentMethod: 'cash',
    receivedCents: 500,
  });
  const request = (payload: unknown) =>
    hub.handle(
      new Request('http://192.168.1.2:3210/cashier/api/v1/mobile/sales', {
        method: 'POST',
        headers: { 'X-GTRZ-Session': session.token },
        body: JSON.stringify(payload),
      }),
    );
  return {
    db,
    authenticate,
    print,
    sale,
    request,
    restart: () => {
      hub = new LocalMobileHub(() => db, authenticate, print);
    },
    session,
  };
}
describe('LAN operation without WAN', () => {
  it('sells with the cloud unavailable, keeps one ID through the outbox, and handles a lost response/restart without duplicate sale or print', async () => {
    const c = await setup();
    c.authenticate.mockRejectedValue(new Error('internet disconnected'));
    const payload = c.sale();
    const first = await c.request(payload);
    expect(first.status).toBe(200);
    c.restart();
    const retry = await c.request(payload);
    expect(retry.status).toBe(200);
    expect(c.db.sqlite.prepare('select count(*) n from orders').get()).toEqual({ n: 1 });
    expect(c.db.sqlite.prepare('select count(*) n from payments').get()).toEqual({ n: 1 });
    expect(c.db.sqlite.prepare('select quantity from event_stock').get()).toEqual({ quantity: 0 });
    expect(
      c.db.sqlite
        .prepare('select operation_id,status from sync_outbox where operation_id=?')
        .get(payload.commandId),
    ).toEqual({ operation_id: payload.commandId, status: 'pending' });
    expect(c.print).toHaveBeenCalledOnce();
    expect(c.authenticate).toHaveBeenCalledOnce();
  });
  it('refuses overselling the last unit and rolls back the losing order', async () => {
    const c = await setup();
    const results = await Promise.all([c.request(c.sale()), c.request(c.sale())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(c.db.sqlite.prepare('select count(*) n from orders').get()).toEqual({ n: 1 });
    expect(c.db.sqlite.pragma('foreign_key_check')).toHaveLength(0);
  });
  it('rejects reusing an operation ID with a changed payload', async () => {
    const c = await setup();
    const payload = c.sale();
    expect((await c.request(payload)).status).toBe(200);
    expect((await c.request({ ...payload, receivedCents: 1000 })).status).toBe(409);
  });
  it('does not let an expired local lease authorize a sale', async () => {
    const c = await setup();
    c.db.sqlite.exec('update lan_sessions set expires_at=0');
    expect((await c.request(c.sale())).status).toBe(401);
    expect(c.db.sqlite.prepare('select count(*) n from orders').get()).toEqual({ n: 0 });
  });
});
