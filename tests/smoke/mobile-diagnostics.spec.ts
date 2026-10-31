import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { mobileDiagnosticsPage } from '../../apps/cloud-sync/src/mobile-diagnostics-page';

describe('read-only mobile diagnostics', () => {
  it('renders a no-store page with a valid script and no storage mutation', async () => {
    const response = mobileDiagnosticsPage();
    const html = await response.text();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const script = html.split('<script>')[1]?.split('</script>')[0];
    if (!script) throw new Error('Diagnostics script missing');
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).not.toContain('localStorage.removeItem');
    expect(script).not.toContain('localStorage.setItem');
    expect(script).not.toContain("method:'POST'");
    expect(script).toContain('/v1/mobile/sales/status?');
  });

  it('reads one saved attempt without exposing its session or posting a sale', async () => {
    const html = await mobileDiagnosticsPage().text();
    const script = html.split('<script>')[1]?.split('</script>')[0];
    if (!script) throw new Error('Diagnostics script missing');
    const output = { value: '' };
    const saved = new Map([
      ['gtrz-mobile-device', 'device'],
      ['gtrz-mobile-session:canonical-v1', 'private-session'],
      [
        'gtrz-mobile-pending-sale:device',
        JSON.stringify({
          eventId: 'event',
          payload: { commandId: 'command', saleId: 'sale' },
        }),
      ],
    ]);
    let requests = 0;
    await vm.runInNewContext(script, {
      document: { getElementById: () => output },
      navigator: { onLine: true },
      localStorage: { getItem: (key: string) => saved.get(key) ?? null },
      AbortController,
      Date,
      setTimeout,
      clearTimeout,
      encodeURIComponent,
      fetch: (url: string, options: RequestInit) => {
        requests++;
        expect(url).toContain('commandId=command&saleId=sale');
        expect(options.method).toBeUndefined();
        return Promise.resolve(Response.json({ accepted: true }));
      },
    });
    expect(requests).toBe(1);
    expect(output.value).toContain('"accepted":true');
    expect(output.value).not.toContain('private-session');
    expect(saved.size).toBe(3);
  });
});
