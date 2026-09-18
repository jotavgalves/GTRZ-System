import { contextBridge, ipcRenderer } from 'electron';

import {
  backupRecordSchema,
  backupStateSchema,
  changeEventStatusInputSchema,
  changeProductionPasswordInputSchema,
  cloudSyncStatusSchema,
  cloudMonitorSchema,
  createEventInputSchema,
  deleteEventInputSchema,
  eventDeletionResultSchema,
  eventListSchema,
  eventSchema,
  IPC_EVENTS,
  IPC_CHANNELS,
  operationResultSchema,
  paymentTerminalSettingsSchema,
  renameEventInputSchema,
  restoreBackupResultSchema,
  sessionStateSchema,
  setActiveEventInputSchema,
  switchProfileInputSchema,
  systemInfoSchema,
  updatePaymentTerminalSettingsInputSchema,
  verifyBackupInputSchema,
  type BackupRecord,
  type BackupState,
  type ChangeEventStatusInput,
  type ChangeProductionPasswordInput,
  type CloudSyncStatus,
  type CloudMonitor,
  type CreateEventInput,
  type DeleteEventInput,
  type EventDeletionResult,
  type GtrzDesktopApi,
  type GtrzEvent,
  type OperationResult,
  type PaymentTerminalSettings,
  type RenameEventInput,
  type RestoreBackupResult,
  type SessionState,
  type SetActiveEventInput,
  type SwitchProfileInput,
  type SystemInfo,
  type UpdatePaymentTerminalSettingsInput,
  type VerifyBackupInput,
} from '@gtrz/contracts';

import { comboApi } from './combo-api';
import { eventCloseApi } from './event-close-api';
import { capitalApi, cashApi, expenseApi } from './finance-api';
import { auditApi, dashboardApi } from './insights-api';
import { inventoryApi } from './inventory-api';
import { operationsApi } from './operations-api';
import { printingApi } from './printing-api';
import { ticketApi } from './ticket-api';
import { foodApi } from './food-api';
import { voucherApi } from './voucher-api';

const api: GtrzDesktopApi = {
  system: {
    async getInfo(): Promise<SystemInfo> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.systemGetInfo);
      return systemInfoSchema.parse(payload);
    },
  },
  realtime: {
    onDataChanged(listener: () => void): () => void {
      const handler = (): void => {
        listener();
      };
      ipcRenderer.on(IPC_EVENTS.dataChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC_EVENTS.dataChanged, handler);
      };
    },
  },
  dashboard: dashboardApi,
  audit: auditApi,
  events: {
    async list(): Promise<readonly GtrzEvent[]> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.eventsList);
      return eventListSchema.parse(payload);
    },
    async create(input: CreateEventInput): Promise<GtrzEvent> {
      const parsedInput = createEventInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.eventsCreate, parsedInput);
      return eventSchema.parse(payload);
    },
    async rename(input: RenameEventInput): Promise<GtrzEvent> {
      const parsedInput = renameEventInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.eventsRename, parsedInput);
      return eventSchema.parse(payload);
    },
    async changeStatus(input: ChangeEventStatusInput): Promise<GtrzEvent> {
      const parsedInput = changeEventStatusInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.eventsChangeStatus,
        parsedInput,
      );
      return eventSchema.parse(payload);
    },
    async delete(input: DeleteEventInput): Promise<EventDeletionResult> {
      const parsedInput = deleteEventInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.eventsDelete, parsedInput);
      return eventDeletionResultSchema.parse(payload);
    },
    async setActive(input: SetActiveEventInput): Promise<SessionState> {
      const parsedInput = setActiveEventInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.eventsSetActive, parsedInput);
      return sessionStateSchema.parse(payload);
    },
  },
  eventClose: eventCloseApi,
  session: {
    async getState(): Promise<SessionState> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.sessionGetState);
      return sessionStateSchema.parse(payload);
    },
    async switchProfile(input: SwitchProfileInput): Promise<SessionState> {
      const parsedInput = switchProfileInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.sessionSwitchProfile,
        parsedInput,
      );
      return sessionStateSchema.parse(payload);
    },
  },
  settings: {
    async changeProductionPassword(input: ChangeProductionPasswordInput): Promise<OperationResult> {
      const parsedInput = changeProductionPasswordInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.settingsChangeProductionPassword,
        parsedInput,
      );
      return operationResultSchema.parse(payload);
    },
    async getPaymentTerminal(): Promise<PaymentTerminalSettings> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.settingsGetPaymentTerminal);
      return paymentTerminalSettingsSchema.parse(payload);
    },
    async updatePaymentTerminal(
      input: UpdatePaymentTerminalSettingsInput,
    ): Promise<PaymentTerminalSettings> {
      const parsedInput = updatePaymentTerminalSettingsInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.settingsUpdatePaymentTerminal,
        parsedInput,
      );
      return paymentTerminalSettingsSchema.parse(payload);
    },
    async getCloudSyncStatus(): Promise<CloudSyncStatus> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.settingsGetCloudSyncStatus);
      return cloudSyncStatusSchema.parse(payload);
    },
    async getCloudMonitor(): Promise<CloudMonitor> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.settingsGetCloudMonitor);
      return cloudMonitorSchema.parse(payload);
    },
  },
  printing: printingApi,
  backups: {
    async getState(): Promise<BackupState> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.backupsGetState);
      return backupStateSchema.parse(payload);
    },
    async chooseDestination(): Promise<BackupState> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.backupsChooseDestination);
      return backupStateSchema.parse(payload);
    },
    async createManual(): Promise<BackupRecord> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.backupsCreateManual);
      return backupRecordSchema.parse(payload);
    },
    async importBackup(): Promise<RestoreBackupResult> {
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.backupsImport);
      return restoreBackupResultSchema.parse(payload);
    },
    async verify(input: VerifyBackupInput): Promise<BackupRecord> {
      const parsedInput = verifyBackupInputSchema.parse(input);
      const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.backupsVerify, parsedInput);
      return backupRecordSchema.parse(payload);
    },
  },
  inventory: inventoryApi,
  combos: comboApi,
  operations: operationsApi,
  vouchers: voucherApi,
  cash: cashApi,
  expenses: expenseApi,
  capital: capitalApi,
  food: foodApi,
  tickets: ticketApi,
};

contextBridge.exposeInMainWorld('gtrz', api);
