import { expect, test } from '@playwright/test';

import {
  closeElectronApplication,
  activateEvent,
  createInventoryCategory,
  ensureProduction,
  launchElectronApplication,
} from './electron-app';

test('SMK-OPR-001 — vende, estorna e devolve o estoque pela interface', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureProduction(window);
    const suffix = String(Date.now());
    const eventName = `Evento operação ${suffix}`;
    const categoryName = `Operação ${suffix}`;
    const productName = `Água venda ${suffix}`;
    const tableName = `Mesa ${suffix.slice(-4)}`;

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

    let productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await productCard.getByRole('button', { name: 'Entrada', exact: true }).click();
    const movementForm = window.locator('form.movement-form');
    await movementForm.getByLabel('Quantidade', { exact: true }).fill('5');
    await movementForm.getByLabel('Valor total pago').fill('10.00');
    await movementForm.getByRole('button', { name: 'Registrar entrada' }).click();
    await expect(productCard.getByText('5 un.', { exact: true })).toBeVisible();

    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    await expect(
      window.getByRole('heading', { name: 'Mesas e balcão', exact: true }),
    ).toBeVisible();
    await window.getByPlaceholder('Ex.: Mesa 12').fill(tableName);
    await window.getByRole('button', { name: 'Criar mesa' }).click();

    const tableButton = window.getByRole('button', { name: new RegExp(tableName, 'u') });
    await expect(tableButton).toBeVisible();
    await tableButton.click();
    await expect(
      window.getByText(
        'Nenhuma comanda aberta. Adicionar o primeiro produto ou combo inicia a venda.',
        { exact: true },
      ),
    ).toBeVisible();

    const catalogItem = window.getByRole('button', { name: new RegExp(productName, 'u') });
    await expect(catalogItem).toBeVisible();
    await catalogItem.click();
    await expect(window.getByText(productName, { exact: true }).last()).toBeVisible();
    await expect(window.getByText('R$ 10,00', { exact: true }).last()).toBeVisible();
    await expect(window.getByText('Valor cobrado', { exact: true })).toBeVisible();
    await expect(window.getByText('R$ 10,00', { exact: true }).last()).toBeVisible();

    await window.getByLabel('Valor recebido', { exact: true }).fill('20.00');
    await expect(window.getByText('Troco: R$ 10,00', { exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'Concluir venda' }).click();
    await expect(window.getByText('Venda concluída e estoque atualizado.')).toBeVisible();
    await window.getByRole('button', { name: 'Voltar para mesas' }).click();
    await expect(window.getByRole('button', { name: new RegExp(tableName, 'u') })).toContainText(
      'Livre',
    );

    await window.getByRole('link', { name: 'Estoque' }).click();
    productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await expect(productCard.getByText('4 un.', { exact: true })).toBeVisible();

    await window.getByRole('button', { name: 'Usar perfil Caixa' }).click();
    await expect(window.getByText('Caixa', { exact: true })).toBeVisible();
    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    const cashierHistory = window.locator('details.history-drawer').filter({
      hasText: 'Histórico de vendas do evento',
    });
    await expect(cashierHistory).not.toHaveAttribute('open', '');
    await cashierHistory.locator('summary').click();
    let recentOrder = cashierHistory
      .locator('article.recent-order-card')
      .filter({ hasText: tableName });
    await expect(recentOrder).toContainText('Paga');
    await expect(recentOrder.getByRole('button', { name: 'Estornar venda' })).toHaveCount(0);

    await window.getByPlaceholder('Digite a senha').fill('121225');
    await window.getByRole('button', { name: 'Entrar em Produção' }).click();
    await expect(window.getByText('Produção', { exact: true })).toBeVisible();
    await window.getByRole('link', { name: 'Mesas e balcão' }).click();
    const productionHistory = window.locator('details.history-drawer').filter({
      hasText: 'Histórico de vendas do evento',
    });
    await productionHistory.locator('summary').click();
    recentOrder = productionHistory
      .locator('article.recent-order-card')
      .filter({ hasText: tableName });
    await expect(recentOrder).toContainText('Paga');
    await recentOrder.getByPlaceholder('Ex.: lançamento duplicado').fill('Pagamento duplicado');
    await recentOrder.getByRole('button', { name: 'Estornar venda' }).click();
    await expect(window.getByText('Comanda cancelada e operação auditada.')).toBeVisible();
    await expect(recentOrder).toContainText('Cancelada');

    await window.getByRole('link', { name: 'Estoque' }).click();
    productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await expect(productCard.getByText('5 un.', { exact: true })).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
