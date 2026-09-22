import type { DatabaseOrderReceipt } from '@gtrz/database/printing';

const PAYMENT_LABELS = {
  cash: 'Dinheiro',
  pix: 'PIX',
  'credit-card': 'Crédito',
  'debit-card': 'Débito',
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
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(timestamp);
}

export function estimateReceiptHeightMm(receipt: DatabaseOrderReceipt): number {
  const contentHeight =
    115 + receipt.items.length * 9 + receipt.payments.length * 8 + receipt.vouchers.length * 8;
  return Math.max(140, Math.min(contentHeight, 700));
}

export function buildReceiptHtml(receipt: DatabaseOrderReceipt, paperWidthMm: 58 | 80): string {
  const itemRows = receipt.items
    .map(
      (item) => `
        <tr>
          <td>${String(item.quantity)}× ${escapeHtml(item.name)}</td>
          <td class="right">${escapeHtml(formatMoney(item.unitPriceCents))}</td>
          <td class="right">${escapeHtml(formatMoney(item.totalCents))}</td>
        </tr>`,
    )
    .join('');
  const paymentRows = receipt.payments
    .map(
      (payment) => `
        <div class="line"><span>${PAYMENT_LABELS[payment.method]}</span><strong>${escapeHtml(formatMoney(payment.amountCents))}</strong></div>
        ${
          payment.method === 'cash' && payment.receivedCents !== null
            ? `<div class="subline"><span>Recebido</span><span>${escapeHtml(formatMoney(payment.receivedCents))}</span></div>`
            : ''
        }
        ${
          payment.changeCents > 0
            ? `<div class="subline"><span>Troco</span><strong>${escapeHtml(formatMoney(payment.changeCents))}</strong></div>`
            : ''
        }`,
    )
    .join('');
  const voucherRows = receipt.vouchers
    .map(
      (voucher) => `
        <div class="line"><span>Voucher ${escapeHtml(voucher.code)}</span><strong>${escapeHtml(formatMoney(voucher.amountCents))}</strong></div>`,
    )
    .join('');
  const servicePointType = receipt.servicePointType === 'counter' ? 'Balcão' : 'Mesa';
  const sourceRows = [
    receipt.operatorName === undefined
      ? ''
      : `<span>Operador: <strong>${escapeHtml(receipt.operatorName)}</strong></span>`,
    receipt.originLabel === undefined
      ? ''
      : `<span>Origem: <strong>${escapeHtml(receipt.originLabel)}</strong></span>`,
    receipt.printedByLabel === undefined
      ? ''
      : `<span>Impresso em: <strong>${escapeHtml(receipt.printedByLabel)}</strong></span>`,
  ].join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>GTRZ System · Retirada</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { width: ${String(paperWidthMm)}mm; padding: 3mm; font-family: "Courier New", monospace; font-size: ${paperWidthMm === 58 ? '10px' : '12px'}; line-height: 1.3; }
  h1, h2, p { margin: 0; }
  h1 { font-size: 1.35em; text-align: center; }
  .center { text-align: center; }
  .divider { border-top: 1px dashed #000; margin: 2.5mm 0; }
  .meta { display: grid; gap: 1mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 1mm 0; vertical-align: top; }
  th { border-bottom: 1px solid #000; text-align: left; }
  .right { text-align: right; white-space: nowrap; }
  .line, .subline { display: flex; justify-content: space-between; gap: 2mm; }
  .subline { font-size: .92em; }
  .total { font-size: 1.15em; font-weight: 700; }
  .pickup { margin-top: 3mm; padding: 2.5mm 1.5mm; border: 2px solid #000; font-weight: 800; text-align: center; text-transform: uppercase; }
  .validity { margin-top: 2mm; text-align: center; font-weight: 700; }
  .code { margin-top: 2mm; text-align: center; font-size: .9em; }
</style>
</head>
<body>
  <h1>GTRZ SYSTEM</h1>
  <p class="center">NOTA DE RETIRADA</p>
  <div class="divider"></div>
  <div class="meta">
    <strong>${escapeHtml(receipt.eventName)}</strong>
    <span>${escapeHtml(formatDate(receipt.closedAt))}</span>
    <span>${servicePointType}: <strong>${escapeHtml(receipt.servicePointLabel)}</strong></span>
    ${sourceRows}
  </div>
  <div class="divider"></div>
  <table>
    <thead><tr><th>Item</th><th class="right">Unit.</th><th class="right">Total</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div class="divider"></div>
  <div class="line"><span>Subtotal</span><span>${escapeHtml(formatMoney(receipt.subtotalCents))}</span></div>
  ${receipt.discountCents > 0 ? `<div class="line"><span>Desconto</span><span>-${escapeHtml(formatMoney(receipt.discountCents))}</span></div>` : ''}
  <div class="line total"><span>TOTAL</span><strong>${escapeHtml(formatMoney(receipt.totalCents))}</strong></div>
  <div class="divider"></div>
  <strong>Pagamento</strong>
  ${paymentRows}${voucherRows}
  <div class="pickup">APRESENTE ESTA NOTA NO BAR PARA RETIRAR OS ITENS</div>
  <p class="validity">Válida somente durante o evento.</p>
  <p class="code">Venda ${escapeHtml(receipt.orderId.slice(0, 8).toUpperCase())}</p>
</body>
</html>`;
}
