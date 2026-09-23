import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';

import {
  mobileOperatorListSchema,
  mobileOperatorSchema,
  type CreateMobileOperatorInput,
  type DeleteMobileOperatorInput,
  type EndMobileOperatorSessionsInput,
  type MobileOperator,
  type UpdateMobileOperatorInput,
  cloudMonitorSchema,
  type CloudMonitor,
  type CloudSyncStatus,
  type BackupRecord,
} from '@gtrz/contracts';
import {
  getSessionState,
  listCombos,
  redeemVouchers,
  refundOrderVouchers,
  resetEventData,
  setActiveEvent,
  type DatabaseContext,
} from '@gtrz/database';
import { getProductPresentation } from '@gtrz/database/product-presentation';
import { getPrintingSettings } from '@gtrz/database/printing';

const CONNECTION_TIMEOUT_MS = 5_000;
const OUTBOX_INTERVAL_MS = 3_000;
const STREAM_RECONNECT_MAX_MS = 60_000;

interface AuditRow {
  readonly id: number;
  readonly event_id: string | null;
  readonly profile: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly details_json: string;
  readonly created_at: number;
}

interface OutboxRow {
  readonly audit_id: number;
  readonly operation_id: string;
  readonly event_id: string;
  readonly payload_json: string;
}

interface RemoteJournalEvent {
  readonly sequence: number;
  readonly commandId: string;
  readonly type: string;
  readonly payload: unknown;
}

interface StreamMessageResult {
  readonly accepted: boolean;
  readonly printQueued: boolean;
}

interface QueueCountsRow {
  readonly outbox_pending: number;
  readonly outbox_accepted: number;
  readonly outbox_failed: number;
  readonly inbox_received: number;
  readonly inbox_awaiting_apply: number;
  readonly conflicts_open: number;
}

interface ConflictRow {
  readonly command_id: string;
  readonly event_id: string;
  readonly action: string;
  readonly entity_id: string | null;
  readonly reason: string;
  readonly created_at: number;
}

interface JournalPayload {
  readonly action: string;
  readonly deviceId: string;
  readonly entityId: string | null;
  readonly details: Record<string, unknown>;
  readonly createdAt: number;
}

interface InboxRow {
  readonly event_id: string;
  readonly sequence: number;
  readonly command_id: string;
  readonly payload_json: string;
}

interface RecoverableConflictRow {
  readonly command_id: string;
  readonly event_id: string;
  readonly payload_json: string;
}

interface GlobalEventCommand {
  readonly sequence: number;
  readonly commandId: string;
  readonly type: 'event.activated' | 'event.reset';
  readonly eventId: string;
  readonly eventName: string;
  readonly reason: string | null;
}

interface PendingGlobalReset {
  readonly requestId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly reason: string;
  readonly targetDeviceIds: readonly string[];
}

