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
  timeoutMs?: number,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (!pathname.includes('/v1/mobile/')) return fetcher(request);
  const catalogResponse = /\/mobile\/(refresh|catalog)$/.test(pathname);
  // Mutations may wait on the event row lock while desktops sync. Keep their
  // deadline longer than reads, but return sale status promptly for recovery.
  const saleRequest = pathname.endsWith('/mobile/sales');
  const statusRequest = pathname.endsWith('/mobile/sales/status');
  const mutationRequest = request.method !== 'GET';
  const deadline =
    timeoutMs ??
    (saleRequest
      ? 45_000
      : statusRequest
        ? 12_000
        : catalogResponse
          ? 30_000
          : mutationRequest
            ? 30_000
            : 12_000);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('MOBILE_UPSTREAM_TIMEOUT'));
    }, deadline);
  });
  try {
    return await Promise.race([
      (async () => {
        const upstream = await fetcher(new Request(request, { signal: controller.signal }));
        const headers = new Headers(upstream.headers);
        headers.delete('Content-Length');
        headers.set('Cache-Control', 'no-store');
        if (catalogResponse && upstream.ok) {
          const data: unknown = await upstream.json();
          if (typeof data !== 'object' || data === null) throw new Error('INVALID_MOBILE_CATALOG');
          const payload = data as Record<string, unknown>;
          const catalog = pathname.endsWith('/refresh') ? payload.catalog : payload;
          if (typeof catalog === 'object' && catalog !== null && 'products' in catalog) {
            const products = catalog.products;
            if (Array.isArray(products)) {
              catalog.products = products.map((product: unknown) => {
                if (typeof product !== 'object' || product === null) return product;
                const compact: Record<string, unknown> = { ...product };
                delete compact.imageDataUrl;
                return compact;
              });
            }
          }
          headers.delete('Content-Encoding');
          return Response.json(payload, { status: upstream.status, headers });
        }
        const body = await upstream.arrayBuffer();
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
