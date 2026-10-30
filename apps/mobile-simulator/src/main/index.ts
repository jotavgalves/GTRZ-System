import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';

const DEFAULT_CASHIER_URL = 'https://gtrz-sync.jvgacontato.workers.dev/cashier';
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; GTRZ System Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0 Mobile Safari/537.36';
const visualQaRun = process.argv.includes('--gtrz-visual-qa');

if (visualQaRun) {
  const userDataPath = process.env.GTRZ_E2E_MOBILE_USER_DATA_PATH?.trim();
  if (userDataPath) app.setPath('userData', userDataPath);
}

const remoteDebuggingPort = process.env.GTRZ_E2E_REMOTE_DEBUGGING_PORT?.trim();
if (remoteDebuggingPort !== undefined && /^\d{2,5}$/u.test(remoteDebuggingPort)) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort);
}

let mainWindow: BrowserWindow | null = null;

function cashierUrl(): string {
  const configured = process.env.GTRZ_MOBILE_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_CASHIER_URL;
}

function windowIcon(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(app.getAppPath(), '..', 'desktop', 'resources', 'icon.ico');
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'GTRZ System Mobile',
    width: 430,
    height: 900,
    minWidth: 320,
    minHeight: 568,
    useContentSize: true,
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:gtrz-system-mobile',
    },
  });

  window.webContents.setUserAgent(MOBILE_USER_AGENT);
  void window.webContents.setVisualZoomLevelLimits(1, 1);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void window.loadURL(cashierUrl());
  return window;
}

if (process.platform === 'win32') {
  app.setAppUserModelId('br.com.gtrz.system.mobile');
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  void app.whenReady().then(() => {
    mainWindow = createMainWindow();
  });

  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
