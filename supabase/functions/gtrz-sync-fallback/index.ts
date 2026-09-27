import { createClient } from 'npm:@supabase/supabase-js@2.93.1';

type JsonRecord = Record<string, unknown>;

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-gtrz-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength = 160): string {
  if (typeof value !== 'string') throw new Error(`${field} deve ser texto.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength)
    throw new Error(`${field} possui tamanho inválido.`);
  return normalized;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0)
    throw new Error(`${field} deve ser um inteiro não negativo.`);
  return value;
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function functionRoute(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const segments = pathname.split('/').filter(Boolean);
  const functionIndex = segments.indexOf('gtrz-sync-fallback');
  if (functionIndex < 0) return pathname;
  const route = segments.slice(functionIndex + 1).join('/');
  return route.length > 0 ? `/${route}` : '/';
}

function supabaseServiceKey(): string | null {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (!keys) return null;
  try {
    const parsed = JSON.parse(keys) as Record<string, unknown>;
    return typeof parsed.default === 'string' ? parsed.default : null;
  } catch {
    return null;
  }
}

async function relayToCloudflare(eventId: string, result: unknown): Promise<boolean> {
  const relayUrl = Deno.env.get('GTRZ_CLOUDFLARE_RELAY_URL');
  const relayKey = Deno.env.get('GTRZ_CLOUDFLARE_RELAY_KEY');
  if (!relayUrl || !relayKey || !isRecord(result) || !isRecord(result.event)) return false;

  const response = await fetch(
    `${relayUrl.replace(/\/$/u, '')}/v1/internal/events/${encodeURIComponent(eventId)}/relay`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GTRZ-Supabase-Relay-Key': relayKey,
      },
      body: JSON.stringify(result.event),
    },
  );
  if (!response.ok) {
    console.error(`Cloudflare relay rejected ${String(response.status)} for ${eventId}.`);
  }
  return response.ok;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const route = functionRoute(request);
  if (request.method === 'GET' && route === '/health') {
    return json({ status: 'ok', service: 'gtrz-sync-fallback' });
  }

  const expectedKey = Deno.env.get('GTRZ_FALLBACK_KEY');
  if (!expectedKey || !sameSecret(request.headers.get('X-GTRZ-Key') ?? '', expectedKey)) {
    return error(401, 'UNAUTHORIZED', 'Chave de acesso inválida.');
  }
  if (request.method === 'GET' && route === '/relay-health') {
    const relayed = await relayToCloudflare('_gtrz-relay-health', {
      event: {
        sequence: 0,
        commandId: 'relay-health',
        type: 'relay.health',
        payload: { action: 'relay.health' },
        createdAt: Date.now(),
      },
    });
    return json({ status: relayed ? 'ok' : 'unavailable', service: 'gtrz-cloudflare-relay' });
  }
  const url = Deno.env.get('SUPABASE_URL');
  const key = supabaseServiceKey();
  if (!url || !key) return error(503, 'NOT_CONFIGURED', 'Rota reserva não configurada.');
  const database = createClient(url, key, { auth: { persistSession: false } });

  const eventMatch = /^\/v1\/events\/([^/]+)\/(journal|snapshot|cashier\/(catalog|context))$/.exec(
    route,
  );
  if (!eventMatch) return error(404, 'NOT_FOUND', 'Rota reserva não encontrada.');

  try {
    const eventId = requiredString(decodeURIComponent(eventMatch[1] ?? ''), 'eventId');
    const action = eventMatch[2] ?? '';
    if (request.method === 'POST' && action === 'journal') {
      const payload: unknown = await request.json();
      if (!isRecord(payload)) return error(400, 'INVALID_INPUT', 'Comando inválido.');
      const commandId = requiredString(payload.commandId, 'commandId');
      const type = requiredString(payload.type, 'type', 120);
      const eventPayload = payload.payload;
      if (!isRecord(eventPayload)) return error(400, 'INVALID_INPUT', 'payload inválido.');
      const createdAt = nonNegativeInteger(payload.createdAt, 'createdAt');
      const { data, error: rpcError } = await database.rpc('gtrz_append_journal', {
        p_event_id: eventId,
        p_command_id: commandId,
        p_type: type,
        p_payload: eventPayload,
        p_created_at: createdAt,
      });
      if (rpcError) throw rpcError;
      await relayToCloudflare(eventId, data);
      return json(data);
    }

    if (request.method === 'GET' && action === 'snapshot') {
      const after = Number(new URL(request.url).searchParams.get('after') ?? '0');
      if (!Number.isSafeInteger(after) || after < 0)
        return error(400, 'INVALID_INPUT', 'after inválido.');
      const { data, error: rpcError } = await database.rpc('gtrz_read_journal', {
        p_event_id: eventId,
        p_after: after,
      });
      if (rpcError) throw rpcError;
      return json(data);
    }

    const projection = action === 'cashier/catalog' ? 'cashier-catalog' : 'mobile-context';
    if (request.method === 'GET') {
      const { data, error: rpcError } = await database.rpc('gtrz_read_projection', {
        p_event_id: eventId,
        p_projection: projection,
      });
      if (rpcError) throw rpcError;
      return json(data);
    }
    if (request.method === 'POST') {
      const payload: unknown = await request.json();
      if (!isRecord(payload)) return error(400, 'INVALID_INPUT', 'Projeção inválida.');
      const { data, error: rpcError } = await database.rpc('gtrz_replace_projection', {
        p_event_id: eventId,
        p_projection: projection,
        p_payload: payload,
        p_updated_at: Date.now(),
      });
      if (rpcError) throw rpcError;
      return json(data);
    }
    return error(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : 'Falha na rota reserva.';
    console.error(message);
    return error(400, 'INVALID_INPUT', message);
  }
});
