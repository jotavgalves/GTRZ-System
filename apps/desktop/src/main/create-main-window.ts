import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mainDirectory = path.dirname(fileURLToPath(import.meta.url));

function getWindowIconPath(): string {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';

  return app.isPackaged
    ? path.join(process.resourcesPath, iconName)
    : path.join(mainDirectory, '../../resources', iconName);
}

interface CreateMainWindowOptions {
  readonly title?: string;
}

export function createMainWindow({
  title = 'GTRZ System',
}: CreateMainWindowOptions = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    title,
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(mainDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;

  if (developmentUrl !== undefined) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadFile(path.join(mainDirectory, '../renderer/index.html'));
  }

  return window;
}
