import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-FIN-002 — exclui despesa definitivamente e atualiza totais', async () => {
  test.setTimeout(60_000);
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const eventName = `Evento despesa exclusão ${suffix}`;
    const description = `Despesa errada ${suffix.slice(-6)}`;

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    const eventCard = window.locator('article.event-card').filter({ hasText: eventName });
    await expect(eventCard).toBeVisible();
    const operateButton = eventCard.getByRole('button', { name: 'Operar evento' });
    if (await operateButton.isVisible()) {
      await operateButton.click();
      await expect(eventCard.getByText('Em operação')).toBeVisible();
    }

    await window.getByRole('link', { name: 'Despesas' }).click();
    await window.getByPlaceholder('Ex.: Estrutura').fill('Operação');
    await window.getByPlaceholder('Ex.: Locação de gerador').fill(description);
    await window.getByPlaceholder('0,00').fill('25.00');
    await window.getByLabel('Forma prevista').selectOption('pix');
    await window.getByRole('button', { name: 'Registrar despesa' }).click();
    await expect(window.getByText('Despesa registrada.')).toBeVisible();

    const expenseCard = window.locator('article.expense-card').filter({ hasText: description });
    await expect(expenseCard).toContainText('R$ 25,00');
    await expenseCard.getByRole('button', { name: 'Gerenciar', exact: true }).click();
    await expenseCard.getByPlaceholder('Ex.: lançamento duplicado').fill('Lançamento incorreto');
    await expenseCard.getByRole('button', { name: 'Excluir definitivamente' }).click();

    await expect(window.getByText('Despesa excluída definitivamente.')).toBeVisible();
    await expect(expenseCard).toHaveCount(0);
    await expect(window.getByText('R$ 0,00', { exact: true }).first()).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});

test('SMK-FIN-003 — situação da despesa não altera o resultado', async () => {
  test.setTimeout(60_000);
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const eventName = `Evento situação despesa ${suffix}`;
    const description = `Locação ${suffix.slice(-6)}`;

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    const eventCard = window.locator('article.event-card').filter({ hasText: eventName });
    await expect(eventCard).toBeVisible();
    const operateButton = eventCard.getByRole('button', { name: 'Operar evento' });
    if (await operateButton.isVisible()) {
      await operateButton.click();
      await expect(eventCard.getByText('Em operação')).toBeVisible();
    }

    await window.getByRole('link', { name: 'Despesas' }).click();
    await window.getByPlaceholder('Ex.: Estrutura').fill('Estrutura');
    await window.getByPlaceholder('Ex.: Locação de gerador').fill(description);
    await window.getByPlaceholder('0,00').fill('25.00');
    await window.getByLabel('Forma prevista').selectOption('pix');
    await window.getByRole('button', { name: 'Registrar despesa' }).click();
    await expect(window.getByText('Despesa registrada.')).toBeVisible();

    const expenseCard = window.locator('article.expense-card').filter({ hasText: description });
    const paymentBadge = expenseCard.locator('span.status-badge').first();
    await expect(paymentBadge).toHaveText('Em aberto');

    await window.getByRole('link', { name: 'Caixa' }).click();
    const projectedResult = window.locator('article.summary-card').filter({
      hasText: 'Resultado projetado',
    });
    await expect(projectedResult).toContainText('-R$ 25,00');

    await window.getByRole('link', { name: 'Despesas' }).click();
    await expenseCard.getByRole('button', { name: 'Gerenciar', exact: true }).click();
    await expenseCard.getByLabel('Pagamento real').fill('10.00');
    await expenseCard.getByRole('button', { name: 'Registrar pagamento' }).click();
    await expect(window.getByText('Pagamento registrado no livro financeiro.')).toBeVisible();
    await expect(paymentBadge).toHaveText('Parcial');

    await window.getByRole('link', { name: 'Caixa' }).click();
    await expect(projectedResult).toContainText('-R$ 25,00');

    await window.getByRole('link', { name: 'Despesas' }).click();
    await expenseCard.getByRole('button', { name: 'Gerenciar', exact: true }).click();
    await expenseCard.getByLabel('Pagamento real').fill('15.00');
    await expenseCard.getByRole('button', { name: 'Registrar pagamento' }).click();
    await expect(window.getByText('Pagamento registrado no livro financeiro.')).toBeVisible();
    await expect(paymentBadge).toHaveText('Paga');

    await window.getByRole('link', { name: 'Caixa' }).click();
    await expect(projectedResult).toContainText('-R$ 25,00');
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
