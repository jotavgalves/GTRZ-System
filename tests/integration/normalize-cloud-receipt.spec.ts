import { describe, expect, it } from 'vitest';

import type { ClaimedCloudPrintJob } from '../../apps/desktop/src/main/cloud-sync-service';
import { normalizeCloudReceipt } from '../../apps/desktop/src/main/normalize-cloud-receipt';
import { buildReceiptHtml } from '../../apps/desktop/src/main/receipt-html';

describe('cloud print receipt', () => {
  it('renders a mobile sale document with journal item names and choices', async () => {
    const document: ClaimedCloudPrintJob['document'] = {
      orderId: 'sample-order',
      eventName: 'Evento teste',
      servicePointLabel: 'Mesa 1',
      servicePointType: 'table',
      subtotalCents: 1500,
      discountCents: 0,
      totalCents: 1500,
      closedAt: 1_800_000_000_000,
      operatorName: 'Caixa',
      originLabel: 'Mobile',
      items: [
        {
          itemName: 'Combo de comida',
          quantity: 1,
          unitPriceCents: 1500,
          totalCents: 1500,
          componentAllocations: [
            {
              choiceGroup: 'Sabor',
              choiceLabel: 'Escolha o sabor',
              productName: 'Arepa de frango',
              quantity: 1,
            },
          ],
        },
      ],
      payments: [{ method: 'pix', amountCents: 1500, receivedCents: null, changeCents: 0 }],
      vouchers: [],
      documentType: 'sale-batch',
    };

    const normalized = normalizeCloudReceipt(document);
    const html = await buildReceiptHtml(normalized, 80);
    expect(normalized.items[0]?.name).toBe('Combo de comida');
    expect(html).toContain('Combo de comida');
    expect(html).toContain('Escolha o sabor: 1× Arepa de frango');
  });
});
