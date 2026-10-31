import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cashierClientScript = readFileSync('apps/cloud-sync/src/cashier-client.ts', 'utf8').replace(
  /\r\n/g,
  '\n',
);

const functions = [
  'pendingSaleKey',
  'restorePendingSale',
  'savePendingSale',
  'clearPendingSale',
  'saleAccepted',
  'finishSale',
  'charge',
];

interface SaleClient {
  charge: () => Promise<void>;
  restorePendingSale: () => void;
  storage: Map<string, string>;
  notices: string[];
}

function saleClient(
  api: (path: string, options?: { body?: string }) => Promise<unknown>,
  storage = new Map<string, string>(),
  online = true,
): SaleClient {
  let nextId = 0;
  const notices: string[] = [];
  const state = {
    cart: new Map([['product:drink', { productId: 'drink', itemKind: 'product', quantity: 1 }]]),
    online: true,
    operator: { id: 'operator' },
    eventId: 'event',
    servicePointId: 'table',
    method: 'cash',
    cashReceived: '',
    voucherCode: '',
    voucherAmount: '',
    saleSubmitting: false,
    pendingSale: null,
  };
  const context = {
    state,
    api,
    amount: () => 1000,
    saleVoucher: () => null,
    voucherUseCents: () => 0,
    parseMoney: () => 0,
    uuid: () => `id-${String(++nextId)}`,
    device: () => 'device',
    obj: (value: unknown) => value !== null && typeof value === 'object',
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    drawSales: () => undefined,
    show: (title: string) => notices.push(title),
    money: (value: number) => String(value),
    load: () => Promise.resolve(),
    document: { querySelector: () => null },
    navigator: { onLine: online },
    encodeURIComponent,
    JSON,
  };
  const source = functions.map((name) => {
    const line =
      name === 'charge'
        ? cashierClientScript.slice(
            cashierClientScript.indexOf('async function charge()'),
            cashierClientScript.indexOf(
              '\n}\n',
              cashierClientScript.indexOf('async function charge()'),
            ) + 2,
          )
        : cashierClientScript
            .split('\n')
            .find(
              (entry) =>
                entry.startsWith(`function ${name}(`) ||
                entry.startsWith(`async function ${name}(`),
            );
    if (!line) throw new Error(`Missing mobile function ${name}`);
    return line;
  });
  vm.runInNewContext(
    `${source.join('\n')}\nglobalThis.saleTest={charge,restorePendingSale};`,
    context,
  );
  return {
    ...(
      context as typeof context & {
        saleTest: { charge: () => Promise<void>; restorePendingSale: () => void };
      }
    ).saleTest,
    storage,
    notices,
  };
}

describe('mobile sale uncertainty', () => {
  it('ends a stalled mobile request without claiming the sale succeeded', async () => {
    const apiSource = cashierClientScript
      .split('\n')
      .find((line) => line.startsWith('async function api('));
    expect(apiSource).toBeDefined();
    const context = {
      Headers,
      AbortController,
      canonicalEndpoint: 'https://example.test/cashier/api',
      sessionToken: () => null,
      fetch: (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimeout: () => undefined,
    };
    vm.runInNewContext(`${apiSource ?? ''}\nglobalThis.testApi=api;`, context);
    await expect(
      (context as typeof context & { testApi: (path: string) => Promise<unknown> }).testApi(
        '/v1/mobile/sales',
      ),
    ).rejects.toThrow('A central demorou para responder');
  });

  it('parses the complete embedded cashier script', () => {
    const start = cashierClientScript.indexOf('String.raw`') + 'String.raw`'.length;
    const end = cashierClientScript.lastIndexOf('`;');
    expect(start).toBeGreaterThan('String.raw`'.length);
    expect(end).toBeGreaterThan(start);
    expect(() => new vm.Script(cashierClientScript.slice(start, end))).not.toThrow();
  });

  it('reuses one command after a lost response instead of creating another sale', async () => {
    const posts: string[] = [];
    let attempt = 0;
    const client = saleClient((path, options) => {
      if (path.includes('/status')) return Promise.resolve({ accepted: false });
      posts.push(options?.body ?? '');
      if (++attempt === 1) throw new Error('network lost after commit');
      return Promise.resolve({ status: 'replayed' });
    });

    await client.charge();
    expect(client.notices).toContain('Venda aguardando confirmação');
    expect(client.storage.size).toBe(1);
    await client.charge();
    expect(posts).toHaveLength(2);
    expect(posts[0]).toBe(posts[1]);
    expect(client.storage.size).toBe(0);
    expect(client.notices).toContain('Venda confirmada');
  });

  it('recovers a saved sale after reopening and checks the central before resending', async () => {
    let posts = 0;
    const storage = new Map<string, string>([
      [
        'gtrz-mobile-pending-sale:device',
        JSON.stringify({
          eventId: 'event',
          operatorId: 'operator',
          totalCents: 1000,
          payload: { commandId: 'existing', saleId: 'sale', items: [] },
        }),
      ],
    ]);
    const client = saleClient((path) => {
      if (path.includes('/status')) return Promise.resolve({ accepted: true });
      posts++;
      return Promise.resolve({});
    }, storage);

    client.restorePendingSale();
    await client.charge();
    expect(posts).toBe(0);
    expect(storage.size).toBe(0);
    expect(client.notices).toContain('Venda confirmada');
  });

  it('does not submit a pending sale into a different event', async () => {
    let requests = 0;
    const storage = new Map<string, string>([
      [
        'gtrz-mobile-pending-sale:device',
        JSON.stringify({
          eventId: 'previous-event',
          operatorId: 'operator',
          totalCents: 1000,
          payload: { commandId: 'existing', saleId: 'sale', items: [] },
        }),
      ],
    ]);
    const client = saleClient(() => {
      requests++;
      return Promise.resolve({});
    }, storage);

    client.restorePendingSale();
    await client.charge();
    expect(requests).toBe(0);
    expect(storage.size).toBe(1);
    expect(client.notices).toContain('Venda pendente em outro contexto');
  });

  it('does not claim to sell offline when the phone has no network', async () => {
    let requests = 0;
    const client = saleClient(
      () => {
        requests++;
        return Promise.resolve({});
      },
      new Map(),
      false,
    );

    await client.charge();
    expect(requests).toBe(0);
    expect(client.storage.size).toBe(0);
  });

  it('releases a confirmed rejection without pretending the sale succeeded', async () => {
    const client = saleClient((path) => {
      if (path.includes('/status')) return Promise.resolve({ accepted: false });
      return Promise.reject(Object.assign(new Error('Estoque insuficiente'), { status: 409 }));
    });

    await client.charge();
    expect(client.storage.size).toBe(0);
    expect(client.notices).toContain('Venda recusada');
  });
});
