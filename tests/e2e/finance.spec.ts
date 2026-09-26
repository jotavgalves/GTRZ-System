import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  activateEvent,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-FIN-001 — concilia despesa, suprimento e diferença de caixa', async () => {
  test.setTimeout(60_000);
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const eventName = `Evento financeiro ${suffix}`;

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    await expect(window.getByText(eventName, { exact: true }).first()).toBeVisible();
    await activateEvent(window, eventName);

    await window.getByRole('link', { name: 'Caixa' }).click();
    await expect(window.getByRole('heading', { name: 'Caixa administrativo' })).toBeVisible();
    await window.getByLabel('Saldo de abertura').fill('100.00');
    await window.getByRole('button', { name: 'Abrir caixa' }).click();
    await expect(window.getByText('Caixa aberto.')).toBeVisible();
    await expect(window.getByText('R$ 100,00', { exact: true }).first()).toBeVisible();

    await window.getByRole('link', { name: 'Despesas' }).click();
    await window.getByPlaceholder('Ex.: Estrutura').fill('Operação');
    await window.getByPlaceholder('Ex.: Locação de gerador').fill('Compra de gelo');
    await window.getByPlaceholder('0,00').fill('20.00');
    await window.getByLabel('Forma prevista').selectOption('cash');
    await window.getByRole('button', { name: 'Registrar despesa' }).click();
    await expect(window.getByText('Despesa registrada.')).toBeVisible();
    await expect(window.getByText('R$ 20,00', { exact: true }).first()).toBeVisible();

    const expenseCard = window
      .locator('article.expense-card')
      .filter({ hasText: 'Compra de gelo' });
    await expenseCard.getByRole('button', { name: 'Gerenciar', exact: true }).click();
    await expenseCard.getByLabel('Pagamento real').fill('20.00');
    await expenseCard.getByLabel('Por').selectOption('cash');
    await expenseCard.getByRole('button', { name: 'Registrar pagamento' }).click();
    await expect(window.getByText('Pagamento registrado no livro financeiro.')).toBeVisible();

    await window.getByRole('link', { name: 'Caixa' }).click();
    await expect(window.getByText('R$ 80,00', { exact: true }).first()).toBeVisible();
    const movementForm = window.locator('form.finance-movement-form');
    await movementForm.getByLabel('Tipo').selectOption('supply');
    await movementForm.getByLabel('Valor', { exact: true }).fill('10.00');
    await movementForm.getByPlaceholder('Ex.: reforço de troco').fill('Troco adicional');
    await movementForm.getByRole('button', { name: 'Registrar' }).click();
    await expect(window.getByText('Suprimento registrado.')).toBeVisible();
    await expect(window.getByText('R$ 90,00', { exact: true }).first()).toBeVisible();

    await window.getByLabel('Dinheiro contado').fill('85.00');
    await window.getByRole('button', { name: 'Fechar caixa' }).click();
    await expect(window.getByText('Caixa fechado.')).toBeVisible();
    await expect(window.getByText('Caixa encerrado')).toBeVisible();
    await expect(window.getByText('-R$ 5,00', { exact: true })).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
