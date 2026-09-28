import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-BRD-001 — exibe marca oficial e insights operacionais', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);

    await expect(window.locator('.brand-lockup')).toHaveAttribute('aria-label', 'GTRZ System');
    await expect(window.getByRole('img', { name: 'GTRZ' })).toBeVisible();
    await expect(window.locator('.brand-lockup')).toBeVisible();

    const suffix = String(Date.now());
    const eventName = `Evento insights ${suffix}`;
    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    await expect(window.getByText(eventName, { exact: true }).first()).toBeVisible();

    await window.getByRole('link', { name: 'Visão geral' }).click();
    await expect(window.getByText('Margem projetada', { exact: true })).toBeVisible();
    await expect(window.getByText('Saúde operacional', { exact: true })).toBeVisible();
    await expect(window.getByText('Ocupação dos lotes', { exact: true })).toBeVisible();
    await expect(window.getByRole('progressbar').first()).toBeVisible();

    await window.getByRole('link', { name: 'Auditoria' }).click();
    await expect(window.getByText('Nenhum filtro ativo', { exact: true })).toBeVisible();
    await expect(window.getByRole('option', { name: 'Evento criado' })).toBeAttached();
    await expect(window.getByText('Perfil Produção', { exact: true })).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
