import { describe, expect, it } from 'vitest';

import type { DatabaseOrderReceipt } from '@gtrz/database/printing';

import { buildReceiptHtml, estimateReceiptHeightMm } from './receipt-html';

const receipt: DatabaseOrderReceipt = {
  orderId: '85ffbb3f-6d4c-43d3-b615-e437fd5d88f4',
  eventName: 'La Rumba Teste',
  servicePointLabel: 'Mesa 12',
  servicePointType: 'table',
  subtotalCents: 2000,
  discountCents: 200,
  totalCents: 1800,
  closedAt: 1_786_000_000_000,
  items: [
    {
      name: 'Budweiser',
      quantity: 2,
      unitPriceCents: 1000,
      totalCents: 2000,
    },
  ],
  payments: [
    {
      method: 'cash',
      amountCents: 1300,
      receivedCents: 1500,
      changeCents: 200,
    },
  ],
  vouchers: [{ code: 'VIP-001', amountCents: 500 }],
  operatorName: 'João',
};

describe('thermal receipt html', () => {
  it('mostra a nota reduzida com operador, itens, total e pagamento sem repetir valores', () => {
    const html = buildReceiptHtml(receipt, 58);

    expect(html).toContain('width: 58mm');
    expect(html).toContain('NOTA DE RETIRADA');
    expect(html).toContain('La Rumba Teste');
    expect(html).toContain('2× Budweiser');
    expect(html).toContain('JOÃO');
    expect(html).toContain('class="operator"');
    expect(html).toContain('Dinheiro');
    expect(html).toContain('Voucher VIP-001');
    expect(html).toContain('Válida somente para o evento e a data indicados.');
    expect(html).toContain('85FFBB3F');
    expect(html).not.toContain('Mesa:');
    expect(html).not.toContain('Subtotal');
    expect(html).not.toContain('Recebido');
    expect(html).not.toContain('Troco');
    expect(html).not.toContain('Origem:');
    expect(html).not.toContain('Impresso em:');
  });

  it('dimensiona a altura conforme o conteúdo com limites seguros', () => {
    expect(estimateReceiptHeightMm(receipt)).toBeGreaterThanOrEqual(140);
    expect(estimateReceiptHeightMm(receipt)).toBeLessThanOrEqual(700);
  });
});
