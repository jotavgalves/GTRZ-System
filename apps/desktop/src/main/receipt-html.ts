import { readFileSync } from 'node:fs';
import path from 'node:path';

import QRCode from 'qrcode';

import type { DatabaseOrderReceipt } from '@gtrz/database/printing';

const PAYMENT_LABELS = {
  cash: 'Dinheiro',
  pix: 'PIX',
  'credit-card': 'Cartão de crédito',
  'debit-card': 'Cartão de débito',
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function money(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function dateParts(timestamp: number): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(timestamp);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${read('day')}/${read('month')}/${read('year')}`,
    time: `${read('hour')}:${read('minute')}:${read('second')}`,
  };
}

function wordmarkDataUri(): string {
  try {
    const source = readFileSync(
      path.join(process.resourcesPath, 'branding', 'gtrz-wordmark.svg'),
      'utf8',
    ).replaceAll('#fff', '#000');
    return `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
  } catch {
    return '';
  }
}

function shortOrder(receipt: DatabaseOrderReceipt): string {
  return receipt.orderId.replaceAll('-', '').slice(-4).toUpperCase();
}

function referenceCode(receipt: DatabaseOrderReceipt): string {
  return (
    receipt.referenceCode ?? `${receipt.eventName.slice(0, 8).toUpperCase()}-${shortOrder(receipt)}`
  );
}

function header(logo: string): string {
  return logo.length > 0
    ? `<img class="brand" src="${logo}" alt="GTRZ Eventos" />`
    : '<p class="brand-fallback">GTRZ EVENTOS</p>';
}

function eventBlock(receipt: DatabaseOrderReceipt): string {
  const timestamp = dateParts(receipt.closedAt);
  return `<section class="event-block"><span><b>EVENTO</b><strong>${escapeHtml(receipt.eventName)}</strong></span><span><b>DATA</b><strong>${timestamp.date}</strong></span><span><b>HORA</b><strong>${timestamp.time}</strong></span></section>`;
}

function itemRows(receipt: DatabaseOrderReceipt, withValue: boolean): string {
  return receipt.items
    .map((item) => {
      const preparation = (item.preparation ?? [])
        .map(
          (choice) =>
            `<tr class="preparation"><td></td><td${withValue ? '' : ' colspan="2"'}>↳ ${escapeHtml(choice.label)}: ${String(choice.quantity)}× ${escapeHtml(choice.productName)}</td>${withValue ? '<td></td>' : ''}</tr>`,
        )
        .join('');
      return `<tr><td>${String(item.quantity)}</td><td>${escapeHtml(item.name)}</td>${withValue ? `<td class="right">${money(item.unitPriceCents)}</td>` : ''}</tr>${preparation}`;
    })
    .join('');
}

function clientReceipt(receipt: DatabaseOrderReceipt, logo: string, qr: string): string {
  const paymentRows = receipt.payments
    .map(
      (payment) =>
        `<div class="line"><span>${PAYMENT_LABELS[payment.method]}</span><strong>${money(payment.amountCents)}</strong></div>`,
    )
    .join('');
  return `<section class="receipt page-break">
    ${header(logo)}<div class="rule"></div><h1>NOTA DE COMPRA</h1>${eventBlock(receipt)}
    <div class="order-line"><span>ATENDENTE: <b>${escapeHtml((receipt.operatorName ?? 'GTRZ').toLocaleUpperCase('pt-BR'))}</b></span><span>PEDIDO Nº: <b>${shortOrder(receipt)}</b></span></div>
    <table><thead><tr><th>QTD</th><th>PRODUTO</th><th class="right">VALOR</th></tr></thead><tbody>${itemRows(receipt, true)}</tbody></table>
    <div class="rule dashed"></div><div class="line total"><span>TOTAL</span><strong>${money(receipt.totalCents)}</strong></div><div class="rule"></div>
    <strong class="section-title">PAGAMENTO</strong>${paymentRows}
    <div class="qr-row"><img src="${qr}" alt="Código do pedido" /><div><span>CÓDIGO: ${escapeHtml(referenceCode(receipt))}</span><small>${dateParts(receipt.closedAt).date} ${dateParts(receipt.closedAt).time}</small></div></div>
    <p class="footer">Obrigado por fazer parte!</p><p class="footer-sub">GTRZ EVENTOS</p>
  </section>`;
}

function pickupVoucher(receipt: DatabaseOrderReceipt, logo: string, qr: string): string {
  return `<section class="receipt">
    ${header(logo)}<h1 class="banner">VALE DE RETIRADA</h1><p class="instruction">ENTREGUE ESTE COMPROVANTE NO BAR<br>PARA RETIRAR SEU PEDIDO</p>${eventBlock(receipt)}
    <div class="order-line"><span>PEDIDO Nº: <b>${shortOrder(receipt)}</b></span><span>ATENDENTE: <b>${escapeHtml((receipt.operatorName ?? 'GTRZ').toLocaleUpperCase('pt-BR'))}</b></span></div>
    <table><thead><tr><th>QTD</th><th>PRODUTO</th></tr></thead><tbody>${itemRows(receipt, false)}</tbody></table>
    <div class="rule dashed"></div><div class="qr-row"><img src="${qr}" alt="Código do pedido" /><div><span>CÓDIGO: ${escapeHtml(referenceCode(receipt))}</span><small>${dateParts(receipt.closedAt).date} ${dateParts(receipt.closedAt).time}</small></div></div>
    <p class="footer">BOM EVENTO!</p><p class="footer-sub">GTRZ EVENTOS</p>
  </section>`;
}

