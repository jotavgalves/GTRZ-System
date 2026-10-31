import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addOrderItem,
  cancelOrder,
  createCombo,
  createEvent,
  createInventoryProduct,
  createProductCategory,
  createServicePoint,
  deleteCombo,
  listCombos,
  openDatabase,
  openOrder,
  recordStockMovement,
  updateCombo,
  type DatabaseContext,
} from './index';
import { getProductPresentation } from './product-presentation';

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';
const OTHER_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';

let temporaryDirectory: string | null = null;

async function createTemporaryDatabase(): Promise<DatabaseContext> {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-combo-photo-'));
  return openDatabase(path.join(temporaryDirectory, 'combo-photo.sqlite'));
}

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = null;
  }
});

function setup(database: DatabaseContext): { readonly productId: string } {
  createEvent(database, { name: 'Evento foto de combo', startsAt: Date.now() });
  const category = createProductCategory(database, 'Bebidas');
  const product = createInventoryProduct(database, {
    categoryId: category.id,
    name: 'Agua',
    kind: 'drink',
    costCents: 100,
    salePriceCents: 500,
    lowStockThreshold: 0,
  });
  recordStockMovement(database, { productId: product.id, type: 'purchase', quantity: 10 });
  return { productId: product.id };
}

describe('combo photo and icon', () => {
  it('a combo without a photo starts with the default icon', async () => {
    const database = await createTemporaryDatabase();
    const { productId } = setup(database);
    const combo = createCombo(database, {
      name: 'Combo sem foto',
      salePriceCents: 900,
      components: [{ productId, quantity: 2 }],
    });
    expect(combo.imageDataUrl).toBeNull();
    expect(combo.fallbackIcon).toBe('package');
    database.close();
  });

  it('saves the photo and icon on creation and returns them in the list', async () => {
    const database = await createTemporaryDatabase();
    const { productId } = setup(database);
    const combo = createCombo(database, {
      name: 'Combo com foto',
      salePriceCents: 900,
      components: [{ productId, quantity: 2 }],
      imageDataUrl: PHOTO,
      fallbackIcon: 'beer',
    });
    expect(combo).toMatchObject({ imageDataUrl: PHOTO, fallbackIcon: 'beer' });
    expect(listCombos(database)[0]).toMatchObject({ imageDataUrl: PHOTO, fallbackIcon: 'beer' });
    database.close();
  });

  it('keeps the photo when an edit omits it, replaces it, and removes it with null', async () => {
    const database = await createTemporaryDatabase();
    const { productId } = setup(database);
    const combo = createCombo(database, {
      name: 'Combo editavel',
      salePriceCents: 900,
      components: [{ productId, quantity: 1 }],
      imageDataUrl: PHOTO,
      fallbackIcon: 'coffee',
    });
    const write = {
      comboId: combo.id,
      name: 'Combo editavel',
      salePriceCents: 950,
      components: [{ productId, quantity: 1 }],
      active: true,
    };
    expect(updateCombo(database, write)).toMatchObject({
      imageDataUrl: PHOTO,
      fallbackIcon: 'coffee',
    });
    expect(updateCombo(database, { ...write, imageDataUrl: OTHER_PHOTO })).toMatchObject({
      imageDataUrl: OTHER_PHOTO,
    });
    expect(
      updateCombo(database, { ...write, imageDataUrl: null, fallbackIcon: 'pizza' }),
    ).toMatchObject({ imageDataUrl: null, fallbackIcon: 'pizza' });
    database.close();
  });

  it('records the photo in the audit so the other computers receive it', async () => {
    const database = await createTemporaryDatabase();
    const { productId } = setup(database);
    const combo = createCombo(database, {
      name: 'Combo auditado',
      salePriceCents: 900,
      components: [{ productId, quantity: 1 }],
      imageDataUrl: PHOTO,
      fallbackIcon: 'candy',
    });
    const row = database.sqlite
      .prepare(
        "SELECT details_json FROM audit_log WHERE action = 'combo.created' AND entity_id = ?",
      )
      .get(combo.id) as { details_json: string };
    expect(JSON.parse(row.details_json)).toMatchObject({
      imageDataUrl: PHOTO,
      fallbackIcon: 'candy',
    });
    database.close();
  });

  it('rejects a photo that is not PNG, JPG or WebP, or is too large, without creating the combo', async () => {
    const database = await createTemporaryDatabase();
    const { productId } = setup(database);
    const base = {
      name: 'Combo invalido',
      salePriceCents: 900,
      components: [{ productId, quantity: 1 }],
    };
    expect(() =>
      createCombo(database, { ...base, imageDataUrl: 'data:text/html;base64,AAAA' }),
    ).toThrow('PNG, JPG ou WebP');
    expect(() =>
      createCombo(database, {
        ...base,
        imageDataUrl: `data:image/png;base64,${'A'.repeat(800_000)}`,
      }),
    ).toThrow('muito grande');
    expect(listCombos(database)).toEqual([]);
    database.close();
  });

  it('removes the photo of a deleted combo and never leaves it for another one', async () => {
    const database = await createTemporaryDatabase();
    const { productId } = setup(database);
    const combo = createCombo(database, {
      name: 'Combo descartavel',
      salePriceCents: 900,
      components: [{ productId, quantity: 1 }],
      imageDataUrl: PHOTO,
    });
    deleteCombo(database, { comboId: combo.id, reason: 'Limpeza do catalogo' });
    expect(getProductPresentation(database, combo.id)).toEqual({
      imageDataUrl: null,
      fallbackIcon: 'package',
    });
    database.close();
  });

  it('shows the combo photo in the sales catalogue and keeps the delete protection for sold combos', async () => {
    const database = await createTemporaryDatabase();
    const { productId } = setup(database);
    const combo = createCombo(database, {
      name: 'Combo vendido',
      salePriceCents: 900,
      components: [{ productId, quantity: 1 }],
      imageDataUrl: PHOTO,
      fallbackIcon: 'beer',
    });
    const point = createServicePoint(database, { label: 'Balcao', type: 'counter' });
    const order = openOrder(database, point.id);
    addOrderItem(database, { orderId: order.id, itemKind: 'combo', itemId: combo.id, quantity: 1 });
    expect(() =>
      deleteCombo(database, { comboId: combo.id, reason: 'Limpeza do catalogo' }),
    ).toThrow('apenas desative o combo');
    cancelOrder(database, { orderId: order.id, reason: 'Teste' });
    expect(deleteCombo(database, { comboId: combo.id, reason: 'Limpeza do catalogo' })).toEqual({
      comboId: combo.id,
      deleted: true,
    });
    database.close();
  });
});
