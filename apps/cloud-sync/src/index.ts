import { DurableObject } from 'cloudflare:workers';
import { cashierIcon, cashierManifest, cashierPage } from './cashier-page';
import { monitorPage } from './monitor-page';
import { printQueuePage } from './print-queue-page';

interface Env {
  readonly EVENT_ROOM: DurableObjectNamespace<EventRoom>;
  readonly MONITOR_ROOM: DurableObjectNamespace<MonitorRoom>;
  readonly SYNC_AUDIT_ARCHIVE: R2Bucket;
  readonly GTRZ_SYNC_KEY?: string;
  readonly GTRZ_ENVIRONMENT?: 'test';
}

function isTestEnvironment(env: Env): boolean {
  return env.GTRZ_ENVIRONMENT === 'test';
}

type JsonRecord = Record<string, unknown>;

interface StockInput {
  readonly productId: string;
  readonly label: string;
  readonly quantity: number;
}

interface SaleInput {
  readonly commandId: string;
  readonly saleId: string;
  readonly totalCents: number;
  readonly items: readonly StockInput[];
}

interface StreamEvent {
  readonly sequence: number;
  readonly commandId: string;
  readonly type: string;
  readonly payload: JsonRecord;
  readonly createdAt: number;
}

interface CommandResponse {
  readonly commandId: string;
  readonly event: StreamEvent;
  readonly result: JsonRecord;
}

interface CloudReceiptDocument {
  readonly orderId: string;
  readonly eventName: string;
  readonly servicePointLabel: string;
  readonly servicePointType: 'counter' | 'table';
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly closedAt: number;
  readonly operatorName: string;
  readonly originLabel: string;
  readonly items: readonly {
    readonly name: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
    readonly totalCents: number;
  }[];
  readonly payments: readonly {
    readonly method: 'cash' | 'pix' | 'credit-card' | 'debit-card';
    readonly amountCents: number;
    readonly receivedCents: number | null;
    readonly changeCents: number;
  }[];
  readonly vouchers: readonly { readonly code: string; readonly amountCents: number }[];
  readonly documentType?: 'sale-batch' | 'internal-decrement';
  readonly internalReason?: string;
  readonly recipient?: string;
  readonly authorizedBy?: string;
  readonly referenceCode?: string;
}

interface ClaimedPrintJob {
  readonly jobId: string;
  readonly claimToken: string;
  readonly document: CloudReceiptDocument;
}

interface MobilePermissions {
  readonly sales: boolean;
  readonly inventory: boolean;
  readonly tickets: boolean;
  readonly expenses: boolean;
  readonly vouchers: boolean;
}

const MOBILE_PERMISSION_KEYS = ['sales', 'inventory', 'tickets', 'expenses', 'vouchers'] as const;

function legacyPermissions(role: unknown): MobilePermissions {
  return {
    sales: role === 'sales' || role === 'sales-and-inventory',
    inventory: role === 'inventory' || role === 'sales-and-inventory',
    tickets: false,
    expenses: false,
    vouchers: false,
  };
}

function legacyRoleFor(
  permissions: MobilePermissions,
): 'sales' | 'inventory' | 'sales-and-inventory' {
  if (permissions.sales && permissions.inventory) return 'sales-and-inventory';
  return permissions.inventory ? 'inventory' : 'sales';
}

function mobilePermissions(value: unknown): MobilePermissions {
  if (!isRecord(value)) throw new ApiError(400, 'INVALID_INPUT', 'Permissões móveis inválidas.');
  const permissions = {} as Record<(typeof MOBILE_PERMISSION_KEYS)[number], boolean>;
  for (const key of MOBILE_PERMISSION_KEYS) {
    if (typeof value[key] !== 'boolean')
      throw new ApiError(400, 'INVALID_INPUT', 'Permissões móveis inválidas.');
    permissions[key] = value[key];
  }
  return permissions as MobilePermissions;
}

function storedMobilePermissions(value: unknown, role: unknown): MobilePermissions {
  if (typeof value !== 'string') return legacyPermissions(role);
  try {
    return mobilePermissions(JSON.parse(value) as unknown);
  } catch {
    return legacyPermissions(role);
  }
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return headers === undefined
    ? Response.json(payload, { status })
    : Response.json(payload, { status, headers });
}

function cashierToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  const cookie = request.headers.get('Cookie') ?? '';
  const match = /(?:^|;\s*)gtrz_cashier=([^;]+)/u.exec(cookie);
  return match === null ? null : decodeURIComponent(match[1] ?? '');
}

function mobileToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  const cookie = request.headers.get('Cookie') ?? '';
  const match = /(?:^|;\s*)gtrz_mobile=([^;]+)/u.exec(cookie);
  return match === null ? null : decodeURIComponent(match[1] ?? '');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength = 160): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'INVALID_INPUT', `${field} deve ser texto.`);
  }

  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} possui tamanho inválido.`);
  }

  return normalized;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} deve ser um inteiro não negativo.`);
  }

  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const number = nonNegativeInteger(value, field);

  if (number === 0) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} deve ser maior que zero.`);
  }

  return number;
}

function parseAfter(value: string | null): number {
  if (value === null || value.length === 0) {
    return 0;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, 'INVALID_INPUT', 'after deve ser uma sequência válida.');
  }

  return parsed;
}

function parseProductList(value: unknown, field: string): readonly StockInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} deve conter entre 1 e 500 itens.`);
  }

  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ApiError(400, 'INVALID_INPUT', `${field}[${String(index)}] é inválido.`);
    }

    const productId = requiredString(entry.productId, `${field}[${String(index)}].productId`);

    if (seen.has(productId)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Um produto não pode aparecer duas vezes.');
    }

    seen.add(productId);
    return {
      productId,
      label: requiredString(entry.label, `${field}[${String(index)}].label`, 120),
      quantity: positiveInteger(entry.quantity, `${field}[${String(index)}].quantity`),
    };
  });
}

async function readJson(request: Request): Promise<JsonRecord> {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'O corpo da requisição deve ser JSON válido.');
  }

  if (!isRecord(payload)) {
    throw new ApiError(400, 'INVALID_INPUT', 'O corpo deve ser um objeto JSON.');
  }

  return payload;
}

function parseStoredJson(value: string): JsonRecord {
  const parsed: unknown = JSON.parse(value);

  if (!isRecord(parsed)) {
    throw new Error('Registro persistido em formato inválido.');
  }

  return parsed;
}

