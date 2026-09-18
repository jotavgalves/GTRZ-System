import { describe, expect, it } from 'vitest';

import {
  createCategoryInputSchema,
  createProductInputSchema,
  inventoryProductSchema,
  recordStockMovementInputSchema,
} from './inventory';

describe('inventory contracts', () => {
  it('normaliza categoria e produto antes de atravessar o IPC', () => {
    expect(createCategoryInputSchema.parse({ name: '  Cervejas  ' })).toEqual({
      name: 'Cervejas',
    });
    expect(
      createProductInputSchema.parse({
        categoryId: '85ffbb3f-6d4c-43d3-b615-e437fd5d88f4',
        name: '  Budweiser lata  ',
        kind: 'drink',
        costCents: 600,
        salePriceCents: 1_000,
        lowStockThreshold: 3,
        comboOnly: false,
      }),
    ).toMatchObject({ name: 'Budweiser lata', costCents: 600, salePriceCents: 1_000 });
  });

  it('rejeita quantidades inválidas e valores monetários negativos', () => {
    expect(() =>
      recordStockMovementInputSchema.parse({
        productId: '85ffbb3f-6d4c-43d3-b615-e437fd5d88f4',
        type: 'loss',
        quantity: 0,
      }),
    ).toThrow();
    expect(() =>
      createProductInputSchema.parse({
        categoryId: '85ffbb3f-6d4c-43d3-b615-e437fd5d88f4',
        name: 'Produto inválido',
        kind: 'food',
        costCents: -1,
        salePriceCents: 1_000,
        lowStockThreshold: 0,
      }),
    ).toThrow();
  });

  it('exige o valor total quando a entrada é uma compra', () => {
    const base = {
      productId: '85ffbb3f-6d4c-43d3-b615-e437fd5d88f4',
      type: 'purchase' as const,
      quantity: 12,
    };
    expect(() => recordStockMovementInputSchema.parse(base)).toThrow(
      'Informe o valor total pago nesta compra.',
    );
    expect(recordStockMovementInputSchema.parse({ ...base, purchaseTotalCents: 3_600 })).toMatchObject({
      purchaseTotalCents: 3_600,
    });
  });

  it('aceita visão de Caixa sem informações financeiras', () => {
    expect(
      inventoryProductSchema.parse({
        id: '85ffbb3f-6d4c-43d3-b615-e437fd5d88f4',
        categoryId: '725a7e97-e95f-4557-a020-d485eba6b3a1',
        categoryName: 'Cervejas',
        name: 'Budweiser lata',
        kind: 'drink',
        salePriceCents: 1_000,
        lowStockThreshold: 3,
        comboOnly: false,
        active: true,
        quantity: 7,
        soldQuantity: 0,
        lowStock: false,
        financials: null,
        imageDataUrl: null,
        fallbackIcon: 'package',
        createdAt: 1_786_000_000_000,
        updatedAt: 1_786_000_000_000,
      }),
    ).toMatchObject({ financials: null, quantity: 7 });
  });
});
