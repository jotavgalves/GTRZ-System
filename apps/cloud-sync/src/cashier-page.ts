import { cashierClientScript } from './cashier-client';
import { cashierStyles } from './cashier-styles';

interface CashierPageOptions {
  readonly environment: 'production' | 'test';
}

const cashierVisualStyles = String.raw`
:root{
  --bg:#09090b;
  --surface:#17171b;
  --raised:#111114;
  --line:#2c2c33;
  --text:#f8f8fa;
  --muted:#a3a3ad;
  --red:#f20d32;
  --green:#22c55e;
  --danger:#ef4444;
  --brand-soft:rgb(242 13 50 / 14%);
  --surface-hover:#202026;
  --surface-active:#27272e;
  --border-strong:#3a3a43;
  --subtle:#71717b;
  --warning:#f5b82e;
  --shadow-panel:0 20px 50px rgb(0 0 0 / 24%);
}
html{background:var(--bg)}
body{
  min-height:100vh;
  background:
    radial-gradient(circle at 82% 0%,rgb(242 13 50 / 8%),transparent 26rem),
    var(--bg);
  font-family:Inter,"Segoe UI",Arial,sans-serif;
  letter-spacing:0;
}
button{transition:background-color 140ms ease,border-color 140ms ease,color 140ms ease,transform 140ms ease}
button:not(:disabled):active{transform:scale(.985)}
header{
  min-height:72px;
  padding:12px 22px;
  border-bottom:1px solid var(--line);
  background:rgb(9 9 11 / 88%);
  backdrop-filter:blur(18px);
}
.brand{gap:12px;min-width:0}
.brand-word{
  display:grid;
  min-width:62px;
  height:38px;
  place-items:center;
  border:1px solid rgb(242 13 50 / 28%);
  border-radius:10px;
  background:linear-gradient(145deg,var(--brand-soft),rgb(20 20 23 / 82%));
  color:#fff;
  font-size:16px;
  font-weight:900;
  letter-spacing:0;
  box-shadow:0 12px 30px rgb(0 0 0 / 22%);
}
.brand-copy{display:flex;min-width:0;flex-direction:column;gap:2px}
.brand-copy small{
  color:var(--red);
  font-size:9px;
  font-weight:850;
  letter-spacing:.16em;
  text-transform:uppercase;
}
.brand-copy b{overflow:hidden;font-size:14px;text-overflow:ellipsis;white-space:nowrap}
.status{
  min-height:32px;
  padding:0 11px;
  border:1px solid var(--line);
  border-radius:999px;
  background:var(--surface);
  font-size:11px;
  font-weight:750;
}
.status i{width:7px;height:7px}
.status.online{
  border-color:rgb(34 197 94 / 22%);
  background:rgb(34 197 94 / 12%);
  color:var(--green);
}
.operator b{font-weight:800}
main{max-width:1220px;padding:24px}
#app{display:flex;flex-direction:column;gap:18px}
.tabs{
  align-self:flex-start;
  gap:4px;
  margin:0;
  padding:4px;
  border:1px solid var(--line);
  border-radius:12px;
  background:var(--raised);
}
.tab{
  min-width:108px;
  height:40px;
  padding:0 16px;
  border-radius:8px;
  color:var(--muted);
  font-size:12px;
  font-weight:800;
}
.tab.active{
  background:var(--brand-soft);
  color:#fff;
  box-shadow:inset 0 0 0 1px rgb(242 13 50 / 24%);
}
.view-head{margin-bottom:14px}
.view-head h1{
  margin:3px 0 4px;
  font-size:30px;
  font-weight:850;
  letter-spacing:0;
}
.view-head p{margin:0;color:var(--muted);font-size:13px}
.view-eyebrow{
  color:var(--red);
  font-size:10px;
  font-weight:850;
  letter-spacing:.12em;
  text-transform:uppercase;
}
.search-shell{
  position:relative;
  display:flex;
  align-items:center;
  margin-bottom:14px;
}
.search-shell svg{
  position:absolute;
  left:13px;
  z-index:1;
  color:var(--subtle);
  pointer-events:none;
}
.search{
  height:48px;
  margin:0;
  padding:0 14px 0 40px;
  border-color:var(--border-strong);
  border-radius:12px;
  background:var(--raised);
  font-size:13px;
}
.search:focus{
  border-color:var(--red);
  box-shadow:0 0 0 3px var(--brand-soft);
}
.layout{grid-template-columns:minmax(0,1fr) 370px;gap:20px}
.catalog{gap:10px}
.product{
  position:relative;
  min-height:150px;
  padding:15px;
  overflow:hidden;
  border-color:var(--line);
  border-radius:14px;
  background:linear-gradient(145deg,rgb(25 25 29 / 96%),rgb(18 18 21 / 96%));
  box-shadow:0 10px 28px rgb(0 0 0 / 12%);
}
.product:not(:disabled):hover{
  border-color:rgb(242 13 50 / 34%);
  background:var(--surface-hover);
}
.product b{
  max-width:100%;
  overflow:hidden;
  font-size:15px;
  font-weight:800;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.product span{
  margin-top:5px;
  color:var(--subtle);
  font-size:10px;
  font-weight:750;
  letter-spacing:.08em;
  text-transform:uppercase;
}
.product strong{
  padding-top:18px;
  color:var(--text);
  font-size:19px;
  font-weight:850;
  letter-spacing:0;
}
.stock{
  display:inline-flex;
  width:max-content;
  max-width:100%;
  align-items:center;
  margin-top:7px;
  padding:4px 7px;
  border-radius:999px;
  background:rgb(34 197 94 / 10%);
  color:var(--green);
  font-size:10px;
  font-weight:750;
}
.product:disabled .stock{background:rgb(239 68 68 / 10%);color:#fca5a5}
.cart{
  position:sticky;
  top:92px;
  align-self:start;
  overflow:hidden;
  border:1px solid var(--line);
  border-radius:16px;
  background:linear-gradient(145deg,rgb(25 25 29 / 98%),rgb(18 18 21 / 98%));
  box-shadow:var(--shadow-panel);
}
.cart-title{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  align-items:center;
  gap:12px;
  padding:15px 16px;
  border-bottom:1px solid var(--line);
  cursor:pointer;
  list-style:none;
}
.cart-title::-webkit-details-marker{display:none}
.cart-title::marker{display:none;content:""}
.cart-title__identity{display:flex;min-width:0;flex-direction:column;gap:3px}
.cart-kicker{
  color:var(--text);
  font-size:14px;
  font-weight:850;
}
#cart-count{
  color:var(--muted);
  font-size:11px;
  font-weight:650;
}
.cart-title #total{
  font-size:20px;
  font-weight:900;
  letter-spacing:0;
}
.cart-body{padding:0 16px 16px}
.line{padding:14px 0}
.line b{font-size:13px;font-weight:800}
.quantity button{
  width:34px;
  height:34px;
  border-color:var(--border-strong);
  border-radius:9px;
  background:var(--surface-hover);
}
.total{display:none}
.methods{gap:8px}
.methods button{
  height:44px;
  border-color:var(--border-strong);
  border-radius:10px;
  background:var(--raised);
  font-weight:750;
}
.methods button.active{
  border-color:rgb(242 13 50 / 52%);
  background:var(--brand-soft);
  color:#fff;
  box-shadow:inset 0 0 0 1px rgb(242 13 50 / 12%);
}
.charge{
  height:50px;
  margin-top:12px;
  border-radius:11px;
  background:var(--green);
  color:#fff;
  font-size:13px;
  font-weight:850;
  box-shadow:0 10px 26px rgb(34 197 94 / 12%);
}
.charge:not(:disabled):hover{filter:brightness(1.06)}
.charge:disabled{background:var(--surface-active);color:var(--muted);box-shadow:none}
.stock-list{gap:10px}
.stock-card{
  min-height:150px;
  border-color:var(--line);
  border-radius:14px;
  background:linear-gradient(145deg,rgb(25 25 29 / 96%),rgb(18 18 21 / 96%));
  box-shadow:0 10px 28px rgb(0 0 0 / 12%);
}
.stock-card b{font-weight:800}
.stock-card strong{font-weight:850}
.stock-card button{
  height:42px;
  border-color:var(--border-strong);
  border-radius:10px;
  background:var(--surface-hover);
  font-weight:750;
}
.login{
  position:relative;
  max-width:440px;
  margin:8vh auto;
  padding:26px;
  overflow:hidden;
  border-color:var(--line);
  border-radius:20px;
  background:linear-gradient(145deg,rgb(25 25 29 / 98%),rgb(17 17 20 / 98%));
  box-shadow:var(--shadow-panel);
}
.login-brand{
  position:relative;
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:28px;
}
.login-brand__mark{
  display:grid;
  width:46px;
  height:46px;
  place-items:center;
  border:1px solid rgb(242 13 50 / 28%);
  border-radius:13px;
  background:var(--brand-soft);
  color:#fff;
  font-size:15px;
  font-weight:900;
  letter-spacing:0;
}
.login-brand div{display:flex;flex-direction:column;gap:2px}
.login-brand strong{font-size:14px}
.login-brand span{
  color:var(--subtle);
  font-size:9px;
  font-weight:800;
  letter-spacing:.14em;
  text-transform:uppercase;
}
.login h1{
  position:relative;
  margin-bottom:8px;
  font-size:27px;
  font-weight:850;
  letter-spacing:0;
}
.login p{position:relative;font-size:13px}
.field span{font-weight:750}
.field input,.field select{
  height:48px;
  border-color:var(--border-strong);
  border-radius:11px;
  background:var(--raised);
}
.field input:focus,.field select:focus{
  border-color:var(--red);
  box-shadow:0 0 0 3px var(--brand-soft);
}
.primary{
  height:48px;
  border-radius:11px;
  background:var(--red);
  font-size:13px;
  font-weight:850;
}
.primary:not(:disabled):hover{background:#ff2447}
.notice{font-size:11px}
.overlay{
  background:rgb(9 9 11 / 82%);
  backdrop-filter:blur(10px);
}
.panel{
  border-color:var(--line);
  border-radius:18px;
  background:linear-gradient(145deg,rgb(25 25 29 / 100%),rgb(17 17 20 / 100%));
  box-shadow:var(--shadow-panel);
}
.panel h2{font-weight:850;letter-spacing:0}
.panel-eyebrow{
  display:block;
  margin-bottom:7px;
  color:var(--red);
  font-size:9px;
  font-weight:850;
  letter-spacing:.12em;
  text-transform:uppercase;
}
.link{min-height:40px;margin-top:4px}
.empty{color:var(--muted)}
@media(min-width:761px){
  details.cart:not([open])>.cart-body{display:block}
  .cart-title{cursor:default}
}
@media(max-width:760px){
  body{padding-bottom:104px}
  header{
    display:grid;
    grid-template-columns:minmax(0,1fr) auto;
    gap:8px 10px;
    min-height:0;
    padding:11px 13px 9px;
  }
  .brand{gap:9px}
  .brand-word{min-width:54px;height:34px;border-radius:9px;font-size:14px}
  .brand-copy small{font-size:8px}
  .brand-copy b{font-size:12px}
  .status{min-height:30px;padding:0 9px;font-size:10px}
  .operator{
    display:block;
    grid-column:1/-1;
    padding-top:7px;
    border-top:1px solid rgb(44 44 51 / 72%);
    color:var(--subtle);
    font-size:10px;
    text-align:left;
  }
  .operator:empty{display:none}
  .operator b{display:inline;margin-right:6px;color:var(--muted);font-size:10px}
  main{padding:12px 10px 24px}
  #app{gap:12px}
  .tabs{
    position:sticky;
    top:78px;
    z-index:4;
    width:100%;
    align-self:stretch;
    border-radius:11px;
    box-shadow:0 8px 24px rgb(0 0 0 / 20%);
  }
  .tab{min-width:0;flex:1;height:39px}
  .view-head{margin:6px 2px 12px}
  .view-head h1{font-size:25px}
  .view-head p{font-size:12px}
  .search-shell{margin-bottom:10px}
  .search{height:46px;border-radius:11px}
  .layout{display:block}
  .catalog{
    grid-template-columns:repeat(2,minmax(0,1fr));
    gap:8px;
  }
  .product{
    min-height:142px;
    padding:13px;
    border-radius:13px;
    box-shadow:none;
  }
  .product b{font-size:14px;white-space:normal;line-height:1.25}
  .product span{font-size:9px}
  .product strong{padding-top:14px;font-size:18px}
  .stock{font-size:9px}
  details.cart{
    position:fixed;
    right:10px;
    bottom:max(10px,env(safe-area-inset-bottom));
    left:10px;
    z-index:15;
    max-height:82vh;
    border-radius:16px;
    background:rgb(23 23 27 / 98%);
    box-shadow:0 18px 60px rgb(0 0 0 / 54%);
    backdrop-filter:blur(18px);
  }
  details.cart[open]{border-color:var(--border-strong)}
  .cart-title{
    min-height:64px;
    padding:11px 14px;
    border-bottom:0;
  }
  details.cart[open] .cart-title{border-bottom:1px solid var(--line)}
  .cart-kicker{font-size:12px}
  #cart-count{font-size:10px}
  .cart-title #total{font-size:19px}
  .cart-body{
    max-height:calc(82vh - 64px);
    overflow:auto;
    padding:0 14px 14px;
    overscroll-behavior:contain;
  }
  #cart{max-height:35vh;overflow:auto}
  .line{padding:12px 0}
  .quantity{gap:8px}
  .quantity button{width:36px;height:36px}
  .methods{position:sticky;bottom:62px;padding-top:10px;background:rgb(23 23 27 / 98%)}
  .methods button{height:45px}
  .charge{
    position:sticky;
    bottom:0;
    height:52px;
    margin-top:9px;
    box-shadow:0 -12px 24px rgb(23 23 27 / 90%);
  }
  #inventory .view-head{margin-top:6px}
  .stock-list{grid-template-columns:1fr;gap:8px}
  .stock-card{
    display:grid;
    min-height:0;
    grid-template-columns:minmax(0,1fr) auto;
    grid-template-areas:"name qty" "kind qty" "action action";
    align-items:center;
    gap:3px 12px;
    padding:13px;
    border-radius:13px;
    box-shadow:none;
  }
  .stock-card b{grid-area:name;font-size:14px}
  .stock-card span{grid-area:kind;margin:0;color:var(--subtle);font-size:10px}
  .stock-card strong{grid-area:qty;margin:0;font-size:19px}
  .stock-card button{grid-area:action;width:100%;margin-top:9px}
  .login{
    margin:5vh 2px;
    padding:22px 18px;
    border-radius:18px;
  }
  .login-brand{margin-bottom:24px}
  .login h1{font-size:24px}
  .overlay{
    align-items:end;
    padding:0;
  }
  .panel{
    width:100%;
    max-height:92vh;
    overflow:auto;
    padding:20px 16px calc(18px + env(safe-area-inset-bottom));
    border-right:0;
    border-bottom:0;
    border-left:0;
    border-radius:20px 20px 0 0;
  }
  .split{grid-template-columns:1fr;gap:0}
}
@media(max-width:360px){
  .catalog{grid-template-columns:1fr}
  .product{min-height:124px}
}
`;

