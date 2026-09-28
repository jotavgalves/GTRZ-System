/* global window, document, MutationObserver, state */

import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { chromium } from 'playwright';

const SCRIPT_DIRECTORY = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../../..');
const QA_ARGUMENT = '--allow-production';
const MAX_BOOTSTRAP_WAIT_MS = 75_000;
const MAX_CLOUD_WAIT_MS = 45_000;
const MAX_VISUAL_WAIT_MS = 12_000;
const KEEP_FIXTURE_ON_FAILURE = process.env.GTRZ_QA_KEEP_FIXTURE === '1';

if (!process.argv.includes(QA_ARGUMENT)) {
  throw new Error(
    'Este teste cria um evento QA temporário na nuvem. Execute novamente com --allow-production.',
  );
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label, predicate, timeoutMs = MAX_CLOUD_WAIT_MS, intervalMs = 250) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : '';
  throw new Error(`${label} não ficou pronto em ${Math.round(timeoutMs / 1000)} s.${detail}`);
}

async function waitForCdp(port) {
  return waitFor(
    `a porta de depuração ${port}`,
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok;
    },
    MAX_BOOTSTRAP_WAIT_MS,
    300,
  );
}

function launch(executable, environment) {
  return spawn(executable, ['--gtrz-visual-qa'], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...environment },
    stdio: 'ignore',
    windowsHide: false,
  });
}

async function connectToElectron(port, label) {
  await waitForCdp(port);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitFor(`${label} renderizar a janela`, async () => {
    const candidate = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((item) => !item.url().startsWith('devtools://'));
    return candidate ?? false;
  });
  return { browser, page };
}

async function closeElectron(browser, process) {
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    await Promise.allSettled(pages.map((page) => page.evaluate(() => window.close())));
    await browser.close();
  } finally {
    if (!process.killed) process.kill();
  }
}

