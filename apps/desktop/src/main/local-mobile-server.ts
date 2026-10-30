import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { LocalMobileHub } from './local-mobile-hub';
import type { DatabaseContext } from '@gtrz/database';

function privateAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '');
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip) ||
    /^fe80:/i.test(ip)
  );
}
export async function startLocalMobileServer(options: {
  getDatabase: () => DatabaseContext;
  htmlPath: string;
  port: number;
  onSale: (id: string) => void;
  cloudFetch?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<Server> {
  const html = await readFile(options.htmlPath, 'utf8');
  const hub = new LocalMobileHub(
    options.getDatabase,
    async (input) => {
      const response = await (options.cloudFetch ?? globalThis.fetch)(
        'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback/v1/mobile/session',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok)
        throw new Error(
          'O primeiro vínculo do celular exige internet e uma senha de operador válida.',
        );
      return response.json() as Promise<unknown>;
    },
    options.onSale,
  );
  const attempts = new Map<string, { count: number; until: number }>();
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const remote = incoming.socket.remoteAddress ?? '';
      const host = incoming.headers.host ?? '';
      const url = new URL(incoming.url ?? '/', `http://${host}`);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (!privateAddress(remote) || (!isIP(hostname) && hostname !== 'localhost')) {
        outgoing.writeHead(403);
        outgoing.end();
        return;
      }
      if (incoming.method === 'GET' && (url.pathname === '/' || url.pathname === '/cashier')) {
        outgoing.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        outgoing.end(html);
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/health') {
        outgoing.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        outgoing.end(JSON.stringify({ status: 'ok', source: 'local-pc' }));
        return;
      }
      if (incoming.method === 'POST' && url.pathname.endsWith('/v1/mobile/session')) {
        let counter = attempts.get(remote);
        if (!counter || Date.now() > counter.until) {
          counter = { count: 0, until: Date.now() + 60000 };
          attempts.set(remote, counter);
        }
        if (++counter.count > 5) {
          outgoing.writeHead(429);
          outgoing.end();
          return;
        }
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        const buffer = Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > 65536) throw new Error('Requisição excede 64 KiB.');
        chunks.push(buffer);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(key, value);
      }
      const method = incoming.method ?? 'GET';
      const response = await hub.handle(
        new Request(url, {
          method,
          headers,
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(503);
      outgoing.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
