const CANONICAL_PRODUCTION_ENDPOINT =
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
