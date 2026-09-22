import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  activateEvent,
  createInventoryCategory,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-CHK-001 — só exige alocação manual no pagamento misto', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const eventName = `Evento checkout ${suffix}`;
    const categoryName = `Checkout ${suffix}`;
    const productName = `Produto checkout ${suffix}`;
    const tableName = `Mesa checkout ${suffix.slice(-4)}`;

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    await activateEvent(window, eventName);

    await window.getByRole('link', { name: 'Estoque' }).click();
    await createInventoryCategory(window, categoryName);
    const productForm = window.locator('form.product-form');
    await productForm.getByLabel('Nome', { exact: true }).fill(productName);
    await productForm.getByRole('combobox').first().selectOption({ label: categoryName });
    await productForm.getByLabel('Preço de custo', { exact: true }).fill('2.00');
    await productForm.getByLabel('Preço de venda', { exact: true }).fill('10.00');
    await productForm.getByLabel('Aviso de estoque baixo', { exact: true }).fill('1');
    await productForm.getByRole('button', { name: 'Cadastrar produto' }).click();
    const productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await productCard.getByRole('button', { name: 'Entrada', exact: true }).click();
    const movementForm = window.locator('form.movement-form');
    await movementForm.getByLabel('Quantidade', { exact: true }).fill('2');
    await movementForm.getByLabel('Valor total pago').fill('4.00');
    await movementForm.getByRole('button', { name: 'Registrar entrada' }).click();

    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    await window.getByPlaceholder('Ex.: Mesa 12').fill(tableName);
    await window.getByRole('button', { name: 'Criar mesa' }).click();
    await window.getByRole('button', { name: new RegExp(tableName, 'u') }).click();
    await window.getByRole('button', { name: new RegExp(productName, 'u') }).click();

    await expect(window.getByLabel('Valor do pagamento 1')).toHaveCount(0);
    await expect(window.getByText('Valor cobrado', { exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'Pagamento misto', exact: true }).click();

    await window.getByLabel('Valor do pagamento 1').fill('4.00');
    await window.getByLabel('Valor recebido 1').fill('5.00');
    await window.getByRole('button', { name: 'Adicionar pagamento' }).click();
    await window.getByLabel('Forma de pagamento 2').selectOption('pix');
    await window.getByLabel('Valor do pagamento 2').fill('6.00');
    await expect(window.getByText('Troco a entregar')).toBeVisible();
    await expect(window.getByText('R$ 1,00', { exact: true }).last()).toBeVisible();
    await window.getByRole('button', { name: 'Concluir venda' }).click();
    await expect(window.getByText('Venda concluída e estoque atualizado.')).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