const searchIcon =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

export function cashierPage(_options: CashierPageOptions): Response {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#09090b"><link rel="manifest" href="/cashier/manifest.webmanifest"><title>GTRZ Mobile</title><style>${cashierStyles}</style><style>${cashierVisualStyles}</style></head><body><header><div class="brand"><span class="brand-word">GTRZ</span><div class="brand-copy"><small>System</small><b>Operação mobile</b></div></div><span class="status" id="status"><i></i><span>Verificando</span></span><div class="operator" id="operator"></div></header><main><section class="login hidden" id="login"><div class="login-brand"><span class="login-brand__mark">GTRZ</span><div><strong>GTRZ System</strong><span>Operação mobile</span></div></div><h1>Entrar na operação</h1><p>Use sua senha de trabalho para acessar o caixa deste evento. A sessão permanece ativa até a Produção encerrá-la.</p><form id="login-form"><label class="field"><span>Senha de acesso</span><input id="password" type="password" autocomplete="current-password" required autofocus></label><button class="primary">Entrar</button><div class="notice" id="login-error"></div></form></section><section id="app" class="hidden"><nav class="tabs" id="tabs"></nav><section id="sales"><div class="layout"><section><div class="view-head"><div><span class="view-eyebrow">Operação rápida</span><h1>Vendas</h1><p>Encontre o produto e toque para adicionar à venda.</p></div></div><label class="search-shell">${searchIcon}<input class="search" id="search" placeholder="Buscar produto" aria-label="Buscar produto"></label><div class="catalog" id="catalog"></div></section><details class="cart"><summary class="cart-title"><span class="cart-title__identity"><span class="cart-kicker">Venda atual</span><span id="cart-count"></span></span><strong id="total">R$ 0,00</strong></summary><div class="cart-body"><div id="cart"></div><div class="total"><span>Total</span><strong>Resumo no topo</strong></div><div class="methods" id="methods"><button data-method="cash">Dinheiro</button><button data-method="pix">PIX</button><button data-method="credit-card">Crédito</button><button data-method="debit-card">Débito</button></div><button class="charge" id="charge" disabled>Conexão necessária</button></div></details></div></section><section id="inventory" class="hidden"><div class="view-head"><div><span class="view-eyebrow">Controle operacional</span><h1>Estoque</h1><p>Consulte saldos e registre entradas ou baixas em tempo real.</p></div></div><label class="search-shell">${searchIcon}<input class="search" id="stock-search" placeholder="Buscar produto" aria-label="Buscar produto no estoque"></label><div class="stock-list" id="stock-list"></div></section></section></main><section class="overlay hidden" id="result"><div class="panel"><span class="panel-eyebrow">GTRZ System</span><h2 id="result-title"></h2><p id="result-text" class="subtle"></p><button class="primary" id="result-close">Continuar</button></div></section><section class="overlay hidden" id="movement"><div class="panel"><span class="panel-eyebrow">Estoque</span><h2 id="movement-title">Movimentar estoque</h2><form id="movement-form"><input id="movement-product" type="hidden"><div class="split"><label class="field"><span>Movimento</span><select id="movement-type"><option value="purchase">Entrada por compra</option><option value="correction-positive">Ajuste positivo</option><option value="return">Devolução</option><option value="correction-negative">Ajuste negativo</option><option value="loss">Perda</option><option value="breakage">Quebra</option><option value="internal-consumption">Consumo interno</option><option value="courtesy">Cortesia</option></select></label><label class="field"><span>Quantidade</span><input id="movement-quantity" type="number" min="1" step="1" required></label></div><label class="field" id="purchase-cost"><span>Valor total pago</span><input id="movement-cost" type="number" min="0.01" step="0.01" inputmode="decimal"><small id="purchase-total">Informe o total pago; o sistema calcula o custo médio.</small></label><label class="field"><span>Observação</span><input id="movement-note" maxlength="240" placeholder="Opcional"></label><button class="primary">Confirmar movimento</button><button class="link" id="movement-cancel" type="button">Cancelar</button></form></div></section><script>${cashierClientScript}</script></body></html>`,
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
    background_color: '#09090b',
    theme_color: '#09090b',
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
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#09090b"/><rect x="72" y="72" width="368" height="368" rx="58" fill="#f20d32"/><path fill="#fff" d="M153 155h206v54H214v38h120v51H214v60h145v54H153z"/></svg>',
    { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } },
  );
}