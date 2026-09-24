import { expect, test } from '@playwright/test';

import {
  activateEvent,
  closeElectronApplication,
  createInventoryCategory,
  launchElectronApplication,
} from './electron-app';

test('SMK-INF-002 — abre o GTRZ System com navegação modular', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await expect(window).toHaveTitle('GTRZ System');
    await expect(window.locator('#root')).not.toBeEmpty();
    await expect(window.getByRole('img', { name: 'GTRZ' })).toBeVisible();

    const bodyText = await window.locator('body').innerText();
    expect(bodyText).not.toContain('Falha ao abrir esta área');

    await expect(window.getByRole('navigation', { name: 'Módulos do sistema' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Estoque' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Mesas e balcão' })).toBeVisible();
    await expect(window.getByText('Banco íntegro')).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});

test('SMK-USR-001 — Caixa vê somente os módulos permitidos e retorna com senha', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    await window.getByRole('button', { name: 'Usar perfil Caixa' }).click();
    await expect(window.getByText('Caixa', { exact: true })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Mesas e balcão' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Estoque' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Ingressos' })).toHaveCount(0);
    await expect(window.getByRole('link', { name: 'Configurações' })).toHaveCount(0);

    await window.getByPlaceholder('Digite a senha').fill('121225');
    await window.getByRole('button', { name: 'Entrar em Produção' }).click();

    await expect(window.getByText('Produção', { exact: true })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Ingressos' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Configurações' })).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});

test('SMK-BKP-001 — cria e verifica backup manual pela interface', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const eventName = `Evento backup ${String(Date.now())}`;
    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    await activateEvent(window, eventName);

    await window.getByRole('link', { name: 'Backups' }).click();
    await expect(window.getByRole('heading', { name: 'Backups' })).toBeVisible();
    await window.getByRole('button', { name: 'Criar backup' }).click();
    await expect(window.getByText(/criado e verificado/u)).toBeVisible();

    const verifyButton = window.getByRole('button', { name: 'Verificar' }).first();
    await expect(verifyButton).toBeVisible();
    await verifyButton.click();
    await expect(window.getByText(/está íntegro/u)).toBeVisible();
  } finally {
    await closeElectronApplication(electronApplication);
  }
});

test('SMK-EST-001 — cadastra produto, movimenta saldo e protege custos no Caixa', async () => {
  const electronApplication = await launchElectronApplication();

  try {
    const window = await electronApplication.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    const suffix = String(Date.now());
    const eventName = `Evento estoque ${suffix}`;
    const categoryName = `Cervejas ${suffix}`;
    const productName = `Budweiser ${suffix}`;

    await window.getByRole('link', { name: 'Eventos' }).click();
    await window.getByPlaceholder('Ex.: La Rumba Neon — Agosto').fill(eventName);
    await window.getByRole('button', { name: 'Criar evento' }).click();
    await expect(window.getByText(eventName, { exact: true }).first()).toBeVisible();
    await activateEvent(window, eventName);

    await window.getByRole('link', { name: 'Estoque' }).click();
    await expect(window.getByRole('heading', { name: 'Estoque', exact: true })).toBeVisible();

    await createInventoryCategory(window, categoryName);

    const productForm = window.locator('form.product-form');
    await productForm.getByLabel('Nome', { exact: true }).fill(productName);
    await productForm.getByRole('combobox').first().selectOption({ label: categoryName });
    await productForm.getByLabel('Preço de custo', { exact: true }).fill('6.00');
    await productForm.getByLabel('Preço de venda', { exact: true }).fill('10.00');
    await productForm.getByLabel('Aviso de estoque baixo', { exact: true }).fill('3');
    await productForm.getByRole('button', { name: 'Cadastrar produto' }).click();

    let productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await expect(productCard).toBeVisible();
    await expect(productCard.getByText('Custo médio', { exact: true })).toBeVisible();
    await expect(productCard.getByText('R$ 6,00', { exact: true })).toBeVisible();
    await expect(productCard.getByText('40.00%')).toBeVisible();

    await productCard.getByRole('button', { name: 'Entrada', exact: true }).click();
    const movementForm = window.locator('form.movement-form');
    await movementForm.getByLabel('Quantidade', { exact: true }).fill('6');
    await movementForm.getByLabel('Valor total pago').fill('36.00');
    await movementForm.getByRole('button', { name: 'Registrar entrada' }).click();

    productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await expect(productCard.getByText('6 un.', { exact: true })).toBeVisible();
    await expect(productCard.getByText('R$ 36,00', { exact: true })).toHaveCount(2);
    await expect(
      productCard.getByRole('button', { name: 'Baixar estoque · 6 un.', exact: true }),
    ).toBeVisible();

    await window.getByRole('button', { name: 'Usar perfil Caixa' }).click();
    await expect(window.getByText('Caixa', { exact: true })).toBeVisible();
    await window.getByRole('link', { name: 'Estoque' }).click();
    await expect(window.getByRole('heading', { name: 'Estoque', exact: true })).toBeVisible();

    productCard = window.locator('article.inventory-card').filter({ hasText: productName });
    await expect(productCard).toBeVisible();
    await expect(productCard.getByText('R$ 10,00', { exact: true })).toBeVisible();
    await expect(productCard.getByText('Custo médio', { exact: true })).toHaveCount(0);
    await expect(productCard.getByText('Valor do saldo', { exact: true })).toHaveCount(0);
    await expect(productCard.getByText('Investido no evento', { exact: true })).toHaveCount(0);
    await expect(productCard.getByRole('button', { name: 'Editar' })).toHaveCount(0);
    await expect(productCard.getByRole('button', { name: 'Entrada', exact: true })).toHaveCount(0);
    await expect(productCard.getByRole('button', { name: /Baixar estoque/u })).toHaveCount(0);
  } finally {
    await closeElectronApplication(electronApplication);
  }
});