function storedString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} persistido em formato inválido.`);
  }

  return value;
}

function websocketRequested(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

function sendSocket(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 2_000 },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

function newSalt(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export class MonitorRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        active_event_id TEXT,
        last_seen_at INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0)
      );
      CREATE TABLE IF NOT EXISTS flow_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_log (
        command_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        action TEXT NOT NULL,
        audit_id INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transport_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT,
        event_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
        transport TEXT NOT NULL CHECK (transport IN ('journal', 'websocket')),
        action TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transport_log_created_idx
        ON transport_log (created_at DESC);
      CREATE TABLE IF NOT EXISTS conflict_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_id TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(command_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS conflict_log_created_idx
        ON conflict_log (created_at DESC);
      CREATE TABLE IF NOT EXISTS cashier_devices (
        device_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        event_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role = 'cashier'),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS cashier_devices_event_idx
        ON cashier_devices (event_id, last_seen_at DESC);
      CREATE TABLE IF NOT EXISTS mobile_operators (
        operator_id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('sales', 'inventory', 'sales-and-inventory')),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mobile_sessions (
        session_token TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        revoke_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS mobile_sessions_operator_idx
        ON mobile_sessions (operator_id, revoked_at, last_seen_at DESC);
      DELETE FROM flow_log WHERE type = 'connection.heartbeat';
    `);
    const columns = this.ctx.storage.sql.exec('PRAGMA table_info(mobile_operators)').toArray();
    if (!columns.some((column) => column.name === 'permissions_json')) {
      this.ctx.storage.sql.exec('ALTER TABLE mobile_operators ADD COLUMN permissions_json TEXT');
    }
    this.ctx.storage.sql
      .exec(
        `UPDATE mobile_operators
         SET permissions_json = CASE role
           WHEN 'sales' THEN '{"sales":true,"inventory":false,"tickets":false,"expenses":false,"vouchers":false}'
           WHEN 'inventory' THEN '{"sales":false,"inventory":true,"tickets":false,"expenses":false,"vouchers":false}'
           ELSE '{"sales":true,"inventory":true,"tickets":false,"expenses":false,"vouchers":false}'
         END
         WHERE permissions_json IS NULL`,
      )
      .toArray();
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/v1/monitor/heartbeat') {
        return json(this.#heartbeat(await readJson(request)));
      }

      if (request.method === 'GET' && url.pathname === '/v1/monitor/snapshot') {
        return json(this.#snapshot());
      }

      if (request.method === 'POST' && url.pathname === '/v1/monitor/command') {
        return json(this.#recordCommand(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname === '/v1/monitor/transport') {
        return json(this.#recordTransport(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname === '/v1/monitor/conflict') {
        return json(this.#recordConflict(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname === '/v1/cashier/enroll') {
        return json(this.#enrollCashier(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname === '/v1/cashier/authorize') {
        return json(this.#authorizeCashier(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname === '/v1/cashier/revoke') {
        return json(this.#revokeCashier(await readJson(request)));
      }

      if (request.method === 'GET' && url.pathname === '/v1/cashier/devices') {
        return json(this.#cashierDevices());
      }

      if (request.method === 'GET' && url.pathname === '/v1/mobile/operators') {
        return json(this.#mobileOperators());
      }

      if (request.method === 'POST' && url.pathname === '/v1/mobile/operators') {
        return json(await this.#createMobileOperator(await readJson(request)));
      }

      const operatorMatch = /^\/v1\/mobile\/operators\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'PATCH' && operatorMatch !== null) {
        return json(
          await this.#updateMobileOperator(
            decodeURIComponent(operatorMatch[1] ?? ''),
            await readJson(request),
          ),
        );
      }
      if (request.method === 'DELETE' && operatorMatch !== null) {
        return json(this.#deleteMobileOperator(decodeURIComponent(operatorMatch[1] ?? '')));
      }

      const sessionsMatch = /^\/v1\/mobile\/operators\/([^/]+)\/sessions$/.exec(url.pathname);
      if (request.method === 'POST' && sessionsMatch !== null) {
        return json(
          this.#endMobileSessions(
            decodeURIComponent(sessionsMatch[1] ?? ''),
            await readJson(request),
          ),
        );
      }

      if (request.method === 'POST' && url.pathname === '/v1/mobile/login') {
        return json(await this.#loginMobile(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname === '/v1/mobile/authorize') {
        return json(this.#authorizeMobile(await readJson(request)));
      }

      if (url.pathname === '/v1/mobile/session/stream') {
        return this.#openMobileSessionStream(request);
      }

      throw new ApiError(404, 'NOT_FOUND', 'Rota de monitoramento não encontrada.');
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        return json({ error: { code: error.code, message: error.message } }, error.status);
      }

      console.error(error);
      return json(
        { error: { code: 'INTERNAL_ERROR', message: 'Falha no monitoramento da nuvem.' } },
        500,
      );
    }
  }

  #heartbeat(payload: JsonRecord): JsonRecord {
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const label = requiredString(payload.label, 'label', 80);
    const latencyMs = nonNegativeInteger(payload.latencyMs, 'latencyMs');
    const activeEventId =
      payload.activeEventId === null || payload.activeEventId === undefined
        ? null
        : requiredString(payload.activeEventId, 'activeEventId', 80);
    const now = Date.now();

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql
        .exec(
          `INSERT INTO devices (device_id, label, active_event_id, last_seen_at, latency_ms)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             label = excluded.label,
             active_event_id = excluded.active_event_id,
             last_seen_at = excluded.last_seen_at,
             latency_ms = excluded.latency_ms`,
          deviceId,
          label,
          activeEventId,
          now,
          latencyMs,
        )
        .toArray();
    });

    return this.#snapshot();
  }

  #snapshot(): JsonRecord {
    const now = Date.now();
    const activeSince = now - 45_000;
    const activeDevices = this.ctx.storage.sql
      .exec(
        `SELECT device_id, label, active_event_id, last_seen_at, latency_ms
         FROM devices WHERE last_seen_at >= ? ORDER BY last_seen_at DESC`,
        activeSince,
      )
      .toArray()
      .map((row) => ({
        id: storedString(row.device_id, 'device_id'),
        label: storedString(row.label, 'label'),
        activeEventId: typeof row.active_event_id === 'string' ? row.active_event_id : null,
        lastSeenAt: Number(row.last_seen_at),
        latencyMs: Number(row.latency_ms),
      }));
    const activeCashiers = this.ctx.storage.sql
      .exec(
        `SELECT device_id, label, event_id, last_seen_at FROM cashier_devices
         WHERE revoked_at IS NULL AND last_seen_at >= ? ORDER BY last_seen_at DESC`,
        activeSince,
      )
      .toArray()
      .map((row) => ({
        id: storedString(row.device_id, 'device_id'),
        label: `Caixa mobile · ${storedString(row.label, 'label')}`,
        activeEventId: storedString(row.event_id, 'event_id'),
        lastSeenAt: Number(row.last_seen_at),
        latencyMs: 0,
      }));
    const recentFlows = this.ctx.storage.sql
      .exec(
        `SELECT sequence, device_id, direction, type, created_at
         FROM flow_log ORDER BY sequence DESC LIMIT 24`,
      )
      .toArray()
      .map((row) => ({
        sequence: Number(row.sequence),
        deviceId: storedString(row.device_id, 'device_id'),
        direction: storedString(row.direction, 'direction'),
        type: storedString(row.type, 'type'),
        createdAt: Number(row.created_at),
      }));

    const recentCommands = this.ctx.storage.sql
      .exec(
        `SELECT command_id, event_id, device_id, action, audit_id, payload_json, created_at
         FROM command_log ORDER BY created_at DESC LIMIT 80`,
      )
      .toArray()
      .map((row) => ({
        commandId: storedString(row.command_id, 'command_id'),
        eventId: storedString(row.event_id, 'event_id'),
        deviceId: storedString(row.device_id, 'device_id'),
        action: storedString(row.action, 'action'),
        auditId: Number(row.audit_id),
        payload: parseStoredJson(storedString(row.payload_json, 'payload_json')),
        createdAt: Number(row.created_at),
      }));

    const recentTransport = this.ctx.storage.sql
      .exec(
        `SELECT sequence, command_id, event_id, device_id, direction, transport, action, created_at
         FROM transport_log ORDER BY sequence DESC LIMIT 100`,
      )
      .toArray()
      .map((row) => ({
        sequence: Number(row.sequence),
        commandId: typeof row.command_id === 'string' ? row.command_id : null,
        eventId: storedString(row.event_id, 'event_id'),
        deviceId: storedString(row.device_id, 'device_id'),
        direction: storedString(row.direction, 'direction'),
        transport: storedString(row.transport, 'transport'),
        action: storedString(row.action, 'action'),
        createdAt: Number(row.created_at),
      }));

    const idempotency = this.ctx.storage.sql
      .exec(
        `SELECT
           (SELECT COUNT(*) FROM command_log) AS accepted_commands,
           (SELECT COUNT(*) FROM transport_log WHERE direction = 'up' AND transport = 'journal')
             AS journal_attempts,
           (SELECT COUNT(*) FROM transport_log
             WHERE direction = 'up' AND transport = 'journal' AND action LIKE '%.replay')
             AS replayed_attempts`,
      )
      .one() as {
      readonly accepted_commands: number;
      readonly journal_attempts: number;
      readonly replayed_attempts: number;
    };
    const recentConflicts = this.ctx.storage.sql
      .exec(
        `SELECT sequence, command_id, event_id, device_id, action, entity_id, reason, created_at
         FROM conflict_log ORDER BY sequence DESC LIMIT 80`,
      )
      .toArray()
      .map((row) => ({
        sequence: Number(row.sequence),
        commandId: storedString(row.command_id, 'command_id'),
        eventId: storedString(row.event_id, 'event_id'),
        deviceId: storedString(row.device_id, 'device_id'),
        action: storedString(row.action, 'action'),
        entityId: typeof row.entity_id === 'string' ? row.entity_id : null,
        reason: storedString(row.reason, 'reason'),
        createdAt: Number(row.created_at),
      }));

    return {
      checkedAt: now,
      activeDevices: [...activeDevices, ...activeCashiers],
      recentFlows,
      recentCommands,
      recentTransport,
      idempotency: {
        acceptedCommands: idempotency.accepted_commands,
        journalAttempts: idempotency.journal_attempts,
        replayedAttempts: idempotency.replayed_attempts,
      },
      recentConflicts,
    };
  }

  #recordCommand(payload: JsonRecord): JsonRecord {
    const commandId = requiredString(payload.commandId, 'commandId');
    const eventId = requiredString(payload.eventId, 'eventId', 160);
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const action = requiredString(payload.action, 'action');
    const auditId = positiveInteger(payload.auditId, 'auditId');
    const commandPayload = isRecord(payload.payload) ? payload.payload : {};
    const createdAt = nonNegativeInteger(payload.createdAt, 'createdAt');
    this.ctx.storage.sql
      .exec(
        `INSERT OR IGNORE INTO command_log
         (command_id, event_id, device_id, action, audit_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        commandId,
        eventId,
        deviceId,
        action,
        auditId,
        JSON.stringify(commandPayload),
        createdAt,
      )
      .toArray();
    return this.#snapshot();
  }

  #recordTransport(payload: JsonRecord): JsonRecord {
    const eventId = requiredString(payload.eventId, 'eventId', 160);
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const direction = requiredString(payload.direction, 'direction', 8);
    const transport = requiredString(payload.transport, 'transport', 16);
    const action = requiredString(payload.action, 'action');
    const commandId =
      payload.commandId === null ? null : requiredString(payload.commandId, 'commandId');
    if (
      (direction !== 'up' && direction !== 'down') ||
      (transport !== 'journal' && transport !== 'websocket')
    ) {
      throw new ApiError(400, 'INVALID_INPUT', 'Direção ou transporte inválido.');
    }
    this.ctx.storage.sql
      .exec(
        `INSERT INTO transport_log
         (command_id, event_id, device_id, direction, transport, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        commandId,
        eventId,
        deviceId,
        direction,
        transport,
        action,
        Date.now(),
      )
      .toArray();
    return this.#snapshot();
  }

  #recordConflict(payload: JsonRecord): JsonRecord {
    const commandId = requiredString(payload.commandId, 'commandId');
    const eventId = requiredString(payload.eventId, 'eventId', 160);
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const action = requiredString(payload.action, 'action', 180);
    const entityId =
      payload.entityId === null ? null : requiredString(payload.entityId, 'entityId', 160);
    const reason = requiredString(payload.reason, 'reason', 240);
    const createdAt = nonNegativeInteger(payload.createdAt, 'createdAt');
    this.ctx.storage.sql
      .exec(
        `INSERT OR IGNORE INTO conflict_log
         (command_id, event_id, device_id, action, entity_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        commandId,
        eventId,
        deviceId,
        action,
        entityId,
        reason,
        createdAt,
      )
      .toArray();
    return this.#snapshot();
  }

  #enrollCashier(payload: JsonRecord): JsonRecord {
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const label = requiredString(payload.label, 'label', 60);
    const requestedEvent =
      payload.eventId === undefined ? null : requiredString(payload.eventId, 'eventId', 160);
    const eventId = requestedEvent ?? this.#activeEventId();
    if (eventId === null) {
      throw new ApiError(
        409,
        'NO_ACTIVE_EVENT',
        'Nenhum evento ativo foi informado por um computador GTRZ.',
      );
    }

    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
    const now = Date.now();
    this.ctx.storage.sql
      .exec(
        `INSERT INTO cashier_devices
         (device_id, token, label, event_id, role, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, 'cashier', ?, ?, NULL)
         ON CONFLICT(device_id) DO UPDATE SET
           token = excluded.token, label = excluded.label, event_id = excluded.event_id,
           last_seen_at = excluded.last_seen_at, revoked_at = NULL`,
        deviceId,
        token,
        label,
        eventId,
        now,
        now,
      )
      .toArray();
    return { deviceId, eventId, label, role: 'cashier', token };
  }

  #authorizeCashier(payload: JsonRecord): JsonRecord {
    const token = requiredString(payload.token, 'token', 160);
    const row = this.ctx.storage.sql
      .exec(
        `SELECT device_id, label, event_id, role FROM cashier_devices
         WHERE token = ? AND revoked_at IS NULL`,
        token,
      )
      .toArray()[0] as
      | {
          readonly device_id: string;
          readonly label: string;
          readonly event_id: string;
          readonly role: string;
        }
      | undefined;
    if (row?.role !== 'cashier') {
      throw new ApiError(
        401,
        'CASHIER_UNAUTHORIZED',
        'Este celular não está autorizado como caixa.',
      );
    }
    this.ctx.storage.sql
      .exec(
        'UPDATE cashier_devices SET last_seen_at = ? WHERE device_id = ?',
        Date.now(),
        row.device_id,
      )
      .toArray();
    return {
      deviceId: row.device_id,
      label: row.label,
      eventId: row.event_id,
      role: 'cashier',
    };
  }

  #revokeCashier(payload: JsonRecord): JsonRecord {
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    this.ctx.storage.sql
      .exec(
        `UPDATE cashier_devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
        Date.now(),
        deviceId,
      )
      .toArray();
    return { deviceId, revoked: true };
  }

  #cashierDevices(): JsonRecord {
    const devices = this.ctx.storage.sql
      .exec(
        `SELECT device_id, label, event_id, created_at, last_seen_at, revoked_at
         FROM cashier_devices ORDER BY created_at DESC LIMIT 100`,
      )
      .toArray()
      .map((row) => ({
        deviceId: storedString(row.device_id, 'device_id'),
        label: storedString(row.label, 'label'),
        eventId: storedString(row.event_id, 'event_id'),
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
        revokedAt: typeof row.revoked_at === 'number' ? row.revoked_at : null,
      }));
    return { devices };
  }

  #mobileOperators(): readonly JsonRecord[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT o.operator_id, o.name, o.role, o.permissions_json, o.active, o.created_at, o.updated_at, o.last_seen_at,
                (SELECT COUNT(*) FROM mobile_sessions s WHERE s.operator_id = o.operator_id AND s.revoked_at IS NULL) AS session_count
         FROM mobile_operators o ORDER BY o.active DESC, o.name COLLATE NOCASE`,
      )
      .toArray()
      .map((row) => this.#mobileOperatorPublic(row));
  }

  #mobileOperatorPublic(row: Record<string, unknown>): JsonRecord {
    return {
      id: storedString(row.operator_id, 'operator_id'),
      name: storedString(row.name, 'name'),
      permissions: storedMobilePermissions(row.permissions_json, row.role),
      active: Number(row.active) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastSeenAt: typeof row.last_seen_at === 'number' ? row.last_seen_at : null,
      sessionCount: Number(row.session_count ?? 0),
    };
  }

  async #createMobileOperator(payload: JsonRecord): Promise<JsonRecord> {
    const name = requiredString(payload.name, 'name', 60);
    const password = requiredString(payload.password, 'password', 128);
    if (password.length < 6)
      throw new ApiError(400, 'INVALID_INPUT', 'A senha deve possuir ao menos 6 caracteres.');
    const permissions = mobilePermissions(payload.permissions);
    const operatorId = crypto.randomUUID();
    const salt = newSalt();
    const now = Date.now();
    try {
      this.ctx.storage.sql
        .exec(
          `INSERT INTO mobile_operators
         (operator_id, name, password_salt, password_hash, role, permissions_json, active, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          operatorId,
          name,
          salt,
          await passwordHash(password, salt),
          legacyRoleFor(permissions),
          JSON.stringify(permissions),
          now,
          now,
        )
        .toArray();
    } catch {
      throw new ApiError(409, 'OPERATOR_EXISTS', 'Já existe um operador móvel com este nome.');
    }
    return this.#mobileOperatorById(operatorId);
  }

  async #updateMobileOperator(operatorId: string, payload: JsonRecord): Promise<JsonRecord> {
    requiredString(operatorId, 'operatorId', 80);
    const current = this.#mobileOperatorRow(operatorId);
    const name =
      payload.name === undefined ? current.name : requiredString(payload.name, 'name', 60);
    const permissions =
      payload.permissions === undefined
        ? storedMobilePermissions(current.permissions_json, current.role)
        : mobilePermissions(payload.permissions);
    const active =
      payload.active === undefined ? Number(current.active) === 1 : payload.active === true;
    let salt = storedString(current.password_salt, 'password_salt');
    let hash = storedString(current.password_hash, 'password_hash');
    if (payload.password !== undefined) {
      const password = requiredString(payload.password, 'password', 128);
      if (password.length < 6)
        throw new ApiError(400, 'INVALID_INPUT', 'A senha deve possuir ao menos 6 caracteres.');
      salt = newSalt();
      hash = await passwordHash(password, salt);
    }
    const now = Date.now();
    try {
      this.ctx.storage.sql
        .exec(
          `UPDATE mobile_operators SET name = ?, password_salt = ?, password_hash = ?, role = ?, permissions_json = ?, active = ?, updated_at = ?
         WHERE operator_id = ?`,
          name,
          salt,
          hash,
          legacyRoleFor(permissions),
          JSON.stringify(permissions),
          active ? 1 : 0,
          now,
          operatorId,
        )
        .toArray();
    } catch {
      throw new ApiError(409, 'OPERATOR_EXISTS', 'Já existe um operador móvel com este nome.');
    }
    if (!active || payload.password !== undefined) {
      this.#revokeMobileSessions(operatorId, !active ? 'deactivated' : 'password-required');
    } else {
      this.#notifyMobileOperator(operatorId, {
        type: 'mobile.permissions',
        operator: this.#mobileOperatorById(operatorId),
      });
    }
    return this.#mobileOperatorById(operatorId);
  }

  #endMobileSessions(operatorId: string, payload: JsonRecord): JsonRecord {
    requiredString(operatorId, 'operatorId', 80);
    this.#mobileOperatorRow(operatorId);
    const reason = payload.reason === 'signed-out' ? 'signed-out' : 'password-required';
    this.#revokeMobileSessions(operatorId, reason);
    return { success: true };
  }

  #deleteMobileOperator(operatorId: string): JsonRecord {
    requiredString(operatorId, 'operatorId', 80);
    this.#mobileOperatorRow(operatorId);
    this.#revokeMobileSessions(operatorId, 'deleted');
    this.ctx.storage.sql
      .exec('DELETE FROM mobile_sessions WHERE operator_id = ?', operatorId)
      .toArray();
    this.ctx.storage.sql
      .exec('DELETE FROM mobile_operators WHERE operator_id = ?', operatorId)
      .toArray();
    return { success: true };
  }

  async #loginMobile(payload: JsonRecord): Promise<JsonRecord> {
    const password = requiredString(payload.password, 'password', 128);
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT operator_id, name, password_salt, password_hash, role, permissions_json, active, created_at, updated_at, last_seen_at
         FROM mobile_operators WHERE active = 1`,
      )
      .toArray() as Array<Record<string, unknown>>;
    let operator: Record<string, unknown> | null = null;
    for (const row of rows) {
      const candidate = await passwordHash(
        password,
        storedString(row.password_salt, 'password_salt'),
      );
      if (candidate === storedString(row.password_hash, 'password_hash')) {
        operator = row;
        break;
      }
    }
    if (operator === null)
      throw new ApiError(
        401,
        'MOBILE_UNAUTHORIZED',
        'Senha não reconhecida ou operador desativado.',
      );
    const eventId = this.#activeEventId();
    if (eventId === null)
      throw new ApiError(409, 'NO_ACTIVE_EVENT', 'Nenhum evento ativo está disponível no momento.');
    const now = Date.now();
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
    this.ctx.storage.sql
      .exec(
        `INSERT INTO mobile_sessions (session_token, operator_id, device_id, created_at, last_seen_at, revoked_at, revoke_reason)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
        token,
        operator.operator_id,
        deviceId,
        now,
        now,
      )
      .toArray();
    this.ctx.storage.sql
      .exec(
        'UPDATE mobile_operators SET last_seen_at = ? WHERE operator_id = ?',
        now,
        operator.operator_id,
      )
      .toArray();
    return {
      token,
      eventId,
      operator: this.#mobileOperatorById(storedString(operator.operator_id, 'operator_id')),
    };
  }

  #authorizeMobile(payload: JsonRecord): JsonRecord {
    const token = requiredString(payload.token, 'token', 160);
    const row = this.ctx.storage.sql
      .exec(
        `SELECT o.operator_id, o.name, o.role, o.permissions_json, o.active, o.created_at, o.updated_at, o.last_seen_at,
              s.device_id, s.created_at AS session_created_at
       FROM mobile_sessions s JOIN mobile_operators o ON o.operator_id = s.operator_id
       WHERE s.session_token = ? AND s.revoked_at IS NULL`,
        token,
      )
      .toArray()[0] as Record<string, unknown> | undefined;
    if (row === undefined || Number(row.active) !== 1) {
      throw new ApiError(401, 'MOBILE_UNAUTHORIZED', 'A sessão móvel foi encerrada.');
    }
    const eventId = this.#activeEventId();
    if (eventId === null)
      throw new ApiError(409, 'NO_ACTIVE_EVENT', 'Nenhum evento ativo está disponível no momento.');
    const now = Date.now();
    this.ctx.storage.sql
      .exec('UPDATE mobile_sessions SET last_seen_at = ? WHERE session_token = ?', now, token)
      .toArray();
    this.ctx.storage.sql
      .exec(
        'UPDATE mobile_operators SET last_seen_at = ? WHERE operator_id = ?',
        now,
        row.operator_id,
      )
      .toArray();
    return {
      operatorId: storedString(row.operator_id, 'operator_id'),
      name: storedString(row.name, 'name'),
      permissions: storedMobilePermissions(row.permissions_json, row.role),
      deviceId: storedString(row.device_id, 'device_id'),
      eventId,
    };
  }

  #mobileOperatorRow(operatorId: string): Record<string, unknown> {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT operator_id, name, password_salt, password_hash, role, permissions_json, active, created_at, updated_at, last_seen_at
       FROM mobile_operators WHERE operator_id = ?`,
        operatorId,
      )
      .toArray()[0] as Record<string, unknown> | undefined;
    if (row === undefined)
      throw new ApiError(404, 'OPERATOR_NOT_FOUND', 'Operador móvel não encontrado.');
    return row;
  }

  #mobileOperatorById(operatorId: string): JsonRecord {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT o.operator_id, o.name, o.role, o.permissions_json, o.active, o.created_at, o.updated_at, o.last_seen_at,
              (SELECT COUNT(*) FROM mobile_sessions s WHERE s.operator_id = o.operator_id AND s.revoked_at IS NULL) AS session_count
       FROM mobile_operators o WHERE o.operator_id = ?`,
        operatorId,
      )
      .toArray()[0] as Record<string, unknown> | undefined;
    if (row === undefined)
      throw new ApiError(404, 'OPERATOR_NOT_FOUND', 'Operador móvel não encontrado.');
    return this.#mobileOperatorPublic(row);
  }

  #revokeMobileSessions(operatorId: string, reason: string): void {
    this.ctx.storage.sql
      .exec(
        `UPDATE mobile_sessions SET revoked_at = ?, revoke_reason = ? WHERE operator_id = ? AND revoked_at IS NULL`,
        Date.now(),
        reason,
        operatorId,
      )
      .toArray();
    this.#notifyMobileOperator(operatorId, { type: 'mobile.session-revoked', reason });
  }

  #openMobileSessionStream(request: Request): Response {
    if (!websocketRequested(request))
      throw new ApiError(426, 'WEBSOCKET_REQUIRED', 'Esta rota exige WebSocket.');
    const operatorId = requiredString(
      request.headers.get('X-GTRZ-Mobile-Operator'),
      'X-GTRZ-Mobile-Operator',
      80,
    );
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (client === undefined || server === undefined)
      throw new Error('Não foi possível iniciar o canal de sessão.');
    server.serializeAttachment({ operatorId });
    this.ctx.acceptWebSocket(server, ['mobile']);
    sendSocket(server, {
      type: 'mobile.permissions',
      operator: this.#mobileOperatorById(operatorId),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  #notifyMobileOperator(operatorId: string, payload: JsonRecord): void {
    for (const socket of this.ctx.getWebSockets('mobile')) {
      const attachment = socket.deserializeAttachment() as { readonly operatorId?: unknown } | null;
      if (attachment?.operatorId === operatorId) sendSocket(socket, payload);
    }
  }

  #activeEventId(): string | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT active_event_id FROM devices
         WHERE active_event_id IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .toArray()[0] as { readonly active_event_id: string } | undefined;
    return row?.active_event_id ?? null;
  }
}

