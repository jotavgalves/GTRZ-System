import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';

import { IPC_EVENTS } from '@gtrz/contracts';
import { getSessionState } from '@gtrz/database';
import { getPrintingSettings } from '@gtrz/database/printing';

import { BackupService } from './backup-service';
import { CloudSyncService } from './cloud-sync-service';
import { createMainWindow } from './create-main-window';
import { DatabaseRuntime } from './database-runtime';
import { registerIpcHandlers } from './register-ipc';
import {
  cloudSyncEndpoint,
  environmentLabel,
  getRuntimeEnvironment,
  isVisualQaRun,
} from './runtime-environment';

let mainWindow: BrowserWindow | null = null;
let databaseRuntime: DatabaseRuntime | null = null;
let cloudSyncService: CloudSyncService | null = null;
let mainWindowWasCreated = false;
const runtimeEnvironment = getRuntimeEnvironment();
const visualQaRun = isVisualQaRun();
const cloudSyncEnabledForRuntime = process.env.GTRZ_E2E_DISABLE_CLOUD_SYNC !== '1';

if (visualQaRun) {
  const userDataPath = process.env.GTRZ_E2E_USER_DATA_PATH?.trim();
  app.setPath(
    'userData',
    userDataPath && userDataPath.length > 0
      ? userDataPath
      : path.join(app.getPath('appData'), '@gtrz', 'desktop-visual-qa'),
  );
  const remoteDebuggingPort = process.env.GTRZ_E2E_REMOTE_DEBUGGING_PORT?.trim();
  if (remoteDebuggingPort !== undefined && /^\d{2,5}$/u.test(remoteDebuggingPort)) {
    app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort);
  }
}

if (process.platform === 'win32') {
  app.setAppUserModelId('br.com.gtrz.system');
}

if (runtimeEnvironment === 'test') {
  const isolatedTestDataPath = process.env.GTRZ_E2E_USER_DATA_PATH?.trim();
  app.setPath(
    'userData',
    isolatedTestDataPath && isolatedTestDataPath.length > 0
      ? isolatedTestDataPath
      : path.join(app.getPath('appData'), '@gtrz', 'desktop-test'),
  );
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function requireDatabaseRuntime(): DatabaseRuntime {
  if (databaseRuntime === null) {
    throw new Error('O banco local ainda não foi inicializado.');
  }

  return databaseRuntime;
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    try {
      const userDataPath = app.getPath('userData');
      const isolatedDataRun = runtimeEnvironment === 'test' || visualQaRun;
      const documentsFolder = isolatedDataRun
        ? path.join(userDataPath, 'test-files')
        : path.join(app.getPath('documents'), 'GTRZ System');
      const databasePath = path.join(userDataPath, 'gtrz-system.sqlite');
      databaseRuntime = new DatabaseRuntime(databasePath);
      const backupService = new BackupService({
        appVersion: app.getVersion(),
        defaultDestinationPath: path.join(documentsFolder, 'Backups'),
        settingsPath: path.join(userDataPath, 'backup-settings.json'),
        databaseRuntime,
      });
      cloudSyncService = new CloudSyncService(
        visualQaRun
          ? (process.env.GTRZ_E2E_PAIRING_KEY_PATH?.trim() ??
            path.join(
              app.getPath('documents'),
              'GTRZ System',
              'Nuvem GTRZ - chave de pareamento.txt',
            ))
          : path.join(
              documentsFolder,
              runtimeEnvironment === 'test'
                ? 'Nuvem GTRZ TESTE - chave de pareamento.txt'
                : 'Nuvem GTRZ - chave de pareamento.txt',
            ),
        path.join(userDataPath, 'gtrz-cloud-device-id'),
        () => {
          if (mainWindow !== null && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_EVENTS.dataChanged);
          }
        },
        cloudSyncEndpoint(runtimeEnvironment),
        () =>
          visualQaRun
            ? 'QA visual desktop'
            : getPrintingSettings(requireDatabaseRuntime().get()).machineName,
        databaseRuntime,
        path.join(userDataPath, 'gtrz-cloud-device-credential.json'),
      );

      const printService = registerIpcHandlers({
        getDatabase: () => requireDatabaseRuntime().get(),
        databaseReady: () => requireDatabaseRuntime().isReady(),
        backupService,
        cloudSyncService,
        receiptArchiveDirectory: path.join(documentsFolder, 'Notas'),
        runtimeEnvironment,
      });
      cloudSyncService.setPrintAgent(
        async (job) => {
          const result = await printService.printCloudJob(job);
          return { success: result.success, message: result.message };
        },
        () => printService.getCloudPrinterRegistration(),
      );
      cloudSyncService.setResetBackupAgent(() => backupService.createBackup('pre-event-reset'));
      if (cloudSyncEnabledForRuntime) {
        cloudSyncService.start(
          () => getSessionState(requireDatabaseRuntime().get()).activeEvent?.id ?? null,
        );
        cloudSyncService.startReplication(
          () => requireDatabaseRuntime().get(),
          () => getSessionState(requireDatabaseRuntime().get()).activeEvent?.id ?? null,
        );
      }

      await backupService.createBackup('automatic').catch(() => undefined);
      mainWindowWasCreated = true;
      mainWindow = createMainWindow({
        title: visualQaRun ? 'GTRZ System - QA visual' : environmentLabel(runtimeEnvironment),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Falha desconhecida na inicialização.';
      dialog.showErrorBox(`${environmentLabel(runtimeEnvironment)} não pôde iniciar`, message);
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindowWasCreated = true;
      mainWindow = createMainWindow({ title: environmentLabel(runtimeEnvironment) });
    }
  });

  app.on('before-quit', () => {
    cloudSyncService?.stop();
    databaseRuntime?.close();
    databaseRuntime = null;
  });

  app.on('window-all-closed', () => {
    // Electron can emit this while asynchronous startup is still preparing the
    // first BrowserWindow. Only a window that has actually existed may close the app.
    if (!mainWindowWasCreated) return;
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
