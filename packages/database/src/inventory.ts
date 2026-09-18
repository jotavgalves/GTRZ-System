import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getSessionState } from './control';
import { getProductEconomics } from './product-administration';
import {
  getProductPresentation,
  setProductPresentation,
  type DatabaseProductFallbackIcon,
} from './product-presentation';
import type { DatabaseContext } from './types';

export type DatabaseProductKind = 'food' | 'drink';
export type DatabaseStockMovementType =
  | 'purchase'
  | 'correction-positive'
  | 'correction-negative'
  | 'loss'
  | 'breakage'
  | 'internal-consumption'
  | 'courtesy'
  | 'return';

export interface DatabaseProductCategory {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DatabaseProductFinancials {
  readonly costCents: number;
  readonly grossProfitCents: number;
  readonly marginPercent: number;
  readonly currentStockValueCents: number;
  readonly contributedCostCents: number;
  readonly potentialGrossRevenueCents: number;
  readonly potentialGrossProfitCents: number;
}

export interface DatabaseInventoryProduct {
  readonly id: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly name: string;
  readonly kind: DatabaseProductKind;
  readonly salePriceCents: number;
  readonly lowStockThreshold: number;
  readonly comboOnly: boolean;
  readonly active: boolean;
  readonly quantity: number;
  readonly soldQuantity: number;
  readonly lowStock: boolean;
  readonly imageDataUrl: string | null;
  readonly fallbackIcon: DatabaseProductFallbackIcon;
  readonly financials: DatabaseProductFinancials | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DatabaseInventoryState {
  readonly activeEventId: string | null;
  readonly categories: readonly DatabaseProductCategory[];
  readonly products: readonly DatabaseInventoryProduct[];
}

export interface DatabaseStockPurchaseLot {
  readonly movementId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly totalCostCents: number;
  readonly unitCostCents: number;
  readonly createdAt: number;
  readonly voided: boolean;
  readonly canUndo: boolean;
}

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ProductRow {
  readonly id: string;
  readonly category_id: string;
  readonly category_name: string;
  readonly name: string;
  readonly kind: DatabaseProductKind;
  readonly cost_cents: number;
  readonly sale_price_cents: number;
  readonly low_stock_threshold: number;
  readonly combo_only: number;
  readonly active: number;
  readonly quantity: number;
  readonly sold_quantity: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ProductWriteInput {
  readonly categoryId: string;
  readonly name: string;
  readonly kind: DatabaseProductKind;
  readonly costCents: number;
  readonly salePriceCents: number;
  readonly lowStockThreshold: number;
  readonly comboOnly?: boolean;
  readonly imageDataUrl?: string | null;
  readonly fallbackIcon?: DatabaseProductFallbackIcon;
}

const POSITIVE_MOVEMENTS = new Set<DatabaseStockMovementType>([
  'purchase',
  'correction-positive',
  'return',
]);

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('Esta operação de estoque exige o perfil Produção.');
  }
}

function requireActiveEvent(database: DatabaseContext): string {
  const event = getSessionState(database).activeEvent;
  if (event === null) {
    throw new Error('Selecione um evento aberto antes de movimentar o estoque.');
  }
  return event.id;
}

function calculateFinancials(
  database: DatabaseContext,
  productId: string,
  eventId: string | null,
  salePriceCents: number,
  quantity: number,
): DatabaseProductFinancials {
  const economics = getProductEconomics(database, productId, eventId);
  const effectiveCostCents = economics.averagePurchaseCostCents;
  const grossProfitCents = salePriceCents - effectiveCostCents;
  const marginPercent =
    salePriceCents === 0 ? 0 : Math.round((grossProfitCents / salePriceCents) * 10_000) / 100;
  return {
    costCents: effectiveCostCents,
    grossProfitCents,
    marginPercent,
    potentialGrossRevenueCents: quantity * salePriceCents,
    potentialGrossProfitCents: quantity * grossProfitCents,
    ...economics,
  };
}

function mapCategory(row: CategoryRow): DatabaseProductCategory {
  return {
    id: row.id,
    name: row.name,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProduct(
  database: DatabaseContext,
  row: ProductRow,
  showFinancials: boolean,
  eventId: string | null,
): DatabaseInventoryProduct {
  const presentation = getProductPresentation(database, row.id);
  return {
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category_name,
    name: row.name,
    kind: row.kind,
    salePriceCents: row.sale_price_cents,
    lowStockThreshold: row.low_stock_threshold,
    comboOnly: row.combo_only === 1,
    active: row.active === 1,
    quantity: row.quantity,
    soldQuantity: Math.max(row.sold_quantity, 0),
    lowStock: eventId !== null && row.quantity <= row.low_stock_threshold,
    imageDataUrl: presentation.imageDataUrl,
    fallbackIcon: presentation.fallbackIcon,
    financials: showFinancials
      ? calculateFinancials(database, row.id, eventId, row.sale_price_cents, row.quantity)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listCategories(database: DatabaseContext): readonly DatabaseProductCategory[] {
  const rows = database.sqlite
    .prepare(
      `SELECT id, name, active, created_at, updated_at
       FROM product_categories
       ORDER BY active DESC, name COLLATE NOCASE`,
    )
    .all() as CategoryRow[];
  return rows.map(mapCategory);
}

function listProducts(
  database: DatabaseContext,
  eventId: string | null,
): readonly DatabaseInventoryProduct[] {
  const rows = database.sqlite
    .prepare(
      `SELECT
         p.id,
         p.category_id,
         c.name AS category_name,
         p.name,
         p.kind,
         p.cost_cents,
         p.sale_price_cents,
         p.low_stock_threshold,
         p.combo_only,
         p.active,
         COALESCE(es.quantity, 0) AS quantity,
         CASE
           WHEN ? IS NULL THEN 0
           ELSE COALESCE((
             SELECT SUM(
               CASE sm.type
                 WHEN 'sale' THEN sm.quantity
                 WHEN 'return' THEN -sm.quantity
                 ELSE 0
               END
             )
             FROM stock_movements sm
             WHERE sm.event_id = ? AND sm.product_id = p.id
           ), 0)
         END AS sold_quantity,
         p.created_at,
         p.updated_at
       FROM products p
       INNER JOIN product_categories c ON c.id = p.category_id
       LEFT JOIN event_stock es ON es.product_id = p.id AND es.event_id = ?
       ORDER BY p.active DESC, c.name COLLATE NOCASE, p.name COLLATE NOCASE`,
    )
    .all(eventId, eventId, eventId) as ProductRow[];
  const showFinancials = getSessionState(database).profile === 'production';
  return rows.map((row) => mapProduct(database, row, showFinancials, eventId));
}

function requireCategory(database: DatabaseContext, categoryId: string): DatabaseProductCategory {
  const row = database.sqlite
    .prepare(
      `SELECT id, name, active, created_at, updated_at
       FROM product_categories WHERE id = ?`,
    )
    .get(categoryId) as CategoryRow | undefined;
  if (row === undefined) throw new Error('A categoria informada não existe.');
  return mapCategory(row);
}

function requireProductRow(database: DatabaseContext, productId: string): ProductRow {
  const row = database.sqlite
    .prepare(
      `SELECT
         p.id, p.category_id, c.name AS category_name, p.name, p.kind, p.cost_cents,
         p.sale_price_cents, p.low_stock_threshold, p.combo_only, p.active, 0 AS quantity, 0 AS sold_quantity,
         p.created_at, p.updated_at
       FROM products p
       INNER JOIN product_categories c ON c.id = p.category_id
       WHERE p.id = ?`,
    )
    .get(productId) as ProductRow | undefined;
  if (row === undefined) throw new Error('O produto informado não existe.');
  return row;
}

function requireUniqueName(
  database: DatabaseContext,
  table: 'product_categories' | 'products',
  name: string,
  excludedId?: string,
): void {
  const row = database.sqlite
    .prepare(
      `SELECT id FROM ${table}
       WHERE name = ? COLLATE NOCASE
         AND (? IS NULL OR id != ?)`,
    )
    .get(name, excludedId ?? null, excludedId ?? null) as { readonly id: string } | undefined;
  if (row !== undefined) {
    throw new Error(
      table === 'products' ? 'Já existe um produto com esse nome.' : 'Já existe essa categoria.',
    );
  }
}

function getProduct(
  database: DatabaseContext,
  productId: string,
  eventId: string | null,
): DatabaseInventoryProduct {
  const product = listProducts(database, eventId).find((item) => item.id === productId);
  if (product === undefined) throw new Error('O produto informado não existe.');
  return product;
}

export function getInventoryState(database: DatabaseContext): DatabaseInventoryState {
  const activeEventId = getSessionState(database).activeEvent?.id ?? null;
  return {
    activeEventId,
    categories: listCategories(database),
    products: listProducts(database, activeEventId),
  };
}

export function createProductCategory(
  database: DatabaseContext,
  nameInput: string,
): DatabaseProductCategory {
  requireProduction(database);
  const name = nameInput.trim();
  requireUniqueName(database, 'product_categories', name);
  const id = randomUUID();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO product_categories (id, name, active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
      )
      .run(id, name, now, now);
    appendAudit(database, {
      action: 'inventory.category-created',
      entityType: 'product-category',
      entityId: id,
      details: { name },
    });
  })();
  return requireCategory(database, id);
}

export function updateProductCategory(
  database: DatabaseContext,
  input: { readonly categoryId: string; readonly name: string },
): DatabaseProductCategory {
  requireProduction(database);
  const name = input.name.trim();
  const current = requireCategory(database, input.categoryId);
  requireUniqueName(database, 'product_categories', name, current.id);
  const now = Date.now();
  database.sqlite
    .prepare('UPDATE product_categories SET name=?, updated_at=? WHERE id=?')
    .run(name, now, current.id);
  appendAudit(database, {
    action: 'inventory.category-updated',
    entityType: 'product-category',
    entityId: current.id,
    details: { name },
  });
  return requireCategory(database, current.id);
}
export function deleteProductCategory(database: DatabaseContext, categoryId: string): void {
  requireProduction(database);
  const current = requireCategory(database, categoryId);
  const usage = database.sqlite
    .prepare('SELECT COUNT(*) AS count FROM products WHERE category_id=?')
    .get(categoryId) as { count: number };
  if (usage.count > 0)
    throw new Error('Mova ou exclua os produtos desta categoria antes de apagá-la.');
  database.sqlite.prepare('DELETE FROM product_categories WHERE id=?').run(categoryId);
  appendAudit(database, {
    action: 'inventory.category-deleted',
    entityType: 'product-category',
    entityId: current.id,
    details: { name: current.name },
  });
}

export function createInventoryProduct(
  database: DatabaseContext,
  input: ProductWriteInput,
): DatabaseInventoryProduct {
  requireProduction(database);
  const category = requireCategory(database, input.categoryId);
  if (!category.active) {
    throw new Error('Não é possível cadastrar produto em uma categoria inativa.');
  }
  const name = input.name.trim();
  requireUniqueName(database, 'products', name);
  const id = randomUUID();
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO products
         (id, category_id, name, kind, cost_cents, sale_price_cents,
          low_stock_threshold, combo_only, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.categoryId,
        name,
        input.kind,
        input.costCents,
        input.salePriceCents,
        input.lowStockThreshold,
        input.comboOnly === true ? 1 : 0,
        now,
        now,
      );
    setProductPresentation(database, id, {
      imageDataUrl: input.imageDataUrl ?? null,
      fallbackIcon: input.fallbackIcon ?? 'package',
    });
    appendAudit(database, {
      action: 'inventory.product-created',
      entityType: 'product',
      entityId: id,
      details: {
        categoryId: input.categoryId,
        costCents: input.costCents,
        fallbackIcon: input.fallbackIcon ?? 'package',
        hasImage: input.imageDataUrl !== undefined && input.imageDataUrl !== null,
        kind: input.kind,
        lowStockThreshold: input.lowStockThreshold,
        comboOnly: input.comboOnly === true,
        name,
        salePriceCents: input.salePriceCents,
      },
    });
  })();
  return getProduct(database, id, getSessionState(database).activeEvent?.id ?? null);
}

export function updateInventoryProduct(
  database: DatabaseContext,
  input: ProductWriteInput & { readonly productId: string; readonly active: boolean },
): DatabaseInventoryProduct {
  requireProduction(database);
  const current = requireProductRow(database, input.productId);
  const category = requireCategory(database, input.categoryId);
  if (!category.active)
    throw new Error('Não é possível mover o produto para uma categoria inativa.');
  const name = input.name.trim();
  requireUniqueName(database, 'products', name, input.productId);
  const presentation = getProductPresentation(database, input.productId);
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE products
         SET category_id = ?, name = ?, kind = ?, cost_cents = ?, sale_price_cents = ?,
             low_stock_threshold = ?, combo_only = ?, active = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.categoryId,
        name,
        input.kind,
        input.costCents,
        input.salePriceCents,
        input.lowStockThreshold,
        input.comboOnly === true ? 1 : 0,
        input.active ? 1 : 0,
        now,
        input.productId,
      );
    setProductPresentation(database, input.productId, {
      imageDataUrl:
        input.imageDataUrl === undefined ? presentation.imageDataUrl : input.imageDataUrl,
      fallbackIcon: input.fallbackIcon ?? presentation.fallbackIcon,
    });
    appendAudit(database, {
      action: 'inventory.product-updated',
      entityType: 'product',
      entityId: input.productId,
      details: {
        before: {
          categoryId: current.category_id,
          costCents: current.cost_cents,
          kind: current.kind,
          lowStockThreshold: current.low_stock_threshold,
          comboOnly: current.combo_only === 1,
          name: current.name,
          salePriceCents: current.sale_price_cents,
        },
        after: { ...input, imageDataUrl: input.imageDataUrl === null ? null : undefined, name },
      },
    });
  })();
  return getProduct(database, input.productId, getSessionState(database).activeEvent?.id ?? null);
}

