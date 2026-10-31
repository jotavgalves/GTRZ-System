import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('apps/cloud-sync/src/canonical-data.ts', 'utf8');
const exported: {
  fetchCanonicalData?: (
    request: Request,
    fetcher: (request: Request) => Promise<Response>,
    timeoutMs?: number,
  ) => Promise<Response>;
} = {};
vm.runInNewContext(
  transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
  { exports: exported, Request, Response, Headers, URL, AbortController, setTimeout, clearTimeout },
);
const proxy = exported.fetchCanonicalData;
if (!proxy) throw new Error('Canonical proxy export missing');
const endpoint = 'https://example.test/functions/v1/gtrz-sync-fallback/v1/mobile/sales';

describe('mobile canonical proxy', () => {
  it.each(['headers', 'body'])(
    'returns 504 when the upstream stalls at %s without retrying',
    async (stage) => {
      const never = new Promise<never>(() => undefined);
      const fetcher = vi.fn(() =>
        stage === 'headers'
          ? never
          : Promise.resolve(new Response(new ReadableStream({ start: () => undefined }))),
      );
      const response = await proxy(new Request(endpoint), fetcher, 5);
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ error: { code: 'MOBILE_UPSTREAM_TIMEOUT' } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the command body, session, and upstream status in one request', async () => {
    const body = JSON.stringify({ commandId: 'same-command', saleId: 'same-sale' });
    let forwarded = '';
    const fetcher = vi.fn(async (request: Request) => {
      forwarded = await request.text();
      expect(request.headers.get('X-GTRZ-Session')).toBe('test-session');
      return Response.json({ error: { code: 'QUOTA' } }, { status: 402 });
    });
    const response = await proxy(
      new Request(endpoint, {
        method: 'POST',
        headers: { 'X-GTRZ-Session': 'test-session' },
        body,
      }),
      fetcher,
    );
    expect(forwarded).toBe(body);
    expect(response.status).toBe(402);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
