import vm from 'node:vm';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';

const cashierSource = readFileSync('apps/cloud-sync/src/cashier-client.ts', 'utf8');
const cashierClientScript = cashierSource.slice(
  cashierSource.indexOf('String.raw`') + 'String.raw`'.length,
  cashierSource.lastIndexOf('`;'),
);

interface SentFrame {
  topic: string;
  event: string;
  ref: string;
}

class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 1;
  sent: SentFrame[] = [];
  onopen: () => void = () => undefined;
  onclose: () => void = () => undefined;
  onmessage: (event: { data: string }) => void = () => undefined;
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose();
  });
  constructor() {
    Socket.sockets.push(this);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SentFrame);
  }
  reply(message: unknown): void {
    this.onmessage({ data: JSON.stringify(message) });
  }
}

interface RealtimeClient {
  openRealtime: (generation: number, streamGeneration: number) => Promise<void>;
  stopStreams: () => void;
  state: Record<string, unknown>;
  intervals: Map<number, () => void>;
  timeouts: Map<number, () => void>;
  refresh: Mock<() => Promise<void>>;
  online: Mock;
  sockets: Socket[];
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('Expected at least one item.');
  return item;
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1);
  if (item === undefined) throw new Error('Expected at least one item.');
  return item;
}

function client(): RealtimeClient {
  Socket.sockets.length = 0;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  let id = 0;
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
    const socket = first(c.sockets);
    socket.onopen();
    const tick = first([...c.intervals.values()]);
    tick();
    const beat = last(socket.sent);
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
    expect(last(socket.sent).ref).not.toBe(beat.ref);
  });
  it('reconnects when a heartbeat is not acknowledged and clears its timer', async () => {
    const c = client();
    await c.openRealtime(1, 1);
    const socket = first(c.sockets);
    socket.onopen();
    const tick = first([...c.intervals.values()]);
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
    const socket = first(c.sockets);
    socket.onopen();
    socket.reply({ event: 'phx_reply', ref: '1', payload: { status: 'ok' } });
    expect(c.refresh).toHaveBeenCalledOnce();
    expect(c.online).not.toHaveBeenCalled();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(c.online).toHaveBeenCalledWith(true, 'Conectado');
    });
  });
  it('cleans up timers on logout and ignores a stale socket close', async () => {
    const c = client();
    await c.openRealtime(1, 1);
    const socket = first(c.sockets);
    socket.onopen();
    c.stopStreams();
    expect(c.intervals.size).toBe(0);
    expect(c.timeouts.size).toBe(0);
    expect(c.online).not.toHaveBeenCalled();
  });
});