function qaPath(root, ...parts) {
  const path = join(root, ...parts);
  if (!path.startsWith(root)) throw new Error('Caminho temporário de QA inválido.');
  return path;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `${stamp}-${randomUUID().slice(0, 8)}`;
const qaRoot = join(tmpdir(), `gtrz-visual-sync-${runId}`);
const evidenceDirectory = join(homedir(), 'Documents', 'GTRZ System', 'QA visual', runId);
const recoveryManifestPath = join(evidenceDirectory, 'recuperacao.json');
const desktopExecutable =
  process.env.GTRZ_DESKTOP_QA_EXECUTABLE ??
  join(REPOSITORY_ROOT, 'release', 'win-unpacked', 'GTRZ System.exe');
const mobileExecutable =
  process.env.GTRZ_MOBILE_QA_EXECUTABLE ??
  join(REPOSITORY_ROOT, 'release', 'mobile', 'win-unpacked', 'GTRZ System Mobile.exe');
const pairingKeyPath =
  process.env.GTRZ_E2E_PAIRING_KEY_PATH ??
  join(homedir(), 'Documents', 'GTRZ System', 'Nuvem GTRZ - chave de pareamento.txt');
const portBase = Number(
  process.env.GTRZ_QA_PORT_BASE ?? 34_000 + Math.floor(Math.random() * 10_000),
);
const desktopPort = portBase;
const mobilePort = portBase + 1;
const qaName = `[QA] Realtime visual ${runId.slice(0, 19)}`;
const qaTable = `QA Mesa ${runId.slice(-8)}`;
const qaCategory = `QA Realtime ${runId.slice(-8)}`;
const qaProduct = `QA Venda ${runId.slice(-8)}`;
const qaOperator = `QA Mobile ${runId.slice(-8)}`;
const qaPassword = `Qa-${randomUUID()}-9`;
const desktopUserDataPath = process.env.GTRZ_QA_DESKTOP_USER_DATA?.trim() ?? '';

let desktopProcess = null;
let mobileProcess = null;
let desktopBrowser = null;
let mobileBrowser = null;
let desktopPage = null;
let mobilePage = null;
let originalEventId = null;
let fixture = null;
const cleanupErrors = [];
let mobileSaleRequestStartedAt = null;
let mobileSaleRequestFinishedAt = null;

async function writeRecoveryManifest(stage) {
  await writeFile(
    recoveryManifestPath,
    JSON.stringify(
      {
        runId,
        stage,
        originalEventId,
        fixture,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function desktop(action, argument) {
  return desktopPage.evaluate(
    async ({ actionName, payload }) => {
      const api = window.gtrz;
      switch (actionName) {
        case 'session':
          return api.session.getState();
        case 'dashboard':
          return api.dashboard.getState();
        case 'events':
          return api.events.list();
        case 'create-event':
          return api.events.create(payload);
        case 'set-global-event':
          return api.settings.setGlobalEvent(payload);
        case 'create-mobile-operator':
          return api.settings.createMobileOperator(payload);
        case 'delete-mobile-operator':
          return api.settings.deleteMobileOperator(payload);
        case 'create-category':
          return api.inventory.createCategory(payload);
        case 'create-product':
          return api.inventory.createProduct(payload);
        case 'stock-movement':
          return api.inventory.recordMovement(payload);
        case 'create-service-point':
          return api.operations.createServicePoint(payload);
        case 'delete-service-point':
          return api.operations.deleteServicePoint(payload);
        case 'delete-product':
          return api.inventory.deleteProduct(payload);
        case 'delete-category':
          return api.inventory.deleteCategory(payload);
        case 'delete-event':
          return api.events.delete(payload);
        default:
          throw new Error(`Ação de QA desconhecida: ${actionName}`);
      }
    },
    { actionName: action, payload: argument },
  );
}

async function cleanup(action, argument) {
  try {
    await desktop(action, argument);
  } catch (error) {
    cleanupErrors.push(`${action}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function setupDesktopVisualObserver(expectedGrossCents, expectedPaidOrders) {
  await desktopPage.evaluate(
    ({ grossCents, paidOrders }) => {
      const expectedMoney = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }).format(grossCents / 100);
      window.__gtrzVisualQa = {
        changedAt: null,
        dataChangedAt: null,
        expectedMoney,
        expectedPaidOrders: paidOrders,
      };
      window.gtrz.realtime.onDataChanged(() => {
        if (window.__gtrzVisualQa.dataChangedAt === null) {
          window.__gtrzVisualQa.dataChangedAt = Date.now();
        }
      });
      const hasRenderedSale = () =>
        [...document.querySelectorAll('.summary-card')].some((card) => {
          const text = card.textContent ?? '';
          return (
            text.includes('Faturamento') &&
            text.includes(expectedMoney) &&
            text.includes(`${paidOrders} vendas concluídas`)
          );
        });
      const mark = () => {
        if (window.__gtrzVisualQa.changedAt === null && hasRenderedSale()) {
          window.__gtrzVisualQa.changedAt = Date.now();
        }
      };
      new MutationObserver(mark).observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      mark();
    },
    { grossCents: expectedGrossCents, paidOrders: expectedPaidOrders },
  );
}

async function main() {
  if (!(await exists(desktopExecutable))) {
    throw new Error(`Desktop não compilado para QA: ${desktopExecutable}`);
  }
  if (!(await exists(mobileExecutable))) {
    throw new Error(`Mobile não compilado para QA: ${mobileExecutable}`);
  }
  if (!(await exists(pairingKeyPath))) {
    throw new Error('A chave local de pareamento não foi encontrada. Nenhuma alteração foi feita.');
  }
  if (!desktopUserDataPath || !(await exists(join(desktopUserDataPath, 'gtrz-system.sqlite')))) {
    throw new Error(
      'Este teste precisa apontar GTRZ_QA_DESKTOP_USER_DATA para a cópia local íntegra do Desktop.',
    );
  }

  await mkdir(qaRoot, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });

  console.log('Abrindo o Desktop QA com a cópia local íntegra para a prova visual.');
  desktopProcess = launch(desktopExecutable, {
    GTRZ_E2E_USER_DATA_PATH: desktopUserDataPath,
    GTRZ_E2E_PAIRING_KEY_PATH: pairingKeyPath,
    GTRZ_E2E_REMOTE_DEBUGGING_PORT: String(desktopPort),
  });
  ({ browser: desktopBrowser, page: desktopPage } = await connectToElectron(
    desktopPort,
    'o Desktop GTRZ',
  ));
  await waitFor('a ponte real do Desktop GTRZ', () =>
    desktopPage.evaluate(() => typeof window.gtrz !== 'undefined'),
  );
  await waitFor(
    'o Desktop GTRZ receber o evento global existente',
    async () => {
      const session = await desktop('session');
      return session.profile === 'production' && session.activeEvent !== null;
    },
    MAX_BOOTSTRAP_WAIT_MS,
  );

  const originalSession = await desktop('session');
  originalEventId = originalSession.activeEvent.id;

  const event = await desktop('create-event', { name: qaName, startsAt: Date.now() });
  fixture = {
    eventId: event.id,
    operatorId: null,
    categoryId: null,
    productId: null,
    servicePointId: null,
  };
  await writeRecoveryManifest('evento-qa-criado');

  await waitFor('a publicação do evento QA na nuvem', async () => {
    try {
      const session = await desktop('set-global-event', { eventId: fixture.eventId });
      return session.activeEvent?.id === fixture.eventId;
    } catch {
      return false;
    }
  });

  const operator = await desktop('create-mobile-operator', {
    name: qaOperator,
    password: qaPassword,
    permissions: {
      sales: true,
      inventory: false,
      tickets: false,
      expenses: false,
      vouchers: false,
    },
  });
  fixture.operatorId = operator.id;
  await writeRecoveryManifest('operador-qa-criado');

  const category = await desktop('create-category', { name: qaCategory, engine: 'catalog' });
  fixture.categoryId = category.id;
  await writeRecoveryManifest('categoria-qa-criada');
  const product = await desktop('create-product', {
    categoryId: category.id,
    name: qaProduct,
    kind: 'drink',
    costCents: 250,
    salePriceCents: 1_100,
    lowStockThreshold: 0,
    comboOnly: false,
    fallbackIcon: 'cup-soda',
  });
  fixture.productId = product.id;
  await writeRecoveryManifest('produto-qa-criado');
  await desktop('stock-movement', {
    productId: product.id,
    type: 'purchase',
    quantity: 3,
    purchaseTotalCents: 750,
    note: 'Estoque temporário do teste visual automatizado.',
  });
  const servicePoint = await desktop('create-service-point', { label: qaTable, type: 'table' });
  fixture.servicePointId = servicePoint.id;
  await writeRecoveryManifest('mesa-qa-criada');

  await waitFor('o Desktop confirmar no diário canônico os dados do cenário QA', async () => {
    const monitor = await desktopPage.evaluate(() => window.gtrz.settings.getCloudMonitor());
    return monitor.localQueue.outboxPending === 0 && monitor.localQueue.outboxFailed === 0;
  });
  // Give the real Desktop channel one event loop to finish its WebSocket join
  // after the canonical journal has caught up. Production desktops stay joined
  // continuously; this only removes startup noise from the visual harness.
  await sleep(2_000);

  await desktopPage.evaluate(() => {
    window.location.hash = '#/';
  });
  await desktopPage.getByRole('heading', { name: 'Visão geral' }).waitFor();
  await waitFor('o evento QA aparecer visualmente na Visão geral', () =>
    desktopPage.locator('.dashboard-event-banner').getByText(qaName).isVisible(),
  );
  const dashboardBefore = await desktop('dashboard');
  if (dashboardBefore.grossSalesCents !== 0 || dashboardBefore.orders.paid !== 0) {
    throw new Error(
      'O evento QA não começou vazio; o teste foi interrompido para preservar os dados.',
    );
  }
  await desktopPage.screenshot({ path: join(evidenceDirectory, '01-desktop-antes.png') });

  console.log('Abrindo GTRZ System Mobile e aguardando o catálogo real da nuvem.');
  mobileProcess = launch(mobileExecutable, {
    GTRZ_E2E_MOBILE_USER_DATA_PATH: qaPath(qaRoot, 'mobile'),
    GTRZ_E2E_REMOTE_DEBUGGING_PORT: String(mobilePort),
  });
  ({ browser: mobileBrowser, page: mobilePage } = await connectToElectron(
    mobilePort,
    'o GTRZ System Mobile',
  ));
  await mobilePage
    .locator('#password')
    .waitFor({ state: 'visible', timeout: MAX_BOOTSTRAP_WAIT_MS });
  console.log('Mobile: autenticando o operador temporário.');
  await mobilePage.locator('#password').fill(qaPassword);
  await mobilePage.locator('#login-form button.primary').click();
  await waitFor(
    'a sessão real do operador mobile',
    () =>
      mobilePage.evaluate(
        (operatorName) =>
          typeof state !== 'undefined' &&
          state.online === true &&
          state.operator?.name === operatorName,
        qaOperator,
      ),
    MAX_BOOTSTRAP_WAIT_MS,
  );
  console.log('Mobile: sessão confirmada.');
  await waitFor(
    'a mesa QA chegar pelo WebSocket no mobile',
    () => mobilePage.locator(`[data-service-point="${fixture.servicePointId}"]`).isVisible(),
    MAX_BOOTSTRAP_WAIT_MS,
  );
  console.log('Mobile: mesa recebida pela atualização em tempo real.');
  await mobilePage.locator(`[data-service-point="${fixture.servicePointId}"]`).click();
  await waitFor(
    'o produto QA chegar ao catálogo mobile',
    () => mobilePage.locator(`[data-item="product:${fixture.productId}"]`).isVisible(),
    MAX_BOOTSTRAP_WAIT_MS,
  );
  console.log('Mobile: produto recebido pela atualização em tempo real.');
  await mobilePage.screenshot({ path: join(evidenceDirectory, '02-mobile-antes.png') });

  await mobilePage.locator(`[data-item="product:${fixture.productId}"]`).click();
  await mobilePage.locator('details.cart > summary').click();
  await mobilePage.locator('[data-method="pix"]').click();
  await mobilePage.locator('#charge').waitFor({ state: 'visible' });
  const saleResponsePromise = mobilePage.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/v1/mobile/sales'),
    { timeout: MAX_VISUAL_WAIT_MS },
  );
  mobilePage.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/v1/mobile/sales')) {
      mobileSaleRequestStartedAt ??= Date.now();
    }
  });
  mobilePage.on('requestfinished', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/v1/mobile/sales')) {
      mobileSaleRequestFinishedAt ??= Date.now();
    }
  });
  await setupDesktopVisualObserver(
    dashboardBefore.grossSalesCents + product.salePriceCents,
    dashboardBefore.orders.paid + 1,
  );

  const actionAt = Date.now();
  await mobilePage.locator('#charge').click();
  const saleResponse = await saleResponsePromise;
  const saleResponseBody = await saleResponse.json().catch(() => null);
  await mobilePage
    .getByRole('heading', { name: 'Venda confirmada' })
    .waitFor({ timeout: MAX_VISUAL_WAIT_MS });
  const mobileConfirmedAt = Date.now();
  await mobilePage.screenshot({ path: join(evidenceDirectory, '03-mobile-confirmada.png') });

  await waitFor(
    'a Visão geral real alterar os números da venda mobile',
    () => desktopPage.evaluate(() => window.__gtrzVisualQa?.changedAt !== null),
    MAX_VISUAL_WAIT_MS,
    50,
  );
  const visualAt = await desktopPage.evaluate(() => window.__gtrzVisualQa.changedAt);
  const desktopDataChangedAt = await desktopPage.evaluate(
    () => window.__gtrzVisualQa.dataChangedAt,
  );
  const dashboardAfter = await desktop('dashboard');
  if (
    dashboardAfter.grossSalesCents !== dashboardBefore.grossSalesCents + product.salePriceCents ||
    dashboardAfter.orders.paid !== dashboardBefore.orders.paid + 1
  ) {
    throw new Error('A interface mudou, mas o estado real da Visão geral não confirmou a venda.');
  }
  const latencyMs = Number(visualAt) - actionAt;
  const result = {
    runId,
    verifiedAt: new Date().toISOString(),
    transport: 'Supabase Edge Function + Supabase Realtime',
    action: 'Clique real em Cobrar no GTRZ System Mobile',
    visualProof: 'A tela real de Visão geral exibiu Faturamento e vendas concluídas atualizados.',
    latencyMs,
    timings: {
      mobileRequestStartedAfterClickMs:
        mobileSaleRequestStartedAt === null ? null : mobileSaleRequestStartedAt - actionAt,
      mobileRequestDurationMs:
        mobileSaleRequestStartedAt === null || mobileSaleRequestFinishedAt === null
          ? null
          : mobileSaleRequestFinishedAt - mobileSaleRequestStartedAt,
      mobileConfirmedAfterClickMs: mobileConfirmedAt - actionAt,
      desktopDataChangedAfterClickMs:
        desktopDataChangedAt === null ? null : Number(desktopDataChangedAt) - actionAt,
      desktopRenderAfterDataChangedMs:
        desktopDataChangedAt === null ? null : Number(visualAt) - Number(desktopDataChangedAt),
      edgeCommand:
        saleResponseBody !== null &&
        typeof saleResponseBody === 'object' &&
        !Array.isArray(saleResponseBody) &&
        saleResponseBody.timing !== null &&
        typeof saleResponseBody.timing === 'object' &&
        !Array.isArray(saleResponseBody.timing)
          ? saleResponseBody.timing
          : null,
    },
    expectedMaximumMs: 200,
    withinTarget: latencyMs >= 0 && latencyMs <= 200,
    before: {
      grossSalesCents: dashboardBefore.grossSalesCents,
      paidOrders: dashboardBefore.orders.paid,
    },
    after: {
      grossSalesCents: dashboardAfter.grossSalesCents,
      paidOrders: dashboardAfter.orders.paid,
    },
    saleCents: product.salePriceCents,
    screenshots: [
      '01-desktop-antes.png',
      '02-mobile-antes.png',
      '03-mobile-confirmada.png',
      '04-desktop-atualizado.png',
    ],
  };
  await writeFile(join(evidenceDirectory, 'resultado.json'), JSON.stringify(result, null, 2));
  try {
    await desktopPage.screenshot({
      path: join(evidenceDirectory, '04-desktop-atualizado.png'),
      timeout: 5_000,
    });
  } catch (error) {
    result.screenshotWarning =
      error instanceof Error ? error.message : 'A captura final do Desktop não foi concluída.';
    await writeFile(join(evidenceDirectory, 'resultado.json'), JSON.stringify(result, null, 2));
  }
  console.log(`RESULTADO_VISUAL latencyMs=${latencyMs} withinTarget=${result.withinTarget}`);
  console.log(`EVIDENCIAS ${evidenceDirectory}`);
  if (!result.withinTarget) {
    throw new Error(`A interface confirmou a venda em ${latencyMs} ms, fora da meta de 200 ms.`);
  }
}

let testError = null;
try {
  await main();
} catch (error) {
  testError = error;
  await writeFile(
    join(evidenceDirectory, 'falha.txt'),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  ).catch(() => undefined);
}

if (desktopPage !== null && fixture !== null && !(KEEP_FIXTURE_ON_FAILURE && testError !== null)) {
  if (fixture.operatorId !== null) {
    await cleanup('delete-mobile-operator', { operatorId: fixture.operatorId });
  }
  if (fixture.servicePointId !== null) {
    await cleanup('delete-service-point', {
      servicePointId: fixture.servicePointId,
      mode: 'delete-all',
      reason: 'Limpeza do teste visual automatizado.',
    });
  }
  if (fixture.productId !== null) {
    await cleanup('delete-product', {
      productId: fixture.productId,
      mode: 'refund-active-event-sales',
      reason: 'Limpeza do teste visual automatizado.',
    });
  }
  if (fixture.categoryId !== null) {
    await cleanup('delete-category', { categoryId: fixture.categoryId });
  }
  if (originalEventId !== null) {
    await cleanup('set-global-event', { eventId: originalEventId });
  }
  if (fixture.eventId !== null) {
    await cleanup('delete-event', {
      eventId: fixture.eventId,
      confirmationName: qaName,
      reason: 'Evento criado exclusivamente para teste visual automatizado.',
    });
  }
  await writeRecoveryManifest(cleanupErrors.length === 0 ? 'limpeza-concluida' : 'limpeza-parcial');
} else if (desktopPage !== null && fixture !== null) {
  await writeRecoveryManifest('fixture-retida-para-diagnostico');
}
if (mobileBrowser !== null && mobileProcess !== null)
  await closeElectron(mobileBrowser, mobileProcess);
if (desktopBrowser !== null && desktopProcess !== null)
  await closeElectron(desktopBrowser, desktopProcess);
try {
  await rm(qaRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 500 });
} catch (error) {
  // A Chromium child can retain a journal handle briefly on Windows. It is an
  // isolated temporary profile; preserve the test result and let the OS remove
  // the harmless directory after the process releases it.
  console.warn(
    `Não foi possível apagar o perfil temporário de QA: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

if (testError !== null) throw testError;
if (cleanupErrors.length > 0) {
  throw new Error(`A limpeza do QA falhou: ${cleanupErrors.join(' | ')}`);
}