export interface CloudPrintReceipt {
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
    readonly preparation?: readonly {
      readonly label: string;
      readonly productName: string;
      readonly quantity: number;
    }[];
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

export interface ClaimedCloudPrintJob {
  readonly jobId: string;
  readonly claimToken: string;
  readonly printerLabel: string;
  readonly document: CloudPrintReceipt;
}

interface PrintAgentResult {
  readonly success: boolean;
  readonly message: string;
}

const CATALOG_EVENT_ID = '_catalog';
const SYNCHRONIZED_ACTIONS = new Set([
  'event.created',
  'inventory.category-created',
  'inventory.category-updated',
  'inventory.category-deleted',
  'inventory.product-created',
  'inventory.product-updated',
  'inventory.product-deleted',
  'inventory.stock-moved',
  'inventory.purchase-lot-corrected',
  'inventory.purchase-lot-voided',
  'food.configured',
  'food.supplier-created',
  'food.supplier-updated',
  'food.supplier-archived',
  'food.supplier-deleted',
  'food.external-item-created',
  'operations.service-point-created',
  'operations.service-point-renamed',
  'operations.service-point-pinned',
  'operations.service-point-deleted',
  'operations.order-paid',
  'operations.order-cancelled',
  'expense.created',
  'expense.updated',
  'expense.payment-status-changed',
  'expense.payment-recorded',
  'expense.cancelled',
  'expense.deleted',
  'capital.contribution-created',
  'capital.contribution-updated',
  'capital.reimbursed',
  'cash.opened',
  'cash.supply',
  'cash.withdrawal',
  'cash.closed',
  'voucher.created',
  'voucher.service-point-bound',
  'voucher.updated',
  'voucher.balance-added',
  'voucher.cancelled',
  'voucher.active',
  'voucher.deleted',
  'voucher.deleted-with-reversal',
  'ticket.lot-created',
  'ticket.lot-updated',
  'ticket.sale-created',
  'ticket.courtesy-created',
  'ticket.sale-cancelled',
  'ticket.lot-deleted',
  'ticket.sale-deleted',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRemoteJournalEvent(value: unknown): value is RemoteJournalEvent {
  return (
    isRecord(value) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.commandId === 'string' &&
    typeof value.type === 'string'
  );
}

function stringField(value: Record<string, unknown>, field: string): string | null {
  const candidate = value[field];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function integerField(value: Record<string, unknown>, field: string): number | null {
  const candidate = value[field];
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : null;
}

function websocketMessageText(message: RawData): string {
  if (Array.isArray(message)) return Buffer.concat(message).toString('utf8');
  if (Buffer.isBuffer(message)) return message.toString('utf8');
  return Buffer.from(message).toString('utf8');
}

function journalPayload(value: unknown): JournalPayload | null {
  if (!isRecord(value)) return null;
  const action = stringField(value, 'action');
  const deviceId = stringField(value, 'deviceId');
  const createdAt = integerField(value, 'createdAt');
  const entityId = value.entityId === null ? null : stringField(value, 'entityId');
  const details = isRecord(value.details) ? value.details : null;

  if (action === null || deviceId === null || createdAt === null || details === null) return null;
  return { action, deviceId, entityId, details, createdAt };
}

export class CloudSyncService {
  readonly #pairingKeyPath: string;
  readonly #deviceIdPath: string;
  readonly #onDataChanged: () => void;
  readonly #endpoint: string;
  readonly #getDeviceLabel: () => string;
  #printAgent: ((job: ClaimedCloudPrintJob) => Promise<PrintAgentResult>) | null = null;
  #resetBackupAgent: (() => Promise<BackupRecord>) | null = null;
  #outboxTimer: NodeJS.Timeout | null = null;
  readonly #eventStreams = new Map<string, WebSocket>();
  readonly #eventReconnectTimers = new Map<string, NodeJS.Timeout>();
  readonly #eventReconnectDelays = new Map<string, number>();
  #controlStream: WebSocket | null = null;
  #controlReconnectTimer: NodeJS.Timeout | null = null;
  #controlReconnectDelayMs = 1_000;
  #flushInFlight = false;
  #cloudConnected = false;
  #lastLatencyMs = 0;

  constructor(
    pairingKeyPath: string,
    deviceIdPath: string,
    onDataChanged: () => void = () => undefined,
    endpoint = 'https://gtrz-sync.jvgacontato.workers.dev',
    getDeviceLabel: () => string = hostname,
  ) {
    this.#pairingKeyPath = pairingKeyPath;
    this.#deviceIdPath = deviceIdPath;
    this.#onDataChanged = onDataChanged;
    this.#endpoint = endpoint;
    this.#getDeviceLabel = getDeviceLabel;
  }

  start(getActiveEventId: () => string | null): void {
    // Replication owns the persistent WebSocket streams once the local database is ready.
    void getActiveEventId;
  }

  stop(): void {
    if (this.#outboxTimer !== null) {
      clearInterval(this.#outboxTimer);
      this.#outboxTimer = null;
    }
    if (this.#controlReconnectTimer !== null) clearTimeout(this.#controlReconnectTimer);
    this.#controlReconnectTimer = null;
    this.#controlStream?.close();
    this.#controlStream = null;
    for (const timer of this.#eventReconnectTimers.values()) clearTimeout(timer);
    this.#eventReconnectTimers.clear();
    for (const stream of this.#eventStreams.values()) stream.close();
    this.#eventStreams.clear();
    this.#cloudConnected = false;
  }

  startReplication(
    getDatabase: () => DatabaseContext,
    getActiveEventId: () => string | null,
  ): void {
    const flush = (): void => {
      void this.flushOutbox(getDatabase(), getActiveEventId()).catch(() => undefined);
    };
    flush();
    this.#outboxTimer = setInterval(flush, OUTBOX_INTERVAL_MS);
  }

  setPrintAgent(agent: (job: ClaimedCloudPrintJob) => Promise<PrintAgentResult>): void {
    this.#printAgent = agent;
  }

  setResetBackupAgent(agent: () => Promise<BackupRecord>): void {
    this.#resetBackupAgent = agent;
  }

  async flushOutbox(database: DatabaseContext, activeEventId: string | null): Promise<void> {
    if (this.#flushInFlight) return;
    this.#flushInFlight = true;
    try {
      const deviceId = await this.#readOrCreateDeviceId();
      const pairingKey = await this.#readPairingKey();
      this.#enqueueNewAudits(database, deviceId);

      if (pairingKey === null) return;

      const effectiveActiveEventId = getSessionState(database).activeEvent?.id ?? activeEventId;

      this.#retryRecoverablePaidOrders(database);
      this.#ensureControlStream(database, deviceId, pairingKey);
      this.#ensureEventStreams(database, effectiveActiveEventId, deviceId, pairingKey);
      await this.#publishCashierCatalog(database, effectiveActiveEventId, pairingKey);
      await this.#publishMobileContext(database, effectiveActiveEventId, pairingKey);
      this.#applyInbox(database, deviceId);

      const pending = database.sqlite
        .prepare(
          `SELECT audit_id, operation_id, event_id, payload_json
         FROM sync_outbox WHERE status IN ('pending', 'failed')
         ORDER BY audit_id ASC LIMIT 30`,
        )
        .all() as OutboxRow[];

      for (const item of pending) {
        try {
          const response = await fetch(
            `${this.#endpoint}/v1/events/${encodeURIComponent(item.event_id)}/journal`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
              body: item.payload_json,
              signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
            },
          );

          if (!response.ok) {
            throw new Error(`A central respondeu ${String(response.status)}.`);
          }

          database.sqlite
            .prepare(
              `UPDATE sync_outbox
             SET status = 'accepted', accepted_at = ?, attempts = attempts + 1,
                 last_error = NULL, updated_at = ?
             WHERE audit_id = ?`,
            )
            .run(Date.now(), Date.now(), item.audit_id);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message.slice(0, 240) : 'Falha de rede.';
          database.sqlite
            .prepare(
              `UPDATE sync_outbox
             SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
             WHERE audit_id = ?`,
            )
            .run(message, Date.now(), item.audit_id);
          return;
        }
      }
    } finally {
      this.#flushInFlight = false;
    }
  }

  async setGlobalEvent(database: DatabaseContext, eventId: string): Promise<void> {
    const event = database.sqlite
      .prepare("SELECT id, name FROM events WHERE id = ? AND status = 'open'")
      .get(eventId) as { readonly id: string; readonly name: string } | undefined;
    if (event === undefined)
      throw new Error('O evento selecionado não está disponível neste computador.');
    await this.#globalControlRequest('/v1/monitor/global-event', {
      eventId: event.id,
      eventName: event.name,
    });
    setActiveEvent(database, event.id);
    this.#onDataChanged();
  }

  async resetGlobalEvent(
    database: DatabaseContext,
    input: { readonly eventId: string; readonly confirmationName: string; readonly reason: string },
  ): Promise<void> {
    const event = database.sqlite
      .prepare('SELECT id, name FROM events WHERE id = ?')
      .get(input.eventId) as { readonly id: string; readonly name: string } | undefined;
    if (event === undefined) throw new Error('O evento informado não existe neste computador.');
    if (input.confirmationName.trim() !== event.name) {
      throw new Error('Digite exatamente o nome do evento para confirmar a limpeza.');
    }
    const deviceId = await this.#readOrCreateDeviceId();
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null)
      throw new Error('A chave da nuvem não foi encontrada neste computador.');
    await this.#globalControlRequest('/v1/monitor/global-event/reset', {
      eventId: event.id,
      eventName: event.name,
      reason: input.reason.trim(),
      deviceId,
    });
    await this.#pullGlobalControl(database, pairingKey, deviceId);
  }

  async getStatus(): Promise<CloudSyncStatus> {
    const checkedAt = Date.now();
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null) {
      return this.#status({
        checkedAt,
        connection: 'attention',
        apiReachable: this.#cloudConnected,
        credentialPresent: false,
        credentialAccepted: false,
        message: 'API online, mas a chave de pareamento não foi encontrada neste computador.',
      });
    }

    return this.#status({
      checkedAt,
      connection: this.#cloudConnected ? 'connected' : 'attention',
      apiReachable: this.#cloudConnected,
      credentialPresent: true,
      credentialAccepted: this.#cloudConnected,
      message: this.#cloudConnected
        ? 'Nuvem conectada pelo canal em tempo real.'
        : 'Aguardando a conexão segura com a nuvem.',
    });
  }

  async getMonitor(activeEventId: string | null): Promise<CloudMonitor> {
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null) {
      throw new Error('A chave de pareamento não foi encontrada neste computador.');
    }

    const deviceId = await this.#readOrCreateDeviceId();
    const startedAt = performance.now();
    const heartbeat = await fetch(`${this.#endpoint}/v1/monitor/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
      body: JSON.stringify({
        deviceId,
        label: this.#getDeviceLabel(),
        activeEventId,
        latencyMs: this.#lastLatencyMs,
      }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    this.#lastLatencyMs = Math.round(performance.now() - startedAt);

    if (!heartbeat.ok) {
      throw new Error('A API recusou o sinal deste computador.');
    }

    const snapshot = await fetch(`${this.#endpoint}/v1/monitor/snapshot`, {
      headers: { 'X-GTRZ-Key': pairingKey },
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });

    if (!snapshot.ok) {
      throw new Error('Não foi possível obter o painel da nuvem.');
    }

    const payload: unknown = await snapshot.json();
    return cloudMonitorSchema.parse({
      endpoint: this.#endpoint,
      localQueue: {
        outboxPending: 0,
        outboxAccepted: 0,
        outboxFailed: 0,
        inboxReceived: 0,
        inboxAwaitingApply: 0,
        conflictsOpen: 0,
      },
      recentTransport: [],
      recentConflicts: [],
      idempotency: { acceptedCommands: 0, journalAttempts: 0, replayedAttempts: 0 },
      localConflicts: [],
      ...(typeof payload === 'object' && payload !== null ? payload : {}),
    });
  }

  async listMobileOperators(): Promise<readonly MobileOperator[]> {
    return this.#mobileOperatorRequest(
      '/v1/mobile/operators',
      'GET',
      undefined,
      mobileOperatorListSchema,
    );
  }

  async createMobileOperator(input: CreateMobileOperatorInput): Promise<MobileOperator> {
    return this.#mobileOperatorRequest('/v1/mobile/operators', 'POST', input, mobileOperatorSchema);
  }

  async updateMobileOperator(input: UpdateMobileOperatorInput): Promise<MobileOperator> {
    const { operatorId, ...changes } = input;
    return this.#mobileOperatorRequest(
      `/v1/mobile/operators/${encodeURIComponent(operatorId)}`,
      'PATCH',
      changes,
      mobileOperatorSchema,
    );
  }

  async endMobileOperatorSessions(
    input: EndMobileOperatorSessionsInput,
  ): Promise<{ readonly success: true }> {
    await this.#mobileOperatorRequest(
      `/v1/mobile/operators/${encodeURIComponent(input.operatorId)}/sessions`,
      'POST',
      { reason: input.reason },
      undefined,
    );
    return { success: true };
  }

  async deleteMobileOperator(
    input: DeleteMobileOperatorInput,
  ): Promise<{ readonly success: true }> {
    await this.#mobileOperatorRequest(
      `/v1/mobile/operators/${encodeURIComponent(input.operatorId)}`,
      'DELETE',
      undefined,
      undefined,
    );
    return { success: true };
  }

  getQueueState(database: DatabaseContext): CloudMonitor['localQueue'] {
    const counts = database.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sync_outbox WHERE status = 'pending') AS outbox_pending,
           (SELECT COUNT(*) FROM sync_outbox WHERE status = 'accepted') AS outbox_accepted,
           (SELECT COUNT(*) FROM sync_outbox WHERE status = 'failed') AS outbox_failed,
           (SELECT COUNT(*) FROM sync_inbox) AS inbox_received,
           (SELECT COUNT(*) FROM sync_inbox WHERE applied_at IS NULL) AS inbox_awaiting_apply,
           (SELECT COUNT(*) FROM sync_conflicts WHERE resolved_at IS NULL) AS conflicts_open`,
      )
      .get() as QueueCountsRow;

    return {
      outboxPending: counts.outbox_pending,
      outboxAccepted: counts.outbox_accepted,
      outboxFailed: counts.outbox_failed,
      inboxReceived: counts.inbox_received,
      inboxAwaitingApply: counts.inbox_awaiting_apply,
      conflictsOpen: counts.conflicts_open,
    };
  }

  getConflicts(database: DatabaseContext): CloudMonitor['localConflicts'] {
    const rows = database.sqlite
      .prepare(
        `SELECT command_id, event_id, action, entity_id, reason, created_at
         FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 30`,
      )
      .all() as ConflictRow[];
    return rows.map((row) => ({
      commandId: row.command_id,
      eventId: row.event_id,
      action: row.action,
      entityId: row.entity_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  async #mobileOperatorRequest<TResult>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    schema: { parse(value: unknown): TResult } | undefined,
  ): Promise<TResult> {
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null) {
      throw new Error('A chave da nuvem não foi encontrada neste computador.');
    }
    const response = await fetch(`${this.#endpoint}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-GTRZ-Key': pairingKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
          ? payload.error.message
          : 'A central não concluiu a alteração do operador móvel.';
      throw new Error(message);
    }
    return schema === undefined ? (payload as TResult) : schema.parse(payload);
  }

  async #globalControlRequest(path: string, body: Record<string, unknown>): Promise<void> {
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null)
      throw new Error('A chave da nuvem não foi encontrada neste computador.');
    const response = await fetch(`${this.#endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return;
    const message =
      isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : 'A central não confirmou o comando global.';
    throw new Error(message);
  }

  #ensureControlStream(database: DatabaseContext, deviceId: string, pairingKey: string): void {
    if (
      this.#controlStream !== null &&
      (this.#controlStream.readyState === WebSocket.OPEN ||
        this.#controlStream.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const cursorRow = database.sqlite
      .prepare("SELECT value FROM sync_state WHERE key = 'global.event-control.cursor'")
      .get() as { readonly value: string } | undefined;
    const cursor = Number.parseInt(cursorRow?.value ?? '0', 10) || 0;
    const streamUrl = `${this.#endpoint.replace(/^https:/u, 'wss:').replace(/^http:/u, 'ws:')}/v1/monitor/stream?after=${String(cursor)}`;
    const stream = new WebSocket(streamUrl, {
      headers: {
        'X-GTRZ-Key': pairingKey,
        'X-GTRZ-Device-Id': deviceId,
        'X-GTRZ-Device-Label': this.#getDeviceLabel(),
      },
      handshakeTimeout: CONNECTION_TIMEOUT_MS,
    });
    this.#controlStream = stream;
    stream.on('open', () => {
      this.#cloudConnected = true;
      this.#controlReconnectDelayMs = 1_000;
    });
    stream.on('message', () => {
      // The control frame is a push signal. The snapshot is requested only on
      // connection/recovery or when the global control actually changes.
      void this.#pullGlobalControl(database, pairingKey, deviceId).catch(() => undefined);
    });
    stream.on('error', () => undefined);
    stream.on('close', () => {
      if (this.#controlStream !== stream) return;
      this.#controlStream = null;
      this.#cloudConnected = false;
      this.#scheduleControlReconnect(database, deviceId, pairingKey);
    });
  }

  #scheduleControlReconnect(database: DatabaseContext, deviceId: string, pairingKey: string): void {
    if (this.#controlReconnectTimer !== null) return;
    const delay = this.#controlReconnectDelayMs;
    this.#controlReconnectDelayMs = Math.min(delay * 2, STREAM_RECONNECT_MAX_MS);
    this.#controlReconnectTimer = setTimeout(() => {
      this.#controlReconnectTimer = null;
      this.#ensureControlStream(database, deviceId, pairingKey);
    }, delay);
  }

  async #pullGlobalControl(
    database: DatabaseContext,
    pairingKey: string,
    deviceId: string,
  ): Promise<void> {
    const cursorKey = 'global.event-control.cursor';
    const cursorRow = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(cursorKey) as { readonly value: string } | undefined;
    const after = Number.parseInt(cursorRow?.value ?? '0', 10) || 0;
    const response = await fetch(
      `${this.#endpoint}/v1/monitor/global-control?after=${String(after)}`,
      {
        headers: { 'X-GTRZ-Key': pairingKey },
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok) return;
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.commands)) return;
    let cursor = after;
    for (const candidate of payload.commands) {
      if (!isRecord(candidate)) continue;
      if (
        typeof candidate.sequence !== 'number' ||
        typeof candidate.commandId !== 'string' ||
        (candidate.type !== 'event.activated' && candidate.type !== 'event.reset') ||
        typeof candidate.eventId !== 'string' ||
        typeof candidate.eventName !== 'string'
      )
        continue;
      const command: GlobalEventCommand = {
        sequence: candidate.sequence,
        commandId: candidate.commandId,
        type: candidate.type,
        eventId: candidate.eventId,
        eventName: candidate.eventName,
        reason: typeof candidate.reason === 'string' ? candidate.reason : null,
      };
      const appliedKey = `global.event-command:${command.commandId}`;
      const alreadyApplied = database.sqlite
        .prepare('SELECT 1 FROM sync_state WHERE key = ?')
        .get(appliedKey) as { readonly value: number } | undefined;
      if (alreadyApplied !== undefined) {
        cursor = Math.max(cursor, command.sequence);
        continue;
      }
      const event = database.sqlite
        .prepare('SELECT id, name FROM events WHERE id = ?')
        .get(command.eventId) as { readonly id: string; readonly name: string } | undefined;
      if (event === undefined) {
        this.#reportConflict({
          commandId: command.commandId,
          eventId: command.eventId,
          deviceId,
          action: command.type,
          entityId: command.eventId,
          reason: 'O evento global ainda não existe nesta cópia local.',
        });
      } else if (command.type === 'event.activated') {
        setActiveEvent(database, event.id);
        this.#onDataChanged();
      } else {
        resetEventData(database, {
          eventId: event.id,
          confirmationName: event.name,
          reason: command.reason ?? 'Limpeza global do evento.',
          system: true,
        });
        this.#onDataChanged();
      }
      database.sqlite
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES (?, 'applied', ?)
           ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(appliedKey, Date.now());
      cursor = Math.max(cursor, command.sequence);
    }
    if (cursor !== after) {
      database.sqlite
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(cursorKey, String(cursor), Date.now());
    }
    const pending = this.#pendingReset(payload.pendingReset);
    if (pending !== null && pending.targetDeviceIds.includes(deviceId)) {
      await this.#prepareResetBackup(database, pairingKey, deviceId, pending);
    }
  }

  #pendingReset(value: unknown): PendingGlobalReset | null {
    if (!isRecord(value) || !Array.isArray(value.targetDeviceIds)) return null;
    if (
      typeof value.requestId !== 'string' ||
      typeof value.eventId !== 'string' ||
      typeof value.eventName !== 'string' ||
      typeof value.reason !== 'string' ||
      !value.targetDeviceIds.every((item) => typeof item === 'string')
    )
      return null;
    return {
      requestId: value.requestId,
      eventId: value.eventId,
      eventName: value.eventName,
      reason: value.reason,
      targetDeviceIds: value.targetDeviceIds,
    };
  }

  async #prepareResetBackup(
    database: DatabaseContext,
    pairingKey: string,
    deviceId: string,
    reset: PendingGlobalReset,
  ): Promise<void> {
    const completionKey = `global.reset-backup:${reset.requestId}`;
    const complete = database.sqlite
      .prepare('SELECT 1 FROM sync_state WHERE key = ?')
      .get(completionKey);
    if (complete !== undefined) return;
    if (this.#resetBackupAgent === null) {
      this.#reportConflict({
        commandId: reset.requestId,
        eventId: reset.eventId,
        deviceId,
        action: 'event.reset-backup',
        entityId: reset.eventId,
        reason: 'Este PC não conseguiu preparar o backup obrigatório.',
      });
      return;
    }
    const backup = await this.#resetBackupAgent();
    if (backup.integrity !== 'valid')
      throw new Error('O backup pré-limpeza não passou na verificação.');
    const contents = await readFile(backup.filePath);
    const response = await fetch(
      `${this.#endpoint}/v1/monitor/reset-backup/${encodeURIComponent(reset.requestId)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-GTRZ-Key': pairingKey,
          'X-GTRZ-Device-Id': deviceId,
          'X-GTRZ-Backup-Sha256': createHash('sha256').update(contents).digest('hex'),
          'X-GTRZ-Backup-Size': String(contents.byteLength),
        },
        body: new Uint8Array(contents),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error('A nuvem não confirmou o envio do backup obrigatório.');
    database.sqlite
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(completionKey, backup.fileName, Date.now());
    this.#onDataChanged();
  }

  #reportConflict(conflict: {
    readonly commandId: string;
    readonly eventId: string;
    readonly deviceId: string;
    readonly action: string;
    readonly entityId: string | null;
    readonly reason: string;
  }): void {
    void this.#sendConflict(conflict);
  }

  async #sendConflict(conflict: {
    readonly commandId: string;
    readonly eventId: string;
    readonly deviceId: string;
    readonly action: string;
    readonly entityId: string | null;
    readonly reason: string;
  }): Promise<void> {
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null) return;

    try {
      await fetch(`${this.#endpoint}/v1/monitor/conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
        body: JSON.stringify({ ...conflict, createdAt: Date.now() }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
    } catch {
      // The local conflict remains authoritative and visible offline.
    }
  }

  async #readPairingKey(): Promise<string | null> {
    try {
      const contents = await readFile(this.#pairingKeyPath, 'utf8');
      const key = contents
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
      return key ?? null;
    } catch {
      return null;
    }
  }

  async #publishCashierCatalog(
    database: DatabaseContext,
    activeEventId: string | null,
    pairingKey: string,
  ): Promise<void> {
    if (activeEventId === null) return;
    const products = database.sqlite
      .prepare(
        `SELECT p.id AS product_id, p.name, p.kind, p.combo_only, p.sale_price_cents,
                c.name AS category_name, COALESCE(es.quantity, 0) AS quantity
         FROM products p
         INNER JOIN product_categories c ON c.id = p.category_id
         LEFT JOIN event_stock es ON es.product_id = p.id AND es.event_id = ?
         WHERE p.active = 1 ORDER BY p.name COLLATE NOCASE`,
      )
      .all(activeEventId) as readonly {
      readonly product_id: string;
      readonly name: string;
      readonly kind: string;
      readonly combo_only: number;
      readonly sale_price_cents: number;
      readonly category_name: string;
      readonly quantity: number;
    }[];
    const catalog = [
      ...products.map((product) => {
        const presentation = getProductPresentation(database, product.product_id);
        return {
          productId: product.product_id,
          label: product.name,
          kind: product.kind,
          itemKind: 'product',
          visible: product.combo_only !== 1,
          categoryLabel: product.category_name,
          imageDataUrl: presentation.imageDataUrl,
          fallbackIcon: presentation.fallbackIcon,
          components: [],
          unitPriceCents: product.sale_price_cents,
          quantity: product.quantity,
        };
      }),
      ...listCombos(database)
        .filter((combo) => combo.active)
        .map((combo) => ({
          productId: combo.id,
          label: combo.name,
          kind: 'combo',
          itemKind: 'combo',
          visible: true,
          categoryLabel: 'Combos',
          imageDataUrl: null,
          fallbackIcon: 'package',
          components: combo.components.map((component) => ({
            productId: component.productId,
            quantity: component.quantity,
            choiceGroup: component.choiceGroup,
            choiceLabel: component.choiceLabel,
          })),
          unitPriceCents: combo.salePriceCents,
          quantity: combo.availableUnits,
        })),
    ];
    const fingerprint = JSON.stringify(catalog);
    const stateKey = `cashier.catalog:${activeEventId}`;
    const current = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(stateKey) as { readonly value: string } | undefined;
    if (current?.value === fingerprint) return;

    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(activeEventId)}/cashier/catalog`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
        body: JSON.stringify({ products: catalog }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok)
      throw new Error(
        `Não foi possível publicar o catálogo do caixa (${String(response.status)}).`,
      );
    database.sqlite
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(stateKey, fingerprint, Date.now());
  }

  async #publishMobileContext(
    database: DatabaseContext,
    activeEventId: string | null,
    pairingKey: string,
  ): Promise<void> {
    if (activeEventId === null) return;
    const ticketLots = database.sqlite
      .prepare(
        `SELECT tl.id, tl.name, tl.price_cents, tl.capacity, tl.active,
                COALESCE(SUM(CASE WHEN ts.status = 'active' THEN ts.quantity ELSE 0 END), 0) AS used_quantity,
                COALESCE(SUM(CASE WHEN ts.status = 'active' AND ts.source = 'courtesy' THEN ts.quantity ELSE 0 END), 0) AS courtesy_quantity
         FROM ticket_lots tl
         LEFT JOIN ticket_sales ts ON ts.lot_id = tl.id
         WHERE tl.event_id = ?
         GROUP BY tl.id
         ORDER BY tl.created_at ASC`,
      )
      .all(activeEventId) as readonly {
      readonly id: string;
      readonly name: string;
      readonly price_cents: number;
      readonly capacity: number;
      readonly active: number;
      readonly used_quantity: number;
      readonly courtesy_quantity: number;
    }[];
    const servicePoints = database.sqlite
      .prepare(
        `SELECT id, label, type, active FROM service_points
         WHERE event_id = ? ORDER BY label COLLATE NOCASE`,
      )
      .all(activeEventId) as readonly {
      readonly id: string;
      readonly label: string;
      readonly type: 'counter' | 'table';
      readonly active: number;
    }[];
    const voucherCodes = database.sqlite
      .prepare('SELECT code FROM vouchers WHERE event_id = ?')
      .all(activeEventId) as readonly { readonly code: string }[];
    const context = {
      eventId: activeEventId,
      ticketLots: ticketLots.map((lot) => ({
        id: lot.id,
        name: lot.name,
        priceCents: lot.price_cents,
        active: lot.active === 1,
        soldQuantity: lot.used_quantity - lot.courtesy_quantity,
        courtesyQuantity: lot.courtesy_quantity,
        availableQuantity: Math.max(0, lot.capacity - lot.used_quantity),
      })),
      servicePoints: servicePoints.map((point) => ({
        id: point.id,
        label: point.label,
        type: point.type,
        active: point.active === 1,
      })),
      voucherCodes: voucherCodes.map((voucher) => voucher.code),
    };
    const fingerprint = JSON.stringify(context);
    const stateKey = `mobile.context:${activeEventId}`;
    const current = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(stateKey) as { readonly value: string } | undefined;
    if (current?.value === fingerprint) return;
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(activeEventId)}/cashier/context`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
        body: JSON.stringify(context),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok)
      throw new Error(`Não foi possível publicar o contexto móvel (${String(response.status)}).`);
    database.sqlite
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(stateKey, fingerprint, Date.now());
  }

  async #processPrintQueue(
    database: DatabaseContext,
    activeEventId: string | null,
    deviceId: string,
    pairingKey: string,
    registerPrinter: boolean,
  ): Promise<void> {
    if (activeEventId === null) return;
    const settings = getPrintingSettings(database);
    const printerName = settings.deviceName ?? '__windows_default__';
    const baseUrl = `${this.#endpoint}/v1/events/${encodeURIComponent(activeEventId)}/print`;
    if (registerPrinter) {
      const register = await fetch(`${baseUrl}/printers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
        body: JSON.stringify({
          deviceId,
          deviceLabel: settings.machineName,
          printerName,
          paperWidthMm: settings.paperWidthMm,
          enabled: settings.automaticPrinting,
        }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
      if (!register.ok) return;
    }
    if (!settings.automaticPrinting || this.#printAgent === null) return;

    const claim = await fetch(`${baseUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
      body: JSON.stringify({ deviceId }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    if (!claim.ok) return;
    const payload: unknown = await claim.json();
    if (!isRecord(payload) || !isRecord(payload.job)) return;
    const rawJob = payload.job;
    if (
      typeof rawJob.jobId !== 'string' ||
      typeof rawJob.claimToken !== 'string' ||
      typeof rawJob.printerLabel !== 'string' ||
      !isRecord(rawJob.document)
    ) {
      return;
    }
    let result: PrintAgentResult;
    let completion: 'printed' | 'failed' | 'uncertain' = 'printed';
    try {
      result = await this.#printAgent({
        jobId: rawJob.jobId,
        claimToken: rawJob.claimToken,
        printerLabel: rawJob.printerLabel,
        document: rawJob.document as unknown as CloudPrintReceipt,
      });
      if (!result.success) completion = 'failed';
    } catch (error: unknown) {
      completion = 'uncertain';
      result = {
        success: false,
        message:
          error instanceof Error ? error.message : 'O agente de impressão parou sem confirmação.',
      };
    }
    await fetch(`${baseUrl}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GTRZ-Key': pairingKey },
      body: JSON.stringify({
        jobId: rawJob.jobId,
        claimToken: rawJob.claimToken,
        deviceId,
        result: completion,
        error: result.success ? undefined : result.message,
      }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
  }

  #enqueueNewAudits(database: DatabaseContext, deviceId: string): void {
    const floorRow = database.sqlite
      .prepare(`SELECT value FROM sync_state WHERE key = 'outbox.audit-floor'`)
      .get() as { readonly value: string } | undefined;

    if (floorRow === undefined) {
      const current = database.sqlite
        .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log')
        .get() as { readonly id: number };
      database.sqlite
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('outbox.audit-floor', ?, ?)`,
        )
        .run(String(current.id), Date.now());
      return;
    }

    const floor = Number(floorRow.value);
    const audits = database.sqlite
      .prepare(
        `SELECT id, event_id, profile, action, entity_type, entity_id, details_json, created_at
         FROM audit_log WHERE id > ? ORDER BY id ASC`,
      )
      .all(floor) as AuditRow[];

    if (audits.length === 0) return;

    const enqueue = database.sqlite.prepare(
      `INSERT OR IGNORE INTO sync_outbox
       (audit_id, operation_id, event_id, payload_json, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    );
    const updateFloor = database.sqlite.prepare(
      `UPDATE sync_state SET value = ?, updated_at = ? WHERE key = 'outbox.audit-floor'`,
    );

    database.sqlite.transaction(() => {
      for (const audit of audits) {
        if (!SYNCHRONIZED_ACTIONS.has(audit.action)) continue;
        const eventName =
          audit.event_id === null
            ? null
            : ((
                database.sqlite
                  .prepare('SELECT name FROM events WHERE id = ?')
                  .get(audit.event_id) as { readonly name: string } | undefined
              )?.name ?? null);
        const rawDetails: unknown = JSON.parse(audit.details_json);
        const payload = {
          commandId: `${deviceId}:${String(audit.id)}`,
          deviceId,
          auditId: audit.id,
          profile: audit.profile,
          action: audit.action,
          entityType: audit.entity_type,
          entityId: audit.entity_id,
          details: isRecord(rawDetails)
            ? {
                ...rawDetails,
                originMachineName: this.#getDeviceLabel(),
                ...(eventName === null ? {} : { eventName }),
              }
            : rawDetails,
          createdAt: audit.created_at,
        };
        enqueue.run(
          audit.id,
          payload.commandId,
          audit.event_id ?? CATALOG_EVENT_ID,
          JSON.stringify(payload),
          Date.now(),
          Date.now(),
        );
      }
      updateFloor.run(String(audits.at(-1)?.id ?? floor), Date.now());
    })();
  }

  #ensureEventStreams(
    database: DatabaseContext,
    activeEventId: string | null,
    deviceId: string,
    pairingKey: string,
  ): void {
    const wanted = new Set([CATALOG_EVENT_ID]);
    if (activeEventId !== null) wanted.add(activeEventId);
    for (const eventId of wanted) {
      this.#ensureEventStream(database, eventId, deviceId, pairingKey, activeEventId);
    }
    for (const [eventId, stream] of this.#eventStreams) {
      if (!wanted.has(eventId)) {
        stream.close();
        this.#eventStreams.delete(eventId);
      }
    }
  }

  #ensureEventStream(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    pairingKey: string,
    activeEventId: string | null,
  ): void {
    const existing = this.#eventStreams.get(eventId);
    if (
      existing !== undefined &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const cursor = this.#getInboxCursor(database, eventId);
    const streamUrl = `${this.#endpoint.replace(/^https:/u, 'wss:').replace(/^http:/u, 'ws:')}/v1/events/${encodeURIComponent(eventId)}/stream?after=${String(cursor)}`;
    const stream = new WebSocket(streamUrl, {
      headers: {
        'X-GTRZ-Key': pairingKey,
        'X-GTRZ-Device-Id': deviceId,
        'X-GTRZ-Device-Label': this.#getDeviceLabel(),
      },
      handshakeTimeout: CONNECTION_TIMEOUT_MS,
    });
    this.#eventStreams.set(eventId, stream);

    stream.on('open', () => {
      this.#eventReconnectDelays.set(eventId, 1_000);
      if (eventId === activeEventId) {
        void this.#processPrintQueue(database, eventId, deviceId, pairingKey, true).catch(
          () => undefined,
        );
      }
    });
    stream.on('message', (message) => {
      const result = this.#applyStreamMessage(database, eventId, deviceId, message);
      if (!result.accepted) {
        stream.close();
        return;
      }
      if (result.printQueued && eventId === getSessionState(database).activeEvent?.id) {
        void this.#processPrintQueue(database, eventId, deviceId, pairingKey, false).catch(
          () => undefined,
        );
      }
    });
    stream.on('error', () => undefined);
    stream.on('close', () => {
      if (this.#eventStreams.get(eventId) === stream) {
        this.#eventStreams.delete(eventId);
        this.#scheduleEventReconnect(database, eventId, deviceId, pairingKey);
      }
    });
  }

  #applyStreamMessage(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    message: RawData,
  ): StreamMessageResult {
    try {
      const envelope: unknown = JSON.parse(websocketMessageText(message));
      if (!isRecord(envelope)) return { accepted: false, printQueued: false };
      const printQueued = envelope.type === 'event' && envelope.printQueued === true;
      const events =
        envelope.type === 'event'
          ? [envelope.event]
          : envelope.type === 'sync' && Array.isArray(envelope.events)
            ? envelope.events
            : null;
      if (events === null) return { accepted: true, printQueued: false };
      const journalEvents = events.filter(isRemoteJournalEvent);
      const cursor = this.#getInboxCursor(database, eventId);
      const newEvents = journalEvents.filter((event) => event.sequence > cursor);
      if (newEvents.length === 0) return { accepted: true, printQueued };
      if (newEvents[0]?.sequence !== cursor + 1) return { accepted: false, printQueued: false };
      for (let index = 1; index < newEvents.length; index += 1) {
        const previous = newEvents[index - 1];
        const current = newEvents[index];
        if (previous === undefined || current?.sequence !== previous.sequence + 1) {
          return { accepted: false, printQueued: false };
        }
      }
      this.#storeRemoteJournalEvents(database, eventId, newEvents);
      this.#applyInbox(database, deviceId);
      const currentSequence = integerField(envelope, 'currentSequence');
      const latest = newEvents.at(-1);
      return {
        accepted:
          latest !== undefined && (currentSequence === null || latest.sequence >= currentSequence),
        printQueued,
      };
    } catch {
      return { accepted: false, printQueued: false };
    }
  }

  #scheduleEventReconnect(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    pairingKey: string,
  ): void {
    if (this.#eventReconnectTimers.has(eventId)) return;
    const delay = this.#eventReconnectDelays.get(eventId) ?? 1_000;
    this.#eventReconnectDelays.set(eventId, Math.min(delay * 2, STREAM_RECONNECT_MAX_MS));
    const timer = setTimeout(() => {
      this.#eventReconnectTimers.delete(eventId);
      const activeEventId = getSessionState(database).activeEvent?.id ?? null;
      if (eventId !== CATALOG_EVENT_ID && eventId !== activeEventId) return;
      this.#ensureEventStream(database, eventId, deviceId, pairingKey, activeEventId);
    }, delay);
    this.#eventReconnectTimers.set(eventId, timer);
  }

  #getInboxCursor(database: DatabaseContext, eventId: string): number {
    const cursorRow = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(`inbox.sequence:${eventId}`) as { readonly value: string } | undefined;
    const cursor = cursorRow === undefined ? 0 : Number(cursorRow.value);
    return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  }

  #storeRemoteJournalEvents(
    database: DatabaseContext,
    eventId: string,
    journalEvents: readonly RemoteJournalEvent[],
  ): void {
    const insert = database.sqlite.prepare(
      `INSERT OR IGNORE INTO sync_inbox
       (event_id, sequence, command_id, payload_json, received_at, applied_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    const updateCursor = database.sqlite.prepare(
      `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    database.sqlite.transaction(() => {
      for (const remote of journalEvents) {
        insert.run(
          eventId,
          remote.sequence,
          remote.commandId,
          JSON.stringify(remote.payload),
          Date.now(),
        );
      }
      const highestSequence = Math.max(...journalEvents.map((remote) => remote.sequence));
      updateCursor.run(`inbox.sequence:${eventId}`, String(highestSequence), Date.now());
    })();
  }

  #applyInbox(database: DatabaseContext, deviceId: string): void {
    const pending = database.sqlite
      .prepare(
        `SELECT event_id, sequence, command_id, payload_json
         FROM sync_inbox WHERE applied_at IS NULL ORDER BY event_id, sequence LIMIT 100`,
      )
      .all() as InboxRow[];
    const markProcessed = database.sqlite.prepare(
      'UPDATE sync_inbox SET applied_at = ? WHERE event_id = ? AND sequence = ?',
    );
    const recordConflict = database.sqlite.prepare(
      `INSERT OR IGNORE INTO sync_conflicts
       (command_id, event_id, sequence, action, entity_id, reason, payload_json, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );

    for (const row of pending) {
      const payload = journalPayload(JSON.parse(row.payload_json) as unknown);
      if (payload === null) {
        recordConflict.run(
          row.command_id,
          row.event_id,
          row.sequence,
          'invalid-payload',
          null,
          'O diário remoto possui um formato que este aplicativo não reconhece.',
          row.payload_json,
          Date.now(),
        );
        this.#reportConflict({
          commandId: row.command_id,
          eventId: row.event_id,
          deviceId,
          action: 'invalid-payload',
          entityId: null,
          reason: 'O diário remoto possui um formato que este aplicativo não reconhece.',
        });
        markProcessed.run(Date.now(), row.event_id, row.sequence);
        continue;
      }

      if (payload.deviceId === deviceId) {
        markProcessed.run(Date.now(), row.event_id, row.sequence);
        continue;
      }

      try {
        database.sqlite.transaction(() => {
          this.#applyRemoteAction(database, row.event_id, payload);
          markProcessed.run(Date.now(), row.event_id, row.sequence);
        })();
        this.#onDataChanged();
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message.slice(0, 240) : 'Falha desconhecida.';
        recordConflict.run(
          row.command_id,
          row.event_id,
          row.sequence,
          payload.action,
          payload.entityId,
          reason,
          row.payload_json,
          Date.now(),
        );
        this.#reportConflict({
          commandId: row.command_id,
          eventId: row.event_id,
          deviceId,
          action: payload.action,
          entityId: payload.entityId,
          reason,
        });
        markProcessed.run(Date.now(), row.event_id, row.sequence);
      }
    }

    this.#retryRecoverablePaidOrders(database);
  }

  /**
   * Older desktop builds rejected mobile paid orders when their virtual counter
   * collided with the permanent local counter. Replaying only those stored
   * transactions is safe because paid orders and movements use stable IDs.
   */
  #retryRecoverablePaidOrders(database: DatabaseContext): void {
    const conflicts = database.sqlite
      .prepare(
        `SELECT command_id, event_id, payload_json
         FROM sync_conflicts
         WHERE resolved_at IS NULL
           AND action = 'operations.order-paid'
           AND reason LIKE 'UNIQUE constraint failed: service_points.%'
         ORDER BY created_at
         LIMIT 100`,
      )
      .all() as RecoverableConflictRow[];
    const resolve = database.sqlite.prepare(
      'UPDATE sync_conflicts SET resolved_at = ? WHERE command_id = ? AND resolved_at IS NULL',
    );

    for (const conflict of conflicts) {
      const payload = journalPayload(JSON.parse(conflict.payload_json) as unknown);
      if (payload === null) continue;
      try {
        database.sqlite.transaction(() => {
          this.#applyRemoteAction(database, conflict.event_id, payload);
          resolve.run(Date.now(), conflict.command_id);
        })();
        this.#onDataChanged();
      } catch {
        // Keep the conflict open for an explicit audit when it is not yet safe to apply.
      }
    }
  }

  #applyRemoteAction(database: DatabaseContext, eventId: string, payload: JournalPayload): void {
    if (payload.action === 'event.created') {
      const name = stringField(payload.details, 'name');
      const startsAt = integerField(payload.details, 'startsAt');
      if (payload.entityId === null || name === null || startsAt === null) {
        throw new Error('Dados insuficientes para criar o evento remoto.');
      }
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO events
           (id, name, status, starts_at, ends_at, created_at, updated_at)
           VALUES (?, ?, 'open', ?, NULL, ?, ?)`,
        )
        .run(payload.entityId, name, startsAt, payload.createdAt, payload.createdAt);
      return;
    }

    if (payload.action === 'inventory.category-created') {
      const name = stringField(payload.details, 'name');
      const engine = stringField(payload.details, 'engine');
      if (
        payload.entityId === null ||
        name === null ||
        (engine !== 'catalog' && engine !== 'food')
      ) {
        throw new Error('Dados insuficientes para criar a categoria remota.');
      }
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO product_categories (id, name, active, engine, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(payload.entityId, name, engine, payload.createdAt, payload.createdAt);
      return;
    }

    if (payload.action === 'inventory.category-updated') {
      const name = stringField(payload.details, 'name');
      if (payload.entityId === null || name === null)
        throw new Error('Atualização remota de categoria incompleta.');
      database.sqlite
        .prepare('UPDATE product_categories SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, payload.createdAt, payload.entityId);
      return;
    }

    if (payload.action === 'inventory.category-deleted') {
      if (payload.entityId === null)
        throw new Error('Exclusão remota de categoria sem identificador.');
      database.sqlite.prepare('DELETE FROM product_categories WHERE id = ?').run(payload.entityId);
      return;
    }

    if (payload.action === 'inventory.product-created') {
      const categoryId = stringField(payload.details, 'categoryId');
      const name = stringField(payload.details, 'name');
      const kind = stringField(payload.details, 'kind');
      const costCents = integerField(payload.details, 'costCents');
      const salePriceCents = integerField(payload.details, 'salePriceCents');
      const lowStockThreshold = integerField(payload.details, 'lowStockThreshold');
      if (
        payload.entityId === null ||
        categoryId === null ||
        name === null ||
        (kind !== 'food' && kind !== 'drink') ||
        costCents === null ||
        salePriceCents === null ||
        lowStockThreshold === null
      ) {
        throw new Error('Dados insuficientes para criar o produto remoto.');
      }
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO products
           (id, category_id, name, kind, cost_cents, sale_price_cents, low_stock_threshold,
            combo_only, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          payload.entityId,
          categoryId,
          name,
          kind,
          costCents,
          salePriceCents,
          lowStockThreshold,
          payload.details.comboOnly === true ? 1 : 0,
          payload.createdAt,
          payload.createdAt,
        );
      return;
    }

    if (payload.action === 'inventory.product-updated') {
      const after = isRecord(payload.details.after) ? payload.details.after : null;
      if (payload.entityId === null || after === null)
        throw new Error('Atualização remota de produto incompleta.');
      const categoryId = stringField(after, 'categoryId');
      const name = stringField(after, 'name');
      const kind = stringField(after, 'kind');
      const costCents = integerField(after, 'costCents');
      const salePriceCents = integerField(after, 'salePriceCents');
      const lowStockThreshold = integerField(after, 'lowStockThreshold');
      const active = after.active;
      if (
        categoryId === null ||
        name === null ||
        (kind !== 'food' && kind !== 'drink') ||
        costCents === null ||
        salePriceCents === null ||
        lowStockThreshold === null ||
        typeof active !== 'boolean'
      )
        throw new Error('Dados inválidos na atualização remota de produto.');
      database.sqlite
        .prepare(
          `UPDATE products
           SET category_id = ?, name = ?, kind = ?, cost_cents = ?, sale_price_cents = ?,
               low_stock_threshold = ?, combo_only = ?, active = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          categoryId,
          name,
          kind,
          costCents,
          salePriceCents,
          lowStockThreshold,
          after.comboOnly === true ? 1 : 0,
          active ? 1 : 0,
          payload.createdAt,
          payload.entityId,
        );
      if (typeof after.fallbackIcon === 'string') {
        database.sqlite
          .prepare(
            `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(`product.icon:${payload.entityId}`, after.fallbackIcon, payload.createdAt);
      }
      return;
    }

    if (payload.action === 'inventory.product-deleted') {
      if (payload.entityId === null)
        throw new Error('Exclusão remota de produto sem identificador.');
      const localOpenOrders = database.sqlite
        .prepare(
          `SELECT DISTINCT o.id FROM orders o
           INNER JOIN order_items oi ON oi.order_id = o.id
           WHERE o.status = 'open' AND (
             (oi.item_kind = 'product' AND oi.item_id = ?)
             OR (oi.item_kind = 'combo' AND oi.item_id IN (
               SELECT combo_id FROM combo_components WHERE product_id = ?
             ))
           )`,
        )
        .all(payload.entityId, payload.entityId) as { readonly id: string }[];
      for (const order of localOpenOrders) {
        database.sqlite
          .prepare('DELETE FROM order_voucher_allocations WHERE order_id = ?')
          .run(order.id);
        database.sqlite
          .prepare(
            "UPDATE orders SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?",
          )
          .run(payload.createdAt, payload.createdAt, order.id);
      }
      database.sqlite
        .prepare(
          'UPDATE combos SET active = 0, updated_at = ? WHERE id IN (SELECT combo_id FROM combo_components WHERE product_id = ?)',
        )
        .run(payload.createdAt, payload.entityId);
      database.sqlite
        .prepare('DELETE FROM combo_components WHERE product_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM stock_transfers WHERE product_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare(
          'DELETE FROM stock_purchase_lot_voids WHERE movement_id IN (SELECT movement_id FROM stock_purchase_lots WHERE product_id = ?)',
        )
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM stock_purchase_lots WHERE product_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM food_sale_settlements WHERE product_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM food_product_terms WHERE product_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM order_item_component_allocations WHERE product_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM stock_movements WHERE product_id = ?')
        .run(payload.entityId);
      database.sqlite.prepare('DELETE FROM event_stock WHERE product_id = ?').run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM app_meta WHERE key IN (?, ?)')
        .run(`product.image:${payload.entityId}`, `product.icon:${payload.entityId}`);
      database.sqlite.prepare('DELETE FROM products WHERE id = ?').run(payload.entityId);
      return;
    }

    if (payload.action === 'food.configured') {
      const supplierMode = stringField(payload.details, 'supplierMode');
      if (supplierMode !== 'gtrz' && supplierMode !== 'external') {
        throw new Error('Configuração de Comida remota inválida.');
      }
      database.sqlite
        .prepare(
          `INSERT INTO food_event_settings (event_id, supplier_mode, updated_at)
         VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET
           supplier_mode = excluded.supplier_mode, updated_at = excluded.updated_at`,
        )
        .run(eventId, supplierMode, payload.createdAt);
      return;
    }

    if (payload.action === 'food.supplier-created') {
      const name = stringField(payload.details, 'name');
      if (payload.entityId === null || name === null)
        throw new Error('Fornecedor remoto inválido.');
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO food_suppliers (id, event_id, name, active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(payload.entityId, eventId, name, payload.createdAt, payload.createdAt);
      return;
    }

    if (payload.action === 'food.supplier-updated') {
      const name = stringField(payload.details, 'name');
      if (payload.entityId === null || name === null)
        throw new Error('Atualização remota de fornecedor incompleta.');
      database.sqlite
        .prepare('UPDATE food_suppliers SET name = ?, updated_at = ? WHERE id = ? AND event_id = ?')
        .run(name, payload.createdAt, payload.entityId, eventId);
      return;
    }

    if (payload.action === 'food.supplier-archived') {
      if (payload.entityId === null)
        throw new Error('Arquivamento remoto de fornecedor sem identificador.');
      database.sqlite
        .prepare(
          'UPDATE food_suppliers SET active = 0, updated_at = ? WHERE id = ? AND event_id = ?',
        )
        .run(payload.createdAt, payload.entityId, eventId);
      return;
    }

    if (payload.action === 'food.supplier-deleted') {
      if (payload.entityId === null)
        throw new Error('Exclusão remota de fornecedor sem identificador.');
      database.sqlite
        .prepare('DELETE FROM food_suppliers WHERE id = ? AND event_id = ?')
        .run(payload.entityId, eventId);
      return;
    }

    if (payload.action === 'food.external-item-created') {
      const supplierId = stringField(payload.details, 'supplierId');
      const supplierUnitCents = integerField(payload.details, 'supplierUnitCents');
      const commissionUnitCents = integerField(payload.details, 'commissionUnitCents');
      if (
        payload.entityId === null ||
        supplierId === null ||
        supplierUnitCents === null ||
        commissionUnitCents === null
      ) {
        throw new Error('Item externo de comida remoto inválido.');
      }
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO food_product_terms
         (product_id, event_id, supplier_id, supplier_unit_cents, commission_unit_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payload.entityId,
          eventId,
          supplierId,
          supplierUnitCents,
          commissionUnitCents,
          payload.createdAt,
          payload.createdAt,
        );
      return;
    }

    if (payload.action === 'inventory.stock-moved') {
      const productId = stringField(payload.details, 'productId');
      const type = stringField(payload.details, 'type');
      const quantity = integerField(payload.details, 'quantity');
      const delta = integerField(payload.details, 'delta');
      const purchaseTotalCents = integerField(payload.details, 'purchaseTotalCents');
      const note = payload.details.note === null ? null : stringField(payload.details, 'note');
      if (
        payload.entityId === null ||
        productId === null ||
        quantity === null ||
        quantity <= 0 ||
        delta === null ||
        delta === 0 ||
        type === null
      ) {
        throw new Error('Dados insuficientes para aplicar o movimento remoto.');
      }
      const eventExists = database.sqlite
        .prepare('SELECT id FROM events WHERE id = ?')
        .get(eventId);
      const productExists = database.sqlite
        .prepare('SELECT id FROM products WHERE id = ?')
        .get(productId);
      if (eventExists === undefined || productExists === undefined) {
        throw new Error('Evento ou produto ainda não existe neste computador.');
      }
      const alreadyApplied = database.sqlite
        .prepare('SELECT id FROM stock_movements WHERE id = ?')
        .get(payload.entityId);
      if (alreadyApplied !== undefined) return;
      const current = database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(eventId, productId) as { readonly quantity: number } | undefined;
      const nextQuantity = (current?.quantity ?? 0) + delta;
      if (nextQuantity < 0) {
        throw new Error('Movimento remoto deixaria o estoque negativo; aguardando auditoria.');
      }
      database.sqlite
        .prepare(
          `INSERT INTO event_stock (event_id, product_id, quantity, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id, product_id) DO UPDATE SET
             quantity = excluded.quantity, updated_at = excluded.updated_at`,
        )
        .run(eventId, productId, nextQuantity, payload.createdAt);
      database.sqlite
        .prepare(
          `INSERT INTO stock_movements
           (id, event_id, product_id, type, quantity, delta, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(payload.entityId, eventId, productId, type, quantity, delta, note, payload.createdAt);
      if (type === 'purchase') {
        const product = database.sqlite
          .prepare('SELECT cost_cents FROM products WHERE id = ?')
          .get(productId) as { readonly cost_cents: number };
        const totalCostCents = purchaseTotalCents ?? product.cost_cents * quantity;
        database.sqlite
          .prepare(
            `INSERT OR IGNORE INTO stock_purchase_lots
             (movement_id, event_id, product_id, quantity, total_cost_cents, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(payload.entityId, eventId, productId, quantity, totalCostCents, payload.createdAt);
      }
      return;
    }

    if (payload.action === 'inventory.stock-rejected') {
      const productId = stringField(payload.details, 'productId');
      const quantity = integerField(payload.details, 'quantity');
      const originalDelta = integerField(payload.details, 'delta');
      const reason = stringField(payload.details, 'reason');
      if (
        payload.entityId === null ||
        productId === null ||
        quantity === null ||
        quantity <= 0 ||
        originalDelta === null ||
        originalDelta >= 0 ||
        Math.abs(originalDelta) !== quantity
      ) {
        throw new Error('A rejeição central do estoque é inválida.');
      }
      const alreadyApplied = database.sqlite
        .prepare('SELECT id FROM stock_movements WHERE id = ?')
        .get(payload.entityId);
      if (alreadyApplied !== undefined) return;
      const productExists = database.sqlite
        .prepare('SELECT id FROM products WHERE id = ?')
        .get(productId);
      if (productExists === undefined) {
        throw new Error('O produto rejeitado pela central não existe neste computador.');
      }
      const current = database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(eventId, productId) as { readonly quantity: number } | undefined;
      const restoredQuantity = (current?.quantity ?? 0) + quantity;
      database.sqlite
        .prepare(
          `INSERT INTO event_stock (event_id, product_id, quantity, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(event_id, product_id) DO UPDATE SET
             quantity = excluded.quantity, updated_at = excluded.updated_at`,
        )
        .run(eventId, productId, restoredQuantity, payload.createdAt);
      database.sqlite
        .prepare(
          `INSERT INTO stock_movements
           (id, event_id, product_id, type, quantity, delta, note, created_at)
           VALUES (?, ?, ?, 'correction-positive', ?, ?, ?, ?)`,
        )
        .run(
          payload.entityId,
          eventId,
          productId,
          quantity,
          quantity,
          reason ?? 'Movimento rejeitado pela central de sincronização.',
          payload.createdAt,
        );
      return;
    }

    if (payload.action === 'inventory.purchase-lot-corrected') {
      const totalCostCents = integerField(payload.details, 'totalCostCents');
      if (payload.entityId === null || totalCostCents === null || totalCostCents <= 0) {
        throw new Error('Dados insuficientes para corrigir o lote remoto.');
      }
      database.sqlite
        .prepare('UPDATE stock_purchase_lots SET total_cost_cents = ? WHERE movement_id = ?')
        .run(totalCostCents, payload.entityId);
      return;
    }

    if (payload.action === 'inventory.purchase-lot-voided') {
      const productId = stringField(payload.details, 'productId');
      const quantity = integerField(payload.details, 'quantity');
      const reason = stringField(payload.details, 'reason');
      if (
        payload.entityId === null ||
        productId === null ||
        quantity === null ||
        quantity <= 0 ||
        reason === null
      ) {
        throw new Error('Dados insuficientes para desfazer o lote remoto.');
      }
      const exists = database.sqlite
        .prepare('SELECT movement_id FROM stock_purchase_lot_voids WHERE movement_id = ?')
        .get(payload.entityId);
      if (exists !== undefined) return;
      database.sqlite
        .prepare(
          'UPDATE event_stock SET quantity = quantity - ?, updated_at = ? WHERE event_id = ? AND product_id = ?',
        )
        .run(quantity, payload.createdAt, eventId, productId);
      database.sqlite
        .prepare(
          `INSERT INTO stock_movements (id, event_id, product_id, type, quantity, delta, note, created_at) VALUES (?, ?, ?, 'correction-negative', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          eventId,
          productId,
          quantity,
          -quantity,
          `Desfazer entrada: ${reason}`,
          payload.createdAt,
        );
      database.sqlite
        .prepare(
          'INSERT INTO stock_purchase_lot_voids (movement_id, event_id, reason, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(payload.entityId, eventId, reason, payload.createdAt);
      return;
    }

    if (payload.action === 'operations.service-point-created') {
      const label = stringField(payload.details, 'label');
      const type = stringField(payload.details, 'type');
      if (payload.entityId === null || label === null || (type !== 'table' && type !== 'counter')) {
        throw new Error('Dados insuficientes para criar o ponto de atendimento remoto.');
      }
      if (
        database.sqlite.prepare('SELECT id FROM events WHERE id = ?').get(eventId) === undefined
      ) {
        throw new Error('O evento do ponto de atendimento ainda não existe neste computador.');
      }
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO service_points
           (id, event_id, label, type, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(payload.entityId, eventId, label, type, payload.createdAt, payload.createdAt);
      return;
    }

    if (payload.action === 'operations.service-point-renamed') {
      const label = stringField(payload.details, 'label');
      if (payload.entityId === null || label === null)
        throw new Error('Renomeação remota de mesa incompleta.');
      database.sqlite
        .prepare(
          'UPDATE service_points SET label = ?, updated_at = ? WHERE id = ? AND event_id = ?',
        )
        .run(label, payload.createdAt, payload.entityId, eventId);
      database.sqlite
        .prepare(
          `UPDATE orders SET service_point_label = ?, updated_at = ?
           WHERE service_point_id = ? AND status = 'open'`,
        )
        .run(label, payload.createdAt, payload.entityId);
      return;
    }

    if (payload.action === 'operations.service-point-pinned') {
      if (payload.entityId === null || typeof payload.details.pinned !== 'boolean')
        throw new Error('Fixação remota de mesa incompleta.');
      const key = `service-point.pinned:${payload.entityId}`;
      if (payload.details.pinned) {
        database.sqlite
          .prepare(
            `INSERT INTO app_meta (key, value, updated_at) VALUES (?, '1', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(key, payload.createdAt);
      } else {
        database.sqlite.prepare('DELETE FROM app_meta WHERE key = ?').run(key);
      }
      return;
    }

    if (payload.action === 'operations.service-point-deleted') {
      if (payload.entityId === null) throw new Error('Exclusão remota de mesa sem identificador.');
      database.sqlite
        .prepare(
          `DELETE FROM order_voucher_allocations
           WHERE order_id IN (
             SELECT id FROM orders WHERE service_point_id = ? AND status = 'open'
           )`,
        )
        .run(payload.entityId);
      database.sqlite
        .prepare(
          "UPDATE orders SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE service_point_id = ? AND status = 'open'",
        )
        .run(payload.createdAt, payload.createdAt, payload.entityId);
      database.sqlite
        .prepare(
          'UPDATE service_points SET active = 0, updated_at = ? WHERE id = ? AND event_id = ?',
        )
        .run(payload.createdAt, payload.entityId, eventId);
      database.sqlite
        .prepare('DELETE FROM app_meta WHERE key = ?')
        .run(`service-point.pinned:${payload.entityId}`);
      return;
    }

    if (payload.action === 'operations.order-paid') {
      this.#applyRemotePaidOrder(database, eventId, payload);
      return;
    }

    if (payload.action === 'operations.order-cancelled') {
      this.#applyRemoteOrderCancellation(database, eventId, payload);
      return;
    }

    if (payload.action === 'cashier.sale-rejected') {
      const originalCommandId = stringField(payload.details, 'originalCommandId');
      if (originalCommandId === null)
        throw new Error('A rejeição remota não identifica a venda original.');
      database.sqlite
        .prepare(
          'UPDATE sync_conflicts SET resolved_at = ? WHERE command_id = ? AND resolved_at IS NULL',
        )
        .run(payload.createdAt, originalCommandId);
      return;
    }

    if (payload.action.startsWith('expense.')) {
      this.#applyRemoteExpense(database, eventId, payload);
      return;
    }

    if (payload.action.startsWith('cash.')) {
      this.#applyRemoteCash(database, eventId, payload);
      return;
    }

    if (payload.action.startsWith('capital.')) {
      this.#applyRemoteCapital(database, eventId, payload);
      return;
    }

    if (payload.action.startsWith('ticket.')) {
      this.#applyRemoteTicket(database, eventId, payload);
      return;
    }

    if (payload.action.startsWith('voucher.')) {
      this.#applyRemoteVoucher(database, eventId, payload);
      return;
    }

    throw new Error(`Ação remota ainda não possui aplicador: ${payload.action}.`);
  }

  #applyRemotePaidOrder(database: DatabaseContext, eventId: string, payload: JournalPayload): void {
    const order = isRecord(payload.details.order) ? payload.details.order : null;
    const items = Array.isArray(payload.details.items) ? payload.details.items : null;
    const payments = Array.isArray(payload.details.payments) ? payload.details.payments : null;
    const movements = Array.isArray(payload.details.stockMovements)
      ? payload.details.stockMovements
      : null;
    const vouchers = Array.isArray(payload.details.vouchers) ? payload.details.vouchers : null;
    const subtotalCents = integerField(payload.details, 'subtotalCents');
    const discountCents = integerField(payload.details, 'discountCents');
    const totalCents = integerField(payload.details, 'totalCents');
    if (
      order === null ||
      items === null ||
      payments === null ||
      movements === null ||
      vouchers === null ||
      subtotalCents === null ||
      discountCents === null ||
      totalCents === null
    ) {
      throw new Error('A venda remota não contém sua transação completa.');
    }
    const orderId = stringField(order, 'id');
    const servicePointId = stringField(order, 'servicePointId');
    const servicePointLabel = stringField(order, 'servicePointLabel');
    const rawServicePointType = stringField(order, 'servicePointType');
    const servicePointType = rawServicePointType === 'table' ? 'table' : 'counter';
    const openedAt = integerField(order, 'openedAt');
    if (
      orderId === null ||
      servicePointId === null ||
      servicePointLabel === null ||
      openedAt === null
    ) {
      throw new Error('A venda remota não identifica a comanda.');
    }
    const voucherUses = vouchers.map((raw) => {
      if (!isRecord(raw)) throw new Error('Uso remoto de voucher inválido.');
      const code = stringField(raw, 'code');
      const amountCents = integerField(raw, 'amountCents');
      if (code === null || amountCents === null || amountCents <= 0)
        throw new Error('Uso remoto de voucher incompleto.');
      return { code, amountCents };
    });
    const paymentCents = payments.reduce(
      (total, raw) => total + (isRecord(raw) ? (integerField(raw, 'amountCents') ?? 0) : 0),
      0,
    );
    const voucherCents = voucherUses.reduce((total, voucher) => total + voucher.amountCents, 0);
    if (paymentCents + voucherCents !== totalCents) {
      throw new Error('Os pagamentos e vouchers remotos não somam o total da venda.');
    }
    if (database.sqlite.prepare('SELECT id FROM orders WHERE id = ?').get(orderId) !== undefined)
      return;
    if (database.sqlite.prepare('SELECT id FROM events WHERE id = ?').get(eventId) === undefined) {
      throw new Error('O evento da venda ainda não existe neste computador.');
    }
    let localServicePointId = servicePointId;
    if (
      database.sqlite.prepare('SELECT id FROM service_points WHERE id = ?').get(servicePointId) ===
      undefined
    ) {
      const matchingPoint = database.sqlite
        .prepare(
          `SELECT id FROM service_points
           WHERE event_id = ? AND label = ? COLLATE NOCASE AND type = ? AND active = 1
           ORDER BY created_at LIMIT 1`,
        )
        .get(eventId, servicePointLabel, servicePointType) as { readonly id: string } | undefined;
      if (matchingPoint !== undefined) {
        localServicePointId = matchingPoint.id;
      } else {
        database.sqlite
          .prepare(
            `INSERT INTO service_points (id, event_id, label, type, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            servicePointId,
            eventId,
            servicePointLabel,
            servicePointType,
            openedAt,
            payload.createdAt,
          );
      }
    }
    const parsedMovements = movements.map((raw) => {
      if (!isRecord(raw)) throw new Error('Movimento de estoque remoto inválido.');
      const id = stringField(raw, 'id');
      const productId = stringField(raw, 'product_id');
      const quantity = integerField(raw, 'quantity');
      const delta = integerField(raw, 'delta');
      const createdAt = integerField(raw, 'created_at');
      const note = raw.note === null ? null : stringField(raw, 'note');
      if (
        id === null ||
        productId === null ||
        quantity === null ||
        delta === null ||
        createdAt === null
      ) {
        throw new Error('Movimento de estoque remoto incompleto.');
      }
      return { id, productId, quantity, delta, createdAt, note };
    });
    for (const movement of parsedMovements) {
      const current = database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(eventId, movement.productId) as { readonly quantity: number } | undefined;
      if ((current?.quantity ?? 0) + movement.delta < 0) {
        throw new Error('Venda remota deixaria o estoque negativo; aguardando auditoria.');
      }
    }
    database.sqlite
      .prepare(
        `INSERT INTO orders
         (id, event_id, service_point_id, service_point_label, status, subtotal_cents,
          discount_cents, total_cents, opened_at, closed_at, updated_at)
         VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        orderId,
        eventId,
        localServicePointId,
        servicePointLabel,
        subtotalCents,
        discountCents,
        totalCents,
        openedAt,
        payload.createdAt,
        payload.createdAt,
      );
    redeemVouchers(database, eventId, orderId, voucherUses, payload.createdAt);
    const insertItem = database.sqlite.prepare(
      `INSERT INTO order_items
       (id, order_id, item_kind, item_id, item_name, quantity, unit_price_cents, total_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertComponentAllocation = database.sqlite.prepare(
      `INSERT INTO order_item_component_allocations
       (id, order_item_id, product_id, choice_group, choice_label, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const raw of items) {
      if (!isRecord(raw)) throw new Error('Item de venda remoto inválido.');
      const id = stringField(raw, 'id');
      const itemKind = stringField(raw, 'itemKind');
      const itemId = stringField(raw, 'itemId');
      const itemName = stringField(raw, 'itemName');
      const quantity = integerField(raw, 'quantity');
      const unitPriceCents = integerField(raw, 'unitPriceCents');
      const itemTotal = integerField(raw, 'totalCents');
      if (
        id === null ||
        itemId === null ||
        itemName === null ||
        quantity === null ||
        unitPriceCents === null ||
        itemTotal === null ||
        (itemKind !== 'product' && itemKind !== 'combo')
      )
        throw new Error('Item de venda remoto incompleto.');
      insertItem.run(
        id,
        orderId,
        itemKind,
        itemId,
        itemName,
        quantity,
        unitPriceCents,
        itemTotal,
        payload.createdAt,
      );
      if (Array.isArray(raw.componentAllocations)) {
        for (const rawAllocation of raw.componentAllocations) {
          if (!isRecord(rawAllocation)) throw new Error('Componente remoto inválido.');
          const productId = stringField(rawAllocation, 'productId');
          const choiceGroup =
            rawAllocation.choiceGroup === null ? null : stringField(rawAllocation, 'choiceGroup');
          const choiceLabel =
            rawAllocation.choiceLabel === null || rawAllocation.choiceLabel === undefined
              ? null
              : stringField(rawAllocation, 'choiceLabel');
          const allocationQuantity = integerField(rawAllocation, 'quantity');
          if (
            productId === null ||
            allocationQuantity === null ||
            allocationQuantity <= 0 ||
            (choiceGroup === null) !== (choiceLabel === null)
          ) {
            throw new Error('Componente remoto incompleto.');
          }
          if (
            database.sqlite.prepare('SELECT id FROM products WHERE id = ?').get(productId) ===
            undefined
          ) {
            throw new Error('O componente remoto ainda não existe neste computador.');
          }
          insertComponentAllocation.run(
            randomUUID(),
            id,
            productId,
            choiceGroup,
            choiceLabel,
            allocationQuantity,
            payload.createdAt,
          );
        }
      }
    }
    const insertPayment = database.sqlite.prepare(
      `INSERT INTO payments (id, order_id, method, amount_cents, received_cents, change_cents, fee_rate_basis_points, fee_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const raw of payments) {
      if (!isRecord(raw)) throw new Error('Pagamento remoto inválido.');
      const id = stringField(raw, 'id');
      const method = stringField(raw, 'method');
      const amount = integerField(raw, 'amountCents');
      const change = integerField(raw, 'changeCents');
      const received = raw.receivedCents === null ? null : integerField(raw, 'receivedCents');
      const feeRateBasisPoints =
        raw.feeRateBasisPoints === null ? null : integerField(raw, 'feeRateBasisPoints');
      const feeCents = raw.feeCents === null ? null : integerField(raw, 'feeCents');
      const hasValidReceived = raw.receivedCents === null || received !== null;
      if (
        id === null ||
        amount === null ||
        change === null ||
        !hasValidReceived ||
        (method !== 'cash' &&
          method !== 'pix' &&
          method !== 'credit-card' &&
          method !== 'debit-card')
      ) {
        throw new Error('Pagamento remoto incompleto.');
      }
      insertPayment.run(
        id,
        orderId,
        method,
        amount,
        received,
        change,
        feeRateBasisPoints,
        feeCents,
        payload.createdAt,
      );
    }
    for (const movement of parsedMovements) {
      // A sale has a negative delta. SQLite validates an INSERT value before
      // conflict resolution, so an UPSERT with -1 violates the non-negative
      // stock constraint even when the existing row has stock available.
      const updated = database.sqlite
        .prepare(
          `UPDATE event_stock
           SET quantity = quantity + ?, updated_at = ?
           WHERE event_id = ? AND product_id = ?`,
        )
        .run(movement.delta, movement.createdAt, eventId, movement.productId);
      if (updated.changes === 0) {
        database.sqlite
          .prepare(
            `INSERT INTO event_stock (event_id, product_id, quantity, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(eventId, movement.productId, movement.delta, movement.createdAt);
      }
      database.sqlite
        .prepare(
          `INSERT INTO stock_movements (id, event_id, product_id, type, quantity, delta, note, created_at)
         VALUES (?, ?, ?, 'sale', ?, ?, ?, ?)`,
        )
        .run(
          movement.id,
          eventId,
          movement.productId,
          movement.quantity,
          movement.delta,
          movement.note,
          movement.createdAt,
        );
    }
    const termForProduct = database.sqlite.prepare(
      `SELECT supplier_unit_cents, commission_unit_cents
       FROM food_product_terms WHERE event_id = ? AND product_id = ?`,
    );
    const insertSettlement = database.sqlite.prepare(
      `INSERT OR IGNORE INTO food_sale_settlements
       (id, event_id, order_id, product_id, quantity, received_cents, supplier_cents, commission_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const movement of parsedMovements) {
      const term = termForProduct.get(eventId, movement.productId) as
        | { readonly supplier_unit_cents: number; readonly commission_unit_cents: number }
        | undefined;
      if (term === undefined) continue;
      const supplierCents = term.supplier_unit_cents * movement.quantity;
      const commissionCents = term.commission_unit_cents * movement.quantity;
      insertSettlement.run(
        randomUUID(),
        eventId,
        orderId,
        movement.productId,
        movement.quantity,
        supplierCents + commissionCents,
        supplierCents,
        commissionCents,
        payload.createdAt,
      );
    }
  }

  #applyRemoteExpense(database: DatabaseContext, eventId: string, payload: JournalPayload): void {
    if (payload.entityId === null) throw new Error('A despesa remota não possui identificador.');
    if (database.sqlite.prepare('SELECT id FROM events WHERE id = ?').get(eventId) === undefined) {
      throw new Error('O evento da despesa ainda não existe neste computador.');
    }
    if (payload.action === 'expense.created') {
      const category = stringField(payload.details, 'category');
      const description = stringField(payload.details, 'description');
      const amountCents = integerField(payload.details, 'amountCents');
      const paymentMethod = stringField(payload.details, 'paymentMethod');
      const paymentStatus = stringField(payload.details, 'paymentStatus');
      const note = payload.details.note === null ? null : stringField(payload.details, 'note');
      if (
        category === null ||
        description === null ||
        amountCents === null ||
        amountCents <= 0 ||
        !['cash', 'pix', 'credit-card', 'debit-card'].includes(paymentMethod ?? '') ||
        !['open', 'partial', 'paid'].includes(paymentStatus ?? '')
      ) {
        throw new Error('Dados insuficientes para criar a despesa remota.');
      }
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO expenses
         (id, event_id, category, description, amount_cents, payment_method, note, status,
          payment_status, created_at, cancelled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?)`,
        )
        .run(
          payload.entityId,
          eventId,
          category,
          description,
          amountCents,
          paymentMethod,
          note,
          paymentStatus,
          payload.createdAt,
          payload.createdAt,
        );
      return;
    }
    if (payload.action === 'expense.payment-recorded') {
      const expenseId = stringField(payload.details, 'expenseId');
      const method = stringField(payload.details, 'method');
      const amount = integerField(payload.details, 'amountCents');
      const note = payload.details.note === null ? null : stringField(payload.details, 'note');
      if (
        expenseId === null ||
        amount === null ||
        amount <= 0 ||
        !['cash', 'pix', 'credit-card', 'debit-card'].includes(method ?? '')
      )
        throw new Error('Pagamento remoto de despesa inválido.');
      database.sqlite
        .prepare(
          'INSERT OR IGNORE INTO expense_payments (id, expense_id, event_id, method, amount_cents, cash_register_id, note, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        )
        .run(payload.entityId, eventId, expenseId, method, amount, note, payload.createdAt);
      const expense = database.sqlite
        .prepare('SELECT amount_cents FROM expenses WHERE id = ?')
        .get(expenseId) as { amount_cents: number } | undefined;
      if (expense !== undefined) {
        const paid = (
          database.sqlite
            .prepare(
              'SELECT COALESCE(SUM(amount_cents), 0) AS value FROM expense_payments WHERE expense_id = ?',
            )
            .get(expenseId) as { value: number }
        ).value;
        database.sqlite
          .prepare('UPDATE expenses SET payment_status = ?, updated_at = ? WHERE id = ?')
          .run(
            paid >= expense.amount_cents ? 'paid' : paid > 0 ? 'partial' : 'open',
            payload.createdAt,
            expenseId,
          );
      }
      return;
    }
    const exists = database.sqlite
      .prepare('SELECT id FROM expenses WHERE id = ?')
      .get(payload.entityId);
    if (exists === undefined)
      throw new Error('A despesa remota ainda não existe neste computador.');
    if (payload.action === 'expense.updated') {
      const after = isRecord(payload.details.after) ? payload.details.after : null;
      if (after === null) throw new Error('Atualização remota de despesa incompleta.');
      const category = stringField(after, 'category');
      const description = stringField(after, 'description');
      const amountCents = integerField(after, 'amountCents');
      const paymentMethod = stringField(after, 'paymentMethod');
      const paymentStatus = stringField(after, 'paymentStatus');
      const note = after.note === null ? null : stringField(after, 'note');
      if (
        category === null ||
        description === null ||
        amountCents === null ||
        !['cash', 'pix', 'credit-card', 'debit-card'].includes(paymentMethod ?? '') ||
        !['open', 'partial', 'paid'].includes(paymentStatus ?? '')
      )
        throw new Error('Atualização remota de despesa inválida.');
      database.sqlite
        .prepare(
          `UPDATE expenses SET category = ?, description = ?, amount_cents = ?, payment_method = ?,
         payment_status = ?, note = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          category,
          description,
          amountCents,
          paymentMethod,
          paymentStatus,
          note,
          payload.createdAt,
          payload.entityId,
        );
      return;
    }
    if (payload.action === 'expense.payment-status-changed') {
      const status = stringField(payload.details, 'after');
      if (status !== 'open' && status !== 'partial' && status !== 'paid')
        throw new Error('Status remoto de despesa inválido.');
      database.sqlite
        .prepare('UPDATE expenses SET payment_status = ?, updated_at = ? WHERE id = ?')
        .run(status, payload.createdAt, payload.entityId);
      return;
    }
    if (payload.action === 'expense.cancelled') {
      database.sqlite
        .prepare(
          `UPDATE expenses SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(payload.createdAt, payload.createdAt, payload.entityId);
      return;
    }
    if (payload.action === 'expense.deleted') {
      database.sqlite
        .prepare('DELETE FROM expense_payments WHERE expense_id = ?')
        .run(payload.entityId);
      database.sqlite.prepare('DELETE FROM expenses WHERE id = ?').run(payload.entityId);
      return;
    }
    throw new Error(`Ação de despesa sem aplicador: ${payload.action}.`);
  }

  #applyRemoteVoucher(database: DatabaseContext, eventId: string, payload: JournalPayload): void {
    if (payload.entityId === null) throw new Error('O voucher remoto não possui identificador.');
    if (database.sqlite.prepare('SELECT id FROM events WHERE id = ?').get(eventId) === undefined) {
      throw new Error('O evento do voucher ainda não existe neste computador.');
    }
    if (payload.action === 'voucher.created') {
      const code = stringField(payload.details, 'code');
      const label = stringField(payload.details, 'label');
      const initialBalanceCents = integerField(payload.details, 'initialBalanceCents');
      const servicePointId = stringField(payload.details, 'servicePointId');
      if (
        code === null ||
        label === null ||
        initialBalanceCents === null ||
        initialBalanceCents <= 0
      ) {
        throw new Error('Dados insuficientes para criar o voucher remoto.');
      }
      const exists = database.sqlite
        .prepare('SELECT id FROM vouchers WHERE id = ?')
        .get(payload.entityId);
      if (exists === undefined) {
        database.sqlite
          .prepare(
            `INSERT INTO vouchers
             (id, event_id, code, label, initial_balance_cents, remaining_balance_cents, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(
            payload.entityId,
            eventId,
            code,
            label,
            initialBalanceCents,
            initialBalanceCents,
            payload.createdAt,
            payload.createdAt,
          );
        database.sqlite
          .prepare(
            `INSERT INTO voucher_transactions
             (id, event_id, voucher_id, voucher_code, order_id, type, amount_cents, balance_before_cents, balance_after_cents, note, created_at)
             VALUES (?, ?, ?, ?, NULL, 'issue', ?, 0, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            eventId,
            payload.entityId,
            code,
            initialBalanceCents,
            initialBalanceCents,
            label,
            payload.createdAt,
          );
      }
      if (servicePointId !== null) {
        database.sqlite
          .prepare(
            `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(`voucher.service-point:${payload.entityId}`, servicePointId, payload.createdAt);
      }
      return;
    }
    if (payload.action === 'voucher.service-point-bound') {
      const servicePointId = stringField(payload.details, 'servicePointId');
      if (servicePointId === null) throw new Error('Vínculo remoto de voucher incompleto.');
      database.sqlite
        .prepare(
          `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(`voucher.service-point:${payload.entityId}`, servicePointId, payload.createdAt);
      return;
    }
    if (payload.action === 'voucher.updated') {
      const code = stringField(payload.details, 'code');
      const label = stringField(payload.details, 'label');
      const servicePointId = stringField(payload.details, 'servicePointId');
      if (code === null || label === null || servicePointId === null)
        throw new Error('Atualização remota de voucher incompleta.');
      database.sqlite
        .prepare(
          'UPDATE vouchers SET code = ?, label = ?, updated_at = ? WHERE id = ? AND event_id = ?',
        )
        .run(code, label, payload.createdAt, payload.entityId, eventId);
      database.sqlite
        .prepare(
          `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(`voucher.service-point:${payload.entityId}`, servicePointId, payload.createdAt);
      return;
    }
    if (payload.action === 'voucher.balance-added') {
      const amount = integerField(payload.details, 'amountCents');
      if (amount === null || amount <= 0) throw new Error('Recarga remota de voucher inválida.');
      database.sqlite
        .prepare(
          `UPDATE vouchers
           SET initial_balance_cents = initial_balance_cents + ?,
               remaining_balance_cents = remaining_balance_cents + ?,
               status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'active' END,
               updated_at = ?
           WHERE id = ? AND event_id = ?`,
        )
        .run(amount, amount, payload.createdAt, payload.entityId, eventId);
      return;
    }
    if (payload.action === 'voucher.cancelled' || payload.action === 'voucher.active') {
      database.sqlite
        .prepare('UPDATE vouchers SET status = ?, updated_at = ? WHERE id = ? AND event_id = ?')
        .run(
          payload.action === 'voucher.active' ? 'active' : 'cancelled',
          payload.createdAt,
          payload.entityId,
          eventId,
        );
      return;
    }
    if (payload.action === 'voucher.deleted') {
      database.sqlite
        .prepare('DELETE FROM order_voucher_allocations WHERE voucher_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM voucher_transactions WHERE voucher_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM app_meta WHERE key IN (?, ?)')
        .run(`voucher.service-point:${payload.entityId}`, `voucher.deleted-at:${payload.entityId}`);
      database.sqlite
        .prepare('DELETE FROM vouchers WHERE id = ? AND event_id = ?')
        .run(payload.entityId, eventId);
      return;
    }
    if (payload.action === 'voucher.deleted-with-reversal') {
      database.sqlite
        .prepare('DELETE FROM order_voucher_allocations WHERE voucher_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare(
          "UPDATE vouchers SET status = 'cancelled', updated_at = ? WHERE id = ? AND event_id = ?",
        )
        .run(payload.createdAt, payload.entityId, eventId);
      database.sqlite
        .prepare('DELETE FROM app_meta WHERE key = ?')
        .run(`voucher.service-point:${payload.entityId}`);
      database.sqlite
        .prepare(
          `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(
          `voucher.deleted-at:${payload.entityId}`,
          String(payload.createdAt),
          payload.createdAt,
        );
      return;
    }
    throw new Error(`Ação de voucher sem aplicador: ${payload.action}.`);
  }

  #applyRemoteCapital(database: DatabaseContext, eventId: string, payload: JournalPayload): void {
    if (payload.entityId === null)
      throw new Error('O lançamento de aporte remoto não possui identificador.');
    if (payload.action === 'capital.contribution-created') {
      const contributorName = stringField(payload.details, 'contributorName');
      const kind = stringField(payload.details, 'kind');
      const amount = integerField(payload.details, 'amountCents');
      const remaining = integerField(payload.details, 'remainingStockValueCents');
      const priority = integerField(payload.details, 'recoveryPriority');
      const note = payload.details.note === null ? null : stringField(payload.details, 'note');
      if (
        contributorName === null ||
        amount === null ||
        remaining === null ||
        priority === null ||
        (kind !== 'cash' && kind !== 'inventory')
      )
        throw new Error('Aporte remoto inválido.');
      database.sqlite
        .prepare(
          "INSERT OR IGNORE INTO capital_contributions (id,event_id,contributor_name,kind,amount_cents,remaining_stock_value_cents,recovery_priority,note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?)",
        )
        .run(
          payload.entityId,
          eventId,
          contributorName,
          kind,
          amount,
          remaining,
          priority,
          note,
          payload.createdAt,
          payload.createdAt,
        );
      return;
    }
    if (payload.action === 'capital.contribution-updated') {
      const remaining = integerField(payload.details, 'remainingStockValueCents');
      if (remaining === null) throw new Error('Atualização de aporte remoto inválida.');
      database.sqlite
        .prepare(
          'UPDATE capital_contributions SET remaining_stock_value_cents = ?, updated_at = ? WHERE id = ?',
        )
        .run(remaining, payload.createdAt, payload.entityId);
      return;
    }
    if (payload.action === 'capital.reimbursed') {
      const contributionId = stringField(payload.details, 'contributionId');
      const method = stringField(payload.details, 'method');
      const amount = integerField(payload.details, 'amountCents');
      const note = payload.details.note === null ? null : stringField(payload.details, 'note');
      if (
        contributionId === null ||
        amount === null ||
        (method !== 'cash' &&
          method !== 'pix' &&
          method !== 'credit-card' &&
          method !== 'debit-card')
      )
        throw new Error('Reembolso remoto inválido.');
      database.sqlite
        .prepare(
          'INSERT OR IGNORE INTO capital_reimbursements (id,contribution_id,event_id,method,amount_cents,cash_register_id,note,created_at) VALUES (?,?,?,?,?,NULL,?,?)',
        )
        .run(payload.entityId, contributionId, eventId, method, amount, note, payload.createdAt);
      return;
    }
    throw new Error(`Ação de aporte sem aplicador: ${payload.action}.`);
  }

  #applyRemoteOrderCancellation(
    database: DatabaseContext,
    eventId: string,
    payload: JournalPayload,
  ): void {
    if (payload.entityId === null) throw new Error('Cancelamento remoto sem comanda.');
    const order = database.sqlite
      .prepare('SELECT status FROM orders WHERE id = ? AND event_id = ?')
      .get(payload.entityId, eventId) as { status: string } | undefined;
    if (order === undefined || order.status === 'cancelled') return;
    const rows = database.sqlite
      .prepare(
        "SELECT product_id, SUM(quantity) AS quantity FROM stock_movements WHERE event_id = ? AND type = 'sale' AND note = ? GROUP BY product_id",
      )
      .all(eventId, `Venda da comanda ${payload.entityId}`) as Array<{
      product_id: string;
      quantity: number;
    }>;
    for (const row of rows) {
      database.sqlite
        .prepare(
          'UPDATE event_stock SET quantity = quantity + ?, updated_at = ? WHERE event_id = ? AND product_id = ?',
        )
        .run(row.quantity, payload.createdAt, eventId, row.product_id);
      database.sqlite
        .prepare(
          'INSERT INTO stock_movements (id,event_id,product_id,type,quantity,delta,note,created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          eventId,
          row.product_id,
          'return',
          row.quantity,
          row.quantity,
          `Estorno da comanda ${payload.entityId}`,
          payload.createdAt,
        );
    }
    refundOrderVouchers(database, eventId, payload.entityId, payload.createdAt);
    const refunds = Array.isArray(payload.details.refunds) ? payload.details.refunds : [];
    for (const raw of refunds) {
      if (!isRecord(raw)) continue;
      const method = stringField(raw, 'method');
      const amount = integerField(raw, 'amountCents');
      if (
        amount === null ||
        (method !== 'cash' &&
          method !== 'pix' &&
          method !== 'credit-card' &&
          method !== 'debit-card')
      )
        continue;
      database.sqlite
        .prepare(
          'INSERT INTO order_refunds (id,order_id,event_id,method,amount_cents,cash_register_id,note,created_at) VALUES (?,?,?,?,?,NULL,?,?)',
        )
        .run(
          randomUUID(),
          payload.entityId,
          eventId,
          method,
          amount,
          stringField(payload.details, 'reason'),
          payload.createdAt,
        );
    }
    database.sqlite
      .prepare("UPDATE orders SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?")
      .run(payload.createdAt, payload.createdAt, payload.entityId);
    database.sqlite
      .prepare('DELETE FROM food_sale_settlements WHERE order_id = ?')
      .run(payload.entityId);
  }

  #applyRemoteCash(database: DatabaseContext, eventId: string, payload: JournalPayload): void {
    if (database.sqlite.prepare('SELECT id FROM events WHERE id = ?').get(eventId) === undefined) {
      throw new Error('O evento do caixa ainda não existe neste computador.');
    }
    if (payload.entityId === null)
      throw new Error('O lançamento de caixa remoto não possui identificador.');
    if (payload.action === 'cash.opened') {
      const opening = integerField(payload.details, 'openingCashCents');
      if (opening === null || opening < 0) throw new Error('Abertura de caixa remota inválida.');
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO cash_registers
         (id, event_id, status, opening_cash_cents, expected_cash_cents, counted_cash_cents,
          variance_cents, opened_at, closed_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, NULL, NULL, ?, NULL, ?)`,
        )
        .run(payload.entityId, eventId, opening, opening, payload.createdAt, payload.createdAt);
      if (opening > 0) {
        database.sqlite
          .prepare(
            `INSERT OR IGNORE INTO cash_movements
           (id, event_id, cash_register_id, type, amount_cents, note, created_at)
           VALUES (?, ?, ?, 'opening', ?, 'Saldo de abertura', ?)`,
          )
          .run(
            `${payload.entityId}:opening`,
            eventId,
            payload.entityId,
            opening,
            payload.createdAt,
          );
      }
      return;
    }
    if (payload.action === 'cash.supply' || payload.action === 'cash.withdrawal') {
      const amount = integerField(payload.details, 'amountCents');
      const registerId = stringField(payload.details, 'registerId');
      const note = payload.details.note === null ? null : stringField(payload.details, 'note');
      const type = payload.action === 'cash.supply' ? 'supply' : 'withdrawal';
      if (amount === null || amount <= 0 || registerId === null)
        throw new Error('Movimento de caixa remoto inválido.');
      if (
        database.sqlite.prepare('SELECT id FROM cash_registers WHERE id = ?').get(registerId) ===
        undefined
      )
        throw new Error('O caixa remoto ainda não existe neste computador.');
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO cash_movements
         (id, event_id, cash_register_id, type, amount_cents, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(payload.entityId, eventId, registerId, type, amount, note, payload.createdAt);
      database.sqlite
        .prepare('UPDATE cash_registers SET updated_at = ? WHERE id = ?')
        .run(payload.createdAt, registerId);
      return;
    }
    if (payload.action === 'cash.closed') {
      const counted = integerField(payload.details, 'countedCashCents');
      const expected = integerField(payload.details, 'expectedCashCents');
      const variance = integerField(payload.details, 'varianceCents');
      if (counted === null || expected === null || variance === null)
        throw new Error('Fechamento de caixa remoto inválido.');
      database.sqlite
        .prepare(
          `UPDATE cash_registers SET status = 'closed', expected_cash_cents = ?, counted_cash_cents = ?,
         variance_cents = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(expected, counted, variance, payload.createdAt, payload.createdAt, payload.entityId);
      return;
    }
    throw new Error(`Ação de caixa sem aplicador: ${payload.action}.`);
  }

  #applyRemoteTicket(database: DatabaseContext, eventId: string, payload: JournalPayload): void {
    if (database.sqlite.prepare('SELECT id FROM events WHERE id = ?').get(eventId) === undefined) {
      throw new Error('O evento do ingresso ainda não existe neste computador.');
    }
    if (payload.entityId === null)
      throw new Error('O registro de ingresso remoto não possui identificador.');
    if (payload.action === 'ticket.lot-created') {
      const name = stringField(payload.details, 'name');
      const price = integerField(payload.details, 'priceCents');
      const capacity = integerField(payload.details, 'capacity');
      if (name === null || price === null || capacity === null || capacity <= 0)
        throw new Error('Lote remoto inválido.');
      database.sqlite
        .prepare(
          `INSERT OR IGNORE INTO ticket_lots
         (id, event_id, name, price_cents, capacity, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          payload.entityId,
          eventId,
          name,
          price,
          capacity,
          payload.createdAt,
          payload.createdAt,
        );
      return;
    }
    if (payload.action === 'ticket.lot-updated') {
      const after = isRecord(payload.details.after) ? payload.details.after : null;
      if (after === null) throw new Error('Atualização de lote remota inválida.');
      const name = stringField(after, 'name');
      const price = integerField(after, 'priceCents');
      const capacity = integerField(after, 'capacity');
      const active = after.active;
      if (name === null || price === null || capacity === null || typeof active !== 'boolean')
        throw new Error('Atualização de lote remota incompleta.');
      database.sqlite
        .prepare(
          `UPDATE ticket_lots SET name = ?, price_cents = ?, capacity = ?, active = ?, updated_at = ? WHERE id = ?`,
        )
        .run(name, price, capacity, active ? 1 : 0, payload.createdAt, payload.entityId);
      return;
    }
    if (payload.action === 'ticket.sale-created' || payload.action === 'ticket.courtesy-created') {
      const lotId = stringField(payload.details, 'lotId');
      const lotName = stringField(payload.details, 'lotName');
      const attendeeName = stringField(payload.details, 'attendeeName');
      const source = stringField(payload.details, 'source');
      const quantity = integerField(payload.details, 'quantity');
      const unitPrice = integerField(payload.details, 'unitPriceCents');
      const total = integerField(payload.details, 'totalCents');
      const paymentMethod =
        payload.details.paymentMethod === null
          ? null
          : stringField(payload.details, 'paymentMethod');
      const codes = Array.isArray(payload.details.codes) ? payload.details.codes : null;
      if (
        lotId === null ||
        lotName === null ||
        attendeeName === null ||
        quantity === null ||
        unitPrice === null ||
        total === null ||
        codes === null ||
        !['sympla', 'whatsapp', 'door', 'courtesy'].includes(source ?? '')
      )
        throw new Error('Venda de ingresso remota incompleta.');
      if (
        database.sqlite.prepare('SELECT id FROM ticket_lots WHERE id = ?').get(lotId) === undefined
      )
        throw new Error('O lote da venda remota ainda não existe neste computador.');
      if (
        database.sqlite
          .prepare('SELECT id FROM ticket_sales WHERE id = ?')
          .get(payload.entityId) !== undefined
      )
        return;
      const parsedCodes = codes.map((raw) => {
        if (!isRecord(raw)) throw new Error('Código de ingresso remoto inválido.');
        const id = stringField(raw, 'id');
        const code = stringField(raw, 'code');
        if (id === null || code === null) throw new Error('Código de ingresso remoto incompleto.');
        return { id, code };
      });
      for (const code of parsedCodes) {
        if (
          database.sqlite
            .prepare('SELECT id FROM ticket_codes WHERE event_id = ? AND code = ? COLLATE NOCASE')
            .get(eventId, code.code) !== undefined
        )
          throw new Error('Código de ingresso já existe neste computador.');
      }
      database.sqlite
        .prepare(
          `INSERT INTO ticket_sales
         (id, event_id, lot_id, lot_name, attendee_name, source, quantity, unit_price_cents,
          total_cents, payment_method, status, created_at, cancelled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)`,
        )
        .run(
          payload.entityId,
          eventId,
          lotId,
          lotName,
          attendeeName,
          source,
          quantity,
          unitPrice,
          total,
          paymentMethod,
          payload.createdAt,
          payload.createdAt,
        );
      const insertCode = database.sqlite.prepare(
        `INSERT INTO ticket_codes (id, event_id, sale_id, code, status, created_at)
         VALUES (?, ?, ?, ?, 'valid', ?)`,
      );
      for (const code of parsedCodes)
        insertCode.run(code.id, eventId, payload.entityId, code.code, payload.createdAt);
      return;
    }
    if (payload.action === 'ticket.sale-cancelled') {
      const exists = database.sqlite
        .prepare('SELECT id FROM ticket_sales WHERE id = ?')
        .get(payload.entityId);
      if (exists === undefined)
        throw new Error('A venda de ingresso remota ainda não existe neste computador.');
      database.sqlite
        .prepare(
          `UPDATE ticket_sales SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(payload.createdAt, payload.createdAt, payload.entityId);
      database.sqlite
        .prepare("UPDATE ticket_codes SET status = 'cancelled' WHERE sale_id = ?")
        .run(payload.entityId);
      return;
    }
    if (payload.action === 'ticket.sale-deleted') {
      database.sqlite.prepare('DELETE FROM ticket_codes WHERE sale_id = ?').run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM ticket_sales WHERE id = ? AND event_id = ?')
        .run(payload.entityId, eventId);
      return;
    }
    if (payload.action === 'ticket.lot-deleted') {
      database.sqlite
        .prepare(
          'DELETE FROM ticket_codes WHERE sale_id IN (SELECT id FROM ticket_sales WHERE lot_id = ? AND event_id = ?)',
        )
        .run(payload.entityId, eventId);
      database.sqlite
        .prepare('DELETE FROM ticket_sales WHERE lot_id = ? AND event_id = ?')
        .run(payload.entityId, eventId);
      database.sqlite
        .prepare('DELETE FROM ticket_lots WHERE id = ? AND event_id = ?')
        .run(payload.entityId, eventId);
      return;
    }
    throw new Error(`Ação de ingresso sem aplicador: ${payload.action}.`);
  }

  async #readOrCreateDeviceId(): Promise<string> {
    try {
      const existing = (await readFile(this.#deviceIdPath, 'utf8')).trim();
      if (existing.length > 0 && existing.length <= 80) {
        return existing;
      }
    } catch {
      // A primeira execução cria uma identidade local sem expor a chave de pareamento.
    }

    const deviceId = randomUUID();
    await writeFile(this.#deviceIdPath, deviceId, 'utf8');
    return deviceId;
  }

  #status(status: Omit<CloudSyncStatus, 'endpoint'>): CloudSyncStatus {
    return { endpoint: this.#endpoint, ...status };
  }
}
