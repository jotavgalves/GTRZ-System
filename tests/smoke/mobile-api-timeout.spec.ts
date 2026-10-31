import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('apps/cloud-sync/src/cashier-client.ts', 'utf8');
const apiSource = source.split(/\r?\n/).find((line) => line.startsWith('async function api('));
if (!apiSource) throw new Error('Mobile API function missing');

function client(fetcher: () => Promise<unknown>): {
  api: (path: string) => Promise<unknown>;
  expire: () => void;
} {
  let expire: () => void = () => undefined;
  const context = {
    Headers,
    AbortController,
    canonicalEndpoint: 'https://example.test/cashier/api',
    sessionToken: () => null,
    fetch: fetcher,
    setTimeout: (callback: () => void) => {
      expire = callback;
      return 1;
    },
    clearTimeout: () => undefined,
  };
  vm.runInNewContext(`${apiSource ?? ''}\nglobalThis.testApi=api;`, context);
  return {
    api: (context as typeof context & { testApi: (path: string) => Promise<unknown> }).testApi,
    expire: () => {
      expire();
    },
  };
}

describe('mobile HTTP deadline', () => {
  it.each(['headers', 'body'])('ends a request stuck waiting for %s', async (stage) => {
    const never = new Promise<never>(() => undefined);
    const mobile = client(() =>
      stage === 'headers' ? never : Promise.resolve({ ok: true, json: () => never }),
    );
    const request = mobile.api('/v1/mobile/sales');
    const rejected = expect(request).rejects.toThrow('A central demorou para responder');
    mobile.expire();
    await rejected;
  });

  it('rejects a non-JSON success instead of confirming a sale', async () => {
    const mobile = client(() => Promise.resolve(new Response('<html>unexpected</html>')));
    await expect(mobile.api('/v1/mobile/sales')).rejects.toThrow('confirmação inválida');
  });

  it('preserves an explicit error status for quota failures', async () => {
    const mobile = client(() => Promise.resolve(new Response('quota exceeded', { status: 402 })));
    await expect(mobile.api('/v1/mobile/sales')).rejects.toMatchObject({ status: 402 });
  });
});
