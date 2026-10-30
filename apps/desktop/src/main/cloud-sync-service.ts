import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { WebSocket, type RawData } from 'ws';
import BetterSqlite3 from 'better-sqlite3';
import {
  createClient,
  REALTIME_SUBSCRIBE_STATES,
  type RealtimeChannel,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';

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
  createDatabaseSnapshot,
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

import type { DatabaseRuntime } from './database-runtime';
import { reconcileOperationIds } from './operation-reconciliation';
import { readReplicaIdBaseline, type ReplicaIdBaseline } from './replica-id-baseline';

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
interface ElectronNet {
  fetch(input: FetchInput, init?: FetchInit): ReturnType<typeof globalThis.fetch>;
}

const require = createRequire(import.meta.url);

/**
 * Node 24's bundled undici has crashed Electron's main process while finishing
 * a cloud response on some Windows connections. Electron's net.fetch uses the
 * Chromium network stack, while retaining the standard fetch response API.
 */
function cloudFetch(input: FetchInput, init?: FetchInit): ReturnType<typeof globalThis.fetch> {
  if ('electron' in process.versions) {
    const electron = require('electron') as { readonly net?: ElectronNet };
    if (electron.net !== undefined) return electron.net.fetch(input, init);
  }
  return globalThis.fetch(input, init);
}

const fetch = cloudFetch;

const CONNECTION_TIMEOUT_MS = 20_000;
const OUTBOX_INTERVAL_MS = 3_000;
const PRINT_POLL_INTERVAL_MS = 1_000;
const PRINT_POLL_BACKOFF_MS = 5_000;
const MOBILE_NOTICE_TIMEOUT_MS = 8_000;
const CHANGE_WATCH_INTERVAL_MS = 400;
const CLOUD_PROBE_INTERVAL_MS = 5_000;
const CLOUD_PROBE_TIMEOUT_MS = 8_000;
const CLOUD_FRESH_MS = 20_000;
const CLOUD_DISCONNECT_GRACE_MS = 30_000;
const CLOUD_RETRY_MAX_MS = 10_000;
const ID_RECONCILIATION_INTERVAL_MS = 300_000;
const ID_RECONCILIATION_RETRY_MS = 60_000;
const PRINT_REGISTRATION_REFRESH_MS = 15_000;
const DESKTOP_PRESENCE_REFRESH_MS = 10_000;
const CANONICAL_FALLBACK_RECONCILIATION_INTERVAL_MS = 15_000;
const CANONICAL_REALTIME_RECONCILIATION_DELAY_MS = 750;
const CANONICAL_SUPABASE_URL = 'https://muhzjnveqrahccoisddo.supabase.co';
const CANONICAL_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ikPSVbY1junIsMbz5SrFrg_wkobALXv';
const STREAM_RECONNECT_MAX_MS = 60_000;
const CONTROL_HEARTBEAT_INTERVAL_MS = 300_000;

interface AuditRow {
  readonly id: number;
  readonly event_id: string | null;
  readonly profile: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly details_json: string;
  readonly created_at: number;
  readonly durable_operation_id?: string | null;
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
  readonly caughtUp: boolean;
  readonly cursor: number;
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
  readonly bootstrapSnapshotId: string | null;
  readonly snapshotSourceDeviceId: string | null;
  readonly createdAt: number;
}

interface PendingBootstrap {
  readonly command: GlobalEventCommand;
}

interface PendingGlobalReset {
  readonly requestId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly reason: string;
  readonly targetDeviceIds: readonly string[];
}

interface CloudPrintReceipt {
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
    readonly name?: string;
    readonly itemName?: string;
    readonly quantity: number;
    readonly unitPriceCents: number;
    readonly totalCents: number;
    readonly preparation?: readonly {
      readonly label: string;
      readonly productName: string;
      readonly quantity: number;
    }[];
    readonly componentAllocations?: readonly {
      readonly choiceGroup?: string | null;
      readonly choiceLabel?: string | null;
      readonly productName?: string;
      readonly quantity?: number;
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

interface PrintQueueRegistration {
  readonly printerName: string;
  readonly enabled: boolean;
  readonly unavailableReason: string | null;
}

const CATALOG_EVENT_ID = '_catalog';
const SYNCHRONIZED_ACTIONS = new Set([
  'sync.operations-retired',
  'event.created',
  'event.renamed',
  'event.open',
  'event.closed',
  'event.archived',
  'event.deleted-permanently',
  'inventory.category-created',
  'inventory.category-updated',
  'inventory.category-deleted',
  'inventory.product-created',
  'inventory.product-updated',
  'inventory.product-deleted',
  'combo.created',
  'combo.updated',
  'combo.deleted',
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
  'voucher.value-updated',
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

const CATALOG_ACTIONS = new Set([
  'event.created',
  'event.renamed',
  'event.open',
  'event.closed',
  'event.archived',
  'event.deleted-permanently',
  'inventory.category-created',
  'inventory.category-updated',
  'inventory.category-deleted',
  'inventory.product-created',
  'inventory.product-updated',
  'inventory.product-deleted',
  'combo.created',
  'combo.updated',
  'combo.deleted',
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
  readonly #deviceCredentialPath: string;
  readonly #onDataChanged: () => void;
  readonly #endpoint: string;
  readonly #getDeviceLabel: () => string;
  readonly #databaseRuntime: DatabaseRuntime | null;
  #printAgent: ((job: ClaimedCloudPrintJob) => Promise<PrintAgentResult>) | null = null;
  #getPrintQueueRegistration: (() => Promise<PrintQueueRegistration>) | null = null;
  #receiptArchiveAgent: ((orderId: string) => Promise<void>) | null = null;
  readonly #receiptArchivesInFlight = new Set<string>();
  #resetBackupAgent: (() => Promise<BackupRecord>) | null = null;
  #outboxTimer: NodeJS.Timeout | null = null;
  #printPollTimer: NodeJS.Timeout | null = null;
  #changeWatchTimer: NodeJS.Timeout | null = null;
  #cloudProbeTimer: NodeJS.Timeout | null = null;
  #cloudProbeInFlight = false;
  #lastCloudResponseAt = 0;
  #lastWatchedAuditId = 0;
  #printPollNotBefore = 0;
  readonly #eventStreams = new Map<string, WebSocket>();
  readonly #eventReconnectTimers = new Map<string, NodeJS.Timeout>();
  readonly #eventReconnectDelays = new Map<string, number>();
  readonly #canonicalRealtimeChannels = new Map<string, RealtimeChannel>();
  readonly #canonicalDesktopRealtimeChannels = new Map<string, RealtimeChannel>();
  readonly #canonicalRealtimeReadyEvents = new Set<string>();
  readonly #canonicalDesktopRealtimeReadyEvents = new Set<string>();
  readonly #canonicalReconciliations = new Map<string, Promise<void>>();
  readonly #canonicalReconciliationTimers = new Map<string, NodeJS.Timeout>();
  readonly #canonicalFastAppliedAt = new Map<string, number>();
  // A persisted fingerprint confirms what this database published in the past,
  // not what the current canonical transport still contains. Revalidate once
  // per process so a repaired/restarted trusted desktop can restore a missing
  // mobile projection without turning the regular sync loop into polling.
  readonly #canonicalProjectionPublished = new Set<string>();
  readonly #canonicalProtectedProjectionFingerprints = new Map<string, string>();
  #canonicalRealtimeClient: SupabaseClient | null = null;
  #ownerAuthClient: SupabaseClient | null = null;
  #ownerSession: Session | null = null;
  #canonicalLastFallbackReconciliationAt = 0;
  #controlStream: WebSocket | null = null;
  #controlReconnectTimer: NodeJS.Timeout | null = null;
  #controlHeartbeatTimer: NodeJS.Timeout | null = null;
  #controlReconnectDelayMs = 1_000;
  #cloudRetryDelayMs = 3_000;
  #cloudRetryNotBefore = 0;
  #cloudFailingSince: number | null = null;
  #printQueueInFlight: Promise<void> | null = null;
  #printQueueRerunRequested = false;
  #queuedReceiptArchiveCheckComplete = false;
  #printRegistrationFingerprint: string | null = null;
  #printRegistrationUpdatedAt = 0;
  #desktopPresenceUpdatedAt = 0;
  #desktopPresenceEventId: string | null = null;
  #replicationRunning = true;
  #flushInFlight = false;
  #immediateFlushRequest:
    | (() => { database: DatabaseContext; activeEventId: string | null })
    | null = null;
  #cloudConnected = false;
  #lastIdReconciliationAt = 0;
  #idReconciliationInFlight = false;
  #idBaseline: ReplicaIdBaseline | null = null;
  #syncIntegrityIssue: string | null = null;
  #lastLatencyMs = 0;
  #pendingBootstrap: PendingBootstrap | null = null;
  #replicaUploadInFlight = false;
  #lastEmptyReplicaCheckAt = 0;

  constructor(
    pairingKeyPath: string,
    deviceIdPath: string,
    onDataChanged: () => void = () => undefined,
    endpoint = 'https://muhzjnveqrahccoisddo.supabase.co/functions/v1/gtrz-sync-fallback',
    getDeviceLabel: () => string = hostname,
    databaseRuntime: DatabaseRuntime | null = null,
    deviceCredentialPath = path.join(
      path.dirname(deviceIdPath),
      'gtrz-cloud-device-credential.json',
    ),
  ) {
    this.#pairingKeyPath = pairingKeyPath;
    this.#deviceIdPath = deviceIdPath;
    this.#deviceCredentialPath = deviceCredentialPath;
    this.#onDataChanged = onDataChanged;
    this.#endpoint = endpoint;
    this.#getDeviceLabel = getDeviceLabel;
    this.#databaseRuntime = databaseRuntime;
  }

  #getOwnerAuthClient(): SupabaseClient {
    this.#ownerAuthClient ??= createClient(
      CANONICAL_SUPABASE_URL,
      CANONICAL_SUPABASE_PUBLISHABLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: cloudFetch },
      },
    );
    return this.#ownerAuthClient;
  }

  getOwnerSession(): { readonly email: string } | null {
    return this.#ownerSession?.user.email ? { email: this.#ownerSession.user.email } : null;
  }

  async registerOwnerAccount(email: string, password: string): Promise<void> {
    const { error } = await this.#getOwnerAuthClient().auth.signUp({ email, password });
    if (error) throw new Error(`Não foi possível criar a conta: ${error.message}`);
  }

  async signInOwner(email: string, password: string): Promise<{ readonly email: string }> {
    const { data, error } = await this.#getOwnerAuthClient().auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      throw new Error('Login não concluído. Confira a senha e a confirmação do e-mail.');
    }
    this.#ownerSession = data.session;
    try {
      const pairingKey = await this.#readPairingKey();
      if (pairingKey === null) throw new Error('Vincule este computador à nuvem antes de entrar.');
      const response = await fetch(`${this.#endpoint}/v1/owner/me`, {
        headers: await this.#ownerHeaders(pairingKey),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('Esta conta não está autorizada como proprietária.');
      return { email: data.user.email ?? email };
    } catch (error: unknown) {
      this.#ownerSession = null;
      throw error;
    }
  }

  signOutOwner(): void {
    this.#ownerSession = null;
  }

  async #ownerHeaders(
    pairingKey: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    let session = this.#ownerSession;
    if (session === null) throw new Error('Entre com a conta proprietária neste computador.');
    if (session.expires_at !== undefined && session.expires_at * 1000 < Date.now() + 30_000) {
      const { data, error } = await this.#getOwnerAuthClient().auth.refreshSession({
        refresh_token: session.refresh_token,
      });
      if (error || data.session === null) {
        this.#ownerSession = null;
        throw new Error('A sessão proprietária expirou. Entre novamente.');
      }
      session = data.session;
      this.#ownerSession = session;
    }
    return this.#cloudHeaders(pairingKey, {
      ...headers,
      Authorization: `Bearer ${session.access_token}`,
    });
  }

  async #administratorHeaders(
    headers: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null) throw new Error('Vincule este computador à nuvem primeiro.');
    if (this.#ownerSession !== null) return this.#ownerHeaders(pairingKey, headers);
    throw new Error('Entre com a conta proprietária para administrar a nuvem.');
  }

  start(getActiveEventId: () => string | null): void {
    // Replication owns the persistent WebSocket streams once the local database is ready.
    void getActiveEventId;
  }

  stop(): void {
    this.#replicationRunning = false;
    this.#immediateFlushRequest = null;
    if (this.#outboxTimer !== null) {
      clearInterval(this.#outboxTimer);
      this.#outboxTimer = null;
    }
    if (this.#printPollTimer !== null) {
      clearInterval(this.#printPollTimer);
      this.#printPollTimer = null;
    }
    if (this.#changeWatchTimer !== null) {
      clearInterval(this.#changeWatchTimer);
      this.#changeWatchTimer = null;
    }
    if (this.#cloudProbeTimer !== null) {
      clearInterval(this.#cloudProbeTimer);
      this.#cloudProbeTimer = null;
    }
    if (this.#controlReconnectTimer !== null) clearTimeout(this.#controlReconnectTimer);
    this.#controlReconnectTimer = null;
    if (this.#controlHeartbeatTimer !== null) clearInterval(this.#controlHeartbeatTimer);
    this.#controlHeartbeatTimer = null;
    this.#controlStream?.close();
    this.#controlStream = null;
    for (const timer of this.#eventReconnectTimers.values()) clearTimeout(timer);
    this.#eventReconnectTimers.clear();
    for (const stream of this.#eventStreams.values()) stream.close();
    this.#eventStreams.clear();
    this.#stopCanonicalRealtime();
    this.#cloudConnected = false;
  }

  startReplication(
    getDatabase: () => DatabaseContext,
    getActiveEventId: () => string | null,
  ): void {
    this.#replicationRunning = true;
    const flush = (): void => {
      void this.flushOutbox(getDatabase(), getActiveEventId()).catch(() => undefined);
    };
    flush();
    this.#outboxTimer = setInterval(flush, OUTBOX_INTERVAL_MS);
    // A note must not wait for a synchronisation cycle: claiming one is a small request, so the
    // print queue has its own, faster clock.
    this.#printPollTimer = setInterval(() => {
      void this.#pollPrintQueue(getDatabase, getActiveEventId).catch(() => undefined);
    }, PRINT_POLL_INTERVAL_MS);
    // Any local change (a sale, a stock count, a purchase) is sent at once instead of waiting for
    // the next cycle, so the phones see it within moments.
    try {
      this.#lastWatchedAuditId = this.#latestAuditId(getDatabase());
    } catch {
      this.#lastWatchedAuditId = 0;
    }
    this.#changeWatchTimer = setInterval(() => {
      try {
        const latest = this.#latestAuditId(getDatabase());
        if (latest <= this.#lastWatchedAuditId) return;
        this.#lastWatchedAuditId = latest;
        this.requestImmediateFlush(getDatabase, getActiveEventId);
      } catch {
        // The database may still be opening; the next tick tries again.
      }
    }, CHANGE_WATCH_INTERVAL_MS);
    void this.#probeCloud();
    this.#cloudProbeTimer = setInterval(() => {
      void this.#probeCloud();
    }, CLOUD_PROBE_INTERVAL_MS);
  }

  async #pollPrintQueue(
    getDatabase: () => DatabaseContext,
    getActiveEventId: () => string | null,
  ): Promise<void> {
    if (
      !this.#replicationRunning ||
      this.#printQueueInFlight !== null ||
      Date.now() < this.#printPollNotBefore ||
      !this.#endpoint.includes('.supabase.co/functions/')
    ) {
      return;
    }
    const activeEventId = getActiveEventId();
    if (activeEventId === null) return;
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null) return;
    const deviceId = await this.#readOrCreateDeviceId();
    this.#schedulePrintQueue(getDatabase(), activeEventId, deviceId, pairingKey);
  }

  requestImmediateFlush(
    getDatabase: () => DatabaseContext,
    getActiveEventId: () => string | null,
  ): void {
    // A sale can finish while a periodic flush is awaiting the network. Keep
    // the request so it runs immediately afterward instead of waiting for the
    // next three-second interval. Resolve the database again after bootstrap.
    this.#immediateFlushRequest = () => ({
      database: getDatabase(),
      activeEventId: getActiveEventId(),
    });
    this.#runImmediateFlush();
  }

  #runImmediateFlush(): void {
    if (this.#flushInFlight || !this.#replicationRunning) return;
    const request = this.#immediateFlushRequest;
    if (request === null) return;
    this.#immediateFlushRequest = null;
    const { database, activeEventId } = request();
    void this.flushOutbox(database, activeEventId).catch(() => undefined);
  }

  setPrintAgent(
    agent: (job: ClaimedCloudPrintJob) => Promise<PrintAgentResult>,
    getRegistration: (() => Promise<PrintQueueRegistration>) | null = null,
  ): void {
    this.#printAgent = agent;
    this.#getPrintQueueRegistration = getRegistration;
  }

  setReceiptArchiveAgent(agent: (orderId: string) => Promise<void>): void {
    this.#receiptArchiveAgent = agent;
  }

  setResetBackupAgent(agent: () => Promise<BackupRecord>): void {
    this.#resetBackupAgent = agent;
  }

  async verifyOrEnrollDesktop(enrollmentCode?: string): Promise<'connected' | 'code-required'> {
    let credential = await this.#readPairingKey();
    if (credential === null) {
      if (enrollmentCode === undefined || enrollmentCode.trim().length === 0) {
        return 'code-required';
      }
      await this.exchangeDesktopEnrollment(enrollmentCode.trim());
      credential = await this.#readPairingKey();
      if (credential === null) {
        throw new Error('O vínculo foi aceito, mas a credencial não foi salva neste computador.');
      }
    }

    const deviceId = await this.#readOrCreateDeviceId();
    const response = await fetch(`${this.#endpoint}/v1/monitor/heartbeat`, {
      method: 'POST',
      headers: await this.#cloudHeaders(credential, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        deviceId,
        label: this.#getDeviceLabel(),
        activeEventId: null,
        latencyMs: 0,
      }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error('A central recusou a credencial deste computador.');
    }
    const control = await fetch(`${this.#endpoint}/v1/monitor/global-control?after=0`, {
      headers: await this.#cloudHeaders(credential),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    if (!control.ok) {
      throw new Error('A central não liberou o estado compartilhado dos eventos.');
    }
    const controlPayload: unknown = await control.json();
    if (
      !isRecord(controlPayload) ||
      !Array.isArray(controlPayload.commands) ||
      typeof controlPayload.cursor !== 'number'
    ) {
      throw new Error('A central retornou um estado compartilhado inválido.');
    }
    return 'connected';
  }

  async createDesktopEnrollment(): Promise<{
    readonly enrollmentCode: string;
    readonly expiresAt: number;
  }> {
    const response = await fetch(`${this.#endpoint}/v1/desktop/enrollment`, {
      method: 'POST',
      headers: await this.#administratorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    const payload: unknown = await response.json();
    if (
      !response.ok ||
      !isRecord(payload) ||
      typeof payload.enrollmentCode !== 'string' ||
      typeof payload.expiresAt !== 'number'
    ) {
      throw new Error('A nuvem não conseguiu criar o código de vínculo.');
    }
    return { enrollmentCode: payload.enrollmentCode, expiresAt: payload.expiresAt };
  }

  async exchangeDesktopEnrollment(enrollmentCode: string): Promise<void> {
    const deviceId = await this.#readOrCreateDeviceId();
    const response = await fetch(`${this.#endpoint}/v1/desktop/enrollment/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentCode, deviceId, label: this.#getDeviceLabel() }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload) || typeof payload.token !== 'string') {
      throw new Error('O código de vínculo é inválido, expirou ou já foi utilizado.');
    }
    await writeFile(
      this.#deviceCredentialPath,
      JSON.stringify({ deviceId, token: payload.token }),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  async listDesktopDevices(): Promise<
    readonly {
      readonly deviceId: string;
      readonly label: string;
      readonly createdAt: number;
      readonly lastSeenAt: number;
      readonly revokedAt: number | null;
    }[]
  > {
    const credential = await this.#readPairingKey();
    if (credential === null) throw new Error('Vincule este computador à nuvem primeiro.');
    const response = await fetch(`${this.#endpoint}/v1/desktop/devices`, {
      headers: await this.#cloudHeaders(credential),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload) || !Array.isArray(payload.devices)) {
      throw new Error('A nuvem não conseguiu listar os computadores vinculados.');
    }
    return payload.devices.flatMap((device) => {
      if (
        !isRecord(device) ||
        typeof device.deviceId !== 'string' ||
        typeof device.label !== 'string' ||
        typeof device.createdAt !== 'number' ||
        typeof device.lastSeenAt !== 'number' ||
        (device.revokedAt !== null && typeof device.revokedAt !== 'number')
      ) {
        return [];
      }
      return [
        {
          deviceId: device.deviceId,
          label: device.label,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
          revokedAt: device.revokedAt,
        },
      ];
    });
  }

  async revokeDesktopDevice(deviceId: string): Promise<void> {
    const response = await fetch(`${this.#endpoint}/v1/desktop/devices/revoke`, {
      method: 'POST',
      headers: await this.#administratorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ deviceId }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('A nuvem não conseguiu bloquear este computador.');
  }

  async getPrintStation(eventId: string): Promise<unknown> {
    const credential = await this.#readPairingKey();
    if (credential === null) throw new Error('Vincule este computador à nuvem primeiro.');
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/print/station`,
      {
        headers: await this.#cloudHeaders(credential),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok)
      throw new Error(
        `Não foi possível consultar a estação de impressão (${String(response.status)}).`,
      );
    return response.json();
  }

  async setPrintStation(eventId: string, deviceId: string | null): Promise<unknown> {
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/print/station`,
      {
        method: 'POST',
        headers: await this.#administratorHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ deviceId }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok)
      throw new Error(`Não foi possível escolher o PC de impressão (${String(response.status)}).`);
    return response.json();
  }

  /**
   * Comparing every ID with the cloud is slow and secondary: it runs beside the outbox, never inside
   * it, and a failure here is only a diagnostic. It must not mark the cloud as disconnected or hold
   * back a sale that is waiting to be sent.
   */
  #startIdReconciliation(
    database: DatabaseContext,
    deviceId: string,
    pairingKey: string,
    activeEventId: string | null,
  ): void {
    if (
      this.#idReconciliationInFlight ||
      Date.now() - this.#lastIdReconciliationAt < ID_RECONCILIATION_INTERVAL_MS
    ) {
      return;
    }
    this.#idReconciliationInFlight = true;
    void this.#reconcileIds(database, deviceId, pairingKey, activeEventId)
      .then(() => {
        this.#lastIdReconciliationAt = Date.now();
        database.sqlite
          .prepare("DELETE FROM sync_state WHERE key = 'cloud.id-reconciliation.last-error'")
          .run();
      })
      .catch((error: unknown) => {
        this.#lastIdReconciliationAt =
          Date.now() - ID_RECONCILIATION_INTERVAL_MS + ID_RECONCILIATION_RETRY_MS;
        database.sqlite
          .prepare(
            `INSERT INTO sync_state (key, value, updated_at) VALUES ('cloud.id-reconciliation.last-error', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(
            (error instanceof Error ? error.message : 'Falha na conferência de IDs.').slice(0, 500),
            Date.now(),
          );
      })
      .finally(() => {
        this.#idReconciliationInFlight = false;
      });
  }

  async #reconcileIds(
    database: DatabaseContext,
    deviceId: string,
    pairingKey: string,
    activeEventId: string | null,
  ): Promise<void> {
    const eventIds = new Set([
      CATALOG_EVENT_ID,
      ...database.sqlite
        .prepare('SELECT DISTINCT event_id FROM sync_outbox')
        .all()
        .map((row) => (row as { event_id: string }).event_id),
    ]);
    if (activeEventId !== null) eventIds.add(activeEventId);
    if (activeEventId !== null)
      this.#idBaseline = await readReplicaIdBaseline(
        this.#endpoint,
        activeEventId,
        await this.#cloudHeaders(pairingKey),
        fetch,
        this.#idBaseline,
      );
    for (const eventId of eventIds) {
      await reconcileOperationIds(
        database,
        eventId,
        async (after) => {
          const response = await fetch(
            `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/snapshot?after=${String(after)}`,
            {
              headers: await this.#cloudHeaders(pairingKey),
              signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
            },
          );
          if (!response.ok)
            throw new Error(`Inventário de IDs indisponível (${String(response.status)}).`);
          const page: unknown = await response.json();
          if (
            !isRecord(page) ||
            !Array.isArray(page.events) ||
            !page.events.every(isRemoteJournalEvent)
          )
            throw new Error('Inventário remoto inválido.');
          return { events: page.events };
        },
        (events) => {
          this.#storeRemoteJournalEvents(database, eventId, events);
        },
        this.#idBaseline?.idsByEvent.get(eventId),
      );
    }
    this.#applyInbox(database, deviceId);
  }
  #hasWaitingOutbox(database: DatabaseContext): boolean {
    return (
      database.sqlite
        .prepare("SELECT 1 FROM sync_outbox WHERE status IN ('pending', 'failed') LIMIT 1")
        .get() !== undefined
    );
  }

  /**
   * Sends the oldest waiting operations to the central, one after another. It is also the first
   * thing a synchronisation cycle does, so a sale or a stock change leaves this computer before any
   * housekeeping. Returns false when the central refused one, leaving it queued for the next round.
   */
  async #pushOutbox(
    database: DatabaseContext,
    deviceId: string,
    pairingKey: string,
    canonicalCloud: boolean,
  ): Promise<boolean> {
    const pending = database.sqlite
      .prepare(
        `SELECT audit_id, operation_id, event_id, payload_json
       FROM sync_outbox WHERE status IN ('pending', 'failed')
       ORDER BY audit_id ASC LIMIT 30`,
      )
      .all() as OutboxRow[];

    for (const item of pending) {
      try {
        // The canonical Edge endpoint stores an envelope around the local
        // audit payload. The older Worker still accepts the raw payload.
        // Sending the raw form to Supabase made it reject `type`, leaving
        // the first failed row at the head of the outbox forever.
        let outgoingPayload: unknown = JSON.parse(item.payload_json);
        if (isRecord(outgoingPayload) && outgoingPayload.deviceId === 'unassigned') {
          outgoingPayload = { ...outgoingPayload, deviceId };
          database.sqlite
            .prepare('UPDATE sync_outbox SET payload_json = ?, updated_at = ? WHERE audit_id = ?')
            .run(JSON.stringify(outgoingPayload), Date.now(), item.audit_id);
        }
        if (
          isRecord(outgoingPayload) &&
          outgoingPayload.action === 'inventory.stock-moved' &&
          isRecord(outgoingPayload.details) &&
          integerField(outgoingPayload.details, 'quantity') === null
        ) {
          const delta = integerField(outgoingPayload.details, 'delta');
          if (delta !== null && delta !== 0) {
            outgoingPayload = {
              ...outgoingPayload,
              details: { ...outgoingPayload.details, quantity: Math.abs(delta) },
            };
            database.sqlite
              .prepare('UPDATE sync_outbox SET payload_json = ?, updated_at = ? WHERE audit_id = ?')
              .run(JSON.stringify(outgoingPayload), Date.now(), item.audit_id);
          }
        }
        const canonicalCreatedAt = isRecord(outgoingPayload)
          ? integerField(outgoingPayload, 'createdAt')
          : null;
        if (canonicalCloud && canonicalCreatedAt === null) {
          throw new Error('A operação local não possui a data exigida pela central.');
        }
        const requestBody = canonicalCloud
          ? JSON.stringify({
              commandId: item.operation_id,
              type: 'journal.committed',
              payload: outgoingPayload,
              createdAt: canonicalCreatedAt,
            })
          : JSON.stringify(outgoingPayload);
        const response = await fetch(
          `${this.#endpoint}/v1/events/${encodeURIComponent(item.event_id)}/journal`,
          {
            method: 'POST',
            headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
            body: requestBody,
            signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
          },
        );

        if (!response.ok) {
          throw new Error(`A central respondeu ${String(response.status)}.`);
        }

        // A local action already exists in SQLite, but its canonical journal
        // sequence does not. Persist the server acknowledgement so the next
        // mobile event is expected as N + 1 instead of being rejected as a
        // gap and deferred to the slow snapshot recovery path.
        if (canonicalCloud) {
          const acknowledgement: unknown = await response.json();
          const journalEvent =
            isRecord(acknowledgement) && isRemoteJournalEvent(acknowledgement.event)
              ? acknowledgement.event
              : null;
          if (journalEvent?.commandId !== item.operation_id) {
            throw new Error('A central confirmou a operação sem a sequência do diário.');
          }
          this.#storeRemoteJournalEvents(database, item.event_id, [journalEvent]);
          this.#applyInbox(database, deviceId);
        }

        this.#recordCloudSuccess();

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
        this.#recordCloudFailure();
        return false;
      }
    }
    return true;
  }
  async flushOutbox(database: DatabaseContext, activeEventId: string | null): Promise<void> {
    if (this.#flushInFlight) return;
    this.#flushInFlight = true;
    try {
      this.#initializeOutboxAuditFloor(database);
      const deviceId = await this.#readOrCreateDeviceId();
      this.#enqueueNewAudits(database, deviceId);
      if (Date.now() < this.#cloudRetryNotBefore) return;
      const pairingKey = await this.#readPairingKey();

      if (pairingKey === null) return;

      // Fast lane: a sale or a stock change leaves this computer, and the phones' stock is
      // refreshed, before any of the housekeeping below can delay them.
      if (
        this.#endpoint.includes('.supabase.co/functions/') &&
        this.#pendingBootstrap === null &&
        this.#hasWaitingOutbox(database)
      ) {
        if (!(await this.#pushOutbox(database, deviceId, pairingKey, true))) return;
        const liveEventId = getSessionState(database).activeEvent?.id ?? activeEventId;
        await this.#publishCashierCatalog(database, liveEventId, pairingKey);
        await this.#publishMobileContext(database, liveEventId, pairingKey);
      }

      if (
        Date.now() - this.#desktopPresenceUpdatedAt >= DESKTOP_PRESENCE_REFRESH_MS ||
        this.#desktopPresenceEventId !== activeEventId
      ) {
        await this.#announceDesktopPresence(pairingKey, deviceId, activeEventId);
        this.#desktopPresenceUpdatedAt = Date.now();
        this.#desktopPresenceEventId = activeEventId;
      }

      // Production uses the compact Postgres journal. The stream branch remains
      // only for the previous transport tests and an explicitly supplied Worker URL.
      const canonicalCloud = this.#endpoint.includes('.supabase.co/functions/');
      // Printing is a separate delivery concern. It must keep polling even if a
      // catalogue projection or another synchronisation step is temporarily rejected.
      if (canonicalCloud) {
        this.#schedulePrintQueue(database, activeEventId, deviceId, pairingKey);
      }
      if (canonicalCloud) {
        const controlIsDue =
          this.#canonicalLastFallbackReconciliationAt === 0 ||
          Date.now() - this.#canonicalLastFallbackReconciliationAt >=
            CANONICAL_FALLBACK_RECONCILIATION_INTERVAL_MS;
        if (controlIsDue) {
          const recovered = await this.#pullGlobalControl(database, pairingKey, deviceId);
          if (!recovered) {
            this.#recordCloudFailure();
            return;
          }
        }
      } else {
        if (this.#controlStream === null) {
          const recovered = await this.#pullGlobalControl(database, pairingKey, deviceId);
          if (!recovered) {
            this.#recordCloudFailure();
            return;
          }
        }
        this.#ensureControlStream(database, deviceId, pairingKey);
      }
      if (canonicalCloud && this.#pendingBootstrap === null) {
        await this.#recoverPartialReplica(database, pairingKey, deviceId);
      }
      const workingDatabase = await this.#applyPendingBootstrap(database, pairingKey, deviceId);
      this.#enqueueNewAudits(workingDatabase, deviceId);

      const effectiveActiveEventId =
        getSessionState(workingDatabase).activeEvent?.id ?? activeEventId;

      if (!canonicalCloud) {
        this.#ensureEventStreams(workingDatabase, effectiveActiveEventId, deviceId, pairingKey);
      } else {
        await this.#ensureCanonicalRealtime(
          workingDatabase,
          effectiveActiveEventId,
          deviceId,
          pairingKey,
        );
      }

      this.#retryRecoverablePaidOrders(workingDatabase);
      this.#backfillRemoteSaleAudits(workingDatabase);
      const fallbackIsDue =
        !canonicalCloud ||
        !this.#canonicalRealtimeReadyEvents.has(CATALOG_EVENT_ID) ||
        !this.#canonicalDesktopRealtimeReadyEvents.has(CATALOG_EVENT_ID) ||
        (effectiveActiveEventId !== null &&
          (!this.#canonicalRealtimeReadyEvents.has(effectiveActiveEventId) ||
            !this.#canonicalDesktopRealtimeReadyEvents.has(effectiveActiveEventId))) ||
        Date.now() - this.#canonicalLastFallbackReconciliationAt >=
          CANONICAL_FALLBACK_RECONCILIATION_INTERVAL_MS;
      if (fallbackIsDue) {
        await this.#reconcileEventJournal(workingDatabase, CATALOG_EVENT_ID, deviceId, pairingKey);
        if (effectiveActiveEventId !== null) {
          await this.#reconcileEventJournal(
            workingDatabase,
            effectiveActiveEventId,
            deviceId,
            pairingKey,
          );
        }
        if (canonicalCloud) this.#canonicalLastFallbackReconciliationAt = Date.now();
      }
      this.#applyInbox(workingDatabase, deviceId);
      if (canonicalCloud) {
        this.#startIdReconciliation(workingDatabase, deviceId, pairingKey, effectiveActiveEventId);
      }

      if (!canonicalCloud) {
        await this.#publishCashierCatalog(
          workingDatabase,
          effectiveActiveEventId,
          pairingKey,
          this.#pendingStockDeltas(workingDatabase, effectiveActiveEventId),
        );
      }

      if (!(await this.#pushOutbox(workingDatabase, deviceId, pairingKey, canonicalCloud))) return;

      // Journalled business commands are authoritative. Publish the derived
      // mobile projections only after those commands have reached the central.
      await this.#publishCashierCatalog(workingDatabase, effectiveActiveEventId, pairingKey);
      await this.#publishMobileContext(workingDatabase, effectiveActiveEventId, pairingKey);
      if (canonicalCloud) {
        this.#schedulePrintQueue(workingDatabase, effectiveActiveEventId, deviceId, pairingKey);
      }
      const unresolved = (
        workingDatabase.sqlite
          .prepare('SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolved_at IS NULL')
          .get() as { count: number }
      ).count;
      this.#syncIntegrityIssue =
        unresolved > 0
          ? `Conexão ativa, mas há ${String(unresolved)} conflitos: a reconciliação não está concluída.`
          : null;
      this.#clearSyncDiagnostic(workingDatabase);
      if (canonicalCloud && effectiveActiveEventId !== null) {
        this.#scheduleReplicaSnapshot(
          workingDatabase,
          effectiveActiveEventId,
          pairingKey,
          deviceId,
        );
      }
    } catch (error: unknown) {
      // Keep every business operation in SQLite and progressively slow retries when
      // the remote side is unavailable or has reached a free-tier limit.
      this.#writeSyncDiagnostic(
        database,
        error instanceof Error ? error.message : 'Falha desconhecida na sincronização.',
      );
      this.#recordCloudFailure();
    } finally {
      this.#flushInFlight = false;
      this.#runImmediateFlush();
    }
  }

  async setGlobalEvent(database: DatabaseContext, eventId: string): Promise<void> {
    const event = database.sqlite
      .prepare("SELECT id, name FROM events WHERE id = ? AND status = 'open'")
      .get(eventId) as { readonly id: string; readonly name: string } | undefined;
    if (event === undefined)
      throw new Error('O evento selecionado não está disponível neste computador.');
    const deviceId = await this.#readOrCreateDeviceId();
    const pairingKey = await this.#readPairingKey();
    if (pairingKey === null)
      throw new Error('A chave da nuvem não foi encontrada neste computador.');

    // The global activation is only announced after its verified SQLite baseline
    // is already private in the canonical cloud. A fresh desktop therefore never
    // depends on another computer being online to reconstruct the event.
    await this.#announceDesktopPresence(pairingKey, deviceId, event.id);
    await this.#publishReplicaSnapshot(database, event.id, pairingKey, deviceId);
    await this.#globalControlRequest('/v1/monitor/global-event', {
      eventId: event.id,
      eventName: event.name,
    });
    setActiveEvent(database, event.id);
    this.#onDataChanged();
  }

  async #announceDesktopPresence(
    pairingKey: string,
    deviceId: string,
    activeEventId: string | null,
  ): Promise<void> {
    const response = await fetch(`${this.#endpoint}/v1/monitor/heartbeat`, {
      method: 'POST',
      headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        deviceId,
        label: this.#getDeviceLabel(),
        activeEventId,
        latencyMs: this.#lastLatencyMs,
      }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('A nuvem recusou o sinal deste computador.');
  }

  async #publishReplicaSnapshot(
    database: DatabaseContext,
    eventId: string,
    pairingKey: string,
    deviceId: string,
  ): Promise<void> {
    if (this.#databaseRuntime === null) {
      throw new Error('A cópia inicial exige um banco local pronto.');
    }

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-replica-upload-'));
    const snapshotPath = path.join(temporaryDirectory, 'database.sqlite');
    try {
      await createDatabaseSnapshot(database, snapshotPath);
      const snapshot = new BetterSqlite3(snapshotPath, { readonly: true, fileMustExist: true });
      let catalogCursor: number;
      let eventCursor: number;
      let controlCursor: number;
      try {
        if (
          snapshot
            .prepare("SELECT 1 FROM sync_outbox WHERE status IN ('pending', 'failed') LIMIT 1")
            .get() ||
          snapshot.prepare('SELECT 1 FROM sync_inbox WHERE applied_at IS NULL LIMIT 1').get()
        ) {
          throw new Error('A cópia inicial contém operações locais ainda não sincronizadas.');
        }
        const cursor = (key: string): number => {
          const row = snapshot.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
            | { readonly value: string }
            | undefined;
          return Number.parseInt(row?.value ?? '0', 10) || 0;
        };
        catalogCursor = cursor(`inbox.sequence:${CATALOG_EVENT_ID}`);
        eventCursor = cursor(`inbox.sequence:${eventId}`);
        controlCursor = cursor('global.event-control.cursor');
      } finally {
        snapshot.close();
      }
      const contents = await readFile(snapshotPath);
      if (contents.byteLength === 0 || contents.byteLength > 50 * 1024 * 1024) {
        throw new Error('A cópia inicial do evento precisa ter entre 1 byte e 50 MB.');
      }
      const checksum = createHash('sha256').update(contents).digest('hex');
      const response = await fetch(
        `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/replica-snapshot`,
        {
          method: 'POST',
          headers: await this.#cloudHeaders(pairingKey, {
            'Content-Type': 'application/vnd.sqlite3',
            'X-GTRZ-Device-Id': deviceId,
            'X-GTRZ-Snapshot-Sha256': checksum,
            'X-GTRZ-Snapshot-Size': String(contents.byteLength),
            'X-GTRZ-Catalog-Cursor': String(catalogCursor),
            'X-GTRZ-Event-Cursor': String(eventCursor),
            'X-GTRZ-Control-Cursor': String(controlCursor),
          }),
          body: new Uint8Array(contents),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (
        !response.ok ||
        !isRecord(payload) ||
        typeof payload.snapshotId !== 'string' ||
        payload.eventId !== eventId
      ) {
        throw new Error('A nuvem não confirmou a cópia inicial do evento.');
      }
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }

  #scheduleReplicaSnapshot(
    database: DatabaseContext,
    eventId: string,
    pairingKey: string,
    deviceId: string,
  ): void {
    if (this.#databaseRuntime === null || this.#replicaUploadInFlight) return;
    if (
      database.sqlite
        .prepare("SELECT 1 FROM sync_outbox WHERE status IN ('pending', 'failed') LIMIT 1")
        .get()
    )
      return;
    if (database.sqlite.prepare('SELECT 1 FROM sync_inbox WHERE applied_at IS NULL LIMIT 1').get())
      return;
    if (
      !database.sqlite
        .prepare('SELECT 1 FROM sync_state WHERE key = ?')
        .get(`replica.reconciled:${eventId}`)
    )
      return;
    if (
      !database.sqlite
        .prepare('SELECT 1 FROM sync_state WHERE key = ?')
        .get(`replica.reconciled:${CATALOG_EVENT_ID}`)
    )
      return;
    const stateKey = `replica.last-upload:${eventId}`;
    const last = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(stateKey) as { readonly value: string } | undefined;
    const readCursor = (key: string): number => {
      const row = database.sqlite.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | { readonly value: string }
        | undefined;
      return Number(row?.value ?? 0);
    };
    const cursors = {
      catalog: readCursor(`inbox.sequence:${CATALOG_EVENT_ID}`),
      event: readCursor(`inbox.sequence:${eventId}`),
      control: readCursor('global.event-control.cursor'),
    };
    let lastUpload: unknown = null;
    try {
      lastUpload = JSON.parse(last?.value ?? 'null') as unknown;
    } catch {
      /* old state */
    }
    if (
      isRecord(lastUpload) &&
      lastUpload.catalog === cursors.catalog &&
      lastUpload.event === cursors.event &&
      lastUpload.control === cursors.control
    )
      return;
    const lastAt = isRecord(lastUpload) ? Number(lastUpload.at ?? 0) : Number(last?.value ?? 0);
    if (Date.now() - lastAt < 24 * 60 * 60 * 1000) return;
    this.#replicaUploadInFlight = true;
    void this.#publishReplicaSnapshot(database, eventId, pairingKey, deviceId)
      .then(() => {
        database.sqlite
          .prepare(
            `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(stateKey, JSON.stringify({ at: Date.now(), ...cursors }), Date.now());
      })
      .catch((error: unknown) => {
        this.#writeSyncDiagnostic(
          database,
          error instanceof Error ? error.message : 'Falha ao publicar a cópia inicial.',
        );
      })
      .finally(() => {
        this.#replicaUploadInFlight = false;
      });
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

    // The indicator says whether the central is reachable, nothing else. Pending reconciliation
    // items are reported in the message, but they never turn a working connection into "down".
    const reachable = this.#isCloudReachable();
    return this.#status({
      checkedAt,
      connection: reachable ? 'connected' : 'attention',
      apiReachable: reachable,
      credentialPresent: true,
      credentialAccepted: reachable,
      message: reachable
        ? (this.#syncIntegrityIssue ?? 'Nuvem conectada; consulte filas e reconciliação por IDs.')
        : 'Sem conexão com a nuvem. O caixa local continua operando e mantém a fila de envio.',
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
      headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
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
      headers: await this.#cloudHeaders(pairingKey),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });

    if (!snapshot.ok) {
      throw new Error('Não foi possível obter o painel da nuvem.');
    }

    const payload: unknown = await snapshot.json();
    const defaults = {
      endpoint: this.#endpoint,
      checkedAt: Date.now(),
      localDeviceId: deviceId,
      localQueue: {
        outboxPending: 0,
        outboxAccepted: 0,
        outboxFailed: 0,
        inboxReceived: 0,
        inboxAwaitingApply: 0,
        conflictsOpen: 0,
        printQueueError: null,
      },
      recentCommands: [],
      recentTransport: [],
      recentConflicts: [],
      idempotency: { acceptedCommands: 0, journalAttempts: 0, replayedAttempts: 0 },
      localConflicts: [],
    };

    if (!this.#endpoint.includes('.supabase.co/functions/')) {
      const monitor = cloudMonitorSchema.parse({
        ...defaults,
        ...(isRecord(payload) ? payload : {}),
        localDeviceId: deviceId,
      });
      this.#recordCloudSuccess();
      return monitor;
    }

    const remote = isRecord(payload) ? payload : {};
    const activeDevices = Array.isArray(remote.activeDevices)
      ? remote.activeDevices.flatMap((device) => {
          if (!isRecord(device)) return [];
          const lastSeenAt = integerField(device, 'lastSeenAt');
          if (lastSeenAt === null || lastSeenAt < Date.now() - 30_000) return [];
          const id = stringField(device, 'id') ?? stringField(device, 'deviceId');
          const label = stringField(device, 'label');
          if (id === null || label === null) return [];
          const possibleEventId = stringField(device, 'activeEventId');
          const activeEventId =
            possibleEventId !== null &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              possibleEventId,
            )
              ? possibleEventId
              : null;
          return [
            {
              id: id.slice(0, 80),
              label: label.slice(0, 80),
              activeEventId,
              lastSeenAt,
              latencyMs:
                integerField(device, 'latencyMs') ?? (id === deviceId ? this.#lastLatencyMs : 0),
            },
          ];
        })
      : [];
    const monitor = cloudMonitorSchema.parse({ ...defaults, activeDevices });
    this.#recordCloudSuccess();
    return monitor;
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
    // A deactivated operator or a new password ends the sessions, and a revoked session no longer
    // receives notices. Warn the phones first so they re-read their session while it still exists.
    const endsSessions = changes.active === false || changes.password !== undefined;
    if (endsSessions) await this.#announceMobileChange();
    const updated = await this.#mobileOperatorRequest(
      `/v1/mobile/operators/${encodeURIComponent(operatorId)}`,
      'PATCH',
      changes,
      mobileOperatorSchema,
    );
    await this.#announceMobileChange();
    return updated;
  }

  async endMobileOperatorSessions(
    input: EndMobileOperatorSessionsInput,
  ): Promise<{ readonly success: true }> {
    await this.#announceMobileChange();
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
    await this.#announceMobileChange();
    await this.#mobileOperatorRequest(
      `/v1/mobile/operators/${encodeURIComponent(input.operatorId)}`,
      'DELETE',
      undefined,
      undefined,
    );
    return { success: true };
  }

  /**
   * The central stores operators and sessions but only announces a change to the phones when asked.
   * Without this notice a phone would keep an old permission until its next periodic refresh. The
   * change itself already succeeded, so a failed notice is not an error.
   */
  async #announceMobileChange(): Promise<void> {
    try {
      await fetch(`${this.#endpoint}/v1/monitor/realtime-ping`, {
        method: 'POST',
        headers: await this.#administratorHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ eventId: CATALOG_EVENT_ID }),
        signal: AbortSignal.timeout(MOBILE_NOTICE_TIMEOUT_MS),
      });
    } catch {
      // Phones still catch up on their own refresh.
    }
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
      printQueueError:
        (
          database.sqlite
            .prepare("SELECT value FROM sync_state WHERE key = 'cloud.print-queue.last-error'")
            .get() as { readonly value: string } | undefined
        )?.value ?? null,
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
    const response = await fetch(`${this.#endpoint}${path}`, {
      method,
      headers: await this.#administratorHeaders({ 'Content-Type': 'application/json' }),
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
    const response = await fetch(`${this.#endpoint}${path}`, {
      method: 'POST',
      headers: await this.#administratorHeaders({ 'Content-Type': 'application/json' }),
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

  async #applyPendingBootstrap(
    database: DatabaseContext,
    pairingKey: string,
    deviceId: string,
  ): Promise<DatabaseContext> {
    const pending = this.#pendingBootstrap;
    if (pending === null || this.#databaseRuntime === null) return database;
    this.#pendingBootstrap = null;

    const { command } = pending;
    if (this.#hasAppliedBootstrap(database, command.commandId)) return database;
    const repair = command.commandId.startsWith('replica-repair:');
    const eligible = repair
      ? this.#isPartialReplicaReplaceable(database, command.eventId)
      : this.#isBootstrapEligible(database, command.eventId);
    if (!eligible) {
      if (!repair) this.#markBootstrapApplied(database, command);
      return database;
    }
    if (command.bootstrapSnapshotId === null) return database;

    const response = await fetch(
      `${this.#endpoint}/v1/monitor/replica-snapshot/${encodeURIComponent(command.bootstrapSnapshotId)}`,
      {
        headers: await this.#cloudHeaders(pairingKey),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS * 6),
      },
    );
    if (!response.ok) {
      throw new Error('A cópia inicial do evento não pôde ser baixada deste PC.');
    }
    if (response.headers.get('X-GTRZ-Snapshot-Event') !== command.eventId) {
      throw new Error('A cópia inicial recebida pertence a outro evento.');
    }
    const expectedChecksum = response.headers.get('X-GTRZ-Snapshot-Sha256');
    if (expectedChecksum === null || !/^[a-f0-9]{64}$/iu.test(expectedChecksum)) {
      throw new Error('A cópia inicial não possui verificação de integridade.');
    }
    const expectedSize = Number(response.headers.get('X-GTRZ-Snapshot-Size'));
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new Error('A cópia inicial não informa um tamanho válido.');
    }
    const contents = Buffer.from(await response.arrayBuffer());
    if (contents.byteLength !== expectedSize) {
      throw new Error('A cópia inicial foi recebida incompleta.');
    }
    if (createHash('sha256').update(contents).digest('hex') !== expectedChecksum) {
      throw new Error('A cópia inicial falhou na verificação de integridade.');
    }

    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-replica-import-'));
    const snapshotPath = path.join(temporaryDirectory, 'database.sqlite');
    const localPrinting = database.sqlite
      .prepare("SELECT key, value, updated_at FROM app_meta WHERE key LIKE 'printing.%'")
      .all() as { readonly key: string; readonly value: string; readonly updated_at: number }[];
    try {
      await writeFile(snapshotPath, contents, { flag: 'wx' });
      await this.#databaseRuntime.replaceWith(snapshotPath);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }

    const restored = this.#databaseRuntime.get();
    restored.sqlite.transaction(() => {
      restored.sqlite.prepare("DELETE FROM app_meta WHERE key LIKE 'printing.%'").run();
      const insert = restored.sqlite.prepare(
        'INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)',
      );
      for (const row of localPrinting) insert.run(row.key, row.value, row.updated_at);
    })();
    const event = restored.sqlite
      .prepare("SELECT id FROM events WHERE id = ? AND status = 'open'")
      .get(command.eventId);
    if (event === undefined) {
      throw new Error('A cópia inicial não contém o evento global selecionado.');
    }
    setActiveEvent(restored, command.eventId);
    restored.sqlite
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES ('replica.baseline.snapshotId', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(command.bootstrapSnapshotId, Date.now());
    this.#markBootstrapApplied(restored, command);
    this.#restartStreamsAfterDatabaseRestore();
    this.#ensureEventStreams(restored, command.eventId, deviceId, pairingKey);
    this.#onDataChanged();
    return restored;
  }

  #isBootstrapEligible(database: DatabaseContext, eventId: string): boolean {
    const otherEvents = database.sqlite
      .prepare('SELECT COUNT(*) AS amount FROM events WHERE id <> ?')
      .get(eventId) as { readonly amount: number };
    if (otherEvents.amount > 0) return false;
    const eventData = database.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM orders WHERE event_id = ?) +
           (SELECT COUNT(*) FROM event_stock WHERE event_id = ?) +
           (SELECT COUNT(*) FROM service_points WHERE event_id = ?) +
           (SELECT COUNT(*) FROM vouchers WHERE event_id = ?) +
           (SELECT COUNT(*) FROM expenses WHERE event_id = ?) +
           (SELECT COUNT(*) FROM ticket_lots WHERE event_id = ?) AS amount`,
      )
      .get(eventId, eventId, eventId, eventId, eventId, eventId) as { readonly amount: number };
    return eventData.amount === 0;
  }

  #isPartialReplicaReplaceable(database: DatabaseContext, eventId: string): boolean {
    const state = database.sqlite
      .prepare(
        `SELECT
         (SELECT COUNT(*) FROM events WHERE id <> ?) AS other_events,
         (SELECT COUNT(*) FROM orders WHERE event_id = ?) AS orders,
         (SELECT COUNT(*) FROM sync_outbox WHERE status IN ('pending', 'failed')) AS unsent`,
      )
      .get(eventId, eventId) as {
      readonly other_events: number;
      readonly orders: number;
      readonly unsent: number;
    };
    return state.other_events === 0 && state.orders === 0 && state.unsent === 0;
  }

  async #recoverPartialReplica(
    database: DatabaseContext,
    pairingKey: string,
    deviceId: string,
  ): Promise<void> {
    if (this.#databaseRuntime === null) return;
    if (
      database.sqlite
        .prepare("SELECT 1 FROM sync_state WHERE key = 'replica.baseline.snapshotId'")
        .get()
    )
      return;
    const event = getSessionState(database).activeEvent;
    if (event === null || !this.#isPartialReplicaReplaceable(database, event.id)) return;
    if (Date.now() - this.#lastEmptyReplicaCheckAt < 60_000) return;
    this.#lastEmptyReplicaCheckAt = Date.now();
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(event.id)}/replica-snapshot/latest`,
      {
        headers: await this.#cloudHeaders(pairingKey),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok) return;
    const manifest: unknown = await response.json();
    if (
      !isRecord(manifest) ||
      manifest.eventId !== event.id ||
      typeof manifest.snapshotId !== 'string' ||
      typeof manifest.sourceDeviceId !== 'string' ||
      manifest.sourceDeviceId === deviceId
    )
      return;
    const cursor = database.sqlite
      .prepare("SELECT value FROM sync_state WHERE key = 'global.event-control.cursor'")
      .get() as { readonly value: string } | undefined;
    this.#pendingBootstrap = {
      command: {
        sequence: Number(cursor?.value ?? 0),
        commandId: `replica-repair:${manifest.snapshotId}`,
        type: 'event.activated',
        eventId: event.id,
        eventName: event.name,
        reason: null,
        bootstrapSnapshotId: manifest.snapshotId,
        snapshotSourceDeviceId: manifest.sourceDeviceId,
        createdAt: Date.now(),
      },
    };
  }

  #hasAppliedBootstrap(database: DatabaseContext, commandId: string): boolean {
    return (
      database.sqlite
        .prepare('SELECT 1 FROM sync_state WHERE key = ?')
        .get(`global.bootstrap:${commandId}`) !== undefined
    );
  }

  #markBootstrapApplied(database: DatabaseContext, command: GlobalEventCommand): void {
    database.sqlite.transaction(() => {
      database.sqlite
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES (?, 'applied', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(`global.bootstrap:${command.commandId}`, Date.now());
      database.sqlite
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES (?, 'applied', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(`global.event-command:${command.commandId}`, Date.now());
      database.sqlite
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run('global.event-control.cursor', String(command.sequence), Date.now());
    })();
  }

  #restartStreamsAfterDatabaseRestore(): void {
    this.#stopControlHeartbeat();
    this.#controlStream?.close();
    this.#controlStream = null;
    if (this.#controlReconnectTimer !== null) clearTimeout(this.#controlReconnectTimer);
    this.#controlReconnectTimer = null;
    for (const timer of this.#eventReconnectTimers.values()) clearTimeout(timer);
    this.#eventReconnectTimers.clear();
    for (const stream of this.#eventStreams.values()) stream.close();
    this.#eventStreams.clear();
    this.#stopCanonicalRealtime();
  }

  #ensureControlStream(database: DatabaseContext, deviceId: string, pairingKey: string): void {
    if (this.#endpoint.includes('.supabase.co/functions/')) {
      void database;
      void deviceId;
      void pairingKey;
      this.#cloudConnected = true;
      return;
    }
    if (this.#controlReconnectTimer !== null) return;
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
      this.#startControlHeartbeat(stream, database);
    });
    stream.on('message', (message) => {
      // The control Durable Object already includes the current global command
      // snapshot in this frame. Applying it directly avoids a duplicate HTTP read.
      let payload: unknown;
      try {
        payload = JSON.parse(websocketMessageText(message));
      } catch {
        this.#recordCloudFailure();
        return;
      }
      // A complete push frame contains commands. Fall back to the cursor-based
      // recovery endpoint only for a malformed or incomplete frame.
      const completePayload =
        isRecord(payload) && Array.isArray(payload.commands) ? payload : undefined;
      void this.#pullGlobalControl(database, pairingKey, deviceId, completePayload)
        .then((recovered) => {
          if (!recovered) this.#recordCloudFailure();
        })
        .catch(() => {
          this.#recordCloudFailure();
        });
    });
    stream.on('error', () => undefined);
    stream.on('close', () => {
      if (this.#controlStream !== stream) return;
      this.#controlStream = null;
      this.#cloudConnected = false;
      this.#stopControlHeartbeat();
      if (!this.#replicationRunning) return;
      this.#scheduleControlReconnect(database, deviceId, pairingKey);
    });
  }

  #scheduleControlReconnect(database: DatabaseContext, deviceId: string, pairingKey: string): void {
    if (!this.#replicationRunning) return;
    if (this.#controlReconnectTimer !== null) return;
    const delay = this.#controlReconnectDelayMs;
    this.#controlReconnectDelayMs = Math.min(delay * 2, STREAM_RECONNECT_MAX_MS);
    this.#controlReconnectTimer = setTimeout(() => {
      this.#controlReconnectTimer = null;
      this.#ensureControlStream(database, deviceId, pairingKey);
    }, delay);
  }

  #startControlHeartbeat(stream: WebSocket, database: DatabaseContext): void {
    this.#stopControlHeartbeat();
    const sendHeartbeat = (): void => {
      if (this.#controlStream !== stream || stream.readyState !== WebSocket.OPEN) return;
      try {
        stream.send(
          JSON.stringify({
            type: 'global.heartbeat',
            activeEventId: getSessionState(database).activeEvent?.id ?? null,
            latencyMs: this.#lastLatencyMs,
          }),
        );
      } catch {
        // The close handler owns reconnecting a broken control stream.
      }
    };
    sendHeartbeat();
    this.#controlHeartbeatTimer = setInterval(sendHeartbeat, CONTROL_HEARTBEAT_INTERVAL_MS);
  }

  #stopControlHeartbeat(): void {
    if (this.#controlHeartbeatTimer !== null) clearInterval(this.#controlHeartbeatTimer);
    this.#controlHeartbeatTimer = null;
  }

  async #pullGlobalControl(
    database: DatabaseContext,
    pairingKey: string,
    deviceId: string,
    pushedPayload?: unknown,
  ): Promise<boolean> {
    const cursorKey = 'global.event-control.cursor';
    const cursorRow = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(cursorKey) as { readonly value: string } | undefined;
    const after = Number.parseInt(cursorRow?.value ?? '0', 10) || 0;
    let payload = pushedPayload;
    if (payload === undefined) {
      const response = await fetch(
        `${this.#endpoint}/v1/monitor/global-control?after=${String(after)}`,
        {
          headers: await this.#cloudHeaders(pairingKey),
          signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
        },
      );
      if (!response.ok) return false;
      payload = await response.json();
    }
    if (!isRecord(payload) || !Array.isArray(payload.commands)) return false;
    let cursor = after;
    for (const candidate of payload.commands) {
      if (!isRecord(candidate)) continue;
      if (
        typeof candidate.sequence !== 'number' ||
        typeof candidate.commandId !== 'string' ||
        (candidate.type !== 'event.activated' && candidate.type !== 'event.reset') ||
        typeof candidate.eventId !== 'string' ||
        typeof candidate.eventName !== 'string' ||
        typeof candidate.createdAt !== 'number'
      )
        continue;
      let command: GlobalEventCommand = {
        sequence: candidate.sequence,
        commandId: candidate.commandId,
        type: candidate.type,
        eventId: candidate.eventId,
        eventName: candidate.eventName,
        reason: typeof candidate.reason === 'string' ? candidate.reason : null,
        bootstrapSnapshotId:
          typeof candidate.bootstrapSnapshotId === 'string' ? candidate.bootstrapSnapshotId : null,
        snapshotSourceDeviceId:
          typeof candidate.snapshotSourceDeviceId === 'string'
            ? candidate.snapshotSourceDeviceId
            : null,
        createdAt: candidate.createdAt,
      };
      const appliedKey = `global.event-command:${command.commandId}`;
      const alreadyApplied = database.sqlite
        .prepare('SELECT 1 FROM sync_state WHERE key = ?')
        .get(appliedKey) as { readonly value: number } | undefined;
      if (alreadyApplied !== undefined) {
        cursor = Math.max(cursor, command.sequence);
        continue;
      }
      let event = database.sqlite
        .prepare('SELECT id, name FROM events WHERE id = ?')
        .get(command.eventId) as { readonly id: string; readonly name: string } | undefined;
      if (event === undefined && command.type === 'event.activated') {
        database.sqlite
          .prepare(
            `INSERT INTO events (id, name, status, starts_at, ends_at, created_at, updated_at)
             VALUES (?, ?, 'open', ?, NULL, ?, ?)`,
          )
          .run(
            command.eventId,
            command.eventName,
            command.createdAt,
            command.createdAt,
            command.createdAt,
          );
        event = { id: command.eventId, name: command.eventName };
      }
      if (event !== undefined && command.type === 'event.activated') {
        if (
          this.#endpoint.includes('.supabase.co/functions/') &&
          this.#databaseRuntime !== null &&
          this.#isBootstrapEligible(database, command.eventId) &&
          !this.#hasAppliedBootstrap(database, command.commandId)
        ) {
          const latest = await fetch(
            `${this.#endpoint}/v1/events/${encodeURIComponent(command.eventId)}/replica-snapshot/latest`,
            {
              headers: await this.#cloudHeaders(pairingKey),
              signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
            },
          );
          const manifest: unknown = await latest.json().catch(() => null);
          if (
            !latest.ok ||
            !isRecord(manifest) ||
            typeof manifest.snapshotId !== 'string' ||
            manifest.eventId !== command.eventId ||
            typeof manifest.sourceDeviceId !== 'string'
          ) {
            throw new Error(
              'A nuvem ainda não possui uma cópia completa e verificada deste evento.',
            );
          }
          command = {
            ...command,
            bootstrapSnapshotId: manifest.snapshotId,
            snapshotSourceDeviceId: manifest.sourceDeviceId,
          };
        }
        if (
          command.bootstrapSnapshotId !== null &&
          command.snapshotSourceDeviceId !== null &&
          command.snapshotSourceDeviceId !== deviceId &&
          this.#databaseRuntime !== null &&
          !this.#hasAppliedBootstrap(database, command.commandId)
        ) {
          this.#pendingBootstrap = { command };
          this.#recordCloudSuccess();
          return true;
        }
        setActiveEvent(database, event.id);
        database.sqlite
          .prepare('DELETE FROM sync_state WHERE key = ?')
          .run(`replica.reconciled:${event.id}`);
        if (!this.#endpoint.includes('.supabase.co/functions/')) {
          this.#ensureEventStreams(database, event.id, deviceId, pairingKey);
        }
        this.#onDataChanged();
      } else if (event !== undefined) {
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
    if (pending?.targetDeviceIds.includes(deviceId) === true) {
      await this.#prepareResetBackup(database, pairingKey, deviceId, pending);
    }
    this.#recordCloudSuccess();
    return true;
  }

  /** True while the central has answered recently, whichever request it answered. */
  #isCloudReachable(): boolean {
    return this.#cloudConnected || Date.now() - this.#lastCloudResponseAt < CLOUD_FRESH_MS;
  }

  /**
   * A cheap authenticated question to the central every few seconds, so the indicator reflects the
   * real connection even when nothing is being sold. Any answer except a server error or a refused
   * credential counts as reachable.
   */
  async #probeCloud(): Promise<void> {
    if (this.#cloudProbeInFlight || !this.#replicationRunning) return;
    this.#cloudProbeInFlight = true;
    try {
      const pairingKey = await this.#readPairingKey();
      if (pairingKey === null) return;
      const startedAt = Date.now();
      const response = await fetch(
        `${this.#endpoint}/v1/events/${CATALOG_EVENT_ID}/snapshot?after=2000000000`,
        {
          headers: await this.#cloudHeaders(pairingKey),
          signal: AbortSignal.timeout(CLOUD_PROBE_TIMEOUT_MS),
        },
      );
      if (response.status < 500 && response.status !== 401 && response.status !== 403) {
        this.#lastLatencyMs = Date.now() - startedAt;
        this.#recordCloudSuccess();
      } else {
        this.#recordCloudFailure();
      }
    } catch {
      this.#recordCloudFailure();
    } finally {
      this.#cloudProbeInFlight = false;
    }
  }

  #latestAuditId(database: DatabaseContext): number {
    return (
      database.sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').get() as {
        readonly id: number;
      }
    ).id;
  }

  #recordCloudSuccess(): void {
    // The canonical HTTP transport has no persistent WebSocket to flip this flag.
    // A completed authenticated request is the authoritative connectivity signal.
    this.#lastCloudResponseAt = Date.now();
    this.#cloudConnected = true;
    this.#cloudFailingSince = null;
    this.#cloudRetryDelayMs = 3_000;
    this.#cloudRetryNotBefore = 0;
  }

  #recordCloudFailure(): void {
    const now = Date.now();
    this.#cloudFailingSince ??= now;
    // One timeout or one rejected request is not a lost connection: report "disconnected" only
    // after the cloud has been silent for a while, and keep retrying quickly meanwhile.
    if (now - this.#cloudFailingSince >= CLOUD_DISCONNECT_GRACE_MS) this.#cloudConnected = false;
    const delay = this.#cloudRetryDelayMs;
    this.#cloudRetryNotBefore = now + delay;
    this.#cloudRetryDelayMs = Math.min(delay * 2, CLOUD_RETRY_MAX_MS);
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
        headers: await this.#cloudHeaders(pairingKey, {
          'Content-Type': 'application/octet-stream',
          'X-GTRZ-Device-Id': deviceId,
          'X-GTRZ-Backup-Name': backup.fileName,
          'X-GTRZ-Backup-Sha256': createHash('sha256').update(contents).digest('hex'),
          'X-GTRZ-Backup-Size': String(contents.byteLength),
          'Content-Length': String(contents.byteLength),
        }),
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
        headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...conflict, createdAt: Date.now() }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
    } catch {
      // The local conflict remains authoritative and visible offline.
    }
  }

  async #readPairingKey(): Promise<string | null> {
    try {
      const rawCredential: unknown = JSON.parse(await readFile(this.#deviceCredentialPath, 'utf8'));
      if (
        isRecord(rawCredential) &&
        typeof rawCredential.token === 'string' &&
        rawCredential.token.trim().length >= 32
      ) {
        return rawCredential.token;
      }
    } catch {
      // A device credential is optional during the transition from the original key.
    }
    return this.#readLegacyPairingKey();
  }

  async #readLegacyPairingKey(): Promise<string | null> {
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

  async #cloudHeaders(
    credential: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    return {
      ...headers,
      'X-GTRZ-Key': credential,
      'X-GTRZ-Device-Id': await this.#readOrCreateDeviceId(),
    };
  }

  async #publishCashierCatalog(
    database: DatabaseContext,
    activeEventId: string | null,
    pairingKey: string,
    pendingStockDeltas: ReadonlyMap<string, number> = new Map(),
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
          quantity: Math.max(
            0,
            product.quantity - (pendingStockDeltas.get(product.product_id) ?? 0),
          ),
        };
      }),
      ...listCombos(database)
        .filter((combo) => combo.active)
        .map((combo) => ({
          productId: combo.id,
          label: combo.name,
          kind: combo.kind,
          itemKind: 'combo',
          visible: true,
          categoryLabel: combo.kind === 'food' ? 'Comidas' : 'Combos',
          imageDataUrl: null,
          fallbackIcon: 'package',
          components: combo.components.map((component) => ({
            productId: component.productId,
            quantity: component.quantity,
            choiceGroup: component.choiceGroup,
            choiceLabel: component.choiceLabel,
            sortOrder: component.sortOrder,
          })),
          unitPriceCents: combo.salePriceCents,
          quantity: combo.availableUnits,
        })),
    ];
    const fingerprint = JSON.stringify(catalog);
    // Publication confirmations belong to a transport. A prior alternate publish
    // must never suppress the first canonical-cloud snapshot for the same event.
    const canonicalCloud = this.#endpoint.includes('.supabase.co/functions/');
    const stateKey = `cashier.catalog:${activeEventId}:${canonicalCloud ? 'canonical' : 'legacy'}`;
    const current = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(stateKey) as { readonly value: string } | undefined;
    const canonicalState = canonicalCloud
      ? await this.#readCanonicalEventState(activeEventId, pairingKey)
      : null;
    if (
      canonicalCloud &&
      catalog.length === 0 &&
      this.#projectionArrayHasEntries(canonicalState?.catalog, 'products')
    ) {
      // A desktop that has not rebuilt its local replica must never replace a
      // populated mobile catalogue with an empty list. Once its journal catch-up
      // fills the local data, the fingerprint changes and publishing resumes.
      this.#canonicalProtectedProjectionFingerprints.set(stateKey, fingerprint);
      return;
    }
    const publishedInThisProcess = this.#canonicalProjectionPublished.has(stateKey);
    if (publishedInThisProcess && current?.value === fingerprint) return;

    const expectedVersion = canonicalState?.version ?? null;
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(activeEventId)}/cashier/catalog`,
      {
        method: 'POST',
        headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(
          canonicalCloud
            ? { projection: { products: catalog }, expectedVersion }
            : { products: catalog },
        ),
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
    if (canonicalCloud) {
      this.#canonicalProjectionPublished.add(stateKey);
      this.#canonicalProtectedProjectionFingerprints.delete(stateKey);
    }
  }

  #pendingStockDeltas(
    database: DatabaseContext,
    activeEventId: string | null,
  ): ReadonlyMap<string, number> {
    const deltas = new Map<string, number>();
    if (activeEventId === null) return deltas;
    const rows = database.sqlite
      .prepare(
        "SELECT payload_json FROM sync_outbox WHERE event_id = ? AND status IN ('pending', 'failed') ORDER BY audit_id",
      )
      .all(activeEventId) as readonly { readonly payload_json: string }[];
    const add = (productId: string, delta: number): void => {
      deltas.set(productId, (deltas.get(productId) ?? 0) + delta);
    };
    for (const row of rows) {
      const payload: unknown = JSON.parse(row.payload_json);
      if (!isRecord(payload) || !isRecord(payload.details)) continue;
      if (payload.action === 'inventory.stock-moved') {
        const productId = stringField(payload.details, 'productId');
        const delta = integerField(payload.details, 'delta');
        if (productId !== null && delta !== null) add(productId, delta);
      } else if (
        payload.action === 'operations.order-paid' &&
        Array.isArray(payload.details.stockMovements)
      ) {
        for (const movement of payload.details.stockMovements) {
          if (!isRecord(movement)) continue;
          const productId = stringField(movement, 'product_id');
          const delta = integerField(movement, 'delta');
          if (productId !== null && delta !== null) add(productId, delta);
        }
      } else if (
        payload.action === 'operations.order-cancelled' &&
        payload.details.previousStatus === 'paid' &&
        typeof payload.entityId === 'string'
      ) {
        const returns = database.sqlite
          .prepare(
            "SELECT product_id, delta FROM stock_movements WHERE event_id = ? AND type = 'return' AND note = ?",
          )
          .all(activeEventId, `Estorno da comanda ${payload.entityId}`) as readonly {
          readonly product_id: string;
          readonly delta: number;
        }[];
        for (const returned of returns) add(returned.product_id, returned.delta);
      }
    }
    return deltas;
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
    const vouchers = database.sqlite
      .prepare(
        `SELECT v.id, v.code, v.label, v.remaining_balance_cents, v.status, v.updated_at,
                binding.value AS service_point_id
         FROM vouchers v
         LEFT JOIN app_meta binding ON binding.key = 'voucher.service-point:' || v.id
         WHERE v.event_id = ?`,
      )
      .all(activeEventId) as readonly {
      readonly id: string;
      readonly code: string;
      readonly label: string;
      readonly remaining_balance_cents: number;
      readonly status: 'active' | 'exhausted' | 'cancelled';
      readonly updated_at: number;
      readonly service_point_id: string | null;
    }[];
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
      voucherCodes: vouchers.map((voucher) => voucher.code),
      vouchers: vouchers.map((voucher) => ({
        id: voucher.id,
        code: voucher.code,
        label: voucher.label,
        remainingBalanceCents: voucher.remaining_balance_cents,
        status: voucher.status,
        servicePointId: voucher.service_point_id,
        updatedAt: voucher.updated_at,
      })),
    };
    const fingerprint = JSON.stringify(context);
    const canonicalCloud = this.#endpoint.includes('.supabase.co/functions/');
    const stateKey = `mobile.context:${activeEventId}:${canonicalCloud ? 'canonical' : 'legacy'}`;
    const current = database.sqlite
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(stateKey) as { readonly value: string } | undefined;
    const canonicalState = canonicalCloud
      ? await this.#readCanonicalEventState(activeEventId, pairingKey)
      : null;
    if (
      canonicalCloud &&
      context.servicePoints.length === 0 &&
      this.#projectionArrayHasEntries(canonicalState?.context, 'servicePoints')
    ) {
      if (this.#canonicalProtectedProjectionFingerprints.get(stateKey) === fingerprint) return;
      // Service points are the mobile's access boundary. Do not erase a
      // working remote list from a desktop whose event replica is still empty.
      this.#canonicalProtectedProjectionFingerprints.set(stateKey, fingerprint);
      return;
    }
    const publishedInThisProcess = this.#canonicalProjectionPublished.has(stateKey);
    if (publishedInThisProcess && current?.value === fingerprint) return;
    const expectedVersion = canonicalState?.version ?? null;
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(activeEventId)}/cashier/context`,
      {
        method: 'POST',
        headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(canonicalCloud ? { projection: context, expectedVersion } : context),
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
    if (canonicalCloud) {
      this.#canonicalProjectionPublished.add(stateKey);
      this.#canonicalProtectedProjectionFingerprints.delete(stateKey);
    }
  }

  #projectionArrayHasEntries(projection: unknown, key: string): boolean {
    if (!isRecord(projection)) return false;
    const value = projection[key];
    return Array.isArray(value) && value.length > 0;
  }

  async #readCanonicalEventState(
    eventId: string,
    pairingKey: string,
  ): Promise<{ readonly version: number; readonly catalog: unknown; readonly context: unknown }> {
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/state`,
      {
        headers: await this.#cloudHeaders(pairingKey),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Não foi possível ler a versão canônica do evento (${String(response.status)}).`,
      );
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.version !== 'number' || payload.version < 0) {
      throw new Error('A nuvem respondeu com uma versão de evento inválida.');
    }
    return { version: payload.version, catalog: payload.catalog, context: payload.context };
  }

  async #processPrintQueue(
    database: DatabaseContext,
    activeEventId: string | null,
    deviceId: string,
    pairingKey: string,
  ): Promise<void> {
    if (this.#printQueueInFlight !== null) {
      this.#printQueueRerunRequested = true;
      return this.#printQueueInFlight;
    }
    const processing = this.#drainPrintQueue(database, activeEventId, deviceId, pairingKey);
    this.#printQueueInFlight = processing;
    try {
      await processing;
    } finally {
      if (this.#printQueueInFlight === processing) this.#printQueueInFlight = null;
      if (this.#printQueueRerunRequested) {
        this.#printQueueRerunRequested = false;
        this.#schedulePrintQueue(database, activeEventId, deviceId, pairingKey);
      }
    }
  }

  #schedulePrintQueue(
    database: DatabaseContext,
    activeEventId: string | null,
    deviceId: string,
    pairingKey: string,
  ): void {
    void this.#processPrintQueue(database, activeEventId, deviceId, pairingKey).catch(
      (error: unknown) => {
        this.#printPollNotBefore = Date.now() + PRINT_POLL_BACKOFF_MS;
        this.#writePrintQueueDiagnostic(
          database,
          error instanceof Error
            ? error.message
            : 'Falha desconhecida ao processar a fila de impressão.',
        );
      },
    );
  }

  #writePrintQueueDiagnostic(database: DatabaseContext, message: string): void {
    database.sqlite
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES ('cloud.print-queue.last-error', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(message.slice(0, 500), Date.now());
  }

  #clearPrintQueueDiagnostic(database: DatabaseContext): void {
    database.sqlite
      .prepare("DELETE FROM sync_state WHERE key = 'cloud.print-queue.last-error'")
      .run();
  }

  #scheduleReceiptArchive(database: DatabaseContext, orderId: string): void {
    const agent = this.#receiptArchiveAgent;
    const stateKey = `cloud.receipt-archive:${orderId}`;
    if (agent === null || this.#receiptArchivesInFlight.has(orderId)) return;
    const archived = database.sqlite
      .prepare('SELECT 1 AS archived FROM sync_state WHERE key = ?')
      .get(stateKey) as { readonly archived: number } | undefined;
    if (archived !== undefined) return;

    this.#receiptArchivesInFlight.add(orderId);
    void agent(orderId)
      .then(() => {
        database.sqlite
          .prepare(
            `INSERT INTO sync_state (key, value, updated_at) VALUES (?, '1', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(stateKey, Date.now());
      })
      .catch(() => undefined)
      .finally(() => this.#receiptArchivesInFlight.delete(orderId));
  }

  async #archiveQueuedReceiptsOnce(
    database: DatabaseContext,
    baseUrl: string,
    pairingKey: string,
  ): Promise<void> {
    if (this.#queuedReceiptArchiveCheckComplete) return;
    const response = await fetch(`${baseUrl}/jobs`, {
      headers: await this.#cloudHeaders(pairingKey),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });
    if (!response.ok) return;
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.jobs)) return;
    for (const job of payload.jobs) {
      if (!isRecord(job) || job.status !== 'queued' || typeof job.orderId !== 'string') continue;
      this.#scheduleReceiptArchive(database, job.orderId);
    }
    this.#queuedReceiptArchiveCheckComplete = true;
  }

  #writeSyncDiagnostic(database: DatabaseContext, message: string): void {
    database.sqlite
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES ('cloud.sync.last-error', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(message.slice(0, 500), Date.now());
  }

  #clearSyncDiagnostic(database: DatabaseContext): void {
    database.sqlite.prepare("DELETE FROM sync_state WHERE key = 'cloud.sync.last-error'").run();
  }

  async #drainPrintQueue(
    database: DatabaseContext,
    activeEventId: string | null,
    deviceId: string,
    pairingKey: string,
  ): Promise<void> {
    if (activeEventId === null) return;
    const settings = getPrintingSettings(database);
    const registration =
      this.#getPrintQueueRegistration === null
        ? {
            printerName: settings.deviceName ?? '__windows_default__',
            enabled: settings.automaticPrinting,
            unavailableReason: settings.automaticPrinting
              ? null
              : 'A impressão automática está desativada neste computador.',
          }
        : await this.#getPrintQueueRegistration();
    const baseUrl = `${this.#endpoint}/v1/events/${encodeURIComponent(activeEventId)}/print`;
    const registrationFingerprint = [
      activeEventId,
      deviceId,
      settings.machineName,
      registration.printerName,
      settings.paperWidthMm,
      registration.enabled,
    ].join('|');
    const registrationIsCurrent =
      this.#printRegistrationFingerprint === registrationFingerprint &&
      Date.now() - this.#printRegistrationUpdatedAt < PRINT_REGISTRATION_REFRESH_MS;
    if (!registrationIsCurrent) {
      const register = await fetch(`${baseUrl}/printers`, {
        method: 'POST',
        headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          deviceId,
          deviceLabel: settings.machineName,
          printerName: registration.printerName,
          paperWidthMm: settings.paperWidthMm,
          enabled: registration.enabled,
        }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
      if (!register.ok) {
        throw new Error(
          `Não foi possível registrar a impressora deste computador (${String(register.status)}).`,
        );
      }
      this.#printRegistrationFingerprint = registrationFingerprint;
      this.#printRegistrationUpdatedAt = Date.now();
    }
    void this.#archiveQueuedReceiptsOnce(database, baseUrl, pairingKey).catch(() => undefined);
    if (!registration.enabled || this.#printAgent === null) {
      if (registration.unavailableReason !== null) {
        this.#writePrintQueueDiagnostic(database, registration.unavailableReason);
      }
      return;
    }

    for (;;) {
      const claim = await fetch(`${baseUrl}/claim`, {
        method: 'POST',
        headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ deviceId }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
      if (!claim.ok) {
        throw new Error(
          `Não foi possível reivindicar a nota para impressão (${String(claim.status)}).`,
        );
      }
      const payload: unknown = await claim.json();
      if (!isRecord(payload) || !isRecord(payload.job)) {
        this.#clearPrintQueueDiagnostic(database);
        return;
      }
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
      const complete = await fetch(`${baseUrl}/complete`, {
        method: 'POST',
        headers: await this.#cloudHeaders(pairingKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          jobId: rawJob.jobId,
          claimToken: rawJob.claimToken,
          deviceId,
          result: completion,
          error: result.success ? undefined : result.message,
        }),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      });
      if (!complete.ok) {
        throw new Error(
          `Não foi possível concluir a impressão da nota (${String(complete.status)}).`,
        );
      }
      if (!result.success) {
        this.#writePrintQueueDiagnostic(database, result.message);
        return;
      }
    }
  }

  #enqueueNewAudits(database: DatabaseContext, deviceId: string): void {
    this.#initializeOutboxAuditFloor(database);
    const floorRow = database.sqlite
      .prepare(`SELECT value FROM sync_state WHERE key = 'outbox.audit-floor'`)
      .get() as { readonly value: string };

    const floor = Number(floorRow.value);
    const audits = database.sqlite
      .prepare(
        `SELECT audit_log.*, local_operation_ids.operation_id AS durable_operation_id
         FROM audit_log LEFT JOIN local_operation_ids ON audit_log.id = local_operation_ids.audit_id
         WHERE audit_log.id > ? ORDER BY audit_log.id ASC`,
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
        const rawDetails: unknown = JSON.parse(audit.details_json);
        // Remote journal entries need to remain visible in the local audit, but
        // must never re-enter the outbox and echo the same transaction back.
        if (isRecord(rawDetails) && rawDetails._cloudReplicated === true) continue;
        const eventName =
          audit.event_id === null
            ? null
            : ((
                database.sqlite
                  .prepare('SELECT name FROM events WHERE id = ?')
                  .get(audit.event_id) as { readonly name: string } | undefined
              )?.name ?? null);
        const payload = {
          commandId: audit.durable_operation_id ?? `${deviceId}:${String(audit.id)}`,
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
          CATALOG_ACTIONS.has(audit.action)
            ? CATALOG_EVENT_ID
            : (audit.event_id ?? CATALOG_EVENT_ID),
          JSON.stringify(payload),
          Date.now(),
          Date.now(),
        );
      }
      updateFloor.run(String(audits.at(-1)?.id ?? floor), Date.now());
    })();
  }

  #initializeOutboxAuditFloor(database: DatabaseContext): void {
    const existing = database.sqlite
      .prepare("SELECT 1 FROM sync_state WHERE key = 'outbox.audit-floor'")
      .get();
    if (existing !== undefined) return;
    const current = database.sqlite
      .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log')
      .get() as { readonly id: number };
    database.sqlite
      .prepare(
        "INSERT INTO sync_state (key, value, updated_at) VALUES ('outbox.audit-floor', ?, ?)",
      )
      .run(String(current.id), Date.now());
  }

  #ensureEventStreams(
    database: DatabaseContext,
    activeEventId: string | null,
    deviceId: string,
    pairingKey: string,
  ): void {
    if (this.#endpoint.includes('.supabase.co/functions/')) {
      void database;
      void activeEventId;
      void deviceId;
      void pairingKey;
      return;
    }
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

  async #ensureCanonicalRealtime(
    database: DatabaseContext,
    activeEventId: string | null,
    deviceId: string,
    pairingKey: string,
  ): Promise<void> {
    if (!this.#endpoint.includes('.supabase.co/functions/')) return;
    if (this.#canonicalRealtimeClient === null) {
      this.#canonicalRealtimeClient = createClient(
        CANONICAL_SUPABASE_URL,
        CANONICAL_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
    }
    const wanted = new Set([CATALOG_EVENT_ID]);
    if (activeEventId !== null) wanted.add(activeEventId);

    for (const eventId of wanted) {
      const hasStateChannel = this.#canonicalRealtimeChannels.has(eventId);
      const hasDesktopChannel = this.#canonicalDesktopRealtimeChannels.has(eventId);
      if (hasStateChannel && hasDesktopChannel) continue;
      const [topic, desktopTopic] = await Promise.all([
        this.#readCanonicalRealtimeTopic(eventId, pairingKey),
        this.#readCanonicalDesktopRealtimeTopic(eventId, pairingKey),
      ]);
      if (!hasStateChannel) {
        const channel = this.#canonicalRealtimeClient
          .channel(topic)
          .on('broadcast', { event: 'state-changed' }, (message: unknown) => {
            const envelope =
              isRecord(message) && isRecord(message.payload) ? message.payload : null;
            if (envelope?.eventId !== eventId) return;
            if (envelope.globalControl === true) {
              void this.#pullGlobalControl(database, pairingKey, deviceId)
                .then((recovered) => {
                  if (!recovered) {
                    this.#recordCloudFailure();
                    return;
                  }
                  const nextEventId = getSessionState(database).activeEvent?.id ?? null;
                  void this.#ensureCanonicalRealtime(database, nextEventId, deviceId, pairingKey);
                })
                .catch(() => {
                  this.#recordCloudFailure();
                });
              return;
            }
            const fastPath = envelope.fastPath === true;
            const recentlyApplied =
              fastPath && Date.now() - (this.#canonicalFastAppliedAt.get(eventId) ?? 0) < 1_500;
            if (!recentlyApplied) {
              this.#scheduleCanonicalReconciliation(
                database,
                eventId,
                deviceId,
                pairingKey,
                fastPath ? 100 : CANONICAL_REALTIME_RECONCILIATION_DELAY_MS,
              );
            }
          })
          .subscribe((status) => {
            if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
              this.#canonicalRealtimeReadyEvents.add(eventId);
            } else {
              this.#canonicalRealtimeReadyEvents.delete(eventId);
              if (this.#canonicalRealtimeChannels.get(eventId) === channel) {
                this.#canonicalRealtimeChannels.delete(eventId);
                void this.#canonicalRealtimeClient?.removeChannel(channel);
              }
            }
          });
        this.#canonicalRealtimeChannels.set(eventId, channel);
      }
      if (!hasDesktopChannel) {
        const desktopChannel = this.#canonicalRealtimeClient
          .channel(desktopTopic)
          .on('broadcast', { event: 'journal-entry' }, (message: unknown) => {
            const envelope =
              isRecord(message) && isRecord(message.payload) ? message.payload : null;
            const journalEvent = envelope?.event;
            if (envelope?.eventId !== eventId || !isRemoteJournalEvent(journalEvent)) return;
            const result = this.#applyJournalEnvelope(
              database,
              eventId,
              deviceId,
              { currentSequence: journalEvent.sequence },
              [journalEvent],
            );
            if (!result.accepted) {
              void this.#reconcileCanonicalEvent(database, eventId, deviceId, pairingKey);
              return;
            }
            this.#canonicalFastAppliedAt.set(eventId, Date.now());
            const payload = journalPayload(journalEvent.payload);
            if (payload?.action === 'operations.order-paid') {
              // A confirmed mobile sale has already queued its receipt in the
              // same cloud transaction. Start the available local print agent
              // immediately instead of waiting for the three-second outbox tick.
              this.#schedulePrintQueue(database, eventId, deviceId, pairingKey);
            }
            const pending = this.#canonicalReconciliationTimers.get(eventId);
            if (pending !== undefined) {
              clearTimeout(pending);
              this.#canonicalReconciliationTimers.delete(eventId);
            }
            this.#recordCloudSuccess();
          })
          .subscribe((status) => {
            if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
              this.#canonicalDesktopRealtimeReadyEvents.add(eventId);
            } else {
              this.#canonicalDesktopRealtimeReadyEvents.delete(eventId);
              if (this.#canonicalDesktopRealtimeChannels.get(eventId) === desktopChannel) {
                this.#canonicalDesktopRealtimeChannels.delete(eventId);
                void this.#canonicalRealtimeClient?.removeChannel(desktopChannel);
              }
            }
          });
        this.#canonicalDesktopRealtimeChannels.set(eventId, desktopChannel);
      }
    }

    for (const [eventId, channel] of this.#canonicalRealtimeChannels) {
      if (wanted.has(eventId)) continue;
      this.#canonicalRealtimeReadyEvents.delete(eventId);
      this.#canonicalDesktopRealtimeReadyEvents.delete(eventId);
      this.#canonicalRealtimeChannels.delete(eventId);
      void this.#canonicalRealtimeClient.removeChannel(channel);
    }
    for (const [eventId, channel] of this.#canonicalDesktopRealtimeChannels) {
      if (wanted.has(eventId)) continue;
      this.#canonicalDesktopRealtimeReadyEvents.delete(eventId);
      this.#canonicalDesktopRealtimeChannels.delete(eventId);
      this.#canonicalFastAppliedAt.delete(eventId);
      void this.#canonicalRealtimeClient.removeChannel(channel);
    }
  }

  #stopCanonicalRealtime(): void {
    this.#canonicalRealtimeReadyEvents.clear();
    this.#canonicalDesktopRealtimeReadyEvents.clear();
    this.#canonicalReconciliations.clear();
    for (const timer of this.#canonicalReconciliationTimers.values()) clearTimeout(timer);
    this.#canonicalReconciliationTimers.clear();
    this.#canonicalFastAppliedAt.clear();
    if (this.#canonicalRealtimeClient !== null) {
      for (const channel of this.#canonicalRealtimeChannels.values()) {
        void this.#canonicalRealtimeClient.removeChannel(channel);
      }
      for (const channel of this.#canonicalDesktopRealtimeChannels.values()) {
        void this.#canonicalRealtimeClient.removeChannel(channel);
      }
    }
    this.#canonicalRealtimeChannels.clear();
    this.#canonicalDesktopRealtimeChannels.clear();
    this.#canonicalRealtimeClient = null;
    this.#canonicalLastFallbackReconciliationAt = 0;
  }

  async #readCanonicalRealtimeTopic(eventId: string, pairingKey: string): Promise<string> {
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/realtime-topic`,
      {
        headers: await this.#cloudHeaders(pairingKey),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || typeof payload.topic !== 'string') {
      throw new Error('A nuvem não conseguiu abrir o canal de atualização imediata.');
    }
    return payload.topic;
  }

  async #readCanonicalDesktopRealtimeTopic(eventId: string, pairingKey: string): Promise<string> {
    const response = await fetch(
      `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/desktop-realtime-topic`,
      {
        headers: await this.#cloudHeaders(pairingKey),
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
      },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || typeof payload.topic !== 'string') {
      throw new Error('A nuvem não conseguiu abrir o canal rápido entre computadores.');
    }
    return payload.topic;
  }

  #scheduleCanonicalReconciliation(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    pairingKey: string,
    delayMs: number,
  ): void {
    if (this.#canonicalReconciliationTimers.has(eventId)) return;
    const timer = setTimeout(() => {
      this.#canonicalReconciliationTimers.delete(eventId);
      void this.#reconcileCanonicalEvent(database, eventId, deviceId, pairingKey);
    }, delayMs);
    this.#canonicalReconciliationTimers.set(eventId, timer);
  }

  #reconcileCanonicalEvent(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    pairingKey: string,
  ): Promise<void> {
    const running = this.#canonicalReconciliations.get(eventId);
    if (running !== undefined) return running;
    const reconciliation = this.#reconcileEventJournal(database, eventId, deviceId, pairingKey)
      .then(() => {
        this.#recordCloudSuccess();
      })
      .catch(() => {
        this.#recordCloudFailure();
      })
      .finally(() => {
        this.#canonicalReconciliations.delete(eventId);
      });
    this.#canonicalReconciliations.set(eventId, reconciliation);
    return reconciliation;
  }

  #ensureEventStream(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    pairingKey: string,
    activeEventId: string | null,
  ): void {
    if (this.#eventReconnectTimers.has(eventId)) return;
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
        this.#schedulePrintQueue(database, eventId, deviceId, pairingKey);
      }
    });
    stream.on('message', (message) => {
      const result = this.#applyStreamMessage(database, eventId, deviceId, message);
      if (!result.accepted) {
        stream.close();
        return;
      }
      if (!result.caughtUp && stream.readyState === WebSocket.OPEN) {
        try {
          stream.send(JSON.stringify({ type: 'sync', after: result.cursor }));
        } catch {
          stream.close();
        }
      }
      if (result.printQueued && eventId === getSessionState(database).activeEvent?.id) {
        this.#schedulePrintQueue(database, eventId, deviceId, pairingKey);
      }
    });
    stream.on('error', () => undefined);
    stream.on('close', () => {
      if (this.#eventStreams.get(eventId) === stream) {
        this.#eventStreams.delete(eventId);
        if (!this.#replicationRunning) return;
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
      if (!isRecord(envelope)) return this.#rejectedStreamMessage(database, eventId);
      const printQueued = envelope.type === 'event' && envelope.printQueued === true;
      const events =
        envelope.type === 'event'
          ? [envelope.event]
          : envelope.type === 'sync' && Array.isArray(envelope.events)
            ? envelope.events
            : null;
      if (events === null) {
        return {
          accepted: true,
          printQueued: false,
          caughtUp: true,
          cursor: this.#getInboxCursor(database, eventId),
        };
      }
      return {
        ...this.#applyJournalEnvelope(database, eventId, deviceId, envelope, events),
        printQueued,
      };
    } catch {
      return this.#rejectedStreamMessage(database, eventId);
    }
  }

  #rejectedStreamMessage(database: DatabaseContext, eventId: string): StreamMessageResult {
    return {
      accepted: false,
      printQueued: false,
      caughtUp: false,
      cursor: this.#getInboxCursor(database, eventId),
    };
  }

  #applyJournalEnvelope(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    envelope: Record<string, unknown>,
    events: readonly unknown[],
  ): Omit<StreamMessageResult, 'printQueued'> {
    const journalEvents = events.filter(isRemoteJournalEvent);
    if (journalEvents.length !== events.length)
      return this.#rejectedStreamMessage(database, eventId);

    const cursor = this.#getInboxCursor(database, eventId);
    const newEvents = journalEvents.filter((event) => event.sequence > cursor);
    const currentSequence = integerField(envelope, 'currentSequence');
    if (newEvents.length === 0) {
      return {
        accepted: true,
        // The canonical cursor is the event version, which also advances for
        // projection updates that deliberately do not create a journal entry.
        // An empty page is therefore authoritative evidence that this journal
        // has no more business commands after the durable local cursor.
        caughtUp: true,
        cursor,
      };
    }
    // Journal entries use the event version as their sequence. Versions are
    // monotonically increasing but not contiguous, because catalogue/context
    // publications also increment the event version. Requiring `cursor + 1`
    // incorrectly leaves a healthy desktop permanently offline after one of
    // those projection-only changes.
    const firstEvent = newEvents[0];
    if (firstEvent === undefined || firstEvent.sequence <= cursor)
      return this.#rejectedStreamMessage(database, eventId);
    for (let index = 1; index < newEvents.length; index += 1) {
      const previous = newEvents[index - 1];
      const current = newEvents[index];
      if (
        previous === undefined ||
        current === undefined ||
        current.sequence <= previous.sequence
      ) {
        return this.#rejectedStreamMessage(database, eventId);
      }
    }
    this.#storeRemoteJournalEvents(database, eventId, newEvents);
    this.#applyInbox(database, deviceId);
    if (eventId === getSessionState(database).activeEvent?.id) {
      let paidOrderReceived = false;
      for (const journalEvent of newEvents) {
        const payload = journalPayload(journalEvent.payload);
        if (payload?.action === 'operations.order-paid' && payload.entityId !== null) {
          paidOrderReceived = true;
          this.#scheduleReceiptArchive(database, payload.entityId);
        }
      }
      if (paidOrderReceived && this.#endpoint.includes('.supabase.co/functions/')) {
        void this.#readPairingKey().then((pairingKey) => {
          if (pairingKey !== null)
            this.#schedulePrintQueue(database, eventId, deviceId, pairingKey);
        });
      }
    }
    const nextCursor = this.#getInboxCursor(database, eventId);
    return {
      accepted: true,
      caughtUp: currentSequence === null || nextCursor >= currentSequence,
      cursor: nextCursor,
    };
  }

  async #reconcileEventJournal(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    pairingKey: string,
  ): Promise<void> {
    // Limit one pass so a damaged or unexpectedly large log cannot monopolize the
    // desktop process. The next regular replication pass resumes at the durable cursor.
    for (let batch = 0; batch < 25; batch += 1) {
      const cursor = this.#getInboxCursor(database, eventId);
      const response = await fetch(
        `${this.#endpoint}/v1/events/${encodeURIComponent(eventId)}/snapshot?after=${String(cursor)}`,
        {
          headers: await this.#cloudHeaders(pairingKey),
          signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(
          `A central não concluiu a recuperação do diário (${String(response.status)}).`,
        );
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.events)) {
        throw new Error('A central enviou um diário de sincronização inválido.');
      }
      const result = this.#applyJournalEnvelope(
        database,
        eventId,
        deviceId,
        payload,
        payload.events,
      );
      if (!result.accepted) {
        throw new Error('O diário remoto possui uma lacuna de sequência.');
      }
      if (result.caughtUp) {
        database.sqlite
          .prepare(
            `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(`replica.reconciled:${eventId}`, String(result.cursor), Date.now());
        return;
      }
      if (result.cursor <= cursor) {
        throw new Error('A central não avançou o cursor de sincronização.');
      }
    }
    throw new Error('A recuperação local ainda possui muitos registros pendentes.');
  }

  #scheduleEventReconnect(
    database: DatabaseContext,
    eventId: string,
    deviceId: string,
    pairingKey: string,
  ): void {
    if (!this.#replicationRunning) return;
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
       ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(sync_state.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT), updated_at = excluded.updated_at`,
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
         FROM sync_inbox WHERE applied_at IS NULL ORDER BY CASE WHEN json_extract(payload_json, '$.action') = 'sync.operations-retired' THEN 0 ELSE 1 END, event_id, sequence LIMIT 100`,
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
    const resolveConflict = database.sqlite.prepare(
      'UPDATE sync_conflicts SET resolved_at = ? WHERE command_id = ? AND resolved_at IS NULL',
    );

    for (const row of pending) {
      if (
        database.sqlite
          .prepare('SELECT 1 FROM sync_operation_tombstones WHERE event_id=? AND command_id=?')
          .get(row.event_id, row.command_id)
      ) {
        markProcessed.run(Date.now(), row.event_id, row.sequence);
        resolveConflict.run(Date.now(), row.command_id);
        continue;
      }
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

      // A 2026-09 server build rejected five valid positive entries because its
      // envelope omitted `quantity`. Those entries already exist in the source
      // SQLite and later sales consumed them. Reversing them would invent a
      // negative stock balance; the verified full replica preserves the entry.
      if (payload.action === 'inventory.stock-rejected') {
        const details = payload.details;
        const originalId = stringField(details, 'originalMovementId');
        const original =
          originalId === null
            ? undefined
            : (database.sqlite
                .prepare('SELECT quantity, delta FROM stock_movements WHERE id = ?')
                .get(originalId) as
                | { readonly quantity: number; readonly delta: number }
                | undefined);
        if (
          stringField(details, 'rejectedDeviceId') === deviceId &&
          stringField(details, 'reason')?.includes('não contém uma quantidade válida') &&
          integerField(details, 'quantity') === null &&
          original !== undefined &&
          original.delta > 0 &&
          original.quantity === integerField(details, 'delta')
        ) {
          markProcessed.run(Date.now(), row.event_id, row.sequence);
          resolveConflict.run(Date.now(), row.command_id);
          continue;
        }
      }

      try {
        database.sqlite.transaction(() => {
          this.#applyRemoteAction(database, row.event_id, payload);
          markProcessed.run(Date.now(), row.event_id, row.sequence);
          resolveConflict.run(Date.now(), row.command_id);
        })();
        this.#onDataChanged();
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message.slice(0, 240) : 'Falha desconhecida.';
        const conflict = recordConflict.run(
          row.command_id,
          row.event_id,
          row.sequence,
          payload.action,
          payload.entityId,
          reason,
          row.payload_json,
          Date.now(),
        );
        if (conflict.changes > 0) {
          this.#reportConflict({
            commandId: row.command_id,
            eventId: row.event_id,
            deviceId,
            action: payload.action,
            entityId: payload.entityId,
            reason,
          });
        }
      }
    }

    this.#retryRecoverablePaidOrders(database);
  }

  #backfillRemoteSaleAudits(database: DatabaseContext): void {
    const rows = database.sqlite
      .prepare(
        `SELECT event_id, payload_json
         FROM sync_inbox
         WHERE applied_at IS NOT NULL
           AND payload_json LIKE '%operations.order-paid%'
         ORDER BY sequence DESC
         LIMIT 100`,
      )
      .all() as { readonly event_id: string; readonly payload_json: string }[];
    const insert = database.sqlite.prepare(
      `INSERT INTO audit_log
       (event_id, profile, action, entity_type, entity_id, details_json, created_at)
       SELECT ?, 'cashier', 'operations.order-paid', 'order', ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_log
         WHERE action = 'operations.order-paid'
           AND entity_id = ?
           AND details_json LIKE '%"_cloudReplicated":true%'
       )`,
    );
    let restored = 0;
    database.sqlite.transaction(() => {
      for (const row of rows) {
        const payload = journalPayload(JSON.parse(row.payload_json) as unknown);
        if (payload?.action !== 'operations.order-paid' || payload.entityId === null) continue;
        const result = insert.run(
          row.event_id,
          payload.entityId,
          JSON.stringify({
            ...payload.details,
            _cloudReplicated: true,
            source: 'mobile',
            originDeviceId: payload.deviceId,
          }),
          payload.createdAt,
          payload.entityId,
        );
        restored += result.changes;
      }
    })();
    if (restored > 0) this.#onDataChanged();
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
    if (payload.action === 'sync.operations-retired') {
      const targets = payload.details.targets;
      const reason = stringField(payload.details, 'reason');
      if (!Array.isArray(targets) || targets.length > 100 || reason === null)
        throw new Error('Confirmação de exclusão sem IDs ou motivo.');
      for (const target of targets as unknown[]) {
        if (!isRecord(target)) throw new Error('ID excluído inválido.');
        const commandId = stringField(target, 'commandId');
        const entityId = stringField(target, 'entityId');
        if (commandId === null || entityId === null)
          throw new Error('Exclusão sem identidade completa.');
        if (database.sqlite.prepare('SELECT id FROM orders WHERE id=?').get(entityId))
          throw new Error(
            'A operação excluída ainda existe neste PC; exige conferência antes de consolidar a exclusão.',
          );
        database.sqlite
          .prepare(
            'INSERT OR IGNORE INTO sync_operation_tombstones(event_id,command_id,entity_id,reason,confirmed_at) VALUES(?,?,?,?,?)',
          )
          .run(eventId, commandId, entityId, reason, payload.createdAt);
        database.sqlite
          .prepare(
            "UPDATE sync_conflicts SET resolved_at=? WHERE event_id=? AND command_id=? AND action='sync.identity-gap'",
          )
          .run(Date.now(), eventId, commandId);
      }
      return;
    }

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

    if (payload.action === 'event.renamed') {
      const name = stringField(payload.details, 'after');
      if (payload.entityId === null || name === null)
        throw new Error('Renomeação remota de evento incompleta.');
      database.sqlite
        .prepare('UPDATE events SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, payload.createdAt, payload.entityId);
      return;
    }

    if (
      payload.action === 'event.open' ||
      payload.action === 'event.closed' ||
      payload.action === 'event.archived'
    ) {
      if (payload.entityId === null)
        throw new Error('Alteração remota de evento sem identificador.');
      const status = payload.action.slice('event.'.length);
      database.sqlite
        .prepare('UPDATE events SET status = ?, ends_at = ?, updated_at = ? WHERE id = ?')
        .run(
          status,
          status === 'closed' ? payload.createdAt : null,
          payload.createdAt,
          payload.entityId,
        );
      return;
    }

    if (payload.action === 'event.deleted-permanently') {
      if (payload.entityId === null)
        throw new Error('Exclusão remota de evento sem identificador.');
      const event = database.sqlite
        .prepare('SELECT id, name FROM events WHERE id = ?')
        .get(payload.entityId) as { readonly id: string; readonly name: string } | undefined;
      if (event === undefined) return;
      resetEventData(database, {
        eventId: event.id,
        confirmationName: event.name,
        reason: stringField(payload.details, 'reason') ?? 'Exclusão remota do evento.',
        system: true,
      });
      database.sqlite.prepare('DELETE FROM events WHERE id = ?').run(event.id);
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
      if (typeof payload.details.fallbackIcon === 'string') {
        database.sqlite
          .prepare(
            `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(`product.icon:${payload.entityId}`, payload.details.fallbackIcon, payload.createdAt);
      }
      if (typeof payload.details.imageDataUrl === 'string') {
        database.sqlite
          .prepare(
            `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(
            `product.image:${payload.entityId}`,
            payload.details.imageDataUrl,
            payload.createdAt,
          );
      }
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
      if (after.imageDataUrl === null) {
        database.sqlite
          .prepare('DELETE FROM app_meta WHERE key = ?')
          .run(`product.image:${payload.entityId}`);
      } else if (typeof after.imageDataUrl === 'string') {
        database.sqlite
          .prepare(
            `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(`product.image:${payload.entityId}`, after.imageDataUrl, payload.createdAt);
      }
      return;
    }

    if (payload.action === 'combo.deleted') {
      if (payload.entityId === null) throw new Error('Exclusão remota de combo sem identificador.');
      database.sqlite
        .prepare('DELETE FROM food_combo_sale_settlements WHERE combo_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM food_combo_terms WHERE combo_id = ?')
        .run(payload.entityId);
      database.sqlite
        .prepare('DELETE FROM combo_components WHERE combo_id = ?')
        .run(payload.entityId);
      database.sqlite.prepare('DELETE FROM combos WHERE id = ?').run(payload.entityId);
      return;
    }

    if (payload.action === 'combo.created' || payload.action === 'combo.updated') {
      const details =
        payload.action === 'combo.created'
          ? payload.details
          : isRecord(payload.details.after)
            ? payload.details.after
            : null;
      if (payload.entityId === null || details === null)
        throw new Error('Dados remotos do combo estão incompletos.');
      const name = stringField(details, 'name');
      const kind = stringField(details, 'kind') ?? 'drink';
      const salePriceCents = integerField(details, 'salePriceCents');
      const active = payload.action === 'combo.created' ? true : details.active;
      const components = details.components;
      if (
        name === null ||
        (kind !== 'food' && kind !== 'drink') ||
        salePriceCents === null ||
        salePriceCents < 0 ||
        typeof active !== 'boolean' ||
        !Array.isArray(components) ||
        components.length === 0
      ) {
        throw new Error('Dados remotos do combo são inválidos.');
      }
      const normalized = components.map((component, index) => {
        if (!isRecord(component)) throw new Error('Componente remoto de combo inválido.');
        const productId = stringField(component, 'productId');
        const quantity = integerField(component, 'quantity');
        const choiceGroup = component.choiceGroup === undefined ? null : component.choiceGroup;
        const choiceLabel = component.choiceLabel === undefined ? null : component.choiceLabel;
        const sortOrder =
          component.sortOrder === undefined ? index : integerField(component, 'sortOrder');
        if (
          productId === null ||
          quantity === null ||
          quantity <= 0 ||
          (choiceGroup !== null && typeof choiceGroup !== 'string') ||
          (choiceLabel !== null && typeof choiceLabel !== 'string') ||
          (choiceGroup === null) !== (choiceLabel === null) ||
          sortOrder === null ||
          sortOrder < 0
        ) {
          throw new Error('Componente remoto de combo inválido.');
        }
        const product = database.sqlite
          .prepare('SELECT id FROM products WHERE id = ?')
          .get(productId);
        if (product === undefined)
          throw new Error('Componente do combo ainda não existe neste computador.');
        return { productId, quantity, choiceGroup, choiceLabel, sortOrder };
      });
      const externalFoodTerms = details.externalFoodTerms;
      if (
        externalFoodTerms !== undefined &&
        (!isRecord(externalFoodTerms) ||
          kind !== 'food' ||
          stringField(externalFoodTerms, 'supplierId') === null ||
          integerField(externalFoodTerms, 'supplierUnitCents') === null ||
          integerField(externalFoodTerms, 'commissionUnitCents') === null)
      ) {
        throw new Error('Condições remotas do combo de comida são inválidas.');
      }
      database.sqlite
        .prepare(
          `INSERT INTO combos (id, name, kind, sale_price_cents, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, sale_price_cents = excluded.sale_price_cents,
             active = excluded.active, updated_at = excluded.updated_at`,
        )
        .run(
          payload.entityId,
          name,
          kind,
          salePriceCents,
          active ? 1 : 0,
          payload.createdAt,
          payload.createdAt,
        );
      database.sqlite
        .prepare('DELETE FROM combo_components WHERE combo_id = ?')
        .run(payload.entityId);
      const insert = database.sqlite.prepare(
        `INSERT INTO combo_components
         (id, combo_id, product_id, quantity, choice_group, choice_label, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const component of normalized) {
        insert.run(
          randomUUID(),
          payload.entityId,
          component.productId,
          component.quantity,
          component.choiceGroup,
          component.choiceLabel,
          component.sortOrder,
        );
      }
      database.sqlite
        .prepare('DELETE FROM food_combo_terms WHERE combo_id = ?')
        .run(payload.entityId);
      if (isRecord(externalFoodTerms)) {
        const supplierId = stringField(externalFoodTerms, 'supplierId');
        const supplierUnitCents = integerField(externalFoodTerms, 'supplierUnitCents');
        const commissionUnitCents = integerField(externalFoodTerms, 'commissionUnitCents');
        database.sqlite
          .prepare(
            `INSERT INTO food_combo_terms
             (combo_id, event_id, supplier_id, supplier_unit_cents, commission_unit_cents, created_at, updated_at)
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
      const comboOnly = payload.details.comboOnly === true;
      if (payload.entityId === null) {
        throw new Error('Item externo de comida remoto inválido.');
      }
      if (comboOnly) return;
      if (supplierId === null || supplierUnitCents === null || commissionUnitCents === null)
        throw new Error('Item externo de comida remoto inválido.');
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
      const delta = integerField(payload.details, 'delta');
      const quantity =
        integerField(payload.details, 'quantity') ?? (delta === null ? null : Math.abs(delta));
      const purchaseTotalCents = integerField(payload.details, 'purchaseTotalCents');
      const note = payload.details.note === null ? null : stringField(payload.details, 'note');
      if (
        payload.entityId === null ||
        productId === null ||
        quantity === null ||
        quantity <= 0 ||
        delta === null ||
        delta === 0 ||
        quantity !== Math.abs(delta) ||
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
    const items: readonly unknown[] | null = Array.isArray(payload.details.items)
      ? payload.details.items
      : null;
    const payments: readonly unknown[] | null = Array.isArray(payload.details.payments)
      ? payload.details.payments
      : null;
    const movements: readonly unknown[] | null = Array.isArray(payload.details.stockMovements)
      ? payload.details.stockMovements
      : null;
    const vouchers: readonly unknown[] | null = Array.isArray(payload.details.vouchers)
      ? payload.details.vouchers
      : null;
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
    const paymentCents = payments.reduce<number>(
      (total, raw) => total + (isRecord(raw) ? (integerField(raw, 'amountCents') ?? 0) : 0),
      0,
    );
    const voucherCents = voucherUses.reduce<number>(
      (total, voucher) => total + voucher.amountCents,
      0,
    );
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
       (id, order_id, item_kind, item_id, item_name, configuration_key, quantity, unit_price_cents, total_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertComponentAllocation = database.sqlite.prepare(
      `INSERT INTO order_item_component_allocations
       (id, order_item_id, product_id, choice_group, choice_label, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const remoteComboItems: { readonly comboId: string; readonly quantity: number }[] = [];
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
      const configurationKey =
        itemKind === 'combo' && Array.isArray(raw.componentAllocations)
          ? JSON.stringify(
              raw.componentAllocations
                .filter(isRecord)
                .map((allocation) => ({
                  choiceGroup: allocation.choiceGroup,
                  productId: allocation.productId,
                  quantity: allocation.quantity,
                }))
                .sort((left, right) =>
                  `${String(left.choiceGroup)}:${String(left.productId)}`.localeCompare(
                    `${String(right.choiceGroup)}:${String(right.productId)}`,
                  ),
                ),
            )
          : '';
      insertItem.run(
        id,
        orderId,
        itemKind,
        itemId,
        itemName,
        configurationKey,
        quantity,
        unitPriceCents,
        itemTotal,
        payload.createdAt,
      );
      if (itemKind === 'combo') remoteComboItems.push({ comboId: itemId, quantity });
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
    const comboTerm = database.sqlite.prepare(
      `SELECT supplier_unit_cents, commission_unit_cents
       FROM food_combo_terms WHERE event_id = ? AND combo_id = ?`,
    );
    const insertComboSettlement = database.sqlite.prepare(
      `INSERT OR IGNORE INTO food_combo_sale_settlements
       (id, event_id, order_id, combo_id, quantity, received_cents, supplier_cents, commission_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of remoteComboItems) {
      const term = comboTerm.get(eventId, item.comboId) as
        | { readonly supplier_unit_cents: number; readonly commission_unit_cents: number }
        | undefined;
      if (term === undefined) continue;
      const supplierCents = term.supplier_unit_cents * item.quantity;
      const commissionCents = term.commission_unit_cents * item.quantity;
      insertComboSettlement.run(
        randomUUID(),
        eventId,
        orderId,
        item.comboId,
        item.quantity,
        supplierCents + commissionCents,
        supplierCents,
        commissionCents,
        payload.createdAt,
      );
    }
    database.sqlite
      .prepare(
        `INSERT INTO audit_log
         (event_id, profile, action, entity_type, entity_id, details_json, created_at)
         VALUES (?, 'cashier', 'operations.order-paid', 'order', ?, ?, ?)`,
      )
      .run(
        eventId,
        orderId,
        JSON.stringify({
          ...payload.details,
          _cloudReplicated: true,
          source: 'mobile',
          originDeviceId: payload.deviceId,
        }),
        payload.createdAt,
      );
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
    if (payload.action === 'voucher.value-updated') {
      const initialBalanceCents = integerField(payload.details, 'initialBalanceCents');
      const remainingBalanceCents = integerField(payload.details, 'remainingBalanceCents');
      const status = stringField(payload.details, 'status');
      if (
        initialBalanceCents === null ||
        initialBalanceCents <= 0 ||
        remainingBalanceCents === null ||
        remainingBalanceCents < 0 ||
        (status !== 'active' && status !== 'exhausted' && status !== 'cancelled')
      ) {
        throw new Error('Correção remota de valor de voucher inválida.');
      }
      database.sqlite
        .prepare(
          `UPDATE vouchers
           SET initial_balance_cents = ?, remaining_balance_cents = ?, status = ?, updated_at = ?
           WHERE id = ? AND event_id = ?`,
        )
        .run(
          initialBalanceCents,
          remainingBalanceCents,
          status,
          payload.createdAt,
          payload.entityId,
          eventId,
        );
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
      .all(eventId, `Venda da comanda ${payload.entityId}`) as {
      product_id: string;
      quantity: number;
    }[];
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
