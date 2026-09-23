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
      preparation: [
        { label: 'Escolha as arepas', productName: 'Arepa de frango', quantity: 1 },
        { label: 'Escolha as arepas', productName: 'Arepa de carne', quantity: 1 },
      ],
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
  it('gera comprovante do cliente e vale de retirada na mesma impressão', async () => {
    const html = await buildReceiptHtml(receipt, 58);

    expect(html).toContain('width: 58mm');
    expect(html).toContain('NOTA DE COMPRA');
    expect(html).toContain('VALE DE RETIRADA');
    expect(html).toContain('La Rumba Teste');
    expect(html).toContain('2× Budweiser');
    expect(html).toContain('Escolha as arepas: 1× Arepa de frango');
    expect(html).toContain('Escolha as arepas: 1× Arepa de carne');
    expect(html).toContain('JOÃO');
    expect(html).toContain('ATENDENTE:');
    expect(html).toContain('Dinheiro');
    expect(html).toContain('R$ 10,00');
    expect(html).toContain('CÓDIGO:');
    expect(html).toContain('page-break-after:always');
  });

  it('dimensiona a altura conforme o conteúdo com limites seguros', () => {
    expect(estimateReceiptHeightMm(receipt)).toBeGreaterThanOrEqual(140);
    expect(estimateReceiptHeightMm(receipt)).toBeLessThanOrEqual(700);
  });
});
