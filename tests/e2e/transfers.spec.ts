import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  createInventoryCategory,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-TRF-001 — transfere estoque entre eventos e exibe o histórico', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const sourceEventName = `Origem transferência ${suffix}`;
    const destinationEventName = `Destino transferência ${suffix}`;
    const categoryName = `Transferíveis ${suffix}`;
    const productName = `Água transferência ${suffix}`;

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(sourceEventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    const sourceEventCard = window
      .locator('article.event-card')
      .filter({ hasText: sourceEventName });
    await expect(sourceEventCard).toBeVisible();
    await sourceEventCard.getByRole('button', { name: 'Operar evento' }).click();
    await expect(sourceEventCard.getByText('Em operação', { exact: true })).toBeVisible();

    await window.getByRole('link', { name: 'Estoque' }).click();
    await createInventoryCategory(window, categoryName);

    const productForm = window.locator('form.product-form');
    await productForm.getByLabel('Nome', { exact: true }).fill(productName);
    await productForm.getByRole('combobox').first().selectOption({ label: categoryName });
    await productForm.getByLabel('Preço de custo', { exact: true }).fill('2.00');
    await productForm.getByLabel('Preço de venda', { exact: true }).fill('5.00');
    await productForm.getByLabel('Aviso de estoque baixo', { exact: true }).fill('2');
    await productForm.getByRole('button', { name: 'Cadastrar produto' }).click();

    let productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await productCard.getByRole('button', { name: 'Entrada', exact: true }).click();
    const movementForm = window.locator('form.movement-form');
    await movementForm.getByLabel('Quantidade', { exact: true }).fill('8');
    await movementForm.getByLabel('Valor total pago').fill('16.00');
    await movementForm.getByRole('button', { name: 'Registrar entrada' }).click();
    productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await expect(productCard.getByText('8 un.', { exact: true })).toBeVisible();

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(destinationEventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    const destinationEventCard = window
      .locator('article.event-card')
      .filter({ hasText: destinationEventName });
    await expect(destinationEventCard).toBeVisible();
    await destinationEventCard.getByRole('button', { name: 'Operar evento' }).click();
    await expect(destinationEventCard.getByText('Em operação', { exact: true })).toBeVisible();

    await window.getByRole('link', { name: 'Estoque' }).click();
    const transferForm = window.locator('form.transfer-form');
    await transferForm
      .getByLabel('Evento de origem', { exact: true })
      .selectOption({ label: `${sourceEventName} · aberto` });
    await transferForm
      .getByLabel('Evento de destino', { exact: true })
      .selectOption({ label: destinationEventName });
    await transferForm
      .getByLabel('Produto a transferir', { exact: true })
      .selectOption({ label: productName });
    await transferForm.getByLabel('Quantidade a transferir', { exact: true }).fill('3');
    await transferForm.getByRole('button', { name: 'Transferir estoque' }).click();

    productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await expect(productCard.getByText('3 un.', { exact: true })).toBeVisible();

    const transferCard = window
      .locator('article.transfer-card')
      .filter({ hasText: productName })
      .first();
    await expect(transferCard).toBeVisible();
    await expect(transferCard.getByText(sourceEventName, { exact: true })).toBeVisible();
    await expect(transferCard.getByText(destinationEventName, { exact: true })).toBeVisible();
    await expect(transferCard.getByText('8 → 5', { exact: true })).toBeVisible();
    await expect(transferCard.getByText('0 → 3', { exact: true })).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
