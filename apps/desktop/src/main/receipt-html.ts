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

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(timestamp);
}

function wordmarkDataUri(): string {
  try {
    const svg = readFileSync(
      path.join(process.resourcesPath, 'branding', 'gtrz-wordmark.svg'),
      'utf8',
    ).replaceAll('#fff', '#000');
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  } catch {
    return '';
  }
}

function operatorLabel(receipt: DatabaseOrderReceipt): string {
  return (receipt.operatorName ?? 'GTRZ').trim().toLocaleUpperCase('pt-BR');
}

export function estimateReceiptHeightMm(receipt: DatabaseOrderReceipt): number {
  const contentHeight =
    82 + receipt.items.length * 8 + receipt.payments.length * 6 + receipt.vouchers.length * 6;
  return Math.max(105, Math.min(contentHeight, 360));
}

export function buildReceiptHtml(receipt: DatabaseOrderReceipt, paperWidthMm: 58 | 80): string {
  const itemRows = receipt.items
    .map(
      (item) => `
        <tr>
          <td>${String(item.quantity)}× ${escapeHtml(item.name)}</td>
          <td class="right">${escapeHtml(formatMoney(item.totalCents))}</td>
        </tr>`,
    )
    .join('');
  const paymentRows = receipt.payments
    .map(
      (payment) => `
        <div class="line"><span>${PAYMENT_LABELS[payment.method]}</span><strong>${escapeHtml(formatMoney(payment.amountCents))}</strong></div>`,
    )
    .join('');
  const voucherRows = receipt.vouchers
    .map(
      (voucher) => `
        <div class="line"><span>Voucher ${escapeHtml(voucher.code)}</span><strong>${escapeHtml(formatMoney(voucher.amountCents))}</strong></div>`,
    )
    .join('');
  const wordmark = wordmarkDataUri();

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>GTRZ · Nota de retirada</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { width: ${String(paperWidthMm)}mm; padding: 3mm; font-family: "Courier New", monospace; font-size: ${paperWidthMm === 58 ? '10px' : '12px'}; line-height: 1.3; }
  p { margin: 0; }
  .brand { display: block; width: 42mm; max-width: 82%; height: auto; margin: 0 auto 1.8mm; }
  .brand-fallback { margin: 0 0 1.8mm; text-align: center; font-size: 1.35em; font-weight: 900; letter-spacing: .08em; }
  .center { text-align: center; }
  .note-title { font-size: .9em; letter-spacing: .08em; }
  .divider { border-top: 1px dashed #000; margin: 2.5mm 0; }
  .event { font-weight: 800; }
  .date { margin-top: .7mm; }
  .operator { display: inline-block; max-width: 100%; margin-top: 2mm; padding: 1.2mm 2.4mm; border: 1.5px solid #000; font-weight: 900; letter-spacing: .05em; overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1.15mm 0; vertical-align: top; }
  tr + tr td { border-top: 1px dotted #777; }
  .right { text-align: right; white-space: nowrap; font-weight: 800; }
  .line { display: flex; justify-content: space-between; gap: 2mm; padding: .75mm 0; }
  .total { padding-top: 1.4mm; font-size: 1.18em; font-weight: 900; }
  .payment-title { display: block; margin-bottom: .6mm; font-weight: 900; }
  .notice { margin-top: 3mm; padding-top: 2mm; border-top: 1px solid #000; text-align: center; font-size: .8em; line-height: 1.35; }
  .code { margin-top: 1.6mm; text-align: center; font-size: .78em; color: #333; }
</style>
</head>
<body>
  ${wordmark.length > 0 ? `<img class="brand" src="${wordmark}" alt="GTRZ" />` : '<p class="brand-fallback">GTRZ</p>'}
  <p class="center note-title">NOTA DE RETIRADA</p>
  <div class="divider"></div>
  <p class="event">${escapeHtml(receipt.eventName)}</p>
  <p class="date">${escapeHtml(formatDate(receipt.closedAt))}</p>
  <p class="center"><strong class="operator">${escapeHtml(operatorLabel(receipt))}</strong></p>
  <div class="divider"></div>
  <table><tbody>${itemRows}</tbody></table>
  <div class="divider"></div>
  <div class="line total"><span>TOTAL</span><strong>${escapeHtml(formatMoney(receipt.totalCents))}</strong></div>
  <div class="divider"></div>
  <strong class="payment-title">PAGAMENTO</strong>
  ${paymentRows}${voucherRows}
  <p class="notice">Válida somente para o evento e a data indicados. Guarde este comprovante: não nos responsabilizamos por perda e não aceitaremos notas rasuradas, rasgadas ou ilegíveis.</p>
  <p class="code">${escapeHtml(receipt.orderId.slice(0, 8).toUpperCase())}</p>
</body>
</html>`;
}
