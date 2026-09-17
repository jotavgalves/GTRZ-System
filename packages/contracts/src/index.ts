import { z } from 'zod';

import type { ComboApi } from './combos';
import type { EventCloseApi } from './event-close';
import type { CashApi, ExpenseApi } from './finance';
import type { AuditApi, DashboardApi } from './insights';
import type { InventoryApi } from './inventory';
import type { OperationsApi } from './operations';
import type { PrintingApi } from './printing';
import type { TicketApi } from './tickets';
import type { VoucherApi } from './vouchers';

export * from './combos';
export * from './event-close';
export * from './finance';
export * from './insights';
export * from './inventory';
export * from './operations';
export * from './printing';
export * from './tickets';
export * from './vouchers';

export const IPC_CHANNELS = {
  systemGetInfo: 'system:get-info',
  dashboardGetState: 'dashboard:get-state',
  auditList: 'audit:list',
  eventsList: 'events:list',
  eventsCreate: 'events:create',
  eventsRename: 'events:rename',
  eventsChangeStatus: 'events:change-status',
  eventsDelete: 'events:delete',
  eventsSetActive: 'events:set-active',
  eventClosePreview: 'event-close:preview',
  eventCloseComplete: 'event-close:complete',
  sessionGetState: 'session:get-state',
  sessionSwitchProfile: 'session:switch-profile',
  settingsChangeProductionPassword: 'settings:change-production-password',
  settingsGetPaymentTerminal: 'settings:get-payment-terminal',
  settingsUpdatePaymentTerminal: 'settings:update-payment-terminal',
  settingsGetCloudSyncStatus: 'settings:get-cloud-sync-status',
  settingsGetCloudMonitor: 'settings:get-cloud-monitor',
  printingListPrinters: 'printing:list-printers',
  printingGetSettings: 'printing:get-settings',
  printingUpdateSettings: 'printing:update-settings',
  printingReprintOrder: 'printing:reprint-order',
  backupsGetState: 'backups:get-state',
  backupsChooseDestination: 'backups:choose-destination',
  backupsCreateManual: 'backups:create-manual',
  backupsImport: 'backups:import',
  backupsVerify: 'backups:verify',
  inventoryGetState: 'inventory:get-state',
  inventoryCreateCategory: 'inventory:create-category',
  inventoryCreateProduct: 'inventory:create-product',
  inventoryUpdateProduct: 'inventory:update-product',
  inventoryRecordMovement: 'inventory:record-movement',
  inventoryListTransfers: 'inventory:list-transfers',
  inventoryTransferStock: 'inventory:transfer-stock',
  inventoryPreviewProductDeletion: 'inventory:preview-product-deletion',
  inventoryDeleteProduct: 'inventory:delete-product',
  combosList: 'combos:list',
  combosCreate: 'combos:create',
  combosUpdate: 'combos:update',
  operationsGetState: 'operations:get-state',
  operationsCreateServicePoint: 'operations:create-service-point',
  operationsRenameServicePoint: 'operations:rename-service-point',
  operationsSetServicePointPinned: 'operations:set-service-point-pinned',
  operationsDeleteServicePoint: 'operations:delete-service-point',
  operationsOpenOrder: 'operations:open-order',
  operationsGetOrder: 'operations:get-order',
  operationsStartOrderWithItem: 'operations:start-order-with-item',
  operationsAddItem: 'operations:add-item',
  operationsRemoveItem: 'operations:remove-item',
  operationsBindVoucher: 'operations:bind-voucher',
  operationsUnbindVoucher: 'operations:unbind-voucher',
  operationsCloseOrder: 'operations:close-order',
  operationsCancelOrder: 'operations:cancel-order',
  vouchersGetState: 'vouchers:get-state',
  vouchersCreate: 'vouchers:create',
  vouchersChangeStatus: 'vouchers:change-status',
  vouchersUpdate: 'vouchers:update',
  vouchersAddBalance: 'vouchers:add-balance',
  vouchersDelete: 'vouchers:delete',
  cashGetState: 'cash:get-state',
  cashOpen: 'cash:open',
  cashRecordMovement: 'cash:record-movement',
  cashClose: 'cash:close',
  expensesGetState: 'expenses:get-state',
  expensesCreate: 'expenses:create',
  expensesUpdate: 'expenses:update',
  expensesUpdatePaymentStatus: 'expenses:update-payment-status',
  expensesCancel: 'expenses:cancel',
  expensesDelete: 'expenses:delete',
  ticketsGetState: 'tickets:get-state',
  ticketsCreateLot: 'tickets:create-lot',
  ticketsUpdateLot: 'tickets:update-lot',
  ticketsDeleteLot: 'tickets:delete-lot',
  ticketsCreateSale: 'tickets:create-sale',
  ticketsCancelSale: 'tickets:cancel-sale',
  ticketsDeleteSale: 'tickets:delete-sale',
} as const;

export const IPC_EVENTS = {
  dataChanged: 'system:data-changed',
} as const;

