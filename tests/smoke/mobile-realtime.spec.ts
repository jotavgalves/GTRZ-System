import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const cashierSource = readFileSync('apps/cloud-sync/src/cashier-client.ts', 'utf8');
const cashierClientScript = cashierSource.slice(
  cashierSource.indexOf('String.raw`') + 'String.raw`'.length,
  cashierSource.lastIndexOf('`;'),
);

function client() {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let id = 0;
  class Socket {
    static OPEN = 1;
    static sockets: Socket[] = [];
    readyState = 1;
    sent: { topic: string; event: string; ref: string }[] = [];
    onopen = () => undefined;
    onclose = () => undefined;
    onmessage = (_event: { data: string }) => undefined;
    close = vi.fn(() => {
      this.readyState = 3;
      this.onclose();
    });
    constructor() {
      Socket.sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    reply(message: unknown) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
  const state = {
    generation: 1,
    streamGeneration: 1,
    realtimeSocket: null as Socket | null,
    heartbeatTimer: null,
    reconnectTimer: null,
    sessionRefreshTimer: null,
    realtimeRefreshInFlight: false,
  };
  const refresh = vi.fn(() => Promise.resolve());
  const online = vi.fn();
  const context = {
    state,
    WebSocket: Socket,
    api: vi.fn(() => Promise.resolve({ topic: 'event:test' })),
    canonicalRealtimeEndpoint: 'wss://example.test',
    refreshSessionAndData: refresh,
    online,
    obj: (v: unknown) => v !== null && typeof v === 'object',
    applyRealtimeSnapshot: vi.fn(),
    setInterval: (fn: () => void) => {
      intervals.set(++id, fn);
      return id;
    },
    clearInterval: (key: number) => intervals.delete(key),
    setTimeout: (fn: () => void) => {
      timeouts.set(++id, fn);
      return id;
    },
    clearTimeout: (key: number) => timeouts.delete(key),
  };
  const names = ['stopStreams', 'reconnect', 'refreshRealtimeData', 'openRealtime'];
  const source = cashierClientScript
    .split('\n')
    .filter((line) =>
      names.some(
        (name) =>
          line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`),
      ),
    )
    .join('\n');
  const api = vm.runInNewContext(`${source}\n({openRealtime,stopStreams})`, context) as {
    openRealtime: (generation: number, streamGeneration: number) => Promise<void>;
    stopStreams: () => void;
  };
  return { ...api, state, intervals, timeouts, refresh, online, sockets: Socket.sockets };
}

describe('mobile realtime recovery', () => {
  it('sends Phoenix heartbeats and accepts their replies without refreshing sales data', async () => {
    const c = client();
    await c.openRealtime(1, 1);
    const socket = c.sockets[0]!;
    socket.onopen();
    const tick = [...c.intervals.values()][0]!;
    tick();
    const beat = socket.sent.at(-1)!;
    expect(beat).toMatchObject({ topic: 'phoenix', event: 'heartbeat' });
    socket.reply({
      topic: 'phoenix',
      event: 'phx_reply',
      ref: beat.ref,
      payload: { status: 'ok' },
    });
    tick();
    expect(socket.close).not.toHaveBeenCalled();
    expect(c.refresh).not.toHaveBeenCalled();
    expect(socket.sent.at(-1)!.ref).not.toBe(beat.ref);
  });
  it('reconnects when a heartbeat is not acknowledged and clears its timer', async () => {
    const c = client();
    await c.openRealtime(1, 1);
    const socket = c.sockets[0]!;
    socket.onopen();
    const tick = [...c.intervals.values()][0]!;
    tick();
    tick();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(c.intervals.size).toBe(0);
    expect(c.timeouts.size).toBe(1);
    expect(c.online).toHaveBeenCalledWith(false, 'Reconectando');
  });
  it('refreshes canonical data before reporting the reconnected session online', async () => {
    const c = client();
    let resolve!: () => void;
    c.refresh.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await c.openRealtime(1, 1);
    const socket = c.sockets[0]!;
    socket.onopen();
    socket.reply({ event: 'phx_reply', ref: '1', payload: { status: 'ok' } });
    expect(c.refresh).toHaveBeenCalledOnce();
    expect(c.online).not.toHaveBeenCalled();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(c.online).toHaveBeenCalledWith(true, 'Conectado'));
  });
  it('cleans up timers on logout and ignores a stale socket close', async () => {
    const c = client();
    await c.openRealtime(1, 1);
    const socket = c.sockets[0]!;
    socket.onopen();
    c.stopStreams();
    expect(c.intervals.size).toBe(0);
    expect(c.timeouts.size).toBe(0);
    expect(c.online).not.toHaveBeenCalled();
  });
});