export class EventRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stock (
        product_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sales (
        sale_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cashier_products (
        product_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cashier_rejections (
        original_command_id TEXT PRIMARY KEY,
        correction_command_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_context (
        context_id INTEGER PRIMARY KEY CHECK (context_id = 1),
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS print_printers (
        printer_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        device_label TEXT NOT NULL,
        printer_name TEXT NOT NULL,
        paper_width_mm INTEGER NOT NULL CHECK (paper_width_mm IN (58, 80)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        busy_job_id TEXT,
        last_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(device_id, printer_name)
      );
      CREATE TABLE IF NOT EXISTS print_jobs (
        job_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        document_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'printed', 'failed', 'uncertain')),
        assigned_printer_id TEXT,
        claim_token TEXT,
        claimed_at INTEGER,
        printed_at INTEGER,
        printed_by_device_id TEXT,
        printed_by_label TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS print_counter (
        counter_id INTEGER PRIMARY KEY CHECK (counter_id = 1),
        next_number INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS print_attempts (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        printer_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('claimed', 'printed', 'failed', 'uncertain')),
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname.endsWith('/stream')) {
        return this.#openStream(request, parseAfter(url.searchParams.get('after')));
      }

      if (request.method === 'GET' && url.pathname.endsWith('/snapshot')) {
        return json(this.#snapshot(parseAfter(url.searchParams.get('after'))));
      }

      if (request.method === 'GET' && url.pathname.endsWith('/cashier/catalog')) {
        return json(this.#cashierCatalog());
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/catalog')) {
        return json(this.#replaceCashierCatalog(await readJson(request)));
      }

      if (request.method === 'GET' && url.pathname.endsWith('/cashier/context')) {
        return json(this.#mobileContext());
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/context')) {
        return json(this.#replaceMobileContext(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/sales')) {
        return json(
          this.#commitCashierSale(
            await readJson(request),
            requiredString(
              request.headers.get('X-GTRZ-Cashier-Device'),
              'X-GTRZ-Cashier-Device',
              80,
            ),
            requiredString(request.headers.get('X-GTRZ-Cashier-Label'), 'X-GTRZ-Cashier-Label', 60),
            url.pathname.split('/')[3] ?? '',
          ),
        );
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/stock')) {
        return json(
          this.#commitMobileStock(
            await readJson(request),
            requiredString(
              request.headers.get('X-GTRZ-Cashier-Device'),
              'X-GTRZ-Cashier-Device',
              80,
            ),
            requiredString(request.headers.get('X-GTRZ-Cashier-Label'), 'X-GTRZ-Cashier-Label', 60),
            url.pathname.split('/')[3] ?? '',
          ),
        );
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/tickets')) {
        return json(
          this.#commitMobileTicketSale(
            await readJson(request),
            requiredString(
              request.headers.get('X-GTRZ-Cashier-Device'),
              'X-GTRZ-Cashier-Device',
              80,
            ),
            requiredString(request.headers.get('X-GTRZ-Cashier-Label'), 'X-GTRZ-Cashier-Label', 60),
            url.pathname.split('/')[3] ?? '',
          ),
        );
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/expenses')) {
        return json(
          this.#commitMobileExpense(
            await readJson(request),
            requiredString(
              request.headers.get('X-GTRZ-Cashier-Device'),
              'X-GTRZ-Cashier-Device',
              80,
            ),
            requiredString(request.headers.get('X-GTRZ-Cashier-Label'), 'X-GTRZ-Cashier-Label', 60),
            url.pathname.split('/')[3] ?? '',
          ),
        );
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/vouchers')) {
        return json(
          this.#commitMobileVoucher(
            await readJson(request),
            requiredString(
              request.headers.get('X-GTRZ-Cashier-Device'),
              'X-GTRZ-Cashier-Device',
              80,
            ),
            requiredString(request.headers.get('X-GTRZ-Cashier-Label'), 'X-GTRZ-Cashier-Label', 60),
            url.pathname.split('/')[3] ?? '',
          ),
        );
      }

      if (request.method === 'POST' && url.pathname.endsWith('/cashier/reject-sale')) {
        return json(
          this.#rejectCashierSale(await readJson(request), url.pathname.split('/')[3] ?? ''),
        );
      }

      if (request.method === 'POST' && url.pathname.endsWith('/print/printers')) {
        return json(this.#registerPrintPrinter(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname.endsWith('/print/claim')) {
        return json(this.#claimPrintJob(await readJson(request)));
      }

      if (request.method === 'POST' && url.pathname.endsWith('/print/complete')) {
        return json(this.#completePrintJob(await readJson(request)));
      }

      if (request.method === 'GET' && url.pathname.endsWith('/print/jobs')) {
        return json(this.#listPrintJobs());
      }

      if (request.method === 'POST' && url.pathname.endsWith('/stock')) {
        const payload = await readJson(request);
        return json(this.#setStock(payload));
      }

      if (request.method === 'POST' && url.pathname.endsWith('/sales')) {
        const payload = await readJson(request);
        return json(this.#commitSale(payload));
      }

      if (request.method === 'POST' && url.pathname.endsWith('/journal')) {
        return json(this.#commitJournal(await readJson(request), url.pathname.split('/')[3] ?? ''));
      }

      throw new ApiError(404, 'NOT_FOUND', 'Rota não encontrada.');
    } catch (error: unknown) {
      return this.#errorResponse(error);
    }
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') {
      return;
    }

    try {
      const input: unknown = JSON.parse(message);

      if (!isRecord(input) || input.type !== 'sync') {
        return;
      }

      const after =
        typeof input.after === 'string' || typeof input.after === 'number'
          ? String(input.after)
          : '0';
      sendSocket(socket, { type: 'sync', ...this.#snapshot(parseAfter(after)) });
    } catch {
      sendSocket(socket, { type: 'error', code: 'INVALID_MESSAGE' });
    }
  }

  override webSocketClose(socket: WebSocket): void {
    socket.close(1000, 'Sessão encerrada.');
  }

  #openStream(request: Request, after: number): Response {
    if (!websocketRequested(request)) {
      throw new ApiError(426, 'WEBSOCKET_REQUIRED', 'Esta rota exige WebSocket.');
    }

    const streamUrl = new URL(request.url);
    const deviceId = requiredString(
      request.headers.get('X-GTRZ-Device-Id') ??
        streamUrl.searchParams.get('deviceId') ??
        'cashier-mobile',
      'deviceId',
      80,
    );
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (client === undefined || server === undefined) {
      throw new Error('Não foi possível iniciar o canal em tempo real.');
    }

    server.serializeAttachment({ deviceId });
    this.ctx.acceptWebSocket(server, ['event']);
    sendSocket(server, { type: 'sync', ...this.#snapshot(after) });

    return new Response(null, { status: 101, webSocket: client });
  }

  #setStock(payload: JsonRecord): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const products = parseProductList(payload.products, 'products');
    const existing = this.#existingCommand(commandId);

    if (existing !== null) {
      return existing;
    }

    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();

      for (const product of products) {
        this.ctx.storage.sql
          .exec(
            `INSERT INTO stock (product_id, label, quantity, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(product_id) DO UPDATE SET
               label = excluded.label,
               quantity = excluded.quantity,
               updated_at = excluded.updated_at`,
            product.productId,
            product.label,
            product.quantity,
            now,
          )
          .toArray();
      }

      const result = { products };
      return this.#recordCommand(commandId, 'stock.replaced', result, now);
    });

    this.#broadcast(response.event);
    return response;
  }

  #cashierCatalog(): JsonRecord {
    const products = this.ctx.storage.sql
      .exec(
        `SELECT product_id, label, kind, unit_price_cents, quantity
         FROM cashier_products WHERE active = 1 ORDER BY label COLLATE NOCASE`,
      )
      .toArray()
      .map((row) => ({
        productId: storedString(row.product_id, 'product_id'),
        label: storedString(row.label, 'label'),
        kind: storedString(row.kind, 'kind'),
        unitPriceCents: Number(row.unit_price_cents),
        quantity: Number(row.quantity),
      }));
    const current = this.ctx.storage.sql
      .exec('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM event_log')
      .one() as { readonly sequence: number };
    return { products, currentSequence: current.sequence };
  }

  #mobileContextPayload(): JsonRecord {
    const row = this.ctx.storage.sql
      .exec('SELECT payload_json FROM mobile_context WHERE context_id = 1')
      .toArray()[0] as { readonly payload_json: string } | undefined;
    if (row === undefined) return { ticketLots: [], servicePoints: [], voucherCodes: [] };
    try {
      return parseStoredJson(row.payload_json);
    } catch {
      return { ticketLots: [], servicePoints: [], voucherCodes: [] };
    }
  }

  #mobileContext(): JsonRecord {
    const current = this.ctx.storage.sql
      .exec('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM event_log')
      .one() as { readonly sequence: number };
    return { ...this.#mobileContextPayload(), currentSequence: current.sequence };
  }

  #replaceMobileContext(payload: JsonRecord): JsonRecord {
    const ticketLots = Array.isArray(payload.ticketLots) ? payload.ticketLots : [];
    const servicePoints = Array.isArray(payload.servicePoints) ? payload.servicePoints : [];
    const voucherCodes = Array.isArray(payload.voucherCodes) ? payload.voucherCodes : [];
    if (ticketLots.length > 500 || servicePoints.length > 500 || voucherCodes.length > 5_000)
      throw new ApiError(400, 'INVALID_INPUT', 'Contexto móvel excede o limite permitido.');
    const normalized = { ticketLots, servicePoints, voucherCodes };
    this.ctx.storage.sql
      .exec(
        `INSERT INTO mobile_context (context_id, payload_json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(context_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
        JSON.stringify(normalized),
        Date.now(),
      )
      .toArray();
    return this.#mobileContext();
  }

  #saveMobileContext(context: JsonRecord, now: number): void {
    this.ctx.storage.sql
      .exec(
        `INSERT INTO mobile_context (context_id, payload_json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(context_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
        JSON.stringify(context),
        now,
      )
      .toArray();
  }

  #commitMobileTicketSale(
    payload: JsonRecord,
    deviceId: string,
    deviceLabel: string,
    eventId: string,
  ): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const existing = this.#existingCommand(commandId);
    if (existing !== null) return existing;
    const lotId = requiredString(payload.lotId, 'lotId');
    const attendeeName = requiredString(payload.attendeeName, 'attendeeName', 120);
    const source = requiredString(payload.source, 'source', 24);
    const quantity = positiveInteger(payload.quantity, 'quantity');
    if (!['sympla', 'whatsapp', 'door', 'courtesy'].includes(source))
      throw new ApiError(400, 'INVALID_INPUT', 'Origem de ingresso inválida.');
    const paymentMethod =
      source === 'courtesy' ? null : requiredString(payload.paymentMethod, 'paymentMethod', 24);
    if (
      paymentMethod !== null &&
      !['cash', 'pix', 'credit-card', 'debit-card'].includes(paymentMethod)
    )
      throw new ApiError(400, 'INVALID_INPUT', 'Método de pagamento inválido.');

    const context = this.#mobileContextPayload();
    const ticketLots = Array.isArray(context.ticketLots) ? context.ticketLots : [];
    const lot = ticketLots.find((item) => isRecord(item) && item.id === lotId);
    if (!isRecord(lot) || lot.active !== true || typeof lot.availableQuantity !== 'number')
      throw new ApiError(
        409,
        'TICKET_LOT_UNAVAILABLE',
        'Este lote não está disponível no celular.',
      );
    const availableQuantity = lot.availableQuantity;
    if (!Number.isSafeInteger(availableQuantity) || availableQuantity < quantity)
      throw new ApiError(
        409,
        'TICKET_CAPACITY_EXHAUSTED',
        'Não há ingressos suficientes neste lote.',
      );
    const lotName = requiredString(lot.name, 'ticketLot.name', 100);
    const unitPriceCents =
      source === 'courtesy' ? 0 : nonNegativeInteger(lot.priceCents, 'ticketLot.priceCents');
    const now = Date.now();
    const saleId = crypto.randomUUID();
    const codes = Array.from({ length: quantity }, () => ({
      id: crypto.randomUUID(),
      code: `GTRZ-${crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`,
    }));
    const nextLots = ticketLots.map((item) => {
      if (!isRecord(item) || item.id !== lotId) return item;
      return {
        ...item,
        availableQuantity: availableQuantity - quantity,
        soldQuantity: Number(item.soldQuantity ?? 0) + (source === 'courtesy' ? 0 : quantity),
        courtesyQuantity:
          Number(item.courtesyQuantity ?? 0) + (source === 'courtesy' ? quantity : 0),
      };
    });
    const journalPayload = {
      commandId,
      deviceId,
      auditId: now,
      profile: 'mobile-tickets',
      action: source === 'courtesy' ? 'ticket.courtesy-created' : 'ticket.sale-created',
      entityType: 'ticket-sale',
      entityId: saleId,
      createdAt: now,
      details: {
        attendeeName,
        codes,
        lotId,
        lotName,
        paymentMethod,
        quantity,
        source,
        totalCents: unitPriceCents * quantity,
        unitPriceCents,
        operatorName: deviceLabel,
      },
    };
    const response = this.ctx.storage.transactionSync(() => {
      this.#saveMobileContext({ ...context, ticketLots: nextLots }, now);
      return this.#recordCommand(commandId, 'journal.committed', journalPayload, now);
    });
    this.#broadcast(response.event, eventId);
    this.#recordJournalInMonitor(eventId, response.event, false);
    this.#archiveAcceptedJournal(eventId, response.event);
    return response;
  }

  #commitMobileExpense(
    payload: JsonRecord,
    deviceId: string,
    deviceLabel: string,
    eventId: string,
  ): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const existing = this.#existingCommand(commandId);
    if (existing !== null) return existing;
    const category = requiredString(payload.category, 'category', 80);
    const description = requiredString(payload.description, 'description', 160);
    const amountCents = positiveInteger(payload.amountCents, 'amountCents');
    const paymentMethod = requiredString(payload.paymentMethod, 'paymentMethod', 24);
    if (!['cash', 'pix', 'credit-card', 'debit-card'].includes(paymentMethod))
      throw new ApiError(400, 'INVALID_INPUT', 'Método de pagamento inválido.');
    const note =
      payload.note === undefined || payload.note === null
        ? null
        : requiredString(payload.note, 'note', 240);
    const now = Date.now();
    const journalPayload = {
      commandId,
      deviceId,
      auditId: now,
      profile: 'mobile-expenses',
      action: 'expense.created',
      entityType: 'expense',
      entityId: crypto.randomUUID(),
      createdAt: now,
      details: {
        amountCents,
        category,
        description,
        note,
        paymentMethod,
        paymentStatus: 'open',
        operatorName: deviceLabel,
      },
    };
    const response = this.ctx.storage.transactionSync(() =>
      this.#recordCommand(commandId, 'journal.committed', journalPayload, now),
    );
    this.#broadcast(response.event, eventId);
    this.#recordJournalInMonitor(eventId, response.event, false);
    this.#archiveAcceptedJournal(eventId, response.event);
    return response;
  }

  #commitMobileVoucher(
    payload: JsonRecord,
    deviceId: string,
    deviceLabel: string,
    eventId: string,
  ): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const existing = this.#existingCommand(commandId);
    if (existing !== null) return existing;
    const label = requiredString(payload.label, 'label', 100);
    const initialBalanceCents = positiveInteger(payload.initialBalanceCents, 'initialBalanceCents');
    const servicePointId = requiredString(payload.servicePointId, 'servicePointId');
    const context = this.#mobileContextPayload();
    const servicePoints = Array.isArray(context.servicePoints) ? context.servicePoints : [];
    if (
      !servicePoints.some(
        (point) => isRecord(point) && point.id === servicePointId && point.active === true,
      )
    )
      throw new ApiError(
        409,
        'SERVICE_POINT_UNAVAILABLE',
        'A mesa selecionada não está disponível.',
      );
    const requestedCode =
      payload.code === undefined || payload.code === null
        ? null
        : requiredString(payload.code, 'code', 32);
    const code = (requestedCode ?? `GTRZ-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`)
      .toLocaleUpperCase('pt-BR')
      .replaceAll(/\s+/gu, '-');
    if (code.length < 4) throw new ApiError(400, 'INVALID_INPUT', 'Código de voucher inválido.');
    const voucherCodes = Array.isArray(context.voucherCodes)
      ? context.voucherCodes.filter((value): value is string => typeof value === 'string')
      : [];
    if (voucherCodes.some((value) => value.toLocaleUpperCase('pt-BR') === code))
      throw new ApiError(409, 'VOUCHER_CODE_EXISTS', 'Este código de voucher já existe.');
    const now = Date.now();
    const journalPayload = {
      commandId,
      deviceId,
      auditId: now,
      profile: 'mobile-vouchers',
      action: 'voucher.created',
      entityType: 'voucher',
      entityId: crypto.randomUUID(),
      createdAt: now,
      details: { code, initialBalanceCents, label, servicePointId, operatorName: deviceLabel },
    };
    const response = this.ctx.storage.transactionSync(() => {
      this.#saveMobileContext({ ...context, voucherCodes: [...voucherCodes, code] }, now);
      return this.#recordCommand(commandId, 'journal.committed', journalPayload, now);
    });
    this.#broadcast(response.event, eventId);
    this.#recordJournalInMonitor(eventId, response.event, false);
    this.#archiveAcceptedJournal(eventId, response.event);
    return response;
  }

  #replaceCashierCatalog(payload: JsonRecord): JsonRecord {
    const rawProducts = payload.products;
    if (!Array.isArray(rawProducts) || rawProducts.length > 2_000) {
      throw new ApiError(400, 'INVALID_INPUT', 'products deve conter no máximo 2.000 itens.');
    }
    const productIds = new Set<string>();
    const products = rawProducts.map((raw, index) => {
      if (!isRecord(raw))
        throw new ApiError(400, 'INVALID_INPUT', `products[${String(index)}] é inválido.`);
      const productId = requiredString(raw.productId, `products[${String(index)}].productId`);
      if (productIds.has(productId))
        throw new ApiError(400, 'INVALID_INPUT', 'Produto duplicado no catálogo.');
      productIds.add(productId);
      return {
        productId,
        label: requiredString(raw.label, `products[${String(index)}].label`, 120),
        kind: requiredString(raw.kind, `products[${String(index)}].kind`, 24),
        unitPriceCents: nonNegativeInteger(
          raw.unitPriceCents,
          `products[${String(index)}].unitPriceCents`,
        ),
        quantity: nonNegativeInteger(raw.quantity, `products[${String(index)}].quantity`),
      };
    });
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM cashier_products').toArray();
      for (const product of products) {
        this.ctx.storage.sql
          .exec(
            `INSERT INTO cashier_products
             (product_id, label, kind, unit_price_cents, quantity, active, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?)`,
            product.productId,
            product.label,
            product.kind,
            product.unitPriceCents,
            product.quantity,
            now,
          )
          .toArray();
      }
    });
    return this.#cashierCatalog();
  }

  #commitCashierSale(
    payload: JsonRecord,
    deviceId: string,
    deviceLabel: string,
    eventId: string,
  ): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const saleId = requiredString(payload.saleId, 'saleId');
    const paymentMethod = requiredString(payload.paymentMethod, 'paymentMethod', 24);
    if (!['cash', 'pix', 'credit-card', 'debit-card'].includes(paymentMethod)) {
      throw new ApiError(400, 'INVALID_INPUT', 'Método de pagamento inválido.');
    }
    const rawItems = payload.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
      throw new ApiError(400, 'INVALID_INPUT', 'A venda deve ter entre 1 e 100 itens.');
    }
    const requested = rawItems.map((raw, index) => {
      if (!isRecord(raw))
        throw new ApiError(400, 'INVALID_INPUT', `items[${String(index)}] é inválido.`);
      return {
        productId: requiredString(raw.productId, `items[${String(index)}].productId`),
        quantity: positiveInteger(raw.quantity, `items[${String(index)}].quantity`),
      };
    });
    const distinct = new Set(requested.map((item) => item.productId));
    if (distinct.size !== requested.length)
      throw new ApiError(400, 'INVALID_INPUT', 'Produto repetido na venda.');
    const existing = this.#existingCommand(commandId);
    if (existing !== null) return existing;

    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const items = requested.map((request) => {
        const product = this.ctx.storage.sql
          .exec(
            `SELECT label, kind, unit_price_cents, quantity, active FROM cashier_products
             WHERE product_id = ?`,
            request.productId,
          )
          .toArray()[0] as
          | {
              readonly label: string;
              readonly kind: string;
              readonly unit_price_cents: number;
              readonly quantity: number;
              readonly active: number;
            }
          | undefined;
        if (product?.active !== 1) {
          throw new ApiError(
            409,
            'PRODUCT_UNAVAILABLE',
            'Um produto da venda não está disponível neste caixa.',
          );
        }
        if (product.quantity < request.quantity) {
          throw new ApiError(
            409,
            'INSUFFICIENT_STOCK',
            `Estoque insuficiente para ${product.label}.`,
          );
        }
        const totalCents = product.unit_price_cents * request.quantity;
        return { ...product, ...request, totalCents };
      });
      const totalCents = items.reduce((total, item) => total + item.totalCents, 0);
      const receivedCents =
        paymentMethod === 'cash'
          ? nonNegativeInteger(payload.receivedCents, 'receivedCents')
          : null;
      if (receivedCents !== null && receivedCents < totalCents) {
        throw new ApiError(400, 'INVALID_INPUT', 'O valor recebido não cobre o total da venda.');
      }
      const changeCents = receivedCents === null ? 0 : receivedCents - totalCents;
      for (const item of items) {
        this.ctx.storage.sql
          .exec(
            `UPDATE cashier_products SET quantity = quantity - ?, updated_at = ? WHERE product_id = ?`,
            item.quantity,
            now,
            item.productId,
          )
          .toArray();
      }
      const servicePointId = `cashier-mobile:${deviceId}`;
      const orderItems = items.map((item) => ({
        id: crypto.randomUUID(),
        itemKind: 'product',
        itemId: item.productId,
        itemName: item.label,
        quantity: item.quantity,
        unitPriceCents: item.unit_price_cents,
        totalCents: item.totalCents,
      }));
      const stockMovements = items.map((item) => ({
        id: crypto.randomUUID(),
        product_id: item.productId,
        quantity: item.quantity,
        delta: -item.quantity,
        note: `Venda no Caixa Mobile ${deviceLabel}`,
        created_at: now,
      }));
      const journalPayload = {
        commandId,
        deviceId,
        auditId: now,
        profile: 'cashier',
        action: 'operations.order-paid',
        entityType: 'order',
        entityId: saleId,
        createdAt: now,
        details: {
          discountCents: 0,
          order: {
            id: saleId,
            openedAt: now,
            servicePointId,
            servicePointLabel: `Caixa mobile · ${deviceLabel}`,
          },
          items: orderItems,
          payments: [
            {
              id: crypto.randomUUID(),
              method: paymentMethod,
              amountCents: totalCents,
              receivedCents,
              changeCents,
            },
          ],
          subtotalCents: totalCents,
          totalCents,
          totalChangeCents: changeCents,
          stockMovements,
          vouchers: [],
          operatorName: deviceLabel,
          originLabel: `Caixa mobile · ${deviceLabel}`,
        },
      };
      const result = this.#recordCommand(commandId, 'journal.committed', journalPayload, now);
      this.#enqueueReceiptJob(eventId, commandId, journalPayload);
      return result;
    });
    this.#broadcast(response.event, eventId);
    this.#recordJournalInMonitor(eventId, response.event, false);
    this.#archiveAcceptedJournal(eventId, response.event);
    return response;
  }

  #commitMobileStock(
    payload: JsonRecord,
    deviceId: string,
    deviceLabel: string,
    eventId: string,
  ): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const productId = requiredString(payload.productId, 'productId');
    const type = requiredString(payload.type, 'type', 32);
    const quantity = positiveInteger(payload.quantity, 'quantity');
    const allowedTypes = [
      'purchase',
      'correction-positive',
      'correction-negative',
      'loss',
      'breakage',
      'internal-consumption',
      'courtesy',
      'return',
    ];
    if (!allowedTypes.includes(type))
      throw new ApiError(400, 'INVALID_INPUT', 'Tipo de movimento inválido.');
    const isPositive = type === 'purchase' || type === 'correction-positive' || type === 'return';
    const delta = isPositive ? quantity : -quantity;
    const purchaseTotalCents =
      type === 'purchase'
        ? positiveInteger(payload.purchaseTotalCents, 'purchaseTotalCents')
        : null;
    const note =
      payload.note === undefined || payload.note === null
        ? null
        : requiredString(payload.note, 'note', 240);
    const existing = this.#existingCommand(commandId);
    if (existing !== null) return existing;
    const response = this.ctx.storage.transactionSync(() => {
      const product = this.ctx.storage.sql
        .exec(
          `SELECT label, quantity, active FROM cashier_products WHERE product_id = ?`,
          productId,
        )
        .toArray()[0] as
        | { readonly label: string; readonly quantity: number; readonly active: number }
        | undefined;
      if (product?.active !== 1)
        throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produto não disponível no estoque móvel.');
      const afterQuantity = product.quantity + delta;
      if (afterQuantity < 0)
        throw new ApiError(
          409,
          'INSUFFICIENT_STOCK',
          `Estoque insuficiente para ${product.label}.`,
        );
      const now = Date.now();
      this.ctx.storage.sql
        .exec(
          `UPDATE cashier_products SET quantity = ?, updated_at = ? WHERE product_id = ?`,
          afterQuantity,
          now,
          productId,
        )
        .toArray();
      const movementId = crypto.randomUUID();
      const journalPayload = {
        commandId,
        deviceId,
        auditId: now,
        profile: 'mobile-inventory',
        action: 'inventory.stock-moved',
        entityType: 'stock-movement',
        entityId: movementId,
        createdAt: now,
        details: {
          productId,
          productLabel: product.label,
          type,
          quantity,
          delta,
          beforeQuantity: product.quantity,
          afterQuantity,
          purchaseTotalCents,
          purchaseUnitCents:
            purchaseTotalCents === null ? null : Math.round(purchaseTotalCents / quantity),
          note: note ?? `Movimento móvel por ${deviceLabel}`,
          operatorName: deviceLabel,
        },
      };
      const result = this.#recordCommand(commandId, 'journal.committed', journalPayload, now);
      this.#enqueueInternalReceiptJob(eventId, commandId, journalPayload);
      return result;
    });
    this.#broadcast(response.event, eventId);
    this.#recordJournalInMonitor(eventId, response.event, false);
    this.#archiveAcceptedJournal(eventId, response.event);
    return response;
  }

  #rejectCashierSale(payload: JsonRecord, eventId: string): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const originalCommandId = requiredString(payload.originalCommandId, 'originalCommandId');
    const reason = requiredString(payload.reason, 'reason', 240);
    const existing = this.#existingCommand(commandId);
    if (existing !== null) return existing;
    const priorCorrection = this.ctx.storage.sql
      .exec(
        `SELECT correction_command_id FROM cashier_rejections WHERE original_command_id = ?`,
        originalCommandId,
      )
      .toArray()[0] as { readonly correction_command_id: string } | undefined;
    if (priorCorrection !== undefined) {
      const correction = this.#existingCommand(priorCorrection.correction_command_id);
      if (correction !== null) return correction;
    }
    const original = this.#existingCommand(originalCommandId);
    if (
      original === null ||
      !isRecord(original.event.payload) ||
      original.event.payload.action !== 'operations.order-paid'
    ) {
      throw new ApiError(404, 'SALE_NOT_FOUND', 'A venda móvel original não foi encontrada.');
    }
    const details = original.event.payload.details;
    if (!isRecord(details) || !Array.isArray(details.stockMovements)) {
      throw new ApiError(
        409,
        'SALE_INVALID',
        'A venda original não possui movimentos de estoque corrigíveis.',
      );
    }
    const movements = details.stockMovements.map((raw) => {
      if (!isRecord(raw)) throw new ApiError(409, 'SALE_INVALID', 'Movimento de estoque inválido.');
      return {
        productId: requiredString(raw.product_id, 'stockMovements.product_id'),
        quantity: positiveInteger(raw.quantity, 'stockMovements.quantity'),
      };
    });
    const response = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      for (const movement of movements) {
        this.ctx.storage.sql
          .exec(
            `UPDATE cashier_products SET quantity = quantity + ?, updated_at = ? WHERE product_id = ?`,
            movement.quantity,
            now,
            movement.productId,
          )
          .toArray();
      }
      const correctionPayload = {
        commandId,
        deviceId: 'cloud-audit',
        auditId: now,
        profile: 'production',
        action: 'cashier.sale-rejected',
        entityType: 'order',
        entityId: originalCommandId,
        createdAt: now,
        details: { originalCommandId, reason },
      };
      this.ctx.storage.sql
        .exec(
          `INSERT INTO cashier_rejections (original_command_id, correction_command_id, created_at)
           VALUES (?, ?, ?)`,
          originalCommandId,
          commandId,
          now,
        )
        .toArray();
      return this.#recordCommand(commandId, 'journal.committed', correctionPayload, now);
    });
    this.#broadcast(response.event, eventId);
    this.#recordJournalInMonitor(eventId, response.event, false);
    this.#archiveAcceptedJournal(eventId, response.event);
    return response;
  }

  #commitSale(payload: JsonRecord): CommandResponse {
    const sale = this.#parseSale(payload);
    const existing = this.#existingCommand(sale.commandId);

    if (existing !== null) {
      return existing;
    }

    const response = this.ctx.storage.transactionSync(() => {
      const existingSale = this.ctx.storage.sql
        .exec('SELECT command_id FROM sales WHERE sale_id = ?', sale.saleId)
        .toArray()[0] as { readonly command_id: string } | undefined;

      if (existingSale !== undefined) {
        throw new ApiError(409, 'SALE_ALREADY_EXISTS', 'Esta venda já foi confirmada.');
      }

      for (const item of sale.items) {
        const stock = this.ctx.storage.sql
          .exec(
            'SELECT product_id, label, quantity FROM stock WHERE product_id = ?',
            item.productId,
          )
          .toArray()[0] as
          | { readonly product_id: string; readonly label: string; readonly quantity: number }
          | undefined;

        if (stock === undefined || stock.quantity < item.quantity) {
          throw new ApiError(409, 'STOCK_INSUFFICIENT', `Estoque insuficiente para ${item.label}.`);
        }
      }

      const now = Date.now();
      for (const item of sale.items) {
        this.ctx.storage.sql
          .exec(
            `UPDATE stock
             SET quantity = quantity - ?, updated_at = ?
             WHERE product_id = ? AND quantity >= ?`,
            item.quantity,
            now,
            item.productId,
            item.quantity,
          )
          .toArray();
      }

      this.ctx.storage.sql
        .exec(
          'INSERT INTO sales (sale_id, command_id, total_cents, created_at) VALUES (?, ?, ?, ?)',
          sale.saleId,
          sale.commandId,
          sale.totalCents,
          now,
        )
        .toArray();

      const stock = sale.items.map((item) => {
        const row = this.ctx.storage.sql
          .exec(
            'SELECT product_id, label, quantity FROM stock WHERE product_id = ?',
            item.productId,
          )
          .one() as {
          readonly product_id: string;
          readonly label: string;
          readonly quantity: number;
        };
        return { productId: row.product_id, label: row.label, quantity: row.quantity };
      });

      return this.#recordCommand(
        sale.commandId,
        'sale.committed',
        { saleId: sale.saleId, totalCents: sale.totalCents, items: sale.items, stock },
        now,
      );
    });

    this.#broadcast(response.event);
    return response;
  }

  #parseSale(payload: JsonRecord): SaleInput {
    return {
      commandId: requiredString(payload.commandId, 'commandId'),
      saleId: requiredString(payload.saleId, 'saleId'),
      totalCents: nonNegativeInteger(payload.totalCents, 'totalCents'),
      items: parseProductList(payload.items, 'items'),
    };
  }

  #commitJournal(payload: JsonRecord, eventId: string): CommandResponse {
    const commandId = requiredString(payload.commandId, 'commandId');
    const existing = this.#existingCommand(commandId);
    if (existing !== null) {
      this.#recordJournalInMonitor(eventId, existing.event, true);
      return existing;
    }

    const action = requiredString(payload.action, 'action');
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const auditId = positiveInteger(payload.auditId, 'auditId');
    const createdAt = nonNegativeInteger(payload.createdAt, 'createdAt');
    const receivedDetails = isRecord(payload.details) ? payload.details : {};
    const movedProductId =
      action === 'inventory.stock-moved' && typeof receivedDetails.productId === 'string'
        ? receivedDetails.productId
        : null;
    const catalogProduct =
      movedProductId === null
        ? undefined
        : (this.ctx.storage.sql
            .exec('SELECT label FROM cashier_products WHERE product_id = ?', movedProductId)
            .toArray()[0] as { readonly label: string } | undefined);
    const details =
      catalogProduct === undefined
        ? receivedDetails
        : { ...receivedDetails, productLabel: catalogProduct.label };
    const entityType = requiredString(payload.entityType, 'entityType', 80);
    const entityId =
      payload.entityId === null ? null : requiredString(payload.entityId, 'entityId', 160);
    const profile = requiredString(payload.profile, 'profile', 32);

    const response = this.ctx.storage.transactionSync(() => {
      const result = this.#recordCommand(
        commandId,
        'journal.recorded',
        { action, auditId, createdAt, details, deviceId, entityId, entityType, profile },
        Date.now(),
      );
      if (action === 'operations.order-paid') {
        this.#enqueueReceiptJob(eventId, commandId, {
          action,
          auditId,
          createdAt,
          details,
          deviceId,
          entityId,
          entityType,
          profile,
        });
      } else if (action === 'inventory.stock-moved') {
        this.#enqueueInternalReceiptJob(eventId, commandId, {
          action,
          auditId,
          createdAt,
          details,
          deviceId,
          entityId,
          entityType,
          profile,
        });
      }
      return result;
    });
    this.#broadcast(response.event, eventId);
    this.#recordJournalInMonitor(eventId, response.event, false);
    this.#archiveAcceptedJournal(eventId, response.event);
    return response;
  }

  #archiveAcceptedJournal(eventId: string, event: StreamEvent): void {
    const archiveKey = `journal/${encodeURIComponent(eventId)}/${String(event.createdAt)}-${encodeURIComponent(event.commandId)}.json`;
    this.ctx.waitUntil(
      this.env.SYNC_AUDIT_ARCHIVE.put(
        archiveKey,
        JSON.stringify({ eventId, commandId: event.commandId, event }),
        { httpMetadata: { contentType: 'application/json' } },
      ),
    );
    this.ctx.waitUntil(
      this.env.SYNC_AUDIT_ARCHIVE.put(
        `snapshots/${encodeURIComponent(eventId)}/latest.json`,
        JSON.stringify({ exportedAt: Date.now(), eventId, snapshot: this.#snapshot(0) }),
        { httpMetadata: { contentType: 'application/json' } },
      ),
    );
  }

  #enqueueReceiptJob(eventId: string, commandId: string, payload: JsonRecord): void {
    const details = isRecord(payload.details) ? payload.details : {};
    const order = isRecord(details.order) ? details.order : {};
    const orderId =
      (typeof payload.entityId === 'string' && payload.entityId) ||
      (typeof order.id === 'string' && order.id) ||
      null;
    if (orderId === null) return;
    const idempotencyKey = `receipt:${orderId}`;
    if (this.#printJobExists(idempotencyKey)) return;

    const items = Array.isArray(details.items)
      ? details.items.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const name = typeof entry.itemName === 'string' ? entry.itemName : null;
          const quantity = typeof entry.quantity === 'number' ? entry.quantity : null;
          const unitPriceCents =
            typeof entry.unitPriceCents === 'number' ? entry.unitPriceCents : null;
          const totalCents = typeof entry.totalCents === 'number' ? entry.totalCents : null;
          return name === null ||
            quantity === null ||
            unitPriceCents === null ||
            totalCents === null
            ? []
            : [{ name, quantity, unitPriceCents, totalCents }];
        })
      : [];
    const payments: CloudReceiptDocument['payments'] = Array.isArray(details.payments)
      ? details.payments.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const method = entry.method;
          const amountCents = typeof entry.amountCents === 'number' ? entry.amountCents : null;
          if (
            amountCents === null ||
            (method !== 'cash' &&
              method !== 'pix' &&
              method !== 'credit-card' &&
              method !== 'debit-card')
          ) {
            return [];
          }
          return [
            {
              method: method as CloudReceiptDocument['payments'][number]['method'],
              amountCents,
              receivedCents: typeof entry.receivedCents === 'number' ? entry.receivedCents : null,
              changeCents: typeof entry.changeCents === 'number' ? entry.changeCents : 0,
            },
          ];
        })
      : [];
    const vouchers = Array.isArray(details.vouchers)
      ? details.vouchers.flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const code = typeof entry.code === 'string' ? entry.code : null;
          const amountCents = typeof entry.amountCents === 'number' ? entry.amountCents : null;
          return code === null || amountCents === null ? [] : [{ code, amountCents }];
        })
      : [];
    const servicePointLabel =
      typeof order.servicePointLabel === 'string' ? order.servicePointLabel : 'Caixa GTRZ';
    const document: CloudReceiptDocument = {
      orderId,
      eventName:
        typeof details.eventName === 'string'
          ? details.eventName
          : `Evento ${eventId.slice(0, 8).toUpperCase()}`,
      servicePointLabel,
      servicePointType: servicePointLabel.toLocaleLowerCase('pt-BR').includes('mesa')
        ? 'table'
        : 'counter',
      subtotalCents: typeof details.subtotalCents === 'number' ? details.subtotalCents : 0,
      discountCents: typeof details.discountCents === 'number' ? details.discountCents : 0,
      totalCents: typeof details.totalCents === 'number' ? details.totalCents : 0,
      closedAt: typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
      operatorName:
        typeof details.operatorName === 'string'
          ? details.operatorName
          : typeof payload.profile === 'string'
            ? payload.profile
            : 'Operador GTRZ',
      originLabel:
        typeof details.originLabel === 'string'
          ? details.originLabel
          : typeof details.originMachineName === 'string'
            ? details.originMachineName
            : typeof payload.deviceId === 'string'
              ? payload.deviceId
              : 'GTRZ System',
      items,
      payments,
      vouchers,
      documentType: 'sale-batch',
      referenceCode: this.#nextPrintReference(eventId),
    };
    const now = Date.now();
    this.ctx.storage.sql
      .exec(
        `INSERT OR IGNORE INTO print_jobs
         (job_id, idempotency_key, command_id, order_id, document_json, status, assigned_printer_id,
          claim_token, claimed_at, printed_at, printed_by_device_id, printed_by_label, attempts, error,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
        crypto.randomUUID(),
        idempotencyKey,
        commandId,
        orderId,
        JSON.stringify(document),
        now,
        now,
      )
      .toArray();
  }

  #enqueueInternalReceiptJob(eventId: string, commandId: string, payload: JsonRecord): void {
    const details = isRecord(payload.details) ? payload.details : {};
    const type = typeof details.type === 'string' ? details.type : null;
    if (type !== 'courtesy' && type !== 'internal-consumption') return;
    const movementId = typeof payload.entityId === 'string' ? payload.entityId : null;
    const productLabel = typeof details.productLabel === 'string' ? details.productLabel : null;
    const quantity = typeof details.quantity === 'number' ? details.quantity : null;
    if (movementId === null || productLabel === null || quantity === null) return;
    const idempotencyKey = `internal:${movementId}`;
    if (this.#printJobExists(idempotencyKey)) return;
    const note =
      typeof details.note === 'string' && details.note.trim().length > 0 ? details.note : undefined;
    const document: CloudReceiptDocument = {
      orderId: movementId,
      eventName:
        typeof details.eventName === 'string'
          ? details.eventName
          : `Evento ${eventId.slice(0, 8).toUpperCase()}`,
      servicePointLabel: 'Estoque GTRZ',
      servicePointType: 'counter',
      subtotalCents: 0,
      discountCents: 0,
      totalCents: 0,
      closedAt: typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
      operatorName:
        typeof details.operatorName === 'string'
          ? details.operatorName
          : typeof payload.profile === 'string'
            ? payload.profile
            : 'GTRZ',
      originLabel: typeof payload.deviceId === 'string' ? payload.deviceId : 'GTRZ System',
      items: [{ name: productLabel, quantity, unitPriceCents: 0, totalCents: 0 }],
      payments: [],
      vouchers: [],
      documentType: 'internal-decrement',
      internalReason: type === 'courtesy' ? 'CORTESIA' : 'CONSUMO INTERNO',
      ...(note === undefined ? {} : { recipient: note }),
      referenceCode: this.#nextPrintReference(eventId, 'BI'),
    };
    const now = Date.now();
    this.ctx.storage.sql
      .exec(
        `INSERT INTO print_jobs
         (job_id, idempotency_key, command_id, order_id, document_json, status, assigned_printer_id,
          claim_token, claimed_at, printed_at, printed_by_device_id, printed_by_label, attempts, error,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
        crypto.randomUUID(),
        idempotencyKey,
        commandId,
        movementId,
        JSON.stringify(document),
        now,
        now,
      )
      .toArray();
  }

  #printJobExists(idempotencyKey: string): boolean {
    return (
      this.ctx.storage.sql
        .exec('SELECT job_id FROM print_jobs WHERE idempotency_key = ?', idempotencyKey)
        .toArray().length > 0
    );
  }

  #nextPrintReference(eventId: string, prefix?: 'BI'): string {
    this.ctx.storage.sql
      .exec('INSERT OR IGNORE INTO print_counter (counter_id, next_number) VALUES (1, 1)')
      .toArray();
    const row = this.ctx.storage.sql
      .exec('SELECT next_number FROM print_counter WHERE counter_id = 1')
      .toArray()[0] as { readonly next_number: number };
    this.ctx.storage.sql
      .exec('UPDATE print_counter SET next_number = ? WHERE counter_id = 1', row.next_number + 1)
      .toArray();
    const number = String(row.next_number).padStart(4, '0');
    const eventCode = eventId.slice(0, 8).toUpperCase();
    return prefix === 'BI' ? `${eventCode}-BI-${number}` : `${eventCode}-${number}`;
  }

  #registerPrintPrinter(payload: JsonRecord): JsonRecord {
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const deviceLabel = requiredString(payload.deviceLabel, 'deviceLabel', 60);
    const printerName = requiredString(payload.printerName, 'printerName', 160);
    const paperWidthMm = payload.paperWidthMm === 58 ? 58 : 80;
    const enabled = payload.enabled === true;
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec(
        'SELECT printer_id FROM print_printers WHERE device_id = ? AND printer_name = ?',
        deviceId,
        printerName,
      )
      .toArray()[0] as { readonly printer_id: string } | undefined;
    const printerId = existing?.printer_id ?? crypto.randomUUID();
    this.ctx.storage.sql
      .exec(
        `INSERT INTO print_printers
         (printer_id, device_id, device_label, printer_name, paper_width_mm, enabled, busy_job_id, last_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(device_id, printer_name) DO UPDATE SET
           device_label = excluded.device_label, paper_width_mm = excluded.paper_width_mm,
           enabled = excluded.enabled, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
        printerId,
        deviceId,
        deviceLabel,
        printerName,
        paperWidthMm,
        enabled ? 1 : 0,
        now,
        now,
      )
      .toArray();
    return { printerId, registeredAt: now, enabled };
  }

  #claimPrintJob(payload: JsonRecord): JsonRecord {
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const printer = this.ctx.storage.sql
        .exec(
          `SELECT printer_id, device_label FROM print_printers
           WHERE device_id = ? AND enabled = 1 AND busy_job_id IS NULL AND last_seen_at >= ?
           ORDER BY last_seen_at DESC LIMIT 1`,
          deviceId,
          now - 45_000,
        )
        .toArray()[0] as { readonly printer_id: string; readonly device_label: string } | undefined;
      if (printer === undefined) return { job: null };
      const job = this.ctx.storage.sql
        .exec(
          `SELECT job_id, document_json FROM print_jobs WHERE status = 'queued'
           ORDER BY created_at ASC LIMIT 1`,
        )
        .toArray()[0] as { readonly job_id: string; readonly document_json: string } | undefined;
      if (job === undefined) return { job: null };

      const claimToken = crypto.randomUUID();
      this.ctx.storage.sql
        .exec(
          `UPDATE print_jobs SET status = 'claimed', assigned_printer_id = ?, claim_token = ?, claimed_at = ?,
             attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND status = 'queued'`,
          printer.printer_id,
          claimToken,
          now,
          now,
          job.job_id,
        )
        .toArray();
      this.ctx.storage.sql
        .exec(
          'UPDATE print_printers SET busy_job_id = ?, updated_at = ? WHERE printer_id = ?',
          job.job_id,
          now,
          printer.printer_id,
        )
        .toArray();
      this.ctx.storage.sql
        .exec(
          `INSERT INTO print_attempts (attempt_id, job_id, printer_id, device_id, result, error, created_at)
           VALUES (?, ?, ?, ?, 'claimed', NULL, ?)`,
          crypto.randomUUID(),
          job.job_id,
          printer.printer_id,
          deviceId,
          now,
        )
        .toArray();
      return {
        job: {
          jobId: job.job_id,
          claimToken,
          printerLabel: printer.device_label,
          document: JSON.parse(job.document_json) as CloudReceiptDocument,
        } satisfies ClaimedPrintJob & { readonly printerLabel: string },
      };
    });
  }

  #completePrintJob(payload: JsonRecord): JsonRecord {
    const jobId = requiredString(payload.jobId, 'jobId', 80);
    const claimToken = requiredString(payload.claimToken, 'claimToken', 80);
    const deviceId = requiredString(payload.deviceId, 'deviceId', 80);
    const result = requiredString(payload.result, 'result', 16);
    if (result !== 'printed' && result !== 'failed' && result !== 'uncertain') {
      throw new ApiError(400, 'INVALID_INPUT', 'Resultado de impressão inválido.');
    }
    const error = payload.error === undefined ? null : requiredString(payload.error, 'error', 240);
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.sql
        .exec(
          `SELECT assigned_printer_id FROM print_jobs
           WHERE job_id = ? AND claim_token = ? AND status = 'claimed'`,
          jobId,
          claimToken,
        )
        .toArray()[0] as { readonly assigned_printer_id: string } | undefined;
      if (job === undefined) {
        throw new ApiError(
          409,
          'PRINT_CLAIM_INVALID',
          'Este trabalho não pertence mais a este agente.',
        );
      }
      const now = Date.now();
      this.ctx.storage.sql
        .exec(
          `UPDATE print_jobs SET status = ?, printed_at = ?, printed_by_device_id = ?,
             printed_by_label = (SELECT device_label FROM print_printers WHERE printer_id = ?),
             error = ?, updated_at = ? WHERE job_id = ?`,
          result,
          result === 'printed' ? now : null,
          deviceId,
          job.assigned_printer_id,
          error,
          now,
          jobId,
        )
        .toArray();
      this.ctx.storage.sql
        .exec(
          'UPDATE print_printers SET busy_job_id = NULL, updated_at = ? WHERE printer_id = ?',
          now,
          job.assigned_printer_id,
        )
        .toArray();
      this.ctx.storage.sql
        .exec(
          `INSERT INTO print_attempts (attempt_id, job_id, printer_id, device_id, result, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          jobId,
          job.assigned_printer_id,
          deviceId,
          result,
          error,
          now,
        )
        .toArray();
      return { success: true, status: result, completedAt: now };
    });
  }

  #listPrintJobs(): JsonRecord {
    const jobs = this.ctx.storage.sql
      .exec(
        `SELECT job_id, command_id, order_id, document_json, status, printed_by_label, attempts,
                error, created_at, claimed_at, printed_at
         FROM print_jobs ORDER BY created_at DESC LIMIT 100`,
      )
      .toArray()
      .map((row) => ({
        jobId: storedString(row.job_id, 'job_id'),
        commandId: storedString(row.command_id, 'command_id'),
        orderId: storedString(row.order_id, 'order_id'),
        document: JSON.parse(
          storedString(row.document_json, 'document_json'),
        ) as CloudReceiptDocument,
        status: storedString(row.status, 'status'),
        printedByLabel:
          row.printed_by_label === null
            ? null
            : storedString(row.printed_by_label, 'printed_by_label'),
        attempts: Number(row.attempts),
        error: row.error === null ? null : storedString(row.error, 'error'),
        createdAt: Number(row.created_at),
        claimedAt: row.claimed_at === null ? null : Number(row.claimed_at),
        printedAt: row.printed_at === null ? null : Number(row.printed_at),
      }));
    return { jobs };
  }

  #recordJournalInMonitor(eventId: string, event: StreamEvent, idempotentReplay: boolean): void {
    const payload = event.payload;
    this.ctx.waitUntil(
      this.env.MONITOR_ROOM.get(this.env.MONITOR_ROOM.idFromName('gtrz-monitor')).fetch(
        new Request('https://monitor.internal/v1/monitor/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commandId: event.commandId,
            eventId,
            deviceId: payload.deviceId,
            action: payload.action,
            auditId: payload.auditId,
            payload,
            createdAt: event.createdAt,
            idempotentReplay,
          }),
        }),
      ),
    );
    this.ctx.waitUntil(
      this.env.MONITOR_ROOM.get(this.env.MONITOR_ROOM.idFromName('gtrz-monitor')).fetch(
        new Request('https://monitor.internal/v1/monitor/transport', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commandId: event.commandId,
            eventId,
            deviceId: payload.deviceId,
            direction: 'up',
            transport: 'journal',
            action: idempotentReplay ? `${String(payload.action)}.replay` : payload.action,
          }),
        }),
      ),
    );
  }

  #existingCommand(commandId: string): CommandResponse | null {
    const row = this.ctx.storage.sql
      .exec('SELECT response_json FROM commands WHERE command_id = ?', commandId)
      .toArray()[0] as { readonly response_json: string } | undefined;

    if (row === undefined) {
      return null;
    }

    const response = parseStoredJson(row.response_json);

    if (
      typeof response.commandId !== 'string' ||
      !isRecord(response.event) ||
      !isRecord(response.result)
    ) {
      throw new Error('Resposta persistida em formato inválido.');
    }

    return response as unknown as CommandResponse;
  }

  #recordCommand(
    commandId: string,
    type: string,
    result: JsonRecord,
    now: number,
  ): CommandResponse {
    this.ctx.storage.sql
      .exec(
        'INSERT INTO event_log (command_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        commandId,
        type,
        JSON.stringify(result),
        now,
      )
      .toArray();
    const eventRow = this.ctx.storage.sql
      .exec(
        `SELECT sequence, command_id, type, payload_json, created_at
         FROM event_log WHERE command_id = ?`,
        commandId,
      )
      .one() as {
      readonly sequence: number;
      readonly command_id: string;
      readonly type: string;
      readonly payload_json: string;
      readonly created_at: number;
    };
    const event: StreamEvent = {
      sequence: eventRow.sequence,
      commandId: eventRow.command_id,
      type: eventRow.type,
      payload: parseStoredJson(eventRow.payload_json),
      createdAt: eventRow.created_at,
    };
    const response: CommandResponse = { commandId, event, result };

    this.ctx.storage.sql
      .exec(
        'INSERT INTO commands (command_id, response_json, created_at) VALUES (?, ?, ?)',
        commandId,
        JSON.stringify(response),
        now,
      )
      .toArray();

    return response;
  }

  #snapshot(after: number): JsonRecord {
    const stock = this.ctx.storage.sql
      .exec(
        'SELECT product_id, label, quantity, updated_at FROM stock ORDER BY label COLLATE NOCASE',
      )
      .toArray()
      .map((row) => ({
        productId: storedString(row.product_id, 'product_id'),
        label: storedString(row.label, 'label'),
        quantity: Number(row.quantity),
        updatedAt: Number(row.updated_at),
      }));
    const events = this.ctx.storage.sql
      .exec(
        `SELECT sequence, command_id, type, payload_json, created_at
         FROM event_log WHERE sequence > ? ORDER BY sequence ASC LIMIT 2_000`,
        after,
      )
      .toArray()
      .map(
        (row): StreamEvent => ({
          sequence: Number(row.sequence),
          commandId: storedString(row.command_id, 'command_id'),
          type: storedString(row.type, 'type'),
          payload: parseStoredJson(storedString(row.payload_json, 'payload_json')),
          createdAt: Number(row.created_at),
        }),
      );
    const current = this.ctx.storage.sql
      .exec('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM event_log')
      .one() as { readonly sequence: number };

    return { currentSequence: current.sequence, stock, events };
  }

  #broadcast(event: StreamEvent, eventId?: string): void {
    for (const socket of this.ctx.getWebSockets('event')) {
      sendSocket(socket, { type: 'event', event });
      if (eventId !== undefined) {
        const attachment = socket.deserializeAttachment() as { readonly deviceId?: unknown } | null;
        const deviceId = typeof attachment?.deviceId === 'string' ? attachment.deviceId : null;
        if (deviceId !== null) {
          this.#recordSocketPushInMonitor(eventId, event, deviceId);
        }
      }
    }
  }

  #recordSocketPushInMonitor(eventId: string, event: StreamEvent, deviceId: string): void {
    const action = typeof event.payload.action === 'string' ? event.payload.action : event.type;
    this.ctx.waitUntil(
      this.env.MONITOR_ROOM.get(this.env.MONITOR_ROOM.idFromName('gtrz-monitor')).fetch(
        new Request('https://monitor.internal/v1/monitor/transport', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commandId: event.commandId,
            eventId,
            deviceId,
            direction: 'down',
            transport: 'websocket',
            action,
          }),
        }),
      ),
    );
  }

  #errorResponse(error: unknown): Response {
    if (error instanceof ApiError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }

    console.error(error);
    return json(
      { error: { code: 'INTERNAL_ERROR', message: 'Falha inesperada no servidor.' } },
      500,
    );
  }
}