export const systemInfoSchema = z.object({
  appName: z.literal('GTRZ System'),
  version: z.string().min(1),
  platform: z.enum(['win32', 'linux', 'darwin']),
  databaseReady: z.boolean(),
});

export const userProfileSchema = z.enum(['production', 'cashier']);
export const eventStatusSchema = z.enum(['open', 'closed', 'archived']);

export const eventSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(2).max(100),
  status: eventStatusSchema,
  startsAt: z.number().int().nonnegative(),
  endsAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const eventListSchema = z.array(eventSchema);

export const createEventInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  startsAt: z.number().int().nonnegative(),
});

export const renameEventInputSchema = z.object({
  eventId: z.uuid(),
  name: z.string().trim().min(2).max(100),
});

export const changeEventStatusInputSchema = z.object({
  eventId: z.uuid(),
  status: eventStatusSchema,
});

export const deleteEventInputSchema = z.object({
  eventId: z.uuid(),
  confirmationName: z.string().trim().min(2).max(100),
  reason: z.string().trim().min(3).max(240),
});

export const eventDeletionResultSchema = z.object({
  eventId: z.uuid(),
  eventName: z.string().min(2).max(100),
  deleted: z.literal(true),
  removedOrdersCount: z.number().int().nonnegative(),
  removedOpenOrdersCount: z.number().int().nonnegative(),
  removedExpensesCount: z.number().int().nonnegative(),
  removedVouchersCount: z.number().int().nonnegative(),
  removedTicketSalesCount: z.number().int().nonnegative(),
  removedStockMovementsCount: z.number().int().nonnegative(),
  removedStockTransfersCount: z.number().int().nonnegative(),
});

export const setActiveEventInputSchema = z.object({
  eventId: z.uuid().nullable(),
});

export const sessionStateSchema = z.object({
  profile: userProfileSchema,
  activeEvent: eventSchema.nullable(),
});

export const switchProfileInputSchema = z.object({
  targetProfile: userProfileSchema,
  password: z.string().max(128).optional(),
});

export const changeProductionPasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(6).max(128),
});

export const paymentTerminalSettingsSchema = z.object({
  activeEventId: z.uuid().nullable(),
  debitRateBasisPoints: z.number().int().min(0).max(10_000),
  creditRateBasisPoints: z.number().int().min(0).max(10_000),
});

export const updatePaymentTerminalSettingsInputSchema = z.object({
  debitRateBasisPoints: z.number().int().min(0).max(10_000),
  creditRateBasisPoints: z.number().int().min(0).max(10_000),
});

export const operationResultSchema = z.object({
  success: z.literal(true),
});

export const cloudSyncStatusSchema = z.object({
  connection: z.enum(['connected', 'attention', 'offline']),
  endpoint: z.url(),
  apiReachable: z.boolean(),
  credentialPresent: z.boolean(),
  credentialAccepted: z.boolean(),
  checkedAt: z.number().int().nonnegative(),
  message: z.string().min(1).max(240),
});

export const cloudMonitorDeviceSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  activeEventId: z.uuid().nullable(),
  lastSeenAt: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});

export const cloudMonitorCommandSchema = z.object({
  commandId: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  deviceId: z.string().min(1).max(80),
  action: z.string().min(1).max(160),
  auditId: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number().int().nonnegative(),
});

export const cloudMonitorTransportSchema = z.object({
  sequence: z.number().int().positive(),
  commandId: z.string().min(1).max(160).nullable(),
  eventId: z.string().min(1).max(160),
  deviceId: z.string().min(1).max(80),
  direction: z.enum(['up', 'down']),
  transport: z.enum(['journal', 'websocket']),
  action: z.string().min(1).max(180),
  createdAt: z.number().int().nonnegative(),
});

export const cloudSyncQueueSchema = z.object({
  outboxPending: z.number().int().nonnegative(),
  outboxAccepted: z.number().int().nonnegative(),
  outboxFailed: z.number().int().nonnegative(),
  inboxReceived: z.number().int().nonnegative(),
  inboxAwaitingApply: z.number().int().nonnegative(),
  conflictsOpen: z.number().int().nonnegative(),
});

export const cloudSyncConflictSchema = z.object({
  commandId: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  action: z.string().min(1).max(180),
  entityId: z.string().nullable(),
  reason: z.string().min(1).max(240),
  createdAt: z.number().int().nonnegative(),
});

export const cloudMonitorConflictSchema = z.object({
  sequence: z.number().int().positive(),
  commandId: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  deviceId: z.string().min(1).max(80),
  action: z.string().min(1).max(180),
  entityId: z.string().nullable(),
  reason: z.string().min(1).max(240),
  createdAt: z.number().int().nonnegative(),
});

