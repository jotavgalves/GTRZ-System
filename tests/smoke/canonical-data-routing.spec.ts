import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ModuleKind, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
const source = readFileSync('apps/cloud-sync/src/canonical-data.ts', 'utf8');
const exported: { canonicalDataRequest?: (request: Request, test: boolean) => Request | null } = {};
vm.runInNewContext(
  transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
  { exports: exported, Request, URL },
);
function route(request: Request, test: boolean): Request | null {
  if (exported.canonicalDataRequest === undefined) {
    throw new Error('canonicalDataRequest was not exported.');
  }
  return exported.canonicalDataRequest(request, test);
}
function routed(request: Request): Request {
  const target = route(request, false);
  if (target === null) throw new Error('The request was not routed to the canonical database.');
  return target;
}

describe('canonical production data routing', () => {
  it.each([
    '/v1/mobile/refresh',
    '/v1/events/event/snapshot?after=201',
    '/v1/monitor/global-control?after=47',
    '/cashier/api/v1/mobile/refresh',
  ])('uses the app production database for %s', (path) => {
    const target = routed(new Request('https://worker.example' + path));
    expect(target.url).toBe(
      'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback' +
        path.replace('/cashier/api', ''),
    );
  });
  it('preserves the sale payload, session and idempotency command without rewriting it', async () => {
    const body = JSON.stringify({ commandId: 'stable-command', saleId: 'stable-sale' });
    const target = routed(
      new Request('https://worker.example/cashier/api/v1/mobile/sales', {
        method: 'POST',
        headers: { 'X-GTRZ-Session': 'test-session', 'Content-Type': 'application/json' },
        body,
      }),
    );
    expect(target.method).toBe('POST');
    expect(target.headers.get('X-GTRZ-Session')).toBe('test-session');
    expect(await target.text()).toBe(body);
  });
  it('never forwards the test environment to production', () => {
    expect(
      route(new Request('https://test.example/cashier/api/v1/mobile/refresh'), true),
    ).toBeNull();
    expect(route(new Request('https://test.example/v1/events/event/snapshot'), true)).toBeNull();
  });
  it('keeps internal relay, socket and static routes outside the data proxy', () => {
    expect(
      route(
        new Request('https://worker.example/v1/internal/events/event/relay', { method: 'POST' }),
        false,
      ),
    ).toBeNull();
    expect(
      route(
        new Request('https://worker.example/v1/mobile/stream', {
          headers: { Upgrade: 'websocket' },
        }),
        false,
      ),
    ).toBeNull();
    expect(route(new Request('https://worker.example/cashier'), false)).toBeNull();
  });
});
