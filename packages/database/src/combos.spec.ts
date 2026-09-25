import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  bindOrderVoucher,
  cancelOrder,
  closeOrder,
  createCombo,
  deleteCombo,
  createEvent,
  configureFood,
  createExternalFoodItem,
  createFoodSupplier,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  listCombos,
  openOrder,
  openDatabase,
  recordStockMovement,
  switchProfile,
  updateCombo,
  type DatabaseContext,
} from './index';
import { createManagedVoucher } from './voucher-management';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-combos-'));
  return openDatabase(path.join(temporaryDirectory, 'combos.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

function createProducts(database: DatabaseContext): {
  readonly beerId: string;
  readonly snackId: string;
} {
  const category = createProductCategory(database, 'Itens do combo');
  const beer = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Budweiser lata',
    kind: 'drink',
    costCents: 600,
    salePriceCents: 1_000,
    lowStockThreshold: 3,
  });
  const snack = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Porção individual',
    kind: 'food',
    costCents: 400,
    salePriceCents: 800,
    lowStockThreshold: 2,
  });

  return { beerId: beer.id, snackId: snack.id };
}

describe('combo database', () => {
  it('calcula custo, lucro, margem, economia e disponibilidade pelo item limitante', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento combos', startsAt: Date.now() });
    const { beerId, snackId } = createProducts(database);
    recordStockMovement(database, { productId: beerId, type: 'purchase', quantity: 7 });
    recordStockMovement(database, { productId: snackId, type: 'purchase', quantity: 2 });

    const combo = createCombo(database, {
      name: 'Combo 2 Bud + porção',
      salePriceCents: 2_500,
      components: [
        { productId: beerId, quantity: 2 },
        { productId: snackId, quantity: 1 },
      ],
    });

    expect(combo).toMatchObject({
      individualSaleTotalCents: 2_800,
      savingsCents: 300,
      availableUnits: 2,
      financials: {
        costCents: 1_600,
        grossProfitCents: 900,
        marginPercent: 36,
      },
    });
    database.close();
  });

  it('reflete alterações de estoque sem manter saldo próprio para o combo', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento combos', startsAt: Date.now() });
    const { beerId } = createProducts(database);
    recordStockMovement(database, { productId: beerId, type: 'purchase', quantity: 5 });
    const combo = createCombo(database, {
      name: 'Dupla Budweiser',
      salePriceCents: 1_800,
      components: [{ productId: beerId, quantity: 2 }],
    });

    expect(combo.availableUnits).toBe(2);
    recordStockMovement(database, { productId: beerId, type: 'loss', quantity: 2 });
    expect(listCombos(database).find((item) => item.id === combo.id)?.availableUnits).toBe(1);
    database.close();
  });

  it('atualiza bancos existentes sem perder componentes de combos já cadastrados', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento de migração de combo', startsAt: Date.now() });
    const { beerId } = createProducts(database);
    const combo = createCombo(database, {
      name: 'Combo existente',
      salePriceCents: 1800,
      components: [{ productId: beerId, quantity: 2 }],
    });

    database.sqlite.exec(`
      CREATE TABLE combo_components_legacy (
        combo_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        choice_group TEXT,
        choice_label TEXT,
        PRIMARY KEY (combo_id, product_id)
      );
      INSERT INTO combo_components_legacy
        (combo_id, product_id, quantity, choice_group, choice_label)
      SELECT combo_id, product_id, quantity, choice_group, choice_label
      FROM combo_components;
      DROP TABLE combo_components;
      ALTER TABLE combo_components_legacy RENAME TO combo_components;
      DELETE FROM schema_migrations WHERE version = 27;
    `);
    database.close();

    if (temporaryDirectory === null) throw new Error('Diretório temporário não foi criado.');
    const upgraded = openDatabase(path.join(temporaryDirectory, 'combos.sqlite'));
    expect(listCombos(upgraded).find((item) => item.id === combo.id)?.components).toEqual([
      expect.objectContaining({ productId: beerId, quantity: 2, choiceGroup: null }),
    ]);
    expect(
      (
        upgraded.sqlite.pragma('table_info(combo_components)') as readonly {
          readonly name: string;
        }[]
      ).map((column) => column.name),
    ).toContain('id');
    upgraded.close();
  });

  it('classifica combos legados formados apenas por comida', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento de classificação', startsAt: Date.now() });
    const { snackId } = createProducts(database);
    const combo = createCombo(database, {
      name: 'Combo legado de comida',
      salePriceCents: 1_600,
      components: [{ productId: snackId, quantity: 2 }],
    });
    database.sqlite.prepare("UPDATE combos SET kind = 'drink' WHERE id = ?").run(combo.id);
    database.sqlite.prepare('DELETE FROM schema_migrations WHERE version = 29').run();
    database.close();

    if (temporaryDirectory === null) throw new Error('Diretório temporário não foi criado.');
    const upgraded = openDatabase(path.join(temporaryDirectory, 'combos.sqlite'));
    expect(listCombos(upgraded).find((item) => item.id === combo.id)?.kind).toBe('food');
    upgraded.close();
  });

  it('atualiza composição e preserva histórico de auditoria', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento combos', startsAt: Date.now() });
    const { beerId, snackId } = createProducts(database);
    const combo = createCombo(database, {
      name: 'Combo inicial',
      salePriceCents: 1_800,
      components: [{ productId: beerId, quantity: 2 }],
    });

    const updated = updateCombo(database, {
      comboId: combo.id,
      name: 'Combo atualizado',
      salePriceCents: 2_300,
      active: false,
      components: [
        { productId: beerId, quantity: 1 },
        { productId: snackId, quantity: 1 },
      ],
    });

    expect(updated).toMatchObject({ name: 'Combo atualizado', active: false });
    expect(updated.components).toHaveLength(2);
    const actions = database.sqlite
      .prepare('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY id')
      .all(combo.id);
    expect(actions).toEqual([{ action: 'combo.created' }, { action: 'combo.updated' }]);
    database.close();
  });

  it('exclui o combo vazio e bloqueia exclusão quando ele possui venda ativa ou paga', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento exclusão de combo', startsAt: Date.now() });
    const { beerId } = createProducts(database);
    recordStockMovement(database, { productId: beerId, type: 'purchase', quantity: 4 });
    const deletable = createCombo(database, {
      name: 'Combo descartável',
      salePriceCents: 1_000,
      components: [{ productId: beerId, quantity: 1 }],
    });
    expect(deleteCombo(database, { comboId: deletable.id, reason: 'Limpeza do catálogo' })).toEqual({
      comboId: deletable.id,
      deleted: true,
    });
    expect(listCombos(database)).toEqual([]);

    const protectedCombo = createCombo(database, {
      name: 'Combo vendido',
      salePriceCents: 1_000,
      components: [{ productId: beerId, quantity: 1 }],
    });
    const point = createServicePoint(database, { label: 'Balcão', type: 'counter' });
    const order = openOrder(database, point.id);
    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: protectedCombo.id,
      quantity: 1,
    });
    expect(() =>
      deleteCombo(database, { comboId: protectedCombo.id, reason: 'Limpeza do catálogo' }),
    ).toThrow('vendas ou comandas registradas');
    cancelOrder(database, { orderId: order.id, reason: 'Teste de limpeza' });
    expect(deleteCombo(database, { comboId: protectedCombo.id, reason: 'Limpeza do catálogo' }))
      .toMatchObject({ comboId: protectedCombo.id, deleted: true });
    expect(event.name).toBe('Evento exclusão de combo');
    database.close();
  });

  it('oculta custos no Caixa e bloqueia criação e edição', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento Caixa', startsAt: Date.now() });
    const { beerId } = createProducts(database);
    const combo = createCombo(database, {
      name: 'Combo protegido',
      salePriceCents: 1_800,
      components: [{ productId: beerId, quantity: 2 }],
    });
    switchProfile(database, 'cashier');

    expect(listCombos(database).find((item) => item.id === combo.id)?.financials).toBeNull();
    expect(() =>
      createCombo(database, {
        name: 'Combo bloqueado',
        salePriceCents: 1_000,
        components: [{ productId: beerId, quantity: 1 }],
      }),
    ).toThrow('Esta operação de combo exige o perfil Produção.');
    expect(() =>
      updateCombo(database, {
        comboId: combo.id,
        name: combo.name,
        salePriceCents: combo.salePriceCents,
        active: false,
        components: [{ productId: beerId, quantity: 2 }],
      }),
    ).toThrow('Esta operação de combo exige o perfil Produção.');
    database.close();
  });

  it('aceita componentes de comida externa em um combo de composição fixa', async () => {
    const database = await createTemporaryDatabase();
    createEvent(database, { name: 'Evento comida em combo', startsAt: Date.now() });
    const category = createProductCategory(database, 'Cozinha externa', 'food');
    configureFood(database, { supplierMode: 'external' });
    const supplier = createFoodSupplier(database, { name: 'Cozinha parceira' });
    createExternalFoodItem(database, {
      categoryId: category.id,
      supplierId: supplier.id,
      name: 'Tequeño de queijo',
      supplierUnitCents: 300,
      commissionUnitCents: 100,
      initialQuantity: 9,
      comboOnly: true,
    });
    createExternalFoodItem(database, {
      categoryId: category.id,
      supplierId: supplier.id,
      name: 'Tequeño Romeu e Julieta',
      supplierUnitCents: 350,
      commissionUnitCents: 100,
      initialQuantity: 6,
      comboOnly: true,
    });
    const products = listCombos(database);
    expect(products).toEqual([]);

    const foodProducts = database.sqlite
      .prepare('SELECT id, name FROM products ORDER BY name')
      .all() as readonly { readonly id: string; readonly name: string }[];
    const cheese = foodProducts.find((product) => product.name === 'Tequeño de queijo');
    const guava = foodProducts.find((product) => product.name === 'Tequeño Romeu e Julieta');
    if (cheese === undefined || guava === undefined)
      throw new Error('Componentes de comida não criados.');

    const combo = createCombo(database, {
      name: 'Tequefest',
      salePriceCents: 2400,
      components: [
        { productId: cheese.id, quantity: 3 },
        { productId: guava.id, quantity: 2 },
      ],
    });
    expect(combo).toMatchObject({
      availableUnits: 3,
      components: [
        { productId: cheese.id, quantity: 3 },
        { productId: guava.id, quantity: 2 },
      ],
    });
    database.close();
  });

  it('registra a escolha variável, baixa somente os sabores escolhidos e os restaura no estorno', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, { name: 'Evento prato variável', startsAt: Date.now() });
    const category = createProductCategory(database, 'Cozinha própria', 'food');
    const queijo = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Tequeño de queijo',
      kind: 'food',
      costCents: 150,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    const frango = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Arepa de frango',
      kind: 'food',
      costCents: 700,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    const carne = createInventoryProduct(database, {
      categoryId: category.id,
      name: 'Arepa de carne',
      kind: 'food',
      costCents: 800,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    for (const product of [queijo, frango, carne]) {
      recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 10 });
    }
    const combo = createCombo(database, {
      name: 'Pasaporte Latino',
      salePriceCents: 2400,
      components: [
        { productId: queijo.id, quantity: 2 },
        {
          productId: frango.id,
          quantity: 2,
          choiceGroup: 'arepa',
          choiceLabel: 'Escolha as arepas',
        },
        {
          productId: carne.id,
          quantity: 2,
          choiceGroup: 'arepa',
          choiceLabel: 'Escolha as arepas',
        },
      ],
    });
    expect(combo.availableUnits).toBe(5);

    const counter = createServicePoint(database, { label: 'Balcão escolhas', type: 'counter' });
    const order = openOrder(database, counter.id);
    expect(() =>
      addOrderItem(database, {
        orderId: order.id,
        itemKind: 'combo',
        itemId: combo.id,
        quantity: 1,
      }),
    ).toThrow('Escolha 2 unidade(s) para Escolha as arepas');

    const selected = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: combo.id,
      quantity: 1,
      componentSelections: [
        { choiceGroup: 'arepa', productId: frango.id, quantity: 1 },
        { choiceGroup: 'arepa', productId: carne.id, quantity: 1 },
      ],
    });
    expect(selected.items[0]?.componentAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: queijo.id, choiceGroup: null, quantity: 2 }),
        expect.objectContaining({ productId: frango.id, choiceGroup: 'arepa', quantity: 1 }),
        expect.objectContaining({ productId: carne.id, choiceGroup: 'arepa', quantity: 1 }),
      ]),
    );

    const twoConfigurations = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: combo.id,
      quantity: 1,
      componentSelections: [{ choiceGroup: 'arepa', productId: frango.id, quantity: 2 }],
    });
    expect(twoConfigurations.items).toHaveLength(2);
    expect(twoConfigurations.items[1]?.componentAllocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: queijo.id, choiceGroup: null, quantity: 2 }),
        expect.objectContaining({ productId: frango.id, choiceGroup: 'arepa', quantity: 2 }),
      ]),
    );

    closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      payments: [{ method: 'pix', amountCents: 4800 }],
    });
    expect(
      database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(event.id, queijo.id),
    ).toEqual({ quantity: 6 });
    expect(
      database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(event.id, frango.id),
    ).toEqual({ quantity: 7 });
    expect(
      database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(event.id, carne.id),
    ).toEqual({ quantity: 9 });

    updateCombo(database, {
      comboId: combo.id,
      name: combo.name,
      salePriceCents: combo.salePriceCents,
      active: true,
      components: [{ productId: queijo.id, quantity: 1 }],
    });
    cancelOrder(database, { orderId: order.id, reason: 'Teste de estorno com receita alterada' });
    expect(
      database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(event.id, queijo.id),
    ).toEqual({ quantity: 10 });
    expect(
      database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(event.id, frango.id),
    ).toEqual({ quantity: 10 });
    expect(
      database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(event.id, carne.id),
    ).toEqual({ quantity: 10 });
    database.close();
  });

  it('fecha uma venda mista com voucher, pagamentos e configurações distintas de combo sem misturar as escolhas', async () => {
    const database = await createTemporaryDatabase();
    const event = createEvent(database, {
      name: 'Evento venda mista de combos',
      startsAt: Date.now(),
    });
    const drinks = createProductCategory(database, 'Bebidas da venda mista', 'catalog');
    const food = createProductCategory(database, 'Comida da venda mista', 'food');
    const coca = createInventoryProduct(database, {
      categoryId: drinks.id,
      name: 'Coca-Cola',
      kind: 'drink',
      costCents: 300,
      salePriceCents: 800,
      lowStockThreshold: 0,
    });
    const queijo = createInventoryProduct(database, {
      categoryId: food.id,
      name: 'Tequeño de queijo',
      kind: 'food',
      costCents: 150,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    const romeu = createInventoryProduct(database, {
      categoryId: food.id,
      name: 'Tequeño Romeu e Julieta',
      kind: 'food',
      costCents: 180,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    const frango = createInventoryProduct(database, {
      categoryId: food.id,
      name: 'Arepa de frango',
      kind: 'food',
      costCents: 700,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    const carne = createInventoryProduct(database, {
      categoryId: food.id,
      name: 'Arepa de carne',
      kind: 'food',
      costCents: 800,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    const pastel = createInventoryProduct(database, {
      categoryId: food.id,
      name: 'Pastel colombiano',
      kind: 'food',
      costCents: 600,
      salePriceCents: 0,
      lowStockThreshold: 0,
      comboOnly: true,
    });
    for (const product of [coca, queijo, romeu, frango, carne, pastel]) {
      recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 20 });
    }

    const tequefest = createCombo(database, {
      name: 'Tequefest',
      salePriceCents: 2400,
      components: [
        { productId: queijo.id, quantity: 3 },
        { productId: romeu.id, quantity: 2 },
      ],
    });
    const pasaporte = createCombo(database, {
      name: 'Pasaporte Latino',
      salePriceCents: 3000,
      components: [
        { productId: queijo.id, quantity: 2 },
        {
          productId: frango.id,
          quantity: 2,
          choiceGroup: 'arepas-principais',
          choiceLabel: 'Escolha as 2 arepas principais',
        },
        {
          productId: carne.id,
          quantity: 2,
          choiceGroup: 'arepas-principais',
          choiceLabel: 'Escolha as 2 arepas principais',
        },
        {
          productId: frango.id,
          quantity: 1,
          choiceGroup: 'acompanhamento',
          choiceLabel: 'Escolha o acompanhamento',
        },
        {
          productId: pastel.id,
          quantity: 1,
          choiceGroup: 'acompanhamento',
          choiceLabel: 'Escolha o acompanhamento',
        },
      ],
    });
    const table = createServicePoint(database, { label: 'Mesa voucher e combos', type: 'table' });
    const voucher = createManagedVoucher(database, {
      code: 'VCH-MISTO',
      label: 'Crédito da mesa',
      initialBalanceCents: 4000,
      servicePointId: table.id,
    });
    const order = openOrder(database, table.id);

    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'product',
      itemId: coca.id,
      quantity: 2,
    });
    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: tequefest.id,
      quantity: 1,
    });
    const sameConfiguration = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: tequefest.id,
      quantity: 1,
    });
    expect(sameConfiguration.items.find((item) => item.itemId === tequefest.id)?.quantity).toBe(2);

    addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: pasaporte.id,
      quantity: 2,
      componentSelections: [
        { choiceGroup: 'arepas-principais', productId: frango.id, quantity: 2 },
        { choiceGroup: 'arepas-principais', productId: carne.id, quantity: 2 },
        { choiceGroup: 'acompanhamento', productId: pastel.id, quantity: 2 },
      ],
    });
    const mixedConfigurations = addOrderItem(database, {
      orderId: order.id,
      itemKind: 'combo',
      itemId: pasaporte.id,
      quantity: 1,
      componentSelections: [
        { choiceGroup: 'arepas-principais', productId: frango.id, quantity: 2 },
        { choiceGroup: 'acompanhamento', productId: frango.id, quantity: 1 },
      ],
    });
    const pasaporteLines = mixedConfigurations.items.filter((item) => item.itemId === pasaporte.id);
    expect(pasaporteLines).toHaveLength(2);
    expect(pasaporteLines.map((item) => item.quantity)).toEqual([2, 1]);
    expect(pasaporteLines.map((item) => item.componentAllocations)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ productId: frango.id, quantity: 2 }),
          expect.objectContaining({ productId: carne.id, quantity: 2 }),
          expect.objectContaining({ productId: pastel.id, quantity: 2 }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({ productId: frango.id, quantity: 2 }),
          expect.objectContaining({ productId: frango.id, quantity: 1 }),
        ]),
      ]),
    );

    bindOrderVoucher(database, { orderId: order.id, code: voucher.code });
    const paid = closeOrder(database, {
      orderId: order.id,
      discountCents: 0,
      voucherUses: [{ code: voucher.code, amountCents: 2000 }],
      payments: [
        { method: 'pix', amountCents: 5000 },
        { method: 'cash', amountCents: 8400, receivedCents: 9000 },
      ],
    });
    expect(paid).toMatchObject({
      status: 'paid',
      subtotalCents: 15_400,
      totalCents: 15_400,
      paidCents: 15_400,
    });
    expect(paid.items).toHaveLength(4);
    expect(paid.payments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'pix', amountCents: 5000, changeCents: 0 }),
        expect.objectContaining({ method: 'cash', amountCents: 8400, changeCents: 600 }),
      ]),
    );
    expect(
      database.sqlite
        .prepare('SELECT remaining_balance_cents FROM vouchers WHERE id = ?')
        .get(voucher.id),
    ).toEqual({ remaining_balance_cents: 2000 });

    const stock = (productId: string): number =>
      (
        database.sqlite
          .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
          .get(event.id, productId) as { readonly quantity: number }
      ).quantity;
    expect(stock(coca.id)).toBe(18);
    expect(stock(queijo.id)).toBe(8);
    expect(stock(romeu.id)).toBe(16);
    expect(stock(frango.id)).toBe(15);
    expect(stock(carne.id)).toBe(18);
    expect(stock(pastel.id)).toBe(18);

    const cancelled = cancelOrder(database, {
      orderId: order.id,
      reason: 'Teste de estorno da venda mista',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(() =>
      cancelOrder(database, { orderId: order.id, reason: 'Estorno duplicado não permitido' }),
    ).toThrow('Esta comanda já foi cancelada.');
    expect(
      database.sqlite
        .prepare('SELECT remaining_balance_cents FROM vouchers WHERE id = ?')
        .get(voucher.id),
    ).toEqual({ remaining_balance_cents: 4000 });
    for (const product of [coca, queijo, romeu, frango, carne, pastel]) {
      expect(stock(product.id)).toBe(20);
    }
    database.close();
  });
});
