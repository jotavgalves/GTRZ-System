import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  createInventoryCategory,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-EVT-001 — exclui definitivamente evento com comanda aberta', async () => {
  test.setTimeout(90_000);
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const eventName = `Evento exclusão ${suffix}`;
    const categoryName = `Categoria ${suffix}`;
    const productName = `Produto ${suffix}`;
    const tableName = `Mesa ${suffix.slice(-5)}`;

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

    await window.getByRole('link', { name: 'Estoque' }).click();
    await createInventoryCategory(window, categoryName);
    const productForm = window.locator('form.product-form');
    await productForm.getByLabel('Nome', { exact: true }).fill(productName);
    await productForm.getByRole('combobox').first().selectOption({ label: categoryName });
    await productForm.getByLabel('Preço de custo', { exact: true }).fill('3.00');
    await productForm.getByLabel('Preço de venda', { exact: true }).fill('10.00');
    await productForm.getByLabel('Aviso de estoque baixo', { exact: true }).fill('1');
    await productForm.getByRole('button', { name: 'Cadastrar produto' }).click();

    const productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await productCard.getByRole('button', { name: 'Entrada', exact: true }).click();
    const movementForm = window.locator('form.movement-form');
    await movementForm.getByLabel('Quantidade', { exact: true }).fill('5');
    await movementForm.getByLabel('Valor total pago').fill('15.00');
    await movementForm.getByRole('button', { name: 'Registrar entrada' }).click();

    await window.getByRole('link', { name: 'Despesas' }).click();
    await window.getByPlaceholder('Ex.: Estrutura').fill('Operação');
    await window.getByPlaceholder('Ex.: Locação de gerador').fill('Despesa a excluir com evento');
    await window.getByPlaceholder('0,00').fill('15.00');
    await window.getByRole('button', { name: 'Registrar despesa' }).click();
    await expect(window.getByText('Despesa registrada.')).toBeVisible();

    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    await window.getByPlaceholder('Ex.: Mesa 12').fill(tableName);
    await window.getByRole('button', { name: 'Criar mesa' }).click();
    const tableButton = window.getByRole('button', { name: new RegExp(tableName, 'u') });
    await tableButton.click();
    const catalogItem = window.getByRole('button', { name: new RegExp(productName, 'u') });
    await catalogItem.click();
    await expect(window.getByText(productName, { exact: true }).last()).toBeVisible();

    await window.getByRole('link', { name: 'Eventos' }).click();
    await eventCard.getByRole('button', { name: 'Excluir definitivamente' }).click();
    const deletionPanel = window.locator('.event-close-panel');
    await expect(deletionPanel.getByRole('heading', { name: eventName })).toBeVisible();
    await deletionPanel
      .getByPlaceholder('Ex.: evento criado por engano')
      .fill('Evento criado para teste');
    await deletionPanel.getByPlaceholder(eventName).fill(eventName);
    await deletionPanel.getByRole('button', { name: 'Excluir evento definitivamente' }).click();

    await expect(eventCard).toHaveCount(0);
    await expect(window.getByText('Nenhum', { exact: true })).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
