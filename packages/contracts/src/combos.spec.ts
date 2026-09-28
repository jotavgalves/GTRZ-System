import { describe, expect, it } from 'vitest';

import { comboSchema, createComboInputSchema } from './combos';

const firstProductId = '85ffbb3f-6d4c-43d3-b615-e437fd5d88f4';
const secondProductId = '725a7e97-e95f-4557-a020-d485eba6b3a1';

describe('combo contracts', () => {
  it('normaliza o nome e aceita componentes distintos', () => {
    expect(
      createComboInputSchema.parse({
        name: '  Balde Budweiser  ',
        salePriceCents: 9_000,
        components: [
          { productId: firstProductId, quantity: 10 },
          { productId: secondProductId, quantity: 1 },
        ],
      }),
    ).toEqual({
      name: 'Balde Budweiser',
      salePriceCents: 9_000,
      components: [
        { productId: firstProductId, quantity: 10 },
        { productId: secondProductId, quantity: 1 },
      ],
    });
  });

  it('aceita o mesmo produto em escolhas diferentes e rejeita repetição na mesma escolha', () => {
    expect(
      createComboInputSchema.parse({
        name: 'Pasaporte Latino',
        salePriceCents: 3_000,
        components: [
          {
            productId: firstProductId,
            quantity: 2,
            choiceGroup: 'arepas-principais',
            choiceLabel: 'Escolha as 2 arepas principais',
          },
          {
            productId: secondProductId,
            quantity: 2,
            choiceGroup: 'arepas-principais',
            choiceLabel: 'Escolha as 2 arepas principais',
          },
          {
            productId: firstProductId,
            quantity: 1,
            choiceGroup: 'acompanhamento',
            choiceLabel: 'Escolha o acompanhamento',
          },
          {
            productId: secondProductId,
            quantity: 1,
            choiceGroup: 'acompanhamento',
            choiceLabel: 'Escolha o acompanhamento',
          },
        ],
      }),
    ).toMatchObject({ name: 'Pasaporte Latino' });
    expect(() =>
      createComboInputSchema.parse({
        name: 'Combo inválido',
        salePriceCents: 1_800,
        components: [
          {
            productId: firstProductId,
            quantity: 1,
            choiceGroup: 'arepas',
            choiceLabel: 'Escolha as arepas',
          },
          {
            productId: firstProductId,
            quantity: 1,
            choiceGroup: 'arepas',
            choiceLabel: 'Escolha as arepas',
          },
        ],
      }),
    ).toThrow('Um produto não pode repetir dentro da mesma parte do combo.');
  });

  it('aceita a visão comercial do Caixa sem custos', () => {
    expect(
      comboSchema.parse({
        id: 'd3b6e421-a873-4713-a2ff-e5439a84b948',
        name: 'Balde Budweiser',
        salePriceCents: 9_000,
        individualSaleTotalCents: 10_000,
        savingsCents: 1_000,
        availableUnits: 3,
        active: true,
        components: [
          {
            productId: firstProductId,
            productName: 'Budweiser lata',
            quantity: 10,
            salePriceCents: 1_000,
            availableQuantity: 34,
          },
        ],
        financials: null,
        createdAt: 1_786_000_000_000,
        updatedAt: 1_786_000_000_000,
      }),
    ).toMatchObject({ availableUnits: 3, financials: null, savingsCents: 1_000 });
  });
});
