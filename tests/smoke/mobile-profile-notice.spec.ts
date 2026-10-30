import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSyncService } from '../../apps/desktop/src/main/cloud-sync-service';

// No real credentials, sockets or cloud requests: every call is answered here.
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn((): Promise<string> => Promise.resolve('notice-temporary-directory')),
  readFile: vi.fn(
    (path: string): Promise<string> =>
      Promise.resolve(path === 'notice-key' ? 'isolated-notice-key' : 'notice-pc'),
  ),
  rm: vi.fn((): Promise<void> => Promise.resolve()),
  writeFile: vi.fn((): Promise<void> => Promise.resolve()),
}));

const permissions = {
  sales: true,
  inventory: false,
  tickets: true,
  expenses: false,
  vouchers: false,
};
const operator = {
  id: '4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10',
  name: 'Maria',
  permissions,
  active: true,
  createdAt: 1,
  updatedAt: 2,
  lastSeenAt: null,
  sessionCount: 1,
};
const session = {
  access_token: 'a.b.c',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'refresh',
  user: {
    id: 'owner',
    email: 'owner@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  },
};

let service: CloudSyncService;
let calls: string[];

function answer(url: string | URL | Request, init?: RequestInit): Response {
  const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
  if (target.pathname.endsWith('/auth/v1/token')) return Response.json(session);
  if (target.pathname.endsWith('/v1/owner/me')) return Response.json({ ok: true });
  calls.push(`${init?.method ?? 'GET'} ${target.pathname}`);
  if (target.pathname.endsWith('/realtime-ping')) return Response.json({ accepted: true });
  return Response.json(operator);
}

beforeEach(async () => {
  calls = [];
  service = new CloudSyncService(
    'notice-key',
    'notice-device',
    (): void => undefined,
    'https://notice.invalid',
  );
  vi.stubGlobal('fetch', vi.fn(answer));
  await service.signInOwner('owner@example.com', 'password');
});

afterEach(() => {
  service.stop();
  vi.unstubAllGlobals();
});

describe('mobile profile notices', () => {
  it('asks the central to tell the phones right after a permission changes', async () => {
    await service.updateMobileOperator({
      operatorId: '4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10',
      permissions: { ...permissions, inventory: true },
    });
    expect(calls).toEqual([
      'PATCH /v1/mobile/operators/4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10',
      'POST /v1/monitor/realtime-ping',
    ]);
  });

  it('warns the phones before the sessions of a deactivated profile are ended', async () => {
    await service.updateMobileOperator({
      operatorId: '4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10',
      active: false,
    });
    expect(calls).toEqual([
      'POST /v1/monitor/realtime-ping',
      'PATCH /v1/mobile/operators/4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10',
      'POST /v1/monitor/realtime-ping',
    ]);
  });

  it('warns the phones before ending the sessions of a profile', async () => {
    await service.endMobileOperatorSessions({
      operatorId: '4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10',
      reason: 'password-required',
    });
    expect(calls).toEqual([
      'POST /v1/monitor/realtime-ping',
      'POST /v1/mobile/operators/4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10/sessions',
    ]);
  });

  it('still reports a successful change when the notice cannot be delivered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit): Response => {
        if (typeof url === 'string' && url.includes('realtime-ping')) throw new Error('offline');
        return answer(url, init);
      }),
    );
    await expect(
      service.updateMobileOperator({
        operatorId: '4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10',
        permissions: { ...permissions, vouchers: true },
      }),
    ).resolves.toMatchObject({ id: '4f1f1d0e-8b3a-4f2e-9d4c-2b7c5a6e9f10' });
  });
});
