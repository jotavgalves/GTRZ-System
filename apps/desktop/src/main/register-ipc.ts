import { app, ipcMain } from 'electron';

import {
  backupRecordSchema,
  backupStateSchema,
  changeEventStatusInputSchema,
  changeProductionPasswordInputSchema,
  cloudSyncStatusSchema,
  cloudMonitorSchema,
  createEventInputSchema,
  createMobileOperatorInputSchema,
  deleteMobileOperatorInputSchema,
  deleteEventInputSchema,
  endMobileOperatorSessionsInputSchema,
  eventDeletionResultSchema,
  eventListSchema,
  eventSchema,
  IPC_CHANNELS,
  operationResultSchema,
  paymentTerminalSettingsSchema,
  renameEventInputSchema,
  restoreBackupResultSchema,
  sessionStateSchema,
  setActiveEventInputSchema,
  switchProfileInputSchema,
  switchRuntimeEnvironmentInputSchema,
  systemInfoSchema,
  updatePaymentTerminalSettingsInputSchema,
  updateMobileOperatorInputSchema,
  verifyBackupInputSchema,
  type SystemInfo,
} from '@gtrz/contracts';
import {
  changeEventStatus,
  changeProductionPassword,
  createEvent,
  deleteEventPermanently,
  getSessionState,
  listEvents,
  renameEvent,
  setActiveEvent,
  switchProfile,
  type DatabaseContext,
} from '@gtrz/database';
import {
  getPaymentTerminalSettings,
  updatePaymentTerminalSettings,
} from '@gtrz/database/payment-terminal';

import type { BackupService } from './backup-service';
import type { CloudSyncService } from './cloud-sync-service';
import type { RuntimeEnvironment } from './runtime-environment';
import { registerComboIpcHandlers } from './register-combo-ipc';
import { registerEventCloseIpcHandlers } from './register-event-close-ipc';
import { registerFoodIpcHandlers } from './register-food-ipc';
import { registerFinanceIpcHandlers } from './register-finance-ipc';
import { registerInsightsIpcHandlers } from './register-insights-ipc';
import { registerInventoryIpcHandlers } from './register-inventory-ipc';
import { registerOperationsIpcHandlers } from './register-operations-ipc';
import { registerPrintingIpcHandlers } from './register-printing-ipc';
import { registerTicketIpcHandlers } from './register-ticket-ipc';
import { registerVoucherIpcHandlers } from './register-voucher-ipc';
import { ThermalPrintService } from './thermal-print-service';

interface RegisterIpcOptions {
  readonly receiptArchiveDirectory: string;
  readonly getDatabase: () => DatabaseContext;
  readonly databaseReady: () => boolean;
  readonly backupService: BackupService;
  readonly cloudSyncService: CloudSyncService;
  readonly runtimeEnvironment: RuntimeEnvironment;
}

const CONTROL_CHANNELS = [
  IPC_CHANNELS.systemGetInfo,
  IPC_CHANNELS.systemSwitchEnvironment,
  IPC_CHANNELS.eventsList,
  IPC_CHANNELS.eventsCreate,
  IPC_CHANNELS.eventsRename,
  IPC_CHANNELS.eventsChangeStatus,
  IPC_CHANNELS.eventsDelete,
  IPC_CHANNELS.eventsSetActive,
  IPC_CHANNELS.sessionGetState,
  IPC_CHANNELS.sessionSwitchProfile,
  IPC_CHANNELS.settingsChangeProductionPassword,
  IPC_CHANNELS.settingsGetPaymentTerminal,
  IPC_CHANNELS.settingsUpdatePaymentTerminal,
  IPC_CHANNELS.settingsGetCloudSyncStatus,
  IPC_CHANNELS.settingsGetCloudMonitor,
  IPC_CHANNELS.settingsListMobileOperators,
  IPC_CHANNELS.settingsCreateMobileOperator,
  IPC_CHANNELS.settingsUpdateMobileOperator,
  IPC_CHANNELS.settingsEndMobileOperatorSessions,
  IPC_CHANNELS.settingsDeleteMobileOperator,
  IPC_CHANNELS.backupsGetState,
  IPC_CHANNELS.backupsChooseDestination,
  IPC_CHANNELS.backupsCreateManual,
  IPC_CHANNELS.backupsImport,
  IPC_CHANNELS.backupsVerify,
] as const;

