import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-PRT-001 — salva impressão automática e largura térmica', async () => {
  test.setTimeout(60_000);
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);

    await window.getByRole('link', { name: 'Configurações' }).click();
    await expect(window.getByRole('heading', { name: 'Saída das notas' })).toBeVisible();
    await expect(window.getByLabel('Destino das notas')).toBeVisible();
    await expect(window.getByLabel('Destino das notas').locator('option').first()).toHaveText(
      'Padrão do Windows',
    );

    const automatic = window.getByLabel('Enviar notas automaticamente após concluir a venda');
    const saveButton = window.getByRole('button', { name: 'Salvar saída das notas' });
    await expect(automatic).toBeEnabled();
    await expect(saveButton).toBeEnabled();
    await automatic.check();
    await expect(automatic).toBeChecked();
    await window.getByLabel('Largura da bobina').selectOption('58');
    await saveButton.click();
    await expect(window.getByText('Configuração de saída das notas salva.')).toBeVisible();

    await window.getByRole('link', { name: 'Visão geral' }).click();
    await window.getByRole('link', { name: 'Configurações' }).click();
    await expect(window.getByRole('heading', { name: 'Saída das notas' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Salvar saída das notas' })).toBeEnabled();
    await expect(
      window.getByLabel('Enviar notas automaticamente após concluir a venda'),
    ).toBeChecked();
    await expect(window.getByLabel('Largura da bobina')).toHaveValue('58');
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