function internalReceipt(receipt: DatabaseOrderReceipt, logo: string): string {
  return `<section class="receipt">
    ${header(logo)}<h1 class="banner">BAIXA INTERNA</h1><p class="instruction">NÃO REPRESENTA VENDA</p>${eventBlock(receipt)}
    <div class="order-line"><span>BAIXA Nº: <b>${shortOrder(receipt)}</b></span><span>OPERADOR: <b>${escapeHtml((receipt.operatorName ?? 'GTRZ').toLocaleUpperCase('pt-BR'))}</b></span></div>
    <section class="reason"><small>MOTIVO</small><strong>${escapeHtml(receipt.internalReason ?? 'CONSUMO INTERNO')}</strong></section>
    <table><thead><tr><th>QTD</th><th>PRODUTO</th></tr></thead><tbody>${itemRows(receipt, false)}</tbody></table>
    ${receipt.recipient === undefined ? '' : `<p class="detail">DESTINATÁRIO: <b>${escapeHtml(receipt.recipient)}</b></p>`}
    ${receipt.authorizedBy === undefined ? '' : `<p class="detail">AUTORIZADO POR: <b>${escapeHtml(receipt.authorizedBy)}</b></p>`}
    <div class="rule dashed"></div><p class="code">CÓDIGO: ${escapeHtml(referenceCode(receipt))}</p><p class="footer">USO INTERNO</p><p class="footer-sub">GTRZ EVENTOS</p>
  </section>`;
}

export function estimateReceiptHeightMm(receipt: DatabaseOrderReceipt): number {
  const preparationLines = receipt.items.reduce(
    (total, item) => total + (item.preparation?.length ?? 0),
    0,
  );
  return Math.max(115, Math.min(145 + receipt.items.length * 8 + preparationLines * 5, 360));
}

export async function buildReceiptHtml(
  receipt: DatabaseOrderReceipt,
  paperWidthMm: 58 | 80,
): Promise<string> {
  const code = referenceCode(receipt);
  const qr = await QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 0, width: 180 });
  const logo = wordmarkDataUri();
  const internal = receipt.documentType === 'internal-decrement';
  const documents = internal
    ? internalReceipt(receipt, logo)
    : `${clientReceipt(receipt, logo, qr)}${pickupVoucher(receipt, logo, qr)}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>GTRZ Eventos</title><style>
    @page { margin: 0; } * { box-sizing: border-box; } html,body { margin:0; padding:0; background:#fff; color:#000; }
    body { width:${String(paperWidthMm)}mm; padding:3mm; font-family:Arial,sans-serif; font-size:${paperWidthMm === 58 ? '9px' : '11px'}; letter-spacing:.025em; }
    .receipt { min-height:100mm; text-align:left; } .page-break { break-after:page; page-break-after:always; } .brand { display:block; width:44mm; max-width:86%; margin:0 auto 2mm; } .brand-fallback { text-align:center; font-weight:900; font-size:1.5em; margin:0 0 2mm; }
    h1 { margin:0; padding:1.3mm 0; text-align:center; font-size:1.35em; letter-spacing:.08em; } .banner { margin-top:1mm; border-radius:1mm; background:#000; color:#fff; } .rule { border-top:1px solid #000; margin:2mm 0; } .dashed { border-top-style:dashed; }
    .instruction,.footer,.footer-sub,.code { margin:1.5mm 0; text-align:center; font-weight:700; } .footer-sub { font-size:.8em; letter-spacing:.14em; } .event-block { display:grid; grid-template-columns:1.1fr 1.1fr .85fr; margin:2mm 0; padding:1.5mm; background:#f0f0f0; } .event-block span { padding:0 1.5mm; border-right:1px solid #bbb; } .event-block span:last-child { border:0; } .event-block b,.event-block strong { display:block; } .event-block b,small { font-size:.75em; } .event-block strong { margin-top:.8mm; font-size:1.1em; }
    .order-line,.line { display:flex; justify-content:space-between; gap:2mm; padding:1.2mm 0; } table { width:100%; border-collapse:collapse; margin-top:1.5mm; } th { padding:1.3mm; background:#ececec; text-align:left; font-size:.82em; } td { padding:1.3mm; border-bottom:1px dotted #999; } th:first-child,td:first-child { width:12%; text-align:center; font-weight:800; } .right { text-align:right; white-space:nowrap; font-weight:800; } .total { font-size:1.4em; font-weight:900; } .section-title { display:block; margin-bottom:.5mm; } .qr-row { display:flex; align-items:center; gap:3mm; margin:3mm 0; } .qr-row img { width:21mm; height:21mm; image-rendering:pixelated; } .qr-row span,.qr-row small { display:block; } .reason { margin:2mm 0; padding:2mm; background:#eee; } .reason small,.reason strong { display:block; } .reason strong { margin-top:1mm; font-size:1.3em; } .detail { margin:1.5mm 0; }
  </style></head><body>${documents}</body></html>`;
}
