export const CANONICAL_PRODUCTION_ENDPOINT =
  'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback';

/** Data APIs have one authority; relay sockets retain their transport-only route. */
export function canonicalDataRequest(request: Request, testEnvironment: boolean): Request | null {
  const url = new URL(request.url);
  const pathname = url.pathname.startsWith('/cashier/api/v1/')
    ? url.pathname.slice('/cashier/api'.length)
    : url.pathname;
  if (
    testEnvironment ||
    !pathname.startsWith('/v1/') ||
    pathname.startsWith('/v1/internal/') ||
    request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  ) {
    return null;
  }
  const target = new URL(CANONICAL_PRODUCTION_ENDPOINT + pathname);
  target.search = url.search;
  return new Request(target, request);
}

/** Bound mobile requests through the response body; a timeout never retries a sale. */
export async function fetchCanonicalData(
  request: Request,
  fetcher: (request: Request) => Promise<Response> = fetch,
  timeoutMs = 12_000,
): Promise<Response> {
  if (!new URL(request.url).pathname.includes('/v1/mobile/')) return fetcher(request);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('MOBILE_UPSTREAM_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const upstream = await fetcher(new Request(request, { signal: controller.signal }));
        const body = await upstream.arrayBuffer();
        const headers = new Headers(upstream.headers);
        headers.delete('Content-Length');
        headers.set('Cache-Control', 'no-store');
        return new Response([204, 205, 304].includes(upstream.status) ? null : body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      })(),
      timeout,
    ]);
  } catch {
    const timedOut = controller.signal.aborted;
    return Response.json(
      {
        error: {
          code: timedOut ? 'MOBILE_UPSTREAM_TIMEOUT' : 'MOBILE_UPSTREAM_UNAVAILABLE',
          message:
            'A central não confirmou a operação. Preserve a venda pendente e tente consultar novamente.',
        },
      },
      { status: timedOut ? 504 : 502, headers: { 'Cache-Control': 'no-store' } },
    );
  } finally {
    clearTimeout(timer);
  }
}
