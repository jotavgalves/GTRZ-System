import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  activateEvent,
  createInventoryCategory,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-VCH-001 — vincula voucher à mesa, usa saldo parcial e restitui no estorno', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const eventName = `Evento voucher ${suffix}`;
    const categoryName = `Categoria voucher ${suffix}`;
    const productName = `Produto voucher ${suffix}`;
    const tableName = `Mesa voucher ${suffix.slice(-5)}`;
    const voucherCode = `VCH-${suffix.slice(-8)}`;

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    await expect(window.getByText(eventName, { exact: true }).first()).toBeVisible();
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
    await movementForm.getByLabel('Quantidade', { exact: true }).fill('3');
    await movementForm.getByLabel('Valor total pago').fill('6.00');
    await movementForm.getByRole('button', { name: 'Registrar entrada' }).click();
    await expect(productCard.getByText('3 un.', { exact: true })).toBeVisible();

    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    await window.getByPlaceholder('Ex.: Mesa 12').fill(tableName);
    await window.getByRole('button', { name: 'Criar mesa' }).click();
    await expect(window.getByRole('button', { name: new RegExp(tableName, 'u') })).toBeVisible();

    await window.getByRole('link', { name: 'Vouchers' }).click();
    await window.getByLabel('Mesa vinculada').selectOption({ label: tableName });
    await window.getByPlaceholder('Ex.: Crédito patrocinador').fill(`Crédito ${suffix}`);
    await window.getByPlaceholder('Gerado automaticamente').fill(voucherCode);
    await window.getByPlaceholder('100,00').fill('10.00');
    await window.getByRole('button', { name: 'Emitir voucher' }).click();
    let voucherCard = window.locator('article.voucher-card').filter({ hasText: voucherCode });
    await expect(voucherCard).toContainText(tableName);
    await expect(voucherCard).toContainText('R$ 10,00');

    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    await window.getByRole('button', { name: new RegExp(tableName, 'u') }).click();
    await window.getByRole('button', { name: new RegExp(productName, 'u') }).click();
    const voucherSelect = window.getByLabel('Voucher vinculado à comanda');
    await expect(voucherSelect.locator('option')).toHaveCount(2);
    await voucherSelect.selectOption(voucherCode);
    await expect(window.getByText('Saldo disponível', { exact: true })).toBeVisible();
    await window.getByLabel('Valor a utilizar').fill('4.00');
    await expect(window.getByText('Saldo a pagar: R$ 6,00', { exact: false })).toBeVisible();
    await window.getByLabel('Valor recebido', { exact: true }).fill('10.00');
    await expect(window.getByText('Troco: R$ 4,00', { exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'Concluir venda' }).click();
    await expect(window.getByText('Venda concluída e estoque atualizado.')).toBeVisible();

    await window.getByRole('link', { name: 'Vouchers' }).click();
    voucherCard = window.locator('article.voucher-card').filter({ hasText: voucherCode });
    await expect(voucherCard).toContainText('R$ 6,00');

    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    const history = window.locator('details.history-drawer').filter({
      hasText: 'Histórico de vendas do evento',
    });
    await history.locator('summary').click();
    const recentOrder = history
      .locator('article.recent-order-card')
      .filter({ hasText: productName });
    await expect(recentOrder).toContainText('Paga');
    await recentOrder.getByPlaceholder('Ex.: lançamento duplicado').fill('Estorno voucher');
    await recentOrder.getByRole('button', { name: 'Estornar venda' }).click();
    await expect(window.getByText('Comanda cancelada e operação auditada.')).toBeVisible();

    await window.getByRole('link', { name: 'Vouchers' }).click();
    voucherCard = window.locator('article.voucher-card').filter({ hasText: voucherCode });
    await expect(voucherCard).toContainText('R$ 10,00');
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
