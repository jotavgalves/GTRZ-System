import { createClient } from 'npm:@supabase/supabase-js@2.93.1';

type Obj = Record<string, unknown>;
type Permission = 'sales' | 'inventory' | 'tickets' | 'expenses' | 'vouchers';
type MobileProjection = { catalog: Obj; context: Obj };
type RealtimeDelivery = { mobileRecipients: number; failed: boolean };
const permissionKeys: readonly Permission[] = [
  'sales',
  'inventory',
  'tickets',
  'expenses',
  'vouchers',
];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, x-gtrz-key, x-gtrz-device-id, x-gtrz-session',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  // Chromium honors up to two hours. The first authenticated request warms this cache.
  'Access-Control-Max-Age': '7200',
};
const emptyCatalog = { products: [], currentSequence: 0 };
const emptyContext = {
  ticketLots: [],
  servicePoints: [],
  voucherCodes: [],
  vouchers: [],
  currentSequence: 0,
};
const asObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const ok = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const bad = (status: number, code: string, message: string) =>
  ok({ error: { code, message } }, status);
function string(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max)
    throw new Error(`${field} inválido.`);
  return value.trim();
}
function integer(value: unknown, field: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new Error(`${field} inválido.`);
  return value;
}
function pathOf(request: Request): string {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const index = parts.indexOf('gtrz-sync-fallback');
  return index < 0 ? new URL(request.url).pathname : `/${parts.slice(index + 1).join('/')}`;
}
function secretEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  let result = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) result |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return result === 0;
}
function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function sha(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}
async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          hash: 'SHA-256',
          salt: new TextEncoder().encode(salt),
          iterations: 200_000,
        },
        key,
        256,
      ),
    ),
  );
}
function salt(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}
function permissions(value: unknown): Record<Permission, boolean> {
  if (!asObj(value)) throw new Error('Permissões móveis inválidas.');
  const next = {} as Record<Permission, boolean>;
  for (const key of permissionKeys) {
    if (typeof value[key] !== 'boolean') throw new Error('Permissões móveis inválidas.');
    next[key] = value[key] as boolean;
  }
  return next;
}
function routeToken(request: Request): string | null {
  const direct = request.headers.get('X-GTRZ-Session');
  if (direct) return direct;
  const bearer = request.headers.get('Authorization');
  return bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;
}
function catalogProducts(catalog: Obj): Obj[] {
  return Array.isArray(catalog.products)
    ? catalog.products.filter(asObj).map((item) => ({ ...item }))
    : [];
}
function adjustedCatalog(catalog: Obj, products: Obj[]): Obj {
  return { ...catalog, products };
}

