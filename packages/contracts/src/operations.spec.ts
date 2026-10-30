import { describe, expect, it } from 'vitest';

import { orderItemSchema, paymentSchema } from './operations';

const orderId = 'bd01b2f5-b155-40bf-a82f-9bdc9ba30654';

describe('operation output contracts', () => {
  it('accepts deterministic child identifiers from canonical mobile sales', () => {
    expect(
      orderItemSchema.parse({
        id: '2c10fd1f-aa9b-4a9c-9424-bdc5772ea539:0',
        orderId,
        itemKind: 'product',
        itemId: '8a0147c6-6883-4eeb-969f-368f1afbcccd',
        itemName: 'AREPA DE CARNE MECHADA',
        quantity: 1,
        unitPriceCents: 1400,
        totalCents: 1400,
        componentAllocations: [],
        createdAt: 1790614413811,
      }).id,
    ).toBe('2c10fd1f-aa9b-4a9c-9424-bdc5772ea539:0');

    expect(
      paymentSchema.parse({
        id: '2c10fd1f-aa9b-4a9c-9424-bdc5772ea539:payment',
        orderId,
        method: 'cash',
        amountCents: 1400,
        receivedCents: null,
        changeCents: 0,
        feeRateBasisPoints: null,
        feeCents: null,
        createdAt: 1790614413811,
      }).id,
    ).toBe('2c10fd1f-aa9b-4a9c-9424-bdc5772ea539:payment');
  });

  it('still rejects an empty persisted record identifier', () => {
    expect(() =>
      paymentSchema.parse({
        id: '',
        orderId,
        method: 'cash',
        amountCents: 1400,
        receivedCents: null,
        changeCents: 0,
        feeRateBasisPoints: null,
        feeCents: null,
        createdAt: 1790614413811,
      }),
    ).toThrow();
  });
});
