import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const execFileAsync = promisify(execFile);
const applicationPath = path.join(process.cwd(), 'apps', 'desktop');
const cleanupTimeout = 5_000;
const userDataDirectories = new WeakMap<ElectronApplication, string>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function terminateProcessTree(processId: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(processId), '/T', '/F']);
      return;
    }

    process.kill(processId, 'SIGKILL');
  } catch {
    // O processo pode ter encerrado entre a verificação e a tentativa de finalização.
  }
}

export async function launchElectronApplication(): Promise<ElectronApplication> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'gtrz-e2e-'));

    try {
      const application = await electron.launch({
        args: [`--user-data-dir=${userDataPath}`, applicationPath],
        env: {
          ...process.env,
          GTRZ_E2E_USER_DATA_PATH: userDataPath,
          GTRZ_E2E_DISABLE_CLOUD_SYNC: '1',
        },
      });
      userDataDirectories.set(application, userDataPath);
      return application;
    } catch (error: unknown) {
      lastError = error;
      await rm(userDataPath, { force: true, recursive: true }).catch(() => undefined);

      if (attempt < 3) {
        await delay(1_000 * attempt);
      }
    }
  }

  throw lastError;
}

export async function closeElectronApplication(application: ElectronApplication): Promise<void> {
  const childProcess = application.process();
  const processId = childProcess.pid;
  const userDataPath = userDataDirectories.get(application);
  let exited = childProcess.exitCode !== null;
  const exitPromise = new Promise<void>((resolve) => {
    if (exited) {
      resolve();
      return;
    }

    childProcess.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  await Promise.race([application.close().catch(() => undefined), delay(cleanupTimeout)]);

  if (!exited && processId !== undefined) {
    await terminateProcessTree(processId);
  }

  await Promise.race([exitPromise, delay(cleanupTimeout)]);
  await delay(300);

  if (userDataPath !== undefined) {
    await rm(userDataPath, { force: true, recursive: true }).catch(() => undefined);
    userDataDirectories.delete(application);
  }
}

export async function ensureProduction(window: Page): Promise<void> {
  if (await window.getByText('Caixa', { exact: true }).isVisible()) {
    await window.getByPlaceholder('Digite a senha').fill('121225');
    await window.getByRole('button', { name: 'Entrar em Produção' }).click();
    await expect(window.getByText('Produção', { exact: true })).toBeVisible();
  }
}

export async function createInventoryCategory(window: Page, name: string): Promise<void> {
  await window.getByRole('link', { name: 'Configurações' }).click();
  await window.getByPlaceholder('Ex.: Cervejas').fill(name);
  await window.getByRole('button', { name: 'Criar categoria' }).click();
  await expect(window.locator('.category-manager').getByText(name, { exact: true })).toBeVisible();
  await window.getByRole('link', { name: 'Estoque' }).click();
}

export async function activateEvent(window: Page, name: string): Promise<void> {
  const eventCard = window.locator('article.event-card').filter({ hasText: name });
  await expect(eventCard).toBeVisible();
  const operateButton = eventCard.getByRole('button', { name: 'Operar evento' });
  if (await operateButton.isVisible()) await operateButton.click();
  await expect(eventCard.getByText('Em operação', { exact: true })).toBeVisible();
}
