import { readFileSync } from 'node:fs';
import path from 'node:path';

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

/**
 * The central numbers every note of an event in one atomic sequence (…-0007), so notes issued
 * by several devices at the same moment never share a number. Notes without it fall back to the
 * last characters of the order id.
 */
function orderNumber(receipt: DatabaseOrderReceipt): string {
  return /-(\d{3,})$/u.exec(referenceCode(receipt))?.[1] ?? shortOrder(receipt);
}

function attendant(receipt: DatabaseOrderReceipt): string {
  return escapeHtml((receipt.operatorName ?? 'GTRZ').toLocaleUpperCase('pt-BR'));
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

function orderLines(receipt: DatabaseOrderReceipt): string {
  return `<div class="order-line"><span>PEDIDO Nº: <b class="number">${orderNumber(receipt)}</b></span><span>COMANDA: <b>${escapeHtml(receipt.servicePointLabel)}</b></span></div>
    <div class="order-line"><span>ATENDENTE: <b>${attendant(receipt)}</b></span></div>`;
}

function codeLine(receipt: DatabaseOrderReceipt): string {
  const timestamp = dateParts(receipt.closedAt);
  const station =
    receipt.printedByLabel === undefined ? '' : ` · ${escapeHtml(receipt.printedByLabel)}`;
  return `<p class="code">CÓDIGO: ${escapeHtml(referenceCode(receipt))}<br><small>${timestamp.date} ${timestamp.time}${station}</small></p>`;
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

function clientReceipt(receipt: DatabaseOrderReceipt, logo: string): string {
  const paymentRows = receipt.payments
    .map(
      (payment) =>
        `<div class="line"><span>${PAYMENT_LABELS[payment.method]}</span><strong>${money(payment.amountCents)}</strong></div>`,
    )
    .join('');
  return `<section class="receipt page-break">
    ${header(logo)}<h1>NOTA DE COMPRA</h1>${eventBlock(receipt)}
    ${orderLines(receipt)}
    <table><thead><tr><th>QTD</th><th>PRODUTO</th><th class="right">VALOR</th></tr></thead><tbody>${itemRows(receipt, true)}</tbody></table>
    <div class="rule dashed"></div><div class="line total"><span>TOTAL</span><strong>${money(receipt.totalCents)}</strong></div>
    ${paymentRows}
    ${codeLine(receipt)}
  </section>`;
}

function pickupVoucher(receipt: DatabaseOrderReceipt, logo: string): string {
  return `<section class="receipt">
    ${header(logo)}<h1 class="banner">VALE DE RETIRADA</h1><p class="instruction">ENTREGUE ESTE COMPROVANTE NO BAR<br>PARA RETIRAR SEU PEDIDO</p>${eventBlock(receipt)}
    ${orderLines(receipt)}
    <table><thead><tr><th>QTD</th><th>PRODUTO</th></tr></thead><tbody>${itemRows(receipt, false)}</tbody></table>
    <div class="rule dashed"></div>${codeLine(receipt)}
    <p class="footer">BOM EVENTO!</p>
  </section>`;
}

function internalReceipt(receipt: DatabaseOrderReceipt, logo: string): string {
  return `<section class="receipt">
    ${header(logo)}<h1 class="banner">BAIXA INTERNA</h1><p class="instruction">NÃO REPRESENTA VENDA</p>${eventBlock(receipt)}
    <div class="order-line"><span>BAIXA Nº: <b>${orderNumber(receipt)}</b></span><span>OPERADOR: <b>${attendant(receipt)}</b></span></div>
    <section class="reason"><small>MOTIVO</small><strong>${escapeHtml(receipt.internalReason ?? 'CONSUMO INTERNO')}</strong></section>
    <table><thead><tr><th>QTD</th><th>PRODUTO</th></tr></thead><tbody>${itemRows(receipt, false)}</tbody></table>
    ${receipt.recipient === undefined ? '' : `<p class="detail">DESTINATÁRIO: <b>${escapeHtml(receipt.recipient)}</b></p>`}
    ${receipt.authorizedBy === undefined ? '' : `<p class="detail">AUTORIZADO POR: <b>${escapeHtml(receipt.authorizedBy)}</b></p>`}
    <div class="rule dashed"></div>${codeLine(receipt)}<p class="footer">USO INTERNO</p>
  </section>`;
}

export function estimateReceiptHeightMm(receipt: DatabaseOrderReceipt): number {
  const preparationLines = receipt.items.reduce(
    (total, item) => total + (item.preparation?.length ?? 0),
    0,
  );
  return Math.max(95, Math.min(105 + receipt.items.length * 7 + preparationLines * 4, 330));
}

export function buildReceiptHtml(receipt: DatabaseOrderReceipt, paperWidthMm: 58 | 80): string {
  const logo = wordmarkDataUri();
  const internal = receipt.documentType === 'internal-decrement';
  const documents = internal
    ? internalReceipt(receipt, logo)
    : `${clientReceipt(receipt, logo)}${pickupVoucher(receipt, logo)}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>GTRZ Eventos</title><style>
    @page { margin: 0; } * { box-sizing: border-box; } html,body { margin:0; padding:0; background:#fff; color:#000; }
    body { width:${String(paperWidthMm)}mm; padding:2mm 2.5mm; font-family:Arial,sans-serif; font-size:${paperWidthMm === 58 ? '9px' : '11px'}; letter-spacing:.02em; }
    .receipt { text-align:left; } .page-break { break-after:page; page-break-after:always; } .brand { display:block; width:36mm; max-width:80%; margin:0 auto 1mm; } .brand-fallback { text-align:center; font-weight:900; font-size:1.4em; margin:0 0 1mm; }
    h1 { margin:0; padding:.8mm 0; text-align:center; font-size:1.25em; letter-spacing:.07em; border-top:1px solid #000; } .banner { margin-top:.5mm; border:0; border-radius:1mm; background:#000; color:#fff; } .rule { border-top:1px solid #000; margin:1mm 0; } .dashed { border-top-style:dashed; }
    .instruction,.footer,.code { margin:.8mm 0; text-align:center; font-weight:700; } .event-block { display:grid; grid-template-columns:1.1fr 1.1fr .85fr; margin:1mm 0; padding:1mm; background:#f0f0f0; } .event-block span { padding:0 1.2mm; border-right:1px solid #bbb; } .event-block span:last-child { border:0; } .event-block b,.event-block strong { display:block; } .event-block b,small { font-size:.75em; } .event-block strong { margin-top:.4mm; font-size:1.05em; }
    .order-line,.line { display:flex; justify-content:space-between; gap:2mm; padding:.5mm 0; } .number { font-size:1.35em; } table { width:100%; border-collapse:collapse; margin-top:.8mm; } th { padding:.7mm 1mm; background:#ececec; text-align:left; font-size:.82em; } td { padding:.7mm 1mm; border-bottom:1px dotted #999; } th:first-child,td:first-child { width:12%; text-align:center; font-weight:800; } .right { text-align:right; white-space:nowrap; font-weight:800; } .total { font-size:1.3em; font-weight:900; } .reason { margin:1mm 0; padding:1.5mm; background:#eee; } .reason small,.reason strong { display:block; } .reason strong { margin-top:.6mm; font-size:1.2em; } .detail { margin:.8mm 0; }
  </style></head><body>${documents}</body></html>`;
}