export function registerIpcHandlers(options: RegisterIpcOptions): void {
  for (const channel of CONTROL_CHANNELS) {
    ipcMain.removeHandler(channel);
  }

  const printService = new ThermalPrintService({
    archiveDirectory: options.receiptArchiveDirectory,
    getDatabase: options.getDatabase,
  });
  registerFoodIpcHandlers({ getDatabase: options.getDatabase });

  ipcMain.handle(IPC_CHANNELS.systemGetInfo, (): SystemInfo => {
    return systemInfoSchema.parse({
      appName: 'GTRZ System',
      version: app.getVersion(),
      platform: process.platform,
      databaseReady: options.databaseReady(),
      environment: options.runtimeEnvironment,
    });
  });

  ipcMain.handle(IPC_CHANNELS.systemSwitchEnvironment, (_event, payload: unknown): void => {
    const input = switchRuntimeEnvironmentInputSchema.parse(payload);
    if (input.environment === options.runtimeEnvironment) return;

    app.relaunch({
      args: input.environment === 'test' ? ['--gtrz-environment=test'] : [],
    });
    app.quit();
  });

  ipcMain.handle(IPC_CHANNELS.eventsList, () => {
    return eventListSchema.parse(listEvents(options.getDatabase()));
  });

  ipcMain.handle(IPC_CHANNELS.eventsCreate, (_event, payload: unknown) => {
    const input = createEventInputSchema.parse(payload);
    return eventSchema.parse(createEvent(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.eventsRename, (_event, payload: unknown) => {
    const input = renameEventInputSchema.parse(payload);
    return eventSchema.parse(renameEvent(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.eventsChangeStatus, (_event, payload: unknown) => {
    const input = changeEventStatusInputSchema.parse(payload);
    const database = options.getDatabase();
    const current = listEvents(database).find((event) => event.id === input.eventId);

    if (current?.status === 'open' && input.status === 'closed') {
      throw new Error(
        'Use o encerramento integrado para conciliar o caixa e gerar o backup final.',
      );
    }

    return eventSchema.parse(changeEventStatus(database, input));
  });

  ipcMain.handle(IPC_CHANNELS.eventsDelete, (_event, payload: unknown) => {
    const input = deleteEventInputSchema.parse(payload);
    return eventDeletionResultSchema.parse(deleteEventPermanently(options.getDatabase(), input));
  });

  ipcMain.handle(IPC_CHANNELS.eventsSetActive, (_event, payload: unknown) => {
    const input = setActiveEventInputSchema.parse(payload);
    return sessionStateSchema.parse(setActiveEvent(options.getDatabase(), input.eventId));
  });

  ipcMain.handle(IPC_CHANNELS.sessionGetState, () => {
    return sessionStateSchema.parse(getSessionState(options.getDatabase()));
  });

  ipcMain.handle(IPC_CHANNELS.sessionSwitchProfile, (_event, payload: unknown) => {
    const input = switchProfileInputSchema.parse(payload);
    return sessionStateSchema.parse(
      switchProfile(options.getDatabase(), input.targetProfile, input.password),
    );
  });

  ipcMain.handle(IPC_CHANNELS.settingsChangeProductionPassword, (_event, payload: unknown) => {
    const input = changeProductionPasswordInputSchema.parse(payload);
    changeProductionPassword(options.getDatabase(), input.currentPassword, input.newPassword);
    return operationResultSchema.parse({ success: true });
  });

  ipcMain.handle(IPC_CHANNELS.settingsGetPaymentTerminal, () => {
    return paymentTerminalSettingsSchema.parse(getPaymentTerminalSettings(options.getDatabase()));
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdatePaymentTerminal, (_event, payload: unknown) => {
    const input = updatePaymentTerminalSettingsInputSchema.parse(payload);
    return paymentTerminalSettingsSchema.parse(
      updatePaymentTerminalSettings(options.getDatabase(), input),
    );
  });

  ipcMain.handle(IPC_CHANNELS.settingsGetCloudSyncStatus, async () => {
    return cloudSyncStatusSchema.parse(await options.cloudSyncService.getStatus());
  });

  ipcMain.handle(IPC_CHANNELS.settingsGetCloudMonitor, async () => {
    const database = options.getDatabase();
    const activeEventId = getSessionState(database).activeEvent?.id ?? null;
    const monitor = await options.cloudSyncService.getMonitor(activeEventId);
    return cloudMonitorSchema.parse({
      ...monitor,
      localQueue: options.cloudSyncService.getQueueState(database),
      localConflicts: options.cloudSyncService.getConflicts(database),
    });
  });

  ipcMain.handle(IPC_CHANNELS.settingsListMobileOperators, async () =>
    options.cloudSyncService.listMobileOperators(),
  );

  ipcMain.handle(IPC_CHANNELS.settingsCreateMobileOperator, async (_event, payload: unknown) =>
    options.cloudSyncService.createMobileOperator(createMobileOperatorInputSchema.parse(payload)),
  );

  ipcMain.handle(IPC_CHANNELS.settingsUpdateMobileOperator, async (_event, payload: unknown) =>
    options.cloudSyncService.updateMobileOperator(updateMobileOperatorInputSchema.parse(payload)),
  );

  ipcMain.handle(
    IPC_CHANNELS.settingsEndMobileOperatorSessions,
    async (_event, payload: unknown) => {
      await options.cloudSyncService.endMobileOperatorSessions(
        endMobileOperatorSessionsInputSchema.parse(payload),
      );
      return operationResultSchema.parse({ success: true });
    },
  );

  ipcMain.handle(IPC_CHANNELS.settingsDeleteMobileOperator, async (_event, payload: unknown) => {
    await options.cloudSyncService.deleteMobileOperator(
      deleteMobileOperatorInputSchema.parse(payload),
    );
    return operationResultSchema.parse({ success: true });
  });

  ipcMain.handle(IPC_CHANNELS.backupsGetState, async () => {
    return backupStateSchema.parse(await options.backupService.getState());
  });

  ipcMain.handle(IPC_CHANNELS.backupsChooseDestination, async () => {
    return backupStateSchema.parse(await options.backupService.chooseDestination());
  });

  ipcMain.handle(IPC_CHANNELS.backupsCreateManual, async () => {
    return backupRecordSchema.parse(await options.backupService.createBackup('manual'));
  });

  ipcMain.handle(IPC_CHANNELS.backupsImport, async () => {
    return restoreBackupResultSchema.parse(await options.backupService.importBackup());
  });

  ipcMain.handle(IPC_CHANNELS.backupsVerify, async (_event, payload: unknown) => {
    const input = verifyBackupInputSchema.parse(payload);
    return backupRecordSchema.parse(await options.backupService.verify(input.filePath));
  });

  registerInsightsIpcHandlers({ getDatabase: options.getDatabase });
  registerInventoryIpcHandlers({ getDatabase: options.getDatabase });
  registerComboIpcHandlers({ getDatabase: options.getDatabase });
  registerEventCloseIpcHandlers({
    getDatabase: options.getDatabase,
    backupService: options.backupService,
  });
  registerFinanceIpcHandlers({ getDatabase: options.getDatabase });
  registerPrintingIpcHandlers({ printService });
  registerOperationsIpcHandlers({
    getDatabase: options.getDatabase,
    printAfterSale: (orderId) => printService.printAfterSale(orderId),
  });
  registerTicketIpcHandlers({ getDatabase: options.getDatabase });
  registerVoucherIpcHandlers({ getDatabase: options.getDatabase });
}