function authorized(request: Request, env: Env): boolean {
  const key = env.GTRZ_SYNC_KEY;
  return key !== undefined && request.headers.get('X-GTRZ-Key') === key;
}

interface CashierAuthorization {
  readonly deviceId: string;
  readonly label: string;
  readonly eventId: string;
  readonly token: string;
}

interface MobileAuthorization {
  readonly operatorId: string;
  readonly name: string;
  readonly permissions: MobilePermissions;
  readonly deviceId: string;
  readonly eventId: string;
  readonly token: string;
}

function cashierSessionCookie(token: string): string {
  return `gtrz_cashier=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000`;
}

function refreshCashierSession(response: Response, token: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cashierSessionCookie(token));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function authorizeCashier(request: Request, env: Env): Promise<CashierAuthorization | null> {
  const token = cashierToken(request);
  if (token === null) return null;
  const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
  const response = await monitor.fetch(
    new Request('https://monitor.internal/v1/cashier/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  );
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.role !== 'cashier') return null;
  if (
    typeof payload.deviceId !== 'string' ||
    typeof payload.label !== 'string' ||
    typeof payload.eventId !== 'string'
  )
    return null;
  return { deviceId: payload.deviceId, label: payload.label, eventId: payload.eventId, token };
}

function mobileSessionCookie(token: string): string {
  return `gtrz_mobile=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000`;
}

async function authorizeMobile(request: Request, env: Env): Promise<MobileAuthorization | null> {
  const token = mobileToken(request);
  if (token === null) return null;
  const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
  const response = await monitor.fetch(
    new Request('https://monitor.internal/v1/mobile/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  );
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.operatorId !== 'string' ||
    typeof payload.name !== 'string' ||
    typeof payload.deviceId !== 'string' ||
    typeof payload.eventId !== 'string'
  )
    return null;
  let permissions: MobilePermissions;
  try {
    permissions = mobilePermissions(payload.permissions);
  } catch {
    return null;
  }
  return {
    operatorId: payload.operatorId,
    name: payload.name,
    permissions,
    deviceId: payload.deviceId,
    eventId: payload.eventId,
    token,
  };
}

function eventRequest(url: URL): boolean {
  return /^\/v1\/events\/[^/]+\/(stock|sales|journal|snapshot|stream|print\/(printers|claim|complete|jobs)|cashier\/(catalog|context|sales|stock|tickets|expenses|vouchers|reject-sale))$/.test(
    url.pathname,
  );
}

function cashierApiRequest(url: URL): boolean {
  return /^\/v1\/cashier\/(catalog|sales|stream)$/.test(url.pathname);
}

function mobileApiRequest(url: URL): boolean {
  return /^\/v1\/mobile\/(catalog|context|sales|stock|tickets|expenses|vouchers|stream|session|session\/stream)$/.test(
    url.pathname,
  );
}

function monitorRequest(url: URL): boolean {
  return /^\/v1\/monitor\/(heartbeat|snapshot|command|transport|conflict)$/.test(url.pathname);
}

export function legacyMonitorPage(): Response {
  return new Response(
    `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GTRZ System · Nuvem</title>
<style>
:root{color-scheme:dark;--bg:#0d0d10;--surface:#17171b;--raised:#202026;--border:#34343d;--text:#f5f5f7;--muted:#a2a2ad;--brand:#f20d32;--brand-soft:#45111d;--success:#4ade80;--success-soft:#12341f;--warn:#f5b82e;--warn-soft:#3c2c0e}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#3c111d 0,transparent 28rem),var(--bg);color:var(--text);font-family:Inter,Segoe UI,Arial,sans-serif}main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:42px 0 64px}.brand{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:28px;border-bottom:1px solid var(--border)}.brand small,.eyebrow{color:var(--brand);font-weight:800;letter-spacing:.1em;text-transform:uppercase;font-size:.68rem}.brand h1{margin:5px 0 0;font-size:1.65rem}.brand p{margin:5px 0 0;color:var(--muted);font-size:.88rem}.lock{display:flex;gap:10px;align-items:center;border:1px solid var(--border);background:var(--surface);padding:8px;border-radius:8px}.lock input{width:min(340px,45vw);height:38px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--text);padding:0 10px}.lock button,.refresh{height:38px;border:0;border-radius:6px;background:var(--brand);color:#fff;font-weight:800;cursor:pointer;padding:0 14px}.lock button:disabled,.refresh:disabled{opacity:.55;cursor:wait}.notice{margin:22px 0;padding:12px 14px;border-radius:6px;background:var(--warn-soft);color:#ffd775;font-size:.82rem}.notice.ok{background:var(--success-soft);color:#a7f3c3}.hidden{display:none}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:22px 0}.metric,.panel,.flow{border:1px solid var(--border);background:linear-gradient(145deg,#1b1b20,#131317);border-radius:8px}.metric{padding:18px}.metric span,.metric small{display:block;color:var(--muted);font-size:.75rem}.metric strong{display:block;margin:7px 0;font-size:1.5rem}.flow{display:grid;grid-template-columns:1fr 80px 1fr 80px 1fr;align-items:center;gap:12px;padding:18px;margin-bottom:14px}.node{min-height:104px;display:grid;place-content:center;gap:5px;text-align:center;border:1px solid var(--border);border-radius:7px;background:var(--raised)}.node.central{border-color:#772235;background:var(--brand-soft)}.node b{font-size:.86rem}.node span{color:var(--muted);font-size:.72rem}.line{height:1px;background:var(--border);overflow:hidden}.line i{display:block;width:35%;height:100%;background:var(--brand);animation:move 1.7s linear infinite}@keyframes move{from{transform:translateX(-100%)}to{transform:translateX(320%)}}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.panel{padding:18px}.panel h2{margin:0;font-size:1rem}.panel p{margin:5px 0 14px;color:var(--muted);font-size:.77rem}.row{display:grid;grid-template-columns:10px 1fr auto;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)}.row:last-child{border:0}.dot{width:9px;height:9px;border-radius:50%;background:var(--success);box-shadow:0 0 0 4px var(--success-soft)}.pulse{background:var(--brand);box-shadow:0 0 0 4px var(--brand-soft)}.row b,.row small{display:block}.row b{font-size:.82rem}.row small,.row time{color:var(--muted);font-size:.7rem}.row em{color:var(--success);font-size:.75rem;font-style:normal;font-weight:800}.empty{display:grid;min-height:150px;place-content:center;color:var(--muted);font-size:.82rem;text-align:center}@media(max-width:760px){.brand,.lock{align-items:flex-start;flex-direction:column}.lock input{width:100%}.metrics,.grid{grid-template-columns:1fr}.flow{grid-template-columns:1fr}.line{width:1px;height:28px;margin:auto}.line i{width:100%;height:35%;animation-name:movev}@keyframes movev{from{transform:translateY(-100%)}to{transform:translateY(320%)}}}
</style>
</head>
<body><main>
  <header class="brand"><div><span class="eyebrow">GTRZ System · Cloudflare</span><h1>Nuvem em tempo real</h1><p>Dispositivos, latência e sinais confirmados pela central.</p></div><form class="lock" id="access"><input id="key" autocomplete="off" placeholder="Chave de pareamento" required type="password"><button>Conectar</button></form></header>
  <p class="notice" id="notice">Informe a chave de pareamento para visualizar o painel protegido.</p>
  <section class="hidden" id="dashboard"><div class="metrics"><article class="metric"><span>Dispositivos ativos</span><strong id="devices">—</strong><small>Expiram após 45 segundos sem sinal</small></article><article class="metric"><span>Latência média</span><strong id="latency">—</strong><small>Medida pelos aplicativos GTRZ</small></article><article class="metric"><span>Central Cloudflare</span><strong>Online</strong><small>Atualiza automaticamente a cada 5 segundos</small></article></div><section class="flow"><div class="node"><b>Computadores GTRZ</b><span>Comandos locais</span></div><div class="line"><i></i></div><div class="node central"><b>Cloudflare</b><span>Diário transacional</span></div><div class="line"><i></i></div><div class="node"><b>Outros computadores</b><span id="others">0 ativos</span></div></section><div class="grid"><section class="panel"><h2>Máquinas conectadas</h2><p>Presença enviada pelo aplicativo instalado.</p><div id="device-list"></div></section><section class="panel"><h2>Comandos confirmados</h2><p>Diário central com idempotência por comando.</p><div id="flow-list"></div></section></div></section>
</main><script>
let accessKey='';let timer=null;const $=id=>document.getElementById(id);const esc=value=>String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));const time=value=>new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(value);async function refresh(){if(!accessKey)return;try{const response=await fetch('/v1/monitor/snapshot',{headers:{'X-GTRZ-Key':accessKey}});if(!response.ok)throw new Error(response.status===401?'Chave de pareamento inválida.':'A central não respondeu.');const data=await response.json();const devices=data.activeDevices||[],commands=data.recentCommands||[];const average=devices.length?Math.round(devices.reduce((sum,item)=>sum+item.latencyMs,0)/devices.length):null;$('devices').textContent=devices.length;$('latency').textContent=average===null?'—':average+' ms';$('others').textContent=Math.max(devices.length-1,0)+' ativos';$('device-list').innerHTML=devices.length?devices.map(item=>'<article class="row"><i class="dot"></i><div><b>'+esc(item.label)+'</b><small>ID '+esc(item.id.slice(0,8).toUpperCase())+' · visto '+time(item.lastSeenAt)+'</small></div><em>'+item.latencyMs+' ms</em></article>').join(''):'<p class="empty">Nenhum computador respondeu ainda.</p>';$('flow-list').innerHTML=commands.length?commands.map(item=>'<article class="row"><i class="dot pulse"></i><div><b>'+esc(item.action)+'</b><small>Evento '+esc(item.eventId.slice(0,8).toUpperCase())+' · comando '+esc(item.commandId.slice(-8).toUpperCase())+'</small></div><time>'+time(item.createdAt)+'</time></article>').join(''):'<p class="empty">Aguardando o primeiro comando confirmado.</p>';$('notice').className='notice ok';$('notice').textContent='Conexão protegida ativa. Dados atualizados às '+time(Date.now())+'.';$('dashboard').className=''}catch(error){$('notice').className='notice';$('notice').textContent=error.message||'Não foi possível consultar a central.';$('dashboard').className='hidden'}}$('access').addEventListener('submit',event=>{event.preventDefault();accessKey=$('key').value;refresh();if(timer)clearInterval(timer);timer=setInterval(refresh,5000)});</script></body></html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        status: 'ok',
        service: isTestEnvironment(env) ? 'gtrz-sync-test' : 'gtrz-sync',
      });
    }

    if (request.method === 'GET' && url.pathname === '/monitor') {
      return monitorPage({ environment: isTestEnvironment(env) ? 'test' : 'production' });
    }

    if (request.method === 'GET' && url.pathname === '/print-queue') {
      return printQueuePage();
    }

    if (request.method === 'GET' && url.pathname === '/cashier') {
      return cashierPage({ environment: isTestEnvironment(env) ? 'test' : 'production' });
    }

    if (request.method === 'GET' && url.pathname === '/cashier/manifest.webmanifest') {
      return cashierManifest({ environment: isTestEnvironment(env) ? 'test' : 'production' });
    }

    if (request.method === 'GET' && url.pathname === '/cashier/icon.svg') {
      return cashierIcon();
    }

    if (request.method === 'GET' && url.pathname === '/v1/verify') {
      if (!authorized(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
      }

      return json({
        status: 'ok',
        service: isTestEnvironment(env) ? 'gtrz-sync-test' : 'gtrz-sync',
      });
    }

    if (request.method === 'POST' && url.pathname === '/v1/cashier/enroll') {
      if (!authorized(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
      }
      const input = await readJson(request);
      const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
      const enrolled = await monitor.fetch(
        new Request('https://monitor.internal/v1/cashier/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
      const enrollment: unknown = await enrolled.json();
      if (!enrolled.ok || !isRecord(enrollment) || typeof enrollment.token !== 'string') {
        return json(enrollment, enrolled.status);
      }
      const { token, ...device } = enrollment;
      return json(device, 200, {
        'Set-Cookie': cashierSessionCookie(token),
      });
    }

    if (request.method === 'GET' && url.pathname === '/v1/monitor/cashiers') {
      if (!authorized(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
      }
      const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
      return monitor.fetch(new Request('https://monitor.internal/v1/cashier/devices'));
    }

    if (request.method === 'POST' && url.pathname === '/v1/cashier/revoke') {
      if (!authorized(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
      }
      const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
      return monitor.fetch(
        new Request('https://monitor.internal/v1/cashier/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await readJson(request)),
        }),
      );
    }

    if (request.method === 'POST' && url.pathname === '/v1/mobile/session') {
      const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
      const response = await monitor.fetch(
        new Request('https://monitor.internal/v1/mobile/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await readJson(request)),
        }),
      );
      const payload: unknown = await response.json();
      if (!response.ok || !isRecord(payload) || typeof payload.token !== 'string')
        return json(payload, response.status);
      const { token, ...session } = payload;
      return json(session, 200, { 'Set-Cookie': mobileSessionCookie(token) });
    }

    if (/^\/v1\/mobile\/operators(?:\/[^/]+(?:\/sessions)?)?$/.test(url.pathname)) {
      if (!authorized(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
      }
      const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
      const target = new URL(`https://monitor.internal${url.pathname}`);
      return monitor.fetch(
        new Request(target, {
          method: request.method,
          headers: { 'Content-Type': 'application/json' },
          ...(request.method === 'GET' ? {} : { body: await request.text() }),
        }),
      );
    }

    if (mobileApiRequest(url)) {
      const mobile = await authorizeMobile(request, env);
      if (mobile === null) {
        return json(
          {
            error: {
              code: 'MOBILE_UNAUTHORIZED',
              message: 'A sessão móvel expirou ou foi encerrada.',
            },
          },
          401,
        );
      }
      if (url.pathname === '/v1/mobile/session') {
        return json({
          operator: { id: mobile.operatorId, name: mobile.name, permissions: mobile.permissions },
          eventId: mobile.eventId,
        });
      }
      if (url.pathname === '/v1/mobile/session/stream') {
        const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
        const headers = new Headers(request.headers);
        headers.set('X-GTRZ-Mobile-Operator', mobile.operatorId);
        return monitor.fetch(
          new Request('https://monitor.internal/v1/mobile/session/stream', { headers }),
        );
      }
      const permission =
        url.pathname === '/v1/mobile/sales'
          ? 'sales'
          : url.pathname === '/v1/mobile/stock'
            ? 'inventory'
            : url.pathname === '/v1/mobile/tickets'
              ? 'tickets'
              : url.pathname === '/v1/mobile/expenses'
                ? 'expenses'
                : url.pathname === '/v1/mobile/vouchers'
                  ? 'vouchers'
                  : null;
      if (permission !== null && !mobile.permissions[permission]) {
        return json(
          {
            error: { code: 'MOBILE_FORBIDDEN', message: 'Este perfil não possui esta permissão.' },
          },
          403,
        );
      }
      const suffix = url.pathname.slice('/v1/mobile/'.length);
      const targetSuffix =
        suffix === 'catalog' ? 'catalog' : suffix === 'stream' ? 'stream' : suffix;
      const room = env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(`event:${mobile.eventId}`));
      const targetUrl = new URL(
        `https://event.internal/v1/events/${encodeURIComponent(mobile.eventId)}/cashier/${targetSuffix}`,
      );
      targetUrl.search = url.search;
      const headers = new Headers(request.headers);
      headers.set(
        'X-GTRZ-Cashier-Device',
        `mobile:${mobile.operatorId}:${mobile.deviceId}`.slice(0, 80),
      );
      headers.set('X-GTRZ-Cashier-Label', mobile.name);
      if (suffix === 'stream') return room.fetch(request);
      const response = await room.fetch(
        new Request(targetUrl, {
          method: request.method,
          headers,
          ...(request.method === 'POST' ? { body: await request.text() } : {}),
        }),
      );
      if (suffix === 'context' && response.ok) {
        const context: unknown = await response.json();
        if (isRecord(context)) {
          return refreshCashierSession(
            json({
              ...context,
              ticketLots: mobile.permissions.tickets ? context.ticketLots : [],
              servicePoints: mobile.permissions.vouchers ? context.servicePoints : [],
              voucherCodes: mobile.permissions.vouchers ? context.voucherCodes : [],
            }),
            mobile.token,
          );
        }
      }
      return refreshCashierSession(response, mobile.token);
    }

    if (cashierApiRequest(url)) {
      const cashier = await authorizeCashier(request, env);
      if (cashier === null) {
        return json(
          { error: { code: 'CASHIER_UNAUTHORIZED', message: 'Celular de caixa não autorizado.' } },
          401,
        );
      }
      const suffix = url.pathname.slice('/v1/cashier/'.length);
      const targetUrl = new URL(
        `https://event.internal/v1/events/${encodeURIComponent(cashier.eventId)}/cashier/${suffix}`,
      );
      targetUrl.search = url.search;
      const headers = new Headers(request.headers);
      headers.set('X-GTRZ-Cashier-Device', cashier.deviceId);
      headers.set('X-GTRZ-Cashier-Label', cashier.label);
      const room = env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(`event:${cashier.eventId}`));
      if (suffix === 'stream') {
        // Preserve the original Upgrade request when handing it to the Durable Object.
        return room.fetch(request);
      }
      if (request.method === 'POST') {
        return refreshCashierSession(
          await room.fetch(
            new Request(targetUrl, { method: 'POST', headers, body: await request.text() }),
          ),
          cashier.token,
        );
      }
      return refreshCashierSession(
        await room.fetch(new Request(targetUrl, { method: request.method, headers })),
        cashier.token,
      );
    }

    if (request.method === 'GET' && url.pathname === '/v1/monitor/archive') {
      if (!authorized(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
      }

      const eventId = url.searchParams.get('eventId');
      const prefix = eventId === null ? '' : `${encodeURIComponent(eventId)}/`;
      const objects = await env.SYNC_AUDIT_ARCHIVE.list({ prefix, limit: 100 });
      return json({
        objects: objects.objects.map((object) => ({
          key: object.key,
          size: object.size,
          uploadedAt: object.uploaded.getTime(),
          etag: object.etag,
        })),
        truncated: objects.truncated,
      });
    }

    if (monitorRequest(url)) {
      if (!authorized(request, env)) {
        return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
      }

      const monitor = env.MONITOR_ROOM.get(env.MONITOR_ROOM.idFromName('gtrz-monitor'));
      return monitor.fetch(request);
    }

    if (!eventRequest(url)) {
      return json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }, 404);
    }

    if (!authorized(request, env)) {
      return json({ error: { code: 'UNAUTHORIZED', message: 'Chave de acesso inválida.' } }, 401);
    }

    const eventId = decodeURIComponent(url.pathname.split('/')[3] ?? '');

    try {
      requiredString(eventId, 'eventId', 160);
    } catch (error: unknown) {
      const apiError = error as ApiError;
      return json({ error: { code: apiError.code, message: apiError.message } }, apiError.status);
    }

    const room = env.EVENT_ROOM.get(env.EVENT_ROOM.idFromName(`event:${eventId}`));
    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;
