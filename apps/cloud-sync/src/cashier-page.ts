import { cashierClientScript } from './cashier-client';
import { cashierStyles } from './cashier-styles';

interface CashierPageOptions {
  readonly environment: 'production' | 'test';
}

export function cashierPage({ environment }: CashierPageOptions): Response {
  const isTest = environment === 'test';
  const environmentBadge = isTest ? '<span class="environment-badge">AMBIENTE DE TESTE</span>' : '';
  const pageTitle = isTest ? 'GTRZ Mobile - Teste' : 'GTRZ Mobile';
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#101014"><link rel="manifest" href="/cashier/manifest.webmanifest"><title>${pageTitle}</title><style>${cashierStyles}\n.environment-badge{display:inline-flex;align-items:center;min-height:1.35rem;margin-left:.5rem;padding:0 .45rem;border:1px solid #e8b436;border-radius:3px;background:#2e2510;color:#f8d984;font-size:.62rem;font-weight:800;letter-spacing:.07em}</style></head><body><header><div class="brand"><span class="mark">G</span><div><small>GTRZ System ${environmentBadge}</small><b>Operação mobile</b></div></div><span class="status" id="status"><i></i><span>Verificando</span></span><div class="operator" id="operator"></div></header><main><section class="login hidden" id="login"><h1>Entrar na operação</h1><p>Informe sua senha de trabalho. Este celular fica conectado até a Produção encerrar a sessão.</p><form id="login-form"><label class="field"><span>Senha</span><input id="password" type="password" autocomplete="current-password" required autofocus></label><button class="primary">Entrar</button><div class="notice" id="login-error"></div></form></section><section id="app" class="hidden"><nav class="tabs" id="tabs"></nav><section id="sales"><div class="layout"><section><div class="view-head"><div><h1>Vendas</h1><p>Toque para montar a venda.</p></div></div><input class="search" id="search" placeholder="Buscar produto"><div class="catalog" id="catalog"></div></section><aside class="cart"><div class="cart-title"><h2>Venda atual</h2><span id="cart-count"></span></div><div class="cart-body"><div id="cart"></div><div class="total"><span>Total</span><strong id="total">R$ 0,00</strong></div><div class="methods" id="methods"><button data-method="cash">Dinheiro</button><button data-method="pix">PIX</button><button data-method="credit-card">Crédito</button><button data-method="debit-card">Débito</button></div><button class="charge" id="charge" disabled>Conexão necessária</button></div></aside></div></section><section id="inventory" class="hidden"><div class="view-head"><div><h1>Estoque</h1><p>Entrada e baixa em tempo real.</p></div></div><input class="search" id="stock-search" placeholder="Buscar produto"><div class="stock-list" id="stock-list"></div></section></section></main><section class="overlay hidden" id="result"><div class="panel"><h2 id="result-title"></h2><p id="result-text" class="subtle"></p><button class="primary" id="result-close">Continuar</button></div></section><section class="overlay hidden" id="movement"><div class="panel"><h2 id="movement-title">Movimentar estoque</h2><form id="movement-form"><input id="movement-product" type="hidden"><div class="split"><label class="field"><span>Movimento</span><select id="movement-type"><option value="purchase">Entrada por compra</option><option value="correction-positive">Ajuste positivo</option><option value="return">Devolução</option><option value="correction-negative">Ajuste negativo</option><option value="loss">Perda</option><option value="breakage">Quebra</option><option value="internal-consumption">Consumo interno</option><option value="courtesy">Cortesia</option></select></label><label class="field"><span>Quantidade</span><input id="movement-quantity" type="number" min="1" step="1" required></label></div><label class="field" id="purchase-cost"><span>Valor total pago</span><input id="movement-cost" type="number" min="0.01" step="0.01" inputmode="decimal"><small id="purchase-total">Informe o total pago; o sistema calcula o custo médio.</small></label><label class="field"><span>Observação</span><input id="movement-note" maxlength="240" placeholder="Opcional"></label><button class="primary">Confirmar movimento</button><button class="link" id="movement-cancel" type="button">Cancelar</button></form></div></section><script>${cashierClientScript}</script></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' } },
  );
}

export function cashierManifest({ environment }: CashierPageOptions): Response {
  const isTest = environment === 'test';
  return Response.json({
    name: isTest ? 'GTRZ Operação Mobile - Teste' : 'GTRZ Operação Mobile',
    short_name: isTest ? 'GTRZ Teste' : 'GTRZ Mobile',
    start_url: '/cashier',
    display: 'standalone',
    background_color: '#101014',
    theme_color: '#101014',
    icons: [
      {
        src: '/cashier/icon.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
  });
}

export function cashierIcon(): Response {
  return new Response(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#101014"/><rect x="72" y="72" width="368" height="368" rx="58" fill="#ed2646"/><path fill="#fff" d="M153 155h206v54H214v38h120v51H214v60h145v54H153z"/></svg>',
    { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } },
  );
}