export function recordStockMovement(
  database: DatabaseContext,
  input: {
    readonly productId: string;
    readonly type: DatabaseStockMovementType;
    readonly quantity: number;
    readonly purchaseTotalCents?: number;
    readonly note?: string;
  },
): DatabaseInventoryProduct {
  requireProduction(database);
  requireProductRow(database, input.productId);
  const eventId = requireActiveEvent(database);
  const delta = POSITIVE_MOVEMENTS.has(input.type) ? input.quantity : -input.quantity;
  const currentRow = database.sqlite
    .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
    .get(eventId, input.productId) as { readonly quantity: number } | undefined;
  const currentQuantity = currentRow?.quantity ?? 0;
  const nextQuantity = currentQuantity + delta;
  if (nextQuantity < 0) {
    throw new Error(`Estoque insuficiente. Saldo atual: ${String(currentQuantity)}.`);
  }

  const movementId = randomUUID();
  const now = Date.now();
  const purchaseTotalCents =
    input.type === 'purchase'
      ? (input.purchaseTotalCents ??
        requireProductRow(database, input.productId).cost_cents * input.quantity)
      : null;
  if (
    purchaseTotalCents !== null &&
    (!Number.isInteger(purchaseTotalCents) || purchaseTotalCents <= 0)
  ) {
    throw new Error('O valor total da compra deve ser maior que zero.');
  }
  const trimmedNote = input.note?.trim();
  const note = trimmedNote === undefined || trimmedNote.length === 0 ? null : trimmedNote;
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO event_stock (event_id, product_id, quantity, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id, product_id)
         DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
      )
      .run(eventId, input.productId, nextQuantity, now);
    database.sqlite
      .prepare(
        `INSERT INTO stock_movements
         (id, event_id, product_id, type, quantity, delta, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(movementId, eventId, input.productId, input.type, input.quantity, delta, note, now);
    if (purchaseTotalCents !== null) {
      database.sqlite
        .prepare(
          `INSERT INTO stock_purchase_lots
           (movement_id, event_id, product_id, quantity, total_cost_cents, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(movementId, eventId, input.productId, input.quantity, purchaseTotalCents, now);
    }
    appendAudit(database, {
      action: 'inventory.stock-moved',
      entityType: 'stock-movement',
      entityId: movementId,
      eventId,
      details: {
        afterQuantity: nextQuantity,
        beforeQuantity: currentQuantity,
        delta,
        note,
        productId: input.productId,
        purchaseTotalCents,
        type: input.type,
      },
    });
  })();
  return getProduct(database, input.productId, eventId);
}