function mobileContext(context: Obj, allowed: Record<Permission, boolean>): Obj {
  return {
    ...context,
    ticketLots: allowed.tickets ? context.ticketLots : [],
    servicePoints: allowed.sales || allowed.vouchers ? context.servicePoints : [],
    voucherCodes: allowed.vouchers ? context.voucherCodes : [],
    vouchers: allowed.sales || allowed.vouchers ? context.vouchers : [],
  };
}
function recalculateCombos(products: Obj[]): void {
  const ids = new Map(products.map((product) => [product.productId, product]));
  for (const combo of products.filter(
    (product) => product.itemKind === 'combo' && product.active !== false,
  )) {
    const parts = Array.isArray(combo.components) ? combo.components.filter(asObj) : [];
    const groups = new Map<string, Obj[]>();
    for (const part of parts)
      if (typeof part.choiceGroup === 'string')
        groups.set(part.choiceGroup, [...(groups.get(part.choiceGroup) ?? []), part]);
    const limits = [
      ...parts
        .filter((part) => !part.choiceGroup)
        .map((part) =>
          Math.floor(Number(ids.get(part.productId)?.quantity ?? 0) / Number(part.quantity ?? 1)),
        ),
      ...[...groups.values()].map((options) =>
        Math.floor(
          options.reduce(
            (sum, option) => sum + Number(ids.get(option.productId)?.quantity ?? 0),
            0,
          ) / Number(options[0]?.quantity ?? 1),
        ),
      ),
    ];
    combo.quantity = limits.length ? Math.max(0, Math.min(...limits)) : 0;
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const path = pathOf(request);
  if (path === '/health' && request.method === 'GET')
    return ok({ status: 'ok', service: 'gtrz-canonical-cloud' });
  const endpoint = Deno.env.get('SUPABASE_URL');
  let serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null;
  if (!serviceKey)
    try {
      serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ?? null;
    } catch {}
  if (!endpoint || !serviceKey)
    return bad(503, 'NOT_CONFIGURED', 'Banco canônico não configurado.');
  const db = createClient(endpoint, serviceKey, { auth: { persistSession: false } });
  const store = db.schema('gtrz');
  const pairingKey = Deno.env.get('GTRZ_FALLBACK_KEY') ?? '';
  const master =
    pairingKey.length > 0 && secretEqual(request.headers.get('X-GTRZ-Key') ?? '', pairingKey);
  const body = async (): Promise<Obj> => {
    const value: unknown = await request.json();
    if (!asObj(value)) throw new Error('O corpo deve ser um objeto JSON.');
    return value;
  };
  const denyAdministrator = () => {
    if (!master)
      throw Object.assign(new Error('Chave de acesso inválida.'), {
        status: 401,
        code: 'UNAUTHORIZED',
      });
  };
  const authorizeDesktop = async (): Promise<string | null> => {
    if (master) return null;
    const deviceId = request.headers.get('X-GTRZ-Device-Id') ?? '';
    const credential = request.headers.get('X-GTRZ-Key') ?? '';
    if (!deviceId || !credential)
      throw Object.assign(new Error('Computador não vinculado.'), {
        status: 401,
        code: 'UNAUTHORIZED',
      });
    const { data, error } = await db.rpc('gtrz_authorize_desktop_device', {
      p_device_id: deviceId,
      p_credential_hash: await sha(credential),
      p_seen_at: Date.now(),
    });
    if (error || !asObj(data) || data.authorized !== true) {
      throw Object.assign(new Error('Computador não autorizado.'), {
        status: 401,
        code: 'UNAUTHORIZED',
      });
    }
    return deviceId;
  };
  const assertDeviceClaim = (actorDeviceId: string | null, claimedDeviceId: string): void => {
    if (actorDeviceId !== null && actorDeviceId !== claimedDeviceId) {
      throw Object.assign(new Error('Um computador não pode operar em nome de outro.'), {
        status: 403,
        code: 'DEVICE_MISMATCH',
      });
    }
  };
  const activeEvent = async (): Promise<Obj | null> => {
    const { data, error } = await db.rpc('gtrz_read_global_control', { p_after: 0 });
    if (error) throw error;
    const commands = asObj(data) && Array.isArray(data.commands) ? data.commands.filter(asObj) : [];
    return commands.at(-1) ?? null;
  };
  const state = async (eventId: string): Promise<Obj> => {
    const { data, error } = await db.rpc('gtrz_read_event_state', { p_event_id: eventId });
    if (error || !asObj(data)) throw error ?? new Error('Estado remoto inválido.');
    return data;
  };
  const mobileRefresh = async (): Promise<Obj> => {
    const raw = routeToken(request);
    if (!raw)
      throw Object.assign(new Error('A sessão móvel foi encerrada.'), {
        status: 401,
        code: 'MOBILE_UNAUTHORIZED',
      });
    const { data, error } = await db.rpc('gtrz_read_mobile_refresh', {
      p_token_hash: await sha(raw),
      p_now: Date.now(),
    });
    if (error || !asObj(data)) throw error ?? new Error('Atualização móvel inválida.');
    if (data.status === 'unauthorized')
      throw Object.assign(new Error('A sessão móvel foi encerrada.'), {
        status: 401,
        code: 'MOBILE_UNAUTHORIZED',
      });
    if (data.status === 'no-active-event')
      throw Object.assign(new Error('Nenhum evento ativo está disponível.'), {
        status: 409,
        code: 'NO_ACTIVE_EVENT',
      });
    if (data.status !== 'ok') throw new Error('Atualização móvel inválida.');
    return data;
  };
  const currentSession = async (): Promise<Obj> => {
    const raw = routeToken(request);
    if (!raw)
      throw Object.assign(new Error('A sessão móvel foi encerrada.'), {
        status: 401,
        code: 'MOBILE_UNAUTHORIZED',
      });
    const { data, error } = await store
      .from('mobile_sessions')
      .select(
        'session_id,operator_id,device_id,expires_at,revoked_at,mobile_operators(operator_id,name,permissions,active,created_at,updated_at)',
      )
      .eq('token_hash', await sha(raw))
      .maybeSingle();
    if (error) throw error;
    const row = data as unknown as Obj | null,
      operator = row && asObj(row.mobile_operators) ? row.mobile_operators : null;
    if (
      !row ||
      !operator ||
      row.revoked_at !== null ||
      Number(row.expires_at) <= Date.now() ||
      operator.active !== true
    )
      throw Object.assign(new Error('A sessão móvel foi encerrada.'), {
        status: 401,
        code: 'MOBILE_UNAUTHORIZED',
      });
    const active = await activeEvent();
    if (!active || typeof active.eventId !== 'string')
      throw Object.assign(new Error('Nenhum evento ativo está disponível.'), {
        status: 409,
        code: 'NO_ACTIVE_EVENT',
      });
    await store
      .from('mobile_sessions')
      .update({ last_seen_at: Date.now() })
      .eq('session_id', row.session_id as string);
    return { operator, deviceId: row.device_id, eventId: active.eventId };
  };
  // The mobile topic is a high-entropy capability derived from the server-only
  // pairing secret. It carries only invalidation signals. A distinct topic,
  // never disclosed to a mobile session, carries committed journal entries to
  // enrolled desktops for an immediate, sequence-checked local apply.
  const realtimeTopic = async (eventId: string): Promise<string> =>
    `gtrz-sync-${await sha(`${pairingKey}:${eventId}:realtime-v1`)}`;
  const mobileRealtimeTopic = async (tokenHash: string): Promise<string> =>
    `gtrz-mobile-${await sha(`${pairingKey}:${tokenHash}:realtime-v2`)}`;
  const desktopRealtimeTopic = async (eventId: string): Promise<string> =>
    `gtrz-desktop-sync-${await sha(`${pairingKey}:${eventId}:desktop-realtime-v1`)}`;
  const notifyRealtime = async (
    eventId: string,
    version: number,
    globalControl = false,
    event: Obj | null = null,
    notifyMobile = true,
    traceId: string | null = null,
    mobileProjection: MobileProjection | null = null,
  ): Promise<RealtimeDelivery> => {
    if (!pairingKey) return { mobileRecipients: 0, failed: true };
    let mobileRecipients = 0;
    try {
      const notifications: Promise<Response>[] = [];
      if (notifyMobile) {
        notifications.push(
          fetch(
            `${endpoint}/realtime/v1/api/broadcast/${encodeURIComponent(await realtimeTopic(eventId))}/events/state-changed`,
            {
              method: 'POST',
              headers: { apikey: serviceKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                eventId,
                version,
                globalControl,
                fastPath: event !== null && !globalControl,
                ...(traceId ? { traceId } : {}),
              }),
            },
          ),
        );
        const { data: sessions, error } = await store
          .from('mobile_sessions')
          .select('token_hash,expires_at,mobile_operators(permissions,active)')
          .is('revoked_at', null)
          .gt('expires_at', Date.now());
        if (error) throw error;
        for (const rawSession of sessions ?? []) {
          const session = rawSession as unknown as Obj,
            relation = session.mobile_operators,
            operator = asObj(relation)
              ? relation
              : Array.isArray(relation)
                ? relation.find(asObj) ?? null
                : null,
            tokenHash = typeof session.token_hash === 'string' ? session.token_hash : null;
          if (!operator || !tokenHash || operator.active !== true) continue;
          const permissions = operator.permissions as Record<Permission, boolean>;
          mobileRecipients += 1;
          notifications.push(
            fetch(
              `${endpoint}/realtime/v1/api/broadcast/${encodeURIComponent(await mobileRealtimeTopic(tokenHash))}/events/state-changed`,
              {
                method: 'POST',
                headers: { apikey: serviceKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  eventId,
                  version,
                  globalControl,
                  fastPath: event !== null && !globalControl,
                  ...(mobileProjection
                    ? {
                        snapshot: {
                          catalog: mobileProjection.catalog,
                          context: mobileContext(mobileProjection.context, permissions),
                        },
                      }
                    : {}),
                  ...(traceId ? { traceId } : {}),
                }),
              },
            ),
          );
        }
      }
      if (event !== null && !globalControl) {
        notifications.push(
          fetch(
            `${endpoint}/realtime/v1/api/broadcast/${encodeURIComponent(await desktopRealtimeTopic(eventId))}/events/journal-entry`,
            {
              method: 'POST',
              headers: { apikey: serviceKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ eventId, event }),
            },
          ),
        );
      }
      if ((await Promise.all(notifications)).some((response) => !response.ok)) {
        console.warn('Realtime broadcast rejected.');
        return { mobileRecipients, failed: true };
      }
      return { mobileRecipients, failed: false };
    } catch {
      // A missed notification is harmless: the desktop fallback pull recovers it.
      return { mobileRecipients, failed: true };
    }
  };
  const queueReceipt = async (eventId: string, commandId: string, payload: Obj): Promise<void> => {
    if (payload.action !== 'operations.order-paid') return;
    const details = asObj(payload.details) ? payload.details : {},
      order = asObj(details.order) ? details.order : {};
    const orderId =
      typeof payload.entityId === 'string'
        ? payload.entityId
        : typeof order.id === 'string'
          ? order.id
          : null;
    if (!orderId) return;
    const items = Array.isArray(details.items)
      ? details.items.filter(asObj).flatMap((item) => {
          if (
            typeof item.itemName !== 'string' ||
            typeof item.quantity !== 'number' ||
            typeof item.unitPriceCents !== 'number' ||
            typeof item.totalCents !== 'number'
          )
            return [];
          const preparation = Array.isArray(item.componentAllocations)
            ? item.componentAllocations.filter(asObj).flatMap((choice) =>
                typeof choice.choiceGroup === 'string' &&
                typeof choice.choiceLabel === 'string' &&
                typeof choice.productName === 'string' &&
                typeof choice.quantity === 'number'
                  ? [
                      {
                        label: choice.choiceLabel,
                        productName: choice.productName,
                        quantity: choice.quantity,
                      },
                    ]
                  : [],
              )
            : [];
          return [
            {
              name: item.itemName,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              totalCents: item.totalCents,
              preparation,
            },
          ];
        })
      : [];
    const payments = Array.isArray(details.payments)
      ? details.payments.filter(asObj).flatMap((payment) =>
          ['cash', 'pix', 'credit-card', 'debit-card'].includes(String(payment.method)) &&
          typeof payment.amountCents === 'number'
            ? [
                {
                  method: payment.method,
                  amountCents: payment.amountCents,
                  receivedCents:
                    typeof payment.receivedCents === 'number' ? payment.receivedCents : null,
                  changeCents: typeof payment.changeCents === 'number' ? payment.changeCents : 0,
                },
              ]
            : [],
        )
      : [];
    const vouchers = Array.isArray(details.vouchers)
      ? details.vouchers
          .filter(asObj)
          .flatMap((voucher) =>
            typeof voucher.code === 'string' && typeof voucher.amountCents === 'number'
              ? [{ code: voucher.code, amountCents: voucher.amountCents }]
              : [],
          )
      : [];
    const document = {
      orderId,
      eventName:
        typeof details.eventName === 'string'
          ? details.eventName
          : `Evento ${eventId.slice(0, 8).toUpperCase()}`,
      servicePointLabel:
        typeof order.servicePointLabel === 'string' ? order.servicePointLabel : 'Caixa GTRZ',
      servicePointType: order.servicePointType === 'table' ? 'table' : 'counter',
      subtotalCents: typeof details.subtotalCents === 'number' ? details.subtotalCents : 0,
      discountCents: typeof details.discountCents === 'number' ? details.discountCents : 0,
      totalCents: typeof details.totalCents === 'number' ? details.totalCents : 0,
      closedAt: typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
      operatorName:
        typeof details.operatorName === 'string' ? details.operatorName : 'Operador GTRZ',
      originLabel:
        typeof details.originLabel === 'string'
          ? details.originLabel
          : typeof payload.deviceId === 'string'
            ? payload.deviceId
            : 'GTRZ System',
      items,
      payments,
      vouchers,
      documentType: 'sale-batch',
    };
    const { error } = await db.rpc('gtrz_enqueue_print_job', {
      p_event_id: eventId,
      p_command_id: commandId,
      p_idempotency_key: `receipt:${orderId}`,
      p_order_id: orderId,
      p_document: document,
      p_created_at: Date.now(),
    });
    if (error) throw error;
  };
  const commit = async (
    eventId: string,
    commandId: string,
    payload: Obj,
    mutate: (catalog: Obj, context: Obj) => { catalog: Obj; context: Obj },
  ): Promise<unknown> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await state(eventId),
        catalog = asObj(current.catalog) ? current.catalog : emptyCatalog,
        context = asObj(current.context) ? current.context : emptyContext,
        next = mutate(catalog, context);
      const { data, error } = await db.rpc('gtrz_commit_mobile_state', {
        p_event_id: eventId,
        p_command_id: commandId,
        p_type: 'journal.committed',
        p_payload: payload,
        p_catalog: next.catalog,
        p_context: next.context,
        p_expected_version: Number(current.version ?? 0),
        p_created_at: Date.now(),
      });
      if (error) throw error;
      if (!asObj(data) || data.status !== 'conflict') {
        const version =
            asObj(data) && typeof data.version === 'number'
              ? data.version
              : Number(current.version ?? 0) + 1,
          response = asObj(data) && asObj(data.response) ? data.response : null,
          event = response && asObj(response.event) ? response.event : null;
        await Promise.all([
          queueReceipt(eventId, commandId, payload),
          notifyRealtime(eventId, version, false, event, true, null, next),
        ]);
        return data;
      }
    }
    throw Object.assign(new Error('Outro dispositivo atualizou o evento. Tente novamente.'), {
      status: 409,
      code: 'STATE_CONFLICT',
    });
  };
  try {
    if (path === '/v1/monitor/heartbeat' && request.method === 'POST') {
      const actorDeviceId = await authorizeDesktop(),
        input = await body(),
        now = Date.now(),
        deviceId = string(input.deviceId, 'deviceId');
      assertDeviceClaim(actorDeviceId, deviceId);
      const { error } = await db.rpc('gtrz_register_desktop_device', {
        p_device_id: deviceId,
        p_label: string(input.label, 'label', 120),
        p_active_event_id: typeof input.activeEventId === 'string' ? input.activeEventId : '',
        p_seen_at: now,
      });
      if (error) throw error;
      return ok({ accepted: true, serverTime: now });
    }
    if (path === '/v1/desktop/enrollment' && request.method === 'POST') {
      denyAdministrator();
      const deviceId = string(request.headers.get('X-GTRZ-Device-Id') ?? '', 'deviceId');
      const enrollmentCode = `gtrz-enroll-${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const { data, error } = await db.rpc('gtrz_create_desktop_enrollment', {
        p_code_hash: await sha(enrollmentCode),
        p_created_by_device_id: deviceId,
        p_now: Date.now(),
      });
      if (error || !asObj(data) || typeof data.expiresAt !== 'number')
        throw error ?? new Error('Código de vínculo inválido.');
      return ok({ enrollmentCode, expiresAt: data.expiresAt });
    }
    if (path === '/v1/desktop/enrollment/exchange' && request.method === 'POST') {
      const input = await body(),
        deviceId = string(input.deviceId, 'deviceId'),
        credential = `gtrz-device-${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const { error } = await db.rpc('gtrz_exchange_desktop_enrollment', {
        p_code_hash: await sha(string(input.enrollmentCode, 'enrollmentCode', 160)),
        p_device_id: deviceId,
        p_label: string(input.label, 'label', 120),
        p_credential_hash: await sha(credential),
        p_now: Date.now(),
      });
      if (error) throw error;
      return ok({ deviceId, token: credential });
    }
    if (path === '/v1/desktop/devices' && request.method === 'GET') {
      denyAdministrator();
      const { data, error } = await db.rpc('gtrz_list_desktop_devices');
      if (error) throw error;
      return ok(data);
    }
    if (path === '/v1/desktop/devices/revoke' && request.method === 'POST') {
      denyAdministrator();
      const input = await body();
      const { data, error } = await db.rpc('gtrz_revoke_desktop_device', {
        p_device_id: string(input.deviceId, 'deviceId'),
        p_now: Date.now(),
      });
      if (error) throw error;
      return ok(data);
    }
    const realtimeTopicRoute = /^\/v1\/events\/([^/]+)\/realtime-topic$/.exec(path);
    if (realtimeTopicRoute && request.method === 'GET') {
      await authorizeDesktop();
      if (!pairingKey)
        throw Object.assign(new Error('Canal de atualização não configurado.'), {
          status: 503,
          code: 'NOT_CONFIGURED',
        });
      return ok({
        topic: await realtimeTopic(
          string(decodeURIComponent(realtimeTopicRoute[1]), 'eventId', 160),
        ),
      });
    }
    const desktopRealtimeTopicRoute = /^\/v1\/events\/([^/]+)\/desktop-realtime-topic$/.exec(path);
    if (desktopRealtimeTopicRoute && request.method === 'GET') {
      await authorizeDesktop();
      if (!pairingKey)
        throw Object.assign(new Error('Canal de atualização não configurado.'), {
          status: 503,
          code: 'NOT_CONFIGURED',
        });
      return ok({
        topic: await desktopRealtimeTopic(
          string(decodeURIComponent(desktopRealtimeTopicRoute[1]), 'eventId', 160),
        ),
      });
    }
    if (path === '/v1/monitor/global-control' && request.method === 'GET') {
      await authorizeDesktop();
      const { data, error } = await db.rpc('gtrz_read_global_control', {
        p_after: Number(new URL(request.url).searchParams.get('after') ?? '0'),
      });
      if (error) throw error;
      return ok(data);
    }
    if (path === '/v1/monitor/global-event' && request.method === 'POST') {
      denyAdministrator();
      const input = await body();
      const { data, error } = await db.rpc('gtrz_set_global_event', {
        p_command_id: input.commandId ?? crypto.randomUUID(),
        p_event_id: string(input.eventId, 'eventId'),
        p_event_name: string(input.eventName, 'eventName'),
        p_created_at: input.createdAt ?? Date.now(),
      });
      if (error) throw error;
      await notifyRealtime('_catalog', 0, true);
      return ok(data);
    }
    if (path === '/v1/monitor/realtime-ping' && request.method === 'POST') {
      denyAdministrator();
      const input = await body(),
        eventId = string(input.eventId, 'eventId');
      const delivery = await notifyRealtime(
        eventId,
        0,
        false,
        null,
        true,
        typeof input.traceId === 'string' ? input.traceId : null,
      );
      return ok({ accepted: true });
    }
    if (path === '/v1/monitor/realtime-snapshot-ping' && request.method === 'POST') {
      denyAdministrator();
      const input = await body(),
        eventId = string(input.eventId, 'eventId'),
        current = await state(eventId),
        catalog = asObj(current.catalog) ? current.catalog : emptyCatalog,
        context = asObj(current.context) ? current.context : emptyContext;
      await notifyRealtime(
        eventId,
        Number(current.version ?? 0),
        false,
        null,
        true,
        typeof input.traceId === 'string' ? input.traceId : null,
        { catalog, context },
      );
      return ok({ accepted: true, ...delivery });
    }
    if (path === '/v1/monitor/desktop-realtime-ping' && request.method === 'POST') {
      denyAdministrator();
      const input = await body(),
        eventId = string(input.eventId, 'eventId');
      await notifyRealtime(
        eventId,
        0,
        false,
        { sequence: 0, commandId: 'monitor-realtime-ping', type: 'monitor.ping', payload: null },
        false,
      );
      return ok({ accepted: true });
    }
    if (path === '/v1/monitor/global-event/reset' && request.method === 'POST') {
      denyAdministrator();
      const input = await body(),
        now = Date.now();
      const { data, error } = await db.rpc('gtrz_request_global_reset', {
        p_request_id: crypto.randomUUID(),
        p_event_id: string(input.eventId, 'eventId'),
        p_event_name: string(input.eventName, 'eventName'),
        p_reason: string(input.reason, 'reason', 500),
        p_device_id: string(input.deviceId, 'deviceId'),
        p_created_at: now,
      });
      if (error) throw error;
      return ok(data, 202);
    }
    const resetBackupRoute = /^\/v1\/monitor\/reset-backup\/([^/]+)$/.exec(path);
    if (resetBackupRoute && request.method === 'POST') {
      await authorizeDesktop();
      const requestId = string(decodeURIComponent(resetBackupRoute[1]), 'requestId'),
        deviceId = string(request.headers.get('X-GTRZ-Device-Id') ?? '', 'deviceId'),
        fileName = string(
          request.headers.get('X-GTRZ-Backup-Name') ?? 'backup.sqlite',
          'backupName',
          240,
        ),
        checksum = string(
          request.headers.get('X-GTRZ-Backup-Sha256') ?? '',
          'backupSha256',
          64,
        ).toLowerCase(),
        bytes = integer(Number(request.headers.get('X-GTRZ-Backup-Size') ?? ''), 'backupSize');
      if (!/^[a-f0-9]{64}$/.test(checksum) || bytes > 104857600)
        throw new Error('Backup inválido.');
      const contents = await request.arrayBuffer();
      if (contents.byteLength !== bytes) throw new Error('O tamanho do backup não confere.');
      const storagePath = `${requestId}/${deviceId}-${Date.now()}.sqlite`;
      const { error: uploadError } = await db.storage
        .from('gtrz-reset-backups')
        .upload(storagePath, contents, { contentType: 'application/vnd.sqlite3', upsert: false });
      if (uploadError) throw uploadError;
      const { data, error } = await db.rpc('gtrz_complete_reset_backup', {
        p_request_id: requestId,
        p_device_id: deviceId,
        p_file_name: fileName,
        p_storage_path: storagePath,
        p_sha256: checksum,
        p_bytes: bytes,
        p_created_at: Date.now(),
      });
      if (error) throw error;
      return ok(data);
    }
    if (path === '/v1/monitor/snapshot' && request.method === 'GET') {
      await authorizeDesktop();
      const now = Date.now(),
        { data, error } = await store
          .from('desktop_devices')
          .select('device_id,label,active_event_id,last_seen_at,revoked_at')
          .is('revoked_at', null)
          .order('last_seen_at', { ascending: false });
      if (error) throw error;
      return ok({
        checkedAt: now,
        activeDevices: (data ?? []).map((item) => ({
          id: item.device_id,
          label: item.label,
          activeEventId: item.active_event_id,
          lastSeenAt: item.last_seen_at,
          latencyMs: 0,
        })),
        recentCommands: [],
        recentTransport: [],
        recentConflicts: [],
        idempotency: { acceptedCommands: 0, journalAttempts: 0, replayedAttempts: 0 },
        activeEvent: await activeEvent(),
        pendingReset:
          (await db.rpc('gtrz_read_global_control', { p_after: 0 })).data?.pendingReset ?? null,
      });
    }

    if (path === '/v1/mobile/operators') {
      denyAdministrator();
      if (request.method === 'GET') {
        const { data, error } = await store
          .from('mobile_operators')
          .select('*')
          .order('active', { ascending: false })
          .order('name');
        if (error) throw error;
        return ok(
          (data ?? []).map((row) => ({
            id: row.operator_id,
            name: row.name,
            permissions: row.permissions,
            active: row.active,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastSeenAt: null,
            sessionCount: 0,
          })),
        );
      }
      if (request.method === 'POST') {
        const input = await body(),
          now = Date.now(),
          operatorId = crypto.randomUUID(),
          nextSalt = salt(),
          permissionSet = permissions(input.permissions);
        const { data, error } = await store
          .from('mobile_operators')
          .insert({
            operator_id: operatorId,
            name: string(input.name, 'name', 60),
            password_salt: nextSalt,
            password_hash: await hashPassword(string(input.password, 'password', 128), nextSalt),
            permissions: permissionSet,
            active: true,
            created_at: now,
            updated_at: now,
          })
          .select()
          .single();
        if (error) throw error;
        return ok({
          id: data.operator_id,
          name: data.name,
          permissions: data.permissions,
          active: data.active,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
          lastSeenAt: null,
          sessionCount: 0,
        });
      }
    }
    const operatorRoute = /^\/v1\/mobile\/operators\/([^/]+)(\/sessions)?$/.exec(path);
    if (operatorRoute) {
      denyAdministrator();
      const id = string(decodeURIComponent(operatorRoute[1]), 'operatorId', 80),
        now = Date.now();
      if (operatorRoute[2] && request.method === 'POST') {
        const { error } = await store
          .from('mobile_sessions')
          .update({ revoked_at: now })
          .eq('operator_id', id)
          .is('revoked_at', null);
        if (error) throw error;
        return ok({ success: true });
      }
      if (request.method === 'DELETE') {
        const { error } = await store.from('mobile_operators').delete().eq('operator_id', id);
        if (error) throw error;
        return ok({ success: true });
      }
      if (request.method === 'PATCH') {
        const input = await body(),
          update: Obj = { updated_at: now };
        if (input.name !== undefined) update.name = string(input.name, 'name', 60);
        if (input.permissions !== undefined) update.permissions = permissions(input.permissions);
        if (input.active !== undefined) update.active = input.active === true;
        if (input.password !== undefined) {
          const nextSalt = salt();
          update.password_salt = nextSalt;
          update.password_hash = await hashPassword(
            string(input.password, 'password', 128),
            nextSalt,
          );
        }
        const { data, error } = await store
          .from('mobile_operators')
          .update(update)
          .eq('operator_id', id)
          .select()
          .single();
        if (error) throw error;
        if (input.password !== undefined || input.active === false)
          await store
            .from('mobile_sessions')
            .update({ revoked_at: now })
            .eq('operator_id', id)
            .is('revoked_at', null);
        return ok({
          id: data.operator_id,
          name: data.name,
          permissions: data.permissions,
          active: data.active,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
          lastSeenAt: null,
          sessionCount: 0,
        });
      }
    }
    if (path === '/v1/mobile/session' && request.method === 'POST') {
      const input = await body(),
        password = string(input.password, 'password', 128),
        deviceId = string(input.deviceId, 'deviceId', 80),
        { data, error } = await store.from('mobile_operators').select('*').eq('active', true);
      if (error) throw error;
      let operator: Obj | null = null;
      for (const candidate of data ?? [])
        if (
          secretEqual(
            await hashPassword(password, candidate.password_salt),
            candidate.password_hash,
          )
        ) {
          operator = candidate as unknown as Obj;
          break;
        }
      if (!operator)
        throw Object.assign(new Error('Senha não reconhecida ou operador desativado.'), {
          status: 401,
          code: 'MOBILE_UNAUTHORIZED',
        });
      const active = await activeEvent();
      if (!active || typeof active.eventId !== 'string')
        throw Object.assign(new Error('Nenhum evento ativo está disponível.'), {
          status: 409,
          code: 'NO_ACTIVE_EVENT',
        });
      const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', ''),
        now = Date.now();
      const { error: sessionError } = await store.from('mobile_sessions').insert({
        session_id: crypto.randomUUID(),
        operator_id: operator.operator_id,
        device_id: deviceId,
        token_hash: await sha(rawToken),
        expires_at: now + 2592000000,
        last_seen_at: now,
        created_at: now,
      });
      if (sessionError) throw sessionError;
      return ok({
        token: rawToken,
        eventId: active.eventId,
        operator: {
          id: operator.operator_id,
          name: operator.name,
          permissions: operator.permissions,
        },
      });
    }
    if (path === '/v1/mobile/session' && request.method === 'GET') {
      const current = await currentSession();
      const operator = current.operator as Obj;
      return ok({
        operator: {
          id: operator.operator_id,
          name: operator.name,
          permissions: operator.permissions,
        },
        eventId: current.eventId,
      });
    }

    const printRoute = /^\/v1\/events\/([^/]+)\/print\/(printers|claim|complete|jobs)$/.exec(path);
    if (printRoute) {
      const actorDeviceId = await authorizeDesktop(),
        eventId = string(decodeURIComponent(printRoute[1]), 'eventId'),
        operation = printRoute[2],
        now = Date.now();
      if (operation === 'jobs' && request.method === 'GET') {
        const { data, error } = await db.rpc('gtrz_list_print_jobs', { p_event_id: eventId });
        if (error) throw error;
        return ok(data);
      }
      const input = await body(),
        deviceId = string(input.deviceId, 'deviceId');
      assertDeviceClaim(actorDeviceId, deviceId);
      if (operation === 'printers' && request.method === 'POST') {
        const { data, error } = await db.rpc('gtrz_register_print_printer', {
          p_event_id: eventId,
          p_device_id: deviceId,
          p_device_label: string(input.deviceLabel, 'deviceLabel', 120),
          p_printer_name: string(input.printerName, 'printerName', 240),
          p_paper_width_mm: input.paperWidthMm === 58 ? 58 : 80,
          p_enabled: input.enabled === true,
          p_seen_at: now,
        });
        if (error) throw error;
        return ok(data);
      }
      if (operation === 'claim' && request.method === 'POST') {
        const { data, error } = await db.rpc('gtrz_claim_print_job', {
          p_event_id: eventId,
          p_device_id: deviceId,
          p_now: now,
        });
        if (error) throw error;
        return ok(data);
      }
      if (operation === 'complete' && request.method === 'POST') {
        const result = string(input.result, 'result', 16),
          { data, error } = await db.rpc('gtrz_complete_print_job', {
            p_job_id: string(input.jobId, 'jobId'),
            p_claim_token: string(input.claimToken, 'claimToken'),
            p_device_id: deviceId,
            p_result: result,
            p_error:
              typeof input.error === 'string' && input.error.trim()
                ? input.error.trim().slice(0, 500)
                : null,
            p_now: now,
          });
        if (error) throw error;
        return ok(data);
      }
      return bad(404, 'NOT_FOUND', 'Rota de impressão não encontrada.');
    }
    const eventRoute =
      /^\/v1\/events\/([^/]+)\/(journal|snapshot|state|cashier\/(catalog|context))$/.exec(path);
    if (eventRoute) {
      const actorDeviceId = await authorizeDesktop(),
        eventId = string(decodeURIComponent(eventRoute[1]), 'eventId'),
        operation = eventRoute[2];
      if (operation === 'state' && request.method === 'GET') return ok(await state(eventId));
      if (operation === 'journal' && request.method === 'POST') {
        const input = await body();
        if (actorDeviceId !== null && asObj(input.payload))
          assertDeviceClaim(actorDeviceId, string(input.payload.deviceId, 'payload.deviceId', 80));
        const { data, error } = await db.rpc('gtrz_append_journal', {
          p_event_id: eventId,
          p_command_id: string(input.commandId, 'commandId'),
          p_type: string(input.type, 'type', 120),
          p_payload: input.payload,
          p_created_at: integer(input.createdAt, 'createdAt'),
        });
        if (error) throw error;
        await Promise.all([
          asObj(input.payload)
            ? queueReceipt(eventId, string(input.commandId, 'commandId'), input.payload)
            : Promise.resolve(),
          notifyRealtime(eventId, 0, false, asObj(data) && asObj(data.event) ? data.event : null),
        ]);
        return ok(data);
      }
      if (operation === 'snapshot' && request.method === 'GET') {
        const { data, error } = await db.rpc('gtrz_read_journal', {
          p_event_id: eventId,
          p_after: Number(new URL(request.url).searchParams.get('after') ?? '0'),
        });
        if (error) throw error;
        return ok(data);
      }
      const current = await state(eventId),
        projection = operation === 'cashier/catalog' ? 'cashier-catalog' : 'mobile-context';
      if (request.method === 'GET')
        return ok(projection === 'cashier-catalog' ? current.catalog : current.context);
      if (request.method === 'POST') {
        const input = await body(),
          payload = asObj(input.projection) ? input.projection : input,
          expectedVersion = integer(input.expectedVersion, 'expectedVersion'),
          { data, error } = await db.rpc('gtrz_replace_event_projection_checked', {
            p_event_id: eventId,
            p_projection: projection,
            p_payload: payload,
            p_expected_version: expectedVersion,
            p_updated_at: Date.now(),
          });
        if (error) throw error;
        if (asObj(data) && data.status === 'conflict')
          return bad(409, 'STATE_CONFLICT', 'O estado do evento mudou antes da publicação.');
        await notifyRealtime(eventId, 0);
        return ok(data);
      }
    }

    if (!path.startsWith('/v1/mobile/'))
      return bad(404, 'NOT_FOUND', 'Rota canônica não encontrada.');
    if (path === '/v1/mobile/refresh' && request.method === 'GET') {
      const refreshed = await mobileRefresh(),
        operator = asObj(refreshed.operator) ? refreshed.operator : null,
        context = asObj(refreshed.context) ? refreshed.context : emptyContext;
      if (!operator) throw new Error('Atualização móvel inválida.');
      const allowed = operator.permissions as Record<Permission, boolean>;
      return ok({
        operator,
        eventId: refreshed.eventId,
        catalog: refreshed.catalog,
        context: {
          ...context,
          ticketLots: allowed.tickets ? context.ticketLots : [],
          servicePoints: allowed.sales || allowed.vouchers ? context.servicePoints : [],
          voucherCodes: allowed.vouchers ? context.voucherCodes : [],
          vouchers: allowed.sales || allowed.vouchers ? context.vouchers : [],
        },
      });
    }
    const current = await currentSession(),
      operator = current.operator as Obj,
      eventId = string(current.eventId, 'eventId'),
      allowed = operator.permissions as Record<Permission, boolean>;
    if (path === '/v1/mobile/realtime-topic' && request.method === 'GET') {
      const raw = routeToken(request);
      if (!raw) throw new Error('A sessão móvel foi encerrada.');
      return ok({ topic: await mobileRealtimeTopic(await sha(raw)) });
    }
    if (path === '/v1/mobile/catalog' && request.method === 'GET')
      return ok((await state(eventId)).catalog);
    if (path === '/v1/mobile/context' && request.method === 'GET') {
      const remote = await state(eventId),
        context = asObj(remote.context) ? remote.context : emptyContext;
      return ok({
        ...context,
        ticketLots: allowed.tickets ? context.ticketLots : [],
        servicePoints: allowed.sales || allowed.vouchers ? context.servicePoints : [],
        voucherCodes: allowed.vouchers ? context.voucherCodes : [],
        vouchers: allowed.sales || allowed.vouchers ? context.vouchers : [],
      });
    }
    const required: Record<string, Permission> = {
        '/v1/mobile/sales': 'sales',
        '/v1/mobile/stock': 'inventory',
        '/v1/mobile/tickets': 'tickets',
        '/v1/mobile/expenses': 'expenses',
        '/v1/mobile/vouchers': 'vouchers',
      },
      permission = required[path];
    if (!permission || request.method !== 'POST')
      return bad(404, 'NOT_FOUND', 'Rota móvel não encontrada.');
    if (!allowed[permission])
      return bad(403, 'MOBILE_FORBIDDEN', 'Este perfil não possui esta permissão.');
    const input = await body(),
      commandId = string(input.commandId, 'commandId'),
      now = Date.now(),
      deviceId = `mobile:${String(operator.operator_id)}:${String(current.deviceId)}`.slice(0, 80),
      operatorName = string(operator.name, 'operator.name', 60);
    if (path === '/v1/mobile/stock') {
      const productId = string(input.productId, 'productId'),
        quantity = integer(input.quantity, 'quantity', true),
        type = string(input.type, 'type', 32),
        delta = ['purchase', 'correction-positive', 'return'].includes(type) ? quantity : -quantity,
        purchase =
          type === 'purchase'
            ? integer(input.purchaseTotalCents, 'purchaseTotalCents', true)
            : null;
      const payload: Obj = {
        commandId,
        deviceId,
        auditId: now,
        profile: 'mobile-inventory',
        action: 'inventory.stock-moved',
        entityType: 'stock-movement',
        entityId: crypto.randomUUID(),
        createdAt: now,
        details: {},
      };
      return ok(
        await commit(eventId, commandId, payload, (catalog, context) => {
          const products = catalogProducts(catalog),
            product = products.find(
              (item) =>
                item.productId === productId && item.itemKind !== 'combo' && item.active !== false,
            );
          if (!product) throw new Error('Produto não disponível no estoque móvel.');
          const before = integer(product.quantity, 'produto.quantidade');
          if (before + delta < 0)
            throw new Error(`Estoque insuficiente para ${String(product.label)}.`);
          product.quantity = before + delta;
          payload.details = {
            productId,
            productLabel: product.label,
            type,
            quantity,
            delta,
            beforeQuantity: before,
            afterQuantity: product.quantity,
            purchaseTotalCents: purchase,
            purchaseUnitCents: purchase === null ? null : Math.round(purchase / quantity),
            note: typeof input.note === 'string' ? input.note.trim() : null,
            operatorName,
          };
          recalculateCombos(products);
          return { catalog: adjustedCatalog(catalog, products), context };
        }),
      );
    }
    if (path === '/v1/mobile/expenses') {
      const payload: Obj = {
        commandId,
        deviceId,
        auditId: now,
        profile: 'mobile-expenses',
        action: 'expense.created',
        entityType: 'expense',
        entityId: crypto.randomUUID(),
        createdAt: now,
        details: {
          category: string(input.category, 'category', 80),
          description: string(input.description, 'description', 160),
          amountCents: integer(input.amountCents, 'amountCents', true),
          paymentMethod: string(input.paymentMethod, 'paymentMethod', 24),
          paymentStatus: 'open',
          note: typeof input.note === 'string' ? input.note.trim() : null,
          operatorName,
        },
      };
      return ok(
        await commit(eventId, commandId, payload, (catalog, context) => ({ catalog, context })),
      );
    }
    if (path === '/v1/mobile/vouchers') {
      const payload: Obj = {
        commandId,
        deviceId,
        auditId: now,
        profile: 'mobile-vouchers',
        action: 'voucher.created',
        entityType: 'voucher',
        entityId: crypto.randomUUID(),
        createdAt: now,
        details: {},
      };
      return ok(
        await commit(eventId, commandId, payload, (catalog, context) => {
          const pointId = string(input.servicePointId, 'servicePointId'),
            points = Array.isArray(context.servicePoints)
              ? context.servicePoints.filter(asObj)
              : [];
          if (
            !points.some(
              (point) => point.id === pointId && point.type === 'table' && point.active === true,
            )
          )
            throw new Error('A mesa selecionada não está disponível.');
          const code = (
              typeof input.code === 'string' && input.code.trim()
                ? input.code.trim()
                : `GTRZ-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
            )
              .toUpperCase()
              .replaceAll(/\s+/g, '-'),
            amount = integer(input.initialBalanceCents, 'initialBalanceCents', true),
            vouchers = Array.isArray(context.vouchers) ? context.vouchers.filter(asObj) : [];
          if (vouchers.some((voucher) => String(voucher.code).toUpperCase() === code))
            throw new Error('Este código de voucher já existe.');
          const label = string(input.label, 'label', 100);
          payload.details = {
            code,
            initialBalanceCents: amount,
            label,
            servicePointId: pointId,
            operatorName,
          };
          return {
            catalog,
            context: {
              ...context,
              voucherCodes: [
                ...new Set([
                  ...(Array.isArray(context.voucherCodes) ? context.voucherCodes : []),
                  code,
                ]),
              ],
              vouchers: [
                ...vouchers,
                {
                  id: payload.entityId,
                  code,
                  label,
                  remainingBalanceCents: amount,
                  status: 'active',
                  servicePointId: pointId,
                  updatedAt: now,
                },
              ],
            },
          };
        }),
      );
    }
    if (path === '/v1/mobile/tickets') {
      const payload: Obj = {
        commandId,
        deviceId,
        auditId: now,
        profile: 'mobile-tickets',
        action: input.source === 'courtesy' ? 'ticket.courtesy-created' : 'ticket.sale-created',
        entityType: 'ticket-sale',
        entityId: crypto.randomUUID(),
        createdAt: now,
        details: {},
      };
      return ok(
        await commit(eventId, commandId, payload, (catalog, context) => {
          const lotId = string(input.lotId, 'lotId'),
            quantity = integer(input.quantity, 'quantity', true),
            lots = Array.isArray(context.ticketLots)
              ? context.ticketLots.filter(asObj).map((item) => ({ ...item }))
              : [],
            lot = lots.find((item) => item.id === lotId && item.active === true);
          if (!lot || integer(lot.availableQuantity, 'lote.quantidade') < quantity)
            throw new Error('Não há ingressos suficientes neste lote.');
          const courtesy = input.source === 'courtesy',
            unit = courtesy ? 0 : integer(lot.priceCents, 'lote.preço');
          lot.availableQuantity = integer(lot.availableQuantity, 'lote.quantidade') - quantity;
          lot.soldQuantity = Number(lot.soldQuantity ?? 0) + (courtesy ? 0 : quantity);
          lot.courtesyQuantity = Number(lot.courtesyQuantity ?? 0) + (courtesy ? quantity : 0);
          payload.details = {
            attendeeName: string(input.attendeeName, 'attendeeName', 120),
            codes: Array.from({ length: quantity }, () => ({
              id: crypto.randomUUID(),
              code: `GTRZ-${crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`,
            })),
            lotId,
            lotName: lot.name,
            paymentMethod: courtesy ? null : string(input.paymentMethod, 'paymentMethod', 24),
            quantity,
            source: input.source,
            totalCents: unit * quantity,
            unitPriceCents: unit,
            operatorName,
          };
          return { catalog, context: { ...context, ticketLots: lots } };
        }),
      );
    }
    if (path === '/v1/mobile/sales') {
      const saleId = string(input.saleId, 'saleId'),
        servicePointId = string(input.servicePointId, 'servicePointId'),
        rawItems = Array.isArray(input.items) ? input.items.filter(asObj) : [];
      if (!rawItems.length) throw new Error('A venda deve conter ao menos um item.');
      const payload: Obj = {
        commandId,
        deviceId,
        auditId: now,
        profile: 'cashier',
        action: 'operations.order-paid',
        entityType: 'order',
        entityId: saleId,
        createdAt: now,
        details: {},
      };
      return ok(
        await commit(eventId, commandId, payload, (catalog, context) => {
          const products = catalogProducts(catalog),
            byId = new Map(products.map((product) => [String(product.productId), product])),
            points = Array.isArray(context.servicePoints)
              ? context.servicePoints.filter(asObj)
              : [],
            point = points.find((item) => item.id === servicePointId && item.active === true);
          if (!point) throw new Error('A mesa selecionada não está disponível.');
          const consumed = new Map<string, number>(),
            orderItems: Obj[] = [];
          for (const raw of rawItems) {
            const id = string(raw.productId, 'items.productId'),
              itemKind = raw.itemKind === 'combo' ? 'combo' : 'product',
              quantity = integer(raw.quantity, 'items.quantity', true),
              product = byId.get(id);
            if (
              !product ||
              product.active === false ||
              product.itemKind !== itemKind ||
              (itemKind === 'product' && product.visible === false)
            )
              throw new Error('Um produto não está disponível neste caixa.');
            const allocated: Obj[] = [];
            if (itemKind === 'product')
              allocated.push({ productId: id, quantity, choiceGroup: null, choiceLabel: null });
            else {
              const definitions = Array.isArray(product.components)
                ? product.components.filter(asObj)
                : [];
              if (!definitions.length)
                throw new Error('O combo não possui componentes disponíveis.');
              const choices = Array.isArray(raw.componentSelections)
                ? raw.componentSelections.filter(asObj)
                : [];
              for (const component of definitions.filter((entry) => !entry.choiceGroup))
                allocated.push({
                  productId: component.productId,
                  quantity: integer(component.quantity, 'component.quantity', true) * quantity,
                  choiceGroup: null,
                  choiceLabel: null,
                });
              const groups = new Map<string, Obj[]>();
              for (const component of definitions.filter(
                (entry) => typeof entry.choiceGroup === 'string',
              ))
                groups.set(component.choiceGroup as string, [
                  ...(groups.get(component.choiceGroup as string) ?? []),
                  component,
                ]);
              for (const [group, options] of groups) {
                const needed = integer(options[0]?.quantity, 'component.quantity', true) * quantity,
                  chosen = choices.filter((entry) => entry.choiceGroup === group);
                if (
                  chosen.reduce(
                    (sum, entry) => sum + integer(entry.quantity, 'selection.quantity', true),
                    0,
                  ) !== needed
                )
                  throw new Error(
                    `Escolha ${needed} unidade(s) para ${String(options[0]?.choiceLabel ?? group)}.`,
                  );
                for (const choice of chosen) {
                  const option = options.find((entry) => entry.productId === choice.productId);
                  if (!option) throw new Error('Uma escolha não pertence a este combo.');
                  allocated.push({
                    productId: choice.productId,
                    quantity: integer(choice.quantity, 'selection.quantity', true),
                    choiceGroup: group,
                    choiceLabel: option.choiceLabel ?? null,
                  });
                }
              }
            }
            for (const component of allocated)
              consumed.set(
                String(component.productId),
                (consumed.get(String(component.productId)) ?? 0) +
                  integer(component.quantity, 'component.quantity', true),
              );
            const unit = integer(product.unitPriceCents, 'produto.preço');
            orderItems.push({
              id: crypto.randomUUID(),
              itemKind,
              itemId: id,
              itemName: product.label,
              quantity,
              unitPriceCents: unit,
              totalCents: unit * quantity,
              componentAllocations: allocated.map((entry) => ({
                ...entry,
                productName: byId.get(String(entry.productId))?.label ?? entry.productId,
              })),
            });
          }
          for (const [id, quantity] of consumed) {
            const product = byId.get(id);
            if (!product || integer(product.quantity, 'produto.quantidade') < quantity)
              throw new Error(
                `Estoque insuficiente para ${String(product?.label ?? 'um componente')}.`,
              );
          }
          for (const [id, quantity] of consumed) {
            const product = byId.get(id) as Obj;
            product.quantity = integer(product.quantity, 'produto.quantidade') - quantity;
          }
          const total = orderItems.reduce(
              (sum, item) => sum + integer(item.totalCents, 'item.total'),
              0,
            ),
            vouchers = Array.isArray(context.vouchers)
              ? context.vouchers.filter(asObj).map((item) => ({ ...item }))
              : [],
            use = asObj(input.voucherUse)
              ? {
                  code: string(input.voucherUse.code, 'voucher.code', 32).toUpperCase(),
                  amountCents: integer(input.voucherUse.amountCents, 'voucher.amount', true),
                }
              : null,
            voucher = use
              ? vouchers.find((item) => String(item.code).toUpperCase() === use.code)
              : null;
          if (
            use &&
            (!voucher ||
              voucher.status !== 'active' ||
              voucher.servicePointId !== servicePointId ||
              integer(voucher.remainingBalanceCents, 'voucher.saldo') < use.amountCents ||
              use.amountCents > total)
          )
            throw new Error('O voucher não possui saldo válido para esta mesa.');
          if (use && voucher) {
            voucher.remainingBalanceCents =
              integer(voucher.remainingBalanceCents, 'voucher.saldo') - use.amountCents;
            voucher.status = voucher.remainingBalanceCents === 0 ? 'exhausted' : 'active';
            voucher.updatedAt = now;
          }
          const payment = total - (use?.amountCents ?? 0),
            method =
              input.paymentMethod === null || input.paymentMethod === undefined
                ? null
                : string(input.paymentMethod, 'paymentMethod', 24);
          if ((payment === 0) !== (method === null))
            throw new Error('Informe a forma de pagamento somente para o saldo restante da venda.');
          const received = method === 'cash' ? integer(input.receivedCents, 'receivedCents') : null;
          if (received !== null && received < payment)
            throw new Error('O valor recebido não cobre o saldo da venda.');
          const movements = [...consumed].map(([productId, quantity]) => ({
            id: crypto.randomUUID(),
            product_id: productId,
            quantity,
            delta: -quantity,
            note: `Venda no Caixa Mobile ${operatorName}`,
            created_at: now,
          }));
          payload.details = {
            discountCents: 0,
            order: {
              id: saleId,
              openedAt: now,
              servicePointId,
              servicePointLabel: point.label,
              servicePointType: point.type === 'table' ? 'table' : 'counter',
            },
            items: orderItems,
            payments:
              method === null
                ? []
                : [
                    {
                      id: crypto.randomUUID(),
                      method,
                      amountCents: payment,
                      receivedCents: received,
                      changeCents: received === null ? 0 : received - payment,
                    },
                  ],
            subtotalCents: total,
            totalCents: total,
            totalChangeCents: received === null ? 0 : received - payment,
            stockMovements: movements,
            vouchers: use ? [use] : [],
            operatorName,
            originLabel: point.label,
          };
          recalculateCombos(products);
          return { catalog: adjustedCatalog(catalog, products), context: { ...context, vouchers } };
        }),
      );
    }
    return bad(404, 'NOT_FOUND', 'Rota móvel não encontrada.');
  } catch (error: unknown) {
    const value = asObj(error) ? error : {};
    const message =
      error instanceof Error
        ? error.message
        : typeof value.message === 'string'
          ? value.message
          : 'Falha na operação canônica.';
    return bad(
      typeof value.status === 'number' ? value.status : 400,
      typeof value.code === 'string' ? value.code : 'INVALID_INPUT',
      message,
    );
  }
});
