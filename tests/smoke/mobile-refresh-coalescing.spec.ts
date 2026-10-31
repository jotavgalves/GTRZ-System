import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('apps/cloud-sync/src/cashier-client.ts', 'utf8');
const functions = source
  .split(/\r?\n/)
  .filter(
    (line) =>
      line.startsWith('function refreshSessionAndData(') ||
      line.startsWith('async function refreshRealtimeData('),
  )
  .join('\n');

describe('mobile refresh coalescing', () => {
  it('folds simultaneous notices into one in-flight and one catch-up request', async () => {
    let release: (value: unknown) => void = () => undefined;
    const firstResponse = new Promise((resolve) => {
      release = resolve;
    });
    const socket = { close: vi.fn() };
    const data = {
      operator: { permissions: { sales: true } },
      eventId: 'event',
      catalog: {},
      context: {},
    };
    const api = vi
      .fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(data);
    const context = {
      state: {
        generation: 1,
        streamGeneration: 1,
        realtimeRefreshInFlight: false,
        realtimeRefreshPending: false,
        realtimeRefreshPromise: null,
        operator: data.operator,
        eventId: 'event',
        realtimeSocket: socket,
      },
      api,
      applyData: vi.fn(),
      online: vi.fn(),
    };
    const run = vm.runInNewContext(`${functions}\nrefreshRealtimeData`, context) as (
      socket: unknown,
    ) => Promise<void>;
    const first = run(socket);
    const second = run(socket);
    release(data);
    await Promise.all([first, second]);
    expect(api).toHaveBeenCalledTimes(2);
    expect(socket.close).not.toHaveBeenCalled();
    expect(context.state.realtimeRefreshInFlight).toBe(false);
  });
});