export function listStockPurchaseLots(
  database: DatabaseContext,
  productId: string,
): readonly DatabaseStockPurchaseLot[] {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const rows = database.sqlite
    .prepare(
      `SELECT lot.movement_id, lot.product_id, lot.quantity, lot.total_cost_cents, lot.created_at,
         void.movement_id AS voided_movement_id,
         EXISTS(
           SELECT 1 FROM stock_movements later
           WHERE later.event_id = lot.event_id AND later.product_id = lot.product_id
             AND later.delta < 0 AND later.created_at > lot.created_at
         ) AS has_later_decrease
       FROM stock_purchase_lots lot
       LEFT JOIN stock_purchase_lot_voids void ON void.movement_id = lot.movement_id
       WHERE lot.event_id = ? AND lot.product_id = ?
       ORDER BY lot.created_at DESC`,
    )
    .all(eventId, productId) as Array<{
    readonly movement_id: string;
    readonly product_id: string;
    readonly quantity: number;
    readonly total_cost_cents: number;
    readonly created_at: number;
    readonly voided_movement_id: string | null;
    readonly has_later_decrease: number;
  }>;
  return rows.map((lot) => ({
    movementId: lot.movement_id,
    productId: lot.product_id,
    quantity: lot.quantity,
    totalCostCents: lot.total_cost_cents,
    unitCostCents: Math.round(lot.total_cost_cents / lot.quantity),
    createdAt: lot.created_at,
    voided: lot.voided_movement_id !== null,
    canUndo: lot.voided_movement_id === null && lot.has_later_decrease === 0,
  }));
}