export const cloudMonitorSchema = z.object({
  endpoint: z.url(),
  checkedAt: z.number().int().nonnegative(),
  activeDevices: z.array(cloudMonitorDeviceSchema),
  recentCommands: z.array(cloudMonitorCommandSchema),
  recentTransport: z.array(cloudMonitorTransportSchema),
  recentConflicts: z.array(cloudMonitorConflictSchema),
  idempotency: z.object({
    acceptedCommands: z.number().int().nonnegative(),
    journalAttempts: z.number().int().nonnegative(),
    replayedAttempts: z.number().int().nonnegative(),
  }),
  localQueue: cloudSyncQueueSchema,
  localConflicts: z.array(cloudSyncConflictSchema),
});

export const backupKindSchema = z.enum(['automatic', 'event-close', 'manual', 'pre-restore']);
export const backupIntegritySchema = z.enum(['valid', 'invalid']);

export const backupRecordSchema = z.object({
  fileName: z.string().min(1),
  filePath: z.string().min(1),
  kind: backupKindSchema,
  createdAt: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  integrity: backupIntegritySchema,
});

export const backupStateSchema = z.object({
  destinationPath: z.string().min(1),
  backups: z.array(backupRecordSchema),
});

export const verifyBackupInputSchema = z.object({
  filePath: z.string().min(1),
});

export const restoreBackupResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({
    status: z.literal('restored'),
    sourceFileName: z.string().min(1),
    restoredAt: z.number().int().nonnegative(),
  }),
]);

export type SystemInfo = z.infer<typeof systemInfoSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type EventStatus = z.infer<typeof eventStatusSchema>;
export type GtrzEvent = z.infer<typeof eventSchema>;
export type CreateEventInput = z.infer<typeof createEventInputSchema>;
export type RenameEventInput = z.infer<typeof renameEventInputSchema>;
export type ChangeEventStatusInput = z.infer<typeof changeEventStatusInputSchema>;
export type DeleteEventInput = z.infer<typeof deleteEventInputSchema>;
export type EventDeletionResult = z.infer<typeof eventDeletionResultSchema>;
export type SetActiveEventInput = z.infer<typeof setActiveEventInputSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type SwitchProfileInput = z.infer<typeof switchProfileInputSchema>;
export type ChangeProductionPasswordInput = z.infer<typeof changeProductionPasswordInputSchema>;
export type PaymentTerminalSettings = z.infer<typeof paymentTerminalSettingsSchema>;
export type UpdatePaymentTerminalSettingsInput = z.infer<
  typeof updatePaymentTerminalSettingsInputSchema
>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type CloudSyncStatus = z.infer<typeof cloudSyncStatusSchema>;
export type CloudMonitor = z.infer<typeof cloudMonitorSchema>;
export type BackupKind = z.infer<typeof backupKindSchema>;
export type BackupRecord = z.infer<typeof backupRecordSchema>;
export type BackupState = z.infer<typeof backupStateSchema>;
export type VerifyBackupInput = z.infer<typeof verifyBackupInputSchema>;
export type RestoreBackupResult = z.infer<typeof restoreBackupResultSchema>;

export interface GtrzDesktopApi {
  readonly system: {
    getInfo(): Promise<SystemInfo>;
  };
  readonly realtime: {
    onDataChanged(listener: () => void): () => void;
  };
  readonly dashboard: DashboardApi;
  readonly audit: AuditApi;
  readonly events: {
    list(): Promise<readonly GtrzEvent[]>;
    create(input: CreateEventInput): Promise<GtrzEvent>;
    rename(input: RenameEventInput): Promise<GtrzEvent>;
    changeStatus(input: ChangeEventStatusInput): Promise<GtrzEvent>;
    delete(input: DeleteEventInput): Promise<EventDeletionResult>;
    setActive(input: SetActiveEventInput): Promise<SessionState>;
  };
  readonly eventClose: EventCloseApi;
  readonly session: {
    getState(): Promise<SessionState>;
    switchProfile(input: SwitchProfileInput): Promise<SessionState>;
  };
  readonly settings: {
    changeProductionPassword(input: ChangeProductionPasswordInput): Promise<OperationResult>;
    getPaymentTerminal(): Promise<PaymentTerminalSettings>;
    updatePaymentTerminal(
      input: UpdatePaymentTerminalSettingsInput,
    ): Promise<PaymentTerminalSettings>;
    getCloudSyncStatus(): Promise<CloudSyncStatus>;
    getCloudMonitor(): Promise<CloudMonitor>;
  };
  readonly printing: PrintingApi;
  readonly backups: {
    getState(): Promise<BackupState>;
    chooseDestination(): Promise<BackupState>;
    createManual(): Promise<BackupRecord>;
    importBackup(): Promise<RestoreBackupResult>;
    verify(input: VerifyBackupInput): Promise<BackupRecord>;
  };
  readonly inventory: InventoryApi;
  readonly combos: ComboApi;
  readonly operations: OperationsApi;
  readonly vouchers: VoucherApi;
  readonly cash: CashApi;
  readonly expenses: ExpenseApi;
  readonly tickets: TicketApi;
}