export function correctStockPurchaseLot(
  database: DatabaseContext,
  input: { readonly movementId: string; readonly totalCostCents: number; readonly reason: string },
): DatabaseStockPurchaseLot {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  if (!Number.isInteger(input.totalCostCents) || input.totalCostCents <= 0) {
    throw new Error('O valor corrigido do lote deve ser maior que zero.');
  }
  const lot = database.sqlite
    .prepare(
      `SELECT movement_id, event_id, product_id, quantity, total_cost_cents, created_at
       FROM stock_purchase_lots WHERE movement_id = ?`,
    )
    .get(input.movementId) as
    | {
        readonly movement_id: string;
        readonly event_id: string;
        readonly product_id: string;
        readonly quantity: number;
        readonly total_cost_cents: number;
        readonly created_at: number;
      }
    | undefined;
  if (lot === undefined || lot.event_id !== eventId) {
    throw new Error('O lote não pertence ao evento ativo.');
  }
  const reason = input.reason.trim();
  if (reason.length < 3) throw new Error('Informe o motivo da correção.');
  const previousTotalCents = lot.total_cost_cents;
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare('UPDATE stock_purchase_lots SET total_cost_cents = ? WHERE movement_id = ?')
      .run(input.totalCostCents, lot.movement_id);
    appendAudit(database, {
      action: 'inventory.purchase-lot-corrected',
      entityType: 'stock-purchase-lot',
      entityId: lot.movement_id,
      eventId,
      details: {
        productId: lot.product_id,
        previousTotalCents,
        totalCostCents: input.totalCostCents,
        reason,
      },
    });
  })();
  return {
    movementId: lot.movement_id,
    productId: lot.product_id,
    quantity: lot.quantity,
    totalCostCents: input.totalCostCents,
    unitCostCents: Math.round(input.totalCostCents / lot.quantity),
    createdAt: lot.created_at,
    voided: false,
    canUndo: false,
  };
}

export function voidStockPurchaseLot(
  database: DatabaseContext,
  input: { readonly movementId: string; readonly reason: string },
): DatabaseStockPurchaseLot {
  requireProduction(database);
  const eventId = requireActiveEvent(database);
  const reason = input.reason.trim();
  if (reason.length < 3) throw new Error('Informe o motivo para desfazer a entrada.');
  const lot = database.sqlite
    .prepare(
      `SELECT lot.movement_id, lot.event_id, lot.product_id, lot.quantity, lot.total_cost_cents,
         lot.created_at, void.movement_id AS voided_movement_id,
         EXISTS(
           SELECT 1 FROM stock_movements later
           WHERE later.event_id = lot.event_id AND later.product_id = lot.product_id
             AND later.delta < 0 AND later.created_at > lot.created_at
         ) AS has_later_decrease
       FROM stock_purchase_lots lot
       LEFT JOIN stock_purchase_lot_voids void ON void.movement_id = lot.movement_id
       WHERE lot.movement_id = ?`,
    )
    .get(input.movementId) as
    | {
        readonly movement_id: string;
        readonly event_id: string;
        readonly product_id: string;
        readonly quantity: number;
        readonly total_cost_cents: number;
        readonly created_at: number;
        readonly voided_movement_id: string | null;
        readonly has_later_decrease: number;
      }
    | undefined;
  if (lot === undefined || lot.event_id !== eventId)
    throw new Error('O lote não pertence ao evento ativo.');
  if (lot.voided_movement_id !== null) throw new Error('Esta entrada já foi desfeita.');
  if (lot.has_later_decrease !== 0) {
    throw new Error(
      'Esta entrada já possui baixas posteriores; corrija o estoque sem apagar o histórico.',
    );
  }
  const stock = database.sqlite
    .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
    .get(eventId, lot.product_id) as { readonly quantity: number } | undefined;
  if ((stock?.quantity ?? 0) < lot.quantity)
    throw new Error('O saldo atual não permite desfazer esta entrada.');
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        'UPDATE event_stock SET quantity = quantity - ?, updated_at = ? WHERE event_id = ? AND product_id = ?',
      )
      .run(lot.quantity, now, eventId, lot.product_id);
    database.sqlite
      .prepare(
        `INSERT INTO stock_movements (id, event_id, product_id, type, quantity, delta, note, created_at)
         VALUES (?, ?, ?, 'correction-negative', ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        eventId,
        lot.product_id,
        lot.quantity,
        -lot.quantity,
        `Desfazer entrada: ${reason}`,
        now,
      );
    database.sqlite
      .prepare(
        'INSERT INTO stock_purchase_lot_voids (movement_id, event_id, reason, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(lot.movement_id, eventId, reason, now);
    appendAudit(database, {
      action: 'inventory.purchase-lot-voided',
      entityType: 'stock-purchase-lot',
      entityId: lot.movement_id,
      eventId,
      details: { productId: lot.product_id, quantity: lot.quantity, reason },
    });
  })();
  return {
    movementId: lot.movement_id,
    productId: lot.product_id,
    quantity: lot.quantity,
    totalCostCents: lot.total_cost_cents,
    unitCostCents: Math.round(lot.total_cost_cents / lot.quantity),
    createdAt: lot.created_at,
    voided: true,
    canUndo: false,
  };
}
