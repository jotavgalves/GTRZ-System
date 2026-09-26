import { randomUUID } from 'node:crypto';
import { appendAudit } from './audit';
import { getSessionState } from './control';
import { createInventoryProduct, recordStockMovement } from './inventory';
import { cancelOrder } from './operation-cancellation';
import { deleteInventoryProduct } from './product-administration';
import type { DatabaseContext } from './types';

export type DatabaseFoodSupplierMode = 'gtrz' | 'external';
export interface DatabaseFoodSupplier {
  readonly id: string;
  readonly eventId: string;
  readonly name: string;
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface DatabaseFoodState {
  readonly activeEventId: string | null;
  readonly supplierMode: DatabaseFoodSupplierMode | null;
  readonly suppliers: readonly DatabaseFoodSupplier[];
  readonly summary: {
    readonly soldQuantity: number;
    readonly receivedCents: number;
    readonly supplierCents: number;
    readonly commissionCents: number;
  };
  readonly items: readonly {
    readonly productId: string;
    readonly name: string;
    readonly supplierName: string | null;
    readonly soldQuantity: number;
    readonly receivedCents: number;
    readonly supplierCents: number;
    readonly commissionCents: number;
  }[];
}
function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production')
    throw new Error('O módulo Comida exige o perfil Produção.');
}
function requireEvent(database: DatabaseContext): string {
  const event = getSessionState(database).activeEvent;
  if (event === null) throw new Error('Selecione um evento aberto antes de configurar Comida.');
  return event.id;
}
function listSuppliers(
  database: DatabaseContext,
  eventId: string,
): readonly DatabaseFoodSupplier[] {
  return (
    database.sqlite
      .prepare(
        'SELECT id,event_id,name,active,created_at,updated_at FROM food_suppliers WHERE event_id=? ORDER BY active DESC,name COLLATE NOCASE',
      )
      .all(eventId) as {
      id: string;
      event_id: string;
      name: string;
      active: number;
      created_at: number;
      updated_at: number;
    }[]
  ).map((row) => ({
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
export function getFoodState(database: DatabaseContext): DatabaseFoodState {
  requireProduction(database);
  const eventId = getSessionState(database).activeEvent?.id ?? null;
  const empty = { soldQuantity: 0, receivedCents: 0, supplierCents: 0, commissionCents: 0 };
  if (eventId === null)
    return { activeEventId: null, supplierMode: null, suppliers: [], summary: empty, items: [] };
  const setting = database.sqlite
    .prepare('SELECT supplier_mode FROM food_event_settings WHERE event_id=?')
    .get(eventId) as { supplier_mode: DatabaseFoodSupplierMode } | undefined;
  const rows = database.sqlite
    .prepare(
      `SELECT p.id AS product_id,p.name AS product_name,fs.name AS supplier_name,COALESCE(SUM(s.quantity),0) AS sold_quantity,COALESCE(SUM(s.received_cents),0) AS received_cents,COALESCE(SUM(s.supplier_cents),0) AS supplier_cents,COALESCE(SUM(s.commission_cents),0) AS commission_cents FROM products p INNER JOIN food_product_terms t ON t.product_id=p.id AND t.event_id=? INNER JOIN food_suppliers fs ON fs.id=t.supplier_id LEFT JOIN food_sale_settlements s ON s.product_id=p.id AND s.event_id=? GROUP BY p.id,p.name,fs.name UNION ALL SELECT c.id AS product_id,c.name AS product_name,fs.name AS supplier_name,COALESCE(SUM(s.quantity),0) AS sold_quantity,COALESCE(SUM(s.received_cents),0) AS received_cents,COALESCE(SUM(s.supplier_cents),0) AS supplier_cents,COALESCE(SUM(s.commission_cents),0) AS commission_cents FROM combos c INNER JOIN food_combo_terms t ON t.combo_id=c.id AND t.event_id=? INNER JOIN food_suppliers fs ON fs.id=t.supplier_id LEFT JOIN food_combo_sale_settlements s ON s.combo_id=c.id AND s.event_id=? GROUP BY c.id,c.name,fs.name ORDER BY product_name COLLATE NOCASE`,
    )
    .all(eventId, eventId, eventId, eventId) as {
    product_id: string;
    product_name: string;
    supplier_name: string | null;
    sold_quantity: number;
    received_cents: number;
    supplier_cents: number;
    commission_cents: number;
  }[];
  const items = rows.map((row) => ({
    productId: row.product_id,
    name: row.product_name,
    supplierName: row.supplier_name,
    soldQuantity: row.sold_quantity,
    receivedCents: row.received_cents,
    supplierCents: row.supplier_cents,
    commissionCents: row.commission_cents,
  }));
  const summary = items.reduce(
    (total, item) => ({
      soldQuantity: total.soldQuantity + item.soldQuantity,
      receivedCents: total.receivedCents + item.receivedCents,
      supplierCents: total.supplierCents + item.supplierCents,
      commissionCents: total.commissionCents + item.commissionCents,
    }),
    empty,
  );
  return {
    activeEventId: eventId,
    supplierMode: setting?.supplier_mode ?? null,
    suppliers: listSuppliers(database, eventId),
    summary,
    items,
  };
}
export function configureFood(
  database: DatabaseContext,
  input: { readonly supplierMode: DatabaseFoodSupplierMode },
): DatabaseFoodState {
  requireProduction(database);
  const eventId = requireEvent(database);
  const current = database.sqlite
    .prepare('SELECT supplier_mode FROM food_event_settings WHERE event_id=?')
    .get(eventId) as { supplier_mode: DatabaseFoodSupplierMode } | undefined;
  const hasExternalItems =
    database.sqlite
      .prepare(
        `SELECT 1 FROM (
           SELECT 1 FROM food_product_terms WHERE event_id=?
           UNION ALL SELECT 1 FROM food_combo_terms WHERE event_id=?
         ) LIMIT 1`,
      )
      .get(eventId, eventId) !== undefined;
  if (current !== undefined && current.supplier_mode !== input.supplierMode && hasExternalItems)
    throw new Error(
      'Não é possível trocar o fornecedor da comida após cadastrar itens externos. Abra outro evento para usar o outro modelo.',
    );
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        'INSERT INTO food_event_settings (event_id,supplier_mode,updated_at) VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET supplier_mode=excluded.supplier_mode,updated_at=excluded.updated_at',
      )
      .run(eventId, input.supplierMode, now);
    appendAudit(database, {
      action: 'food.configured',
      entityType: 'food-event-settings',
      entityId: eventId,
      eventId,
      details: { supplierMode: input.supplierMode },
    });
  })();
  return getFoodState(database);
}
export function createFoodSupplier(
  database: DatabaseContext,
  input: { readonly name: string },
): DatabaseFoodSupplier {
  requireProduction(database);
  const eventId = requireEvent(database);
  const name = input.name.trim();
  const now = Date.now();
  const id = randomUUID();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        'INSERT INTO food_suppliers (id,event_id,name,active,created_at,updated_at) VALUES (?,?,?,1,?,?)',
      )
      .run(id, eventId, name, now, now);
    appendAudit(database, {
      action: 'food.supplier-created',
      entityType: 'food-supplier',
      entityId: id,
      eventId,
      details: { name },
    });
  })();
  const supplier = listSuppliers(database, eventId).find((item) => item.id === id);
  if (supplier === undefined) throw new Error('O fornecedor criado não pôde ser localizado.');
  return supplier;
}

export function updateFoodSupplier(
  database: DatabaseContext,
  input: { readonly supplierId: string; readonly name: string },
): DatabaseFoodSupplier {
  requireProduction(database);
  const eventId = requireEvent(database);
  const current = database.sqlite
    .prepare('SELECT id FROM food_suppliers WHERE id = ? AND event_id = ?')
    .get(input.supplierId, eventId);
  if (current === undefined) throw new Error('Fornecedor não encontrado neste evento.');
  const now = Date.now();
  const name = input.name.trim();
  database.sqlite
    .prepare('UPDATE food_suppliers SET name = ?, updated_at = ? WHERE id = ?')
    .run(name, now, input.supplierId);
  appendAudit(database, {
    action: 'food.supplier-updated',
    entityType: 'food-supplier',
    entityId: input.supplierId,
    eventId,
    details: { name },
  });
  const supplier = listSuppliers(database, eventId).find((item) => item.id === input.supplierId);
  if (supplier === undefined) throw new Error('O fornecedor atualizado não pôde ser localizado.');
  return supplier;
}

export function archiveFoodSupplier(database: DatabaseContext, supplierId: string): void {
  requireProduction(database);
  const eventId = requireEvent(database);
  const current = database.sqlite
    .prepare('SELECT id, name FROM food_suppliers WHERE id = ? AND event_id = ?')
    .get(supplierId, eventId) as { readonly id: string; readonly name: string } | undefined;
  if (current === undefined) throw new Error('Fornecedor não encontrado neste evento.');
  const now = Date.now();
  database.sqlite
    .prepare('UPDATE food_suppliers SET active = 0, updated_at = ? WHERE id = ?')
    .run(now, supplierId);
  appendAudit(database, {
    action: 'food.supplier-archived',
    entityType: 'food-supplier',
    entityId: supplierId,
    eventId,
    details: { name: current.name },
  });
}

export function deleteFoodSupplier(
  database: DatabaseContext,
  input: {
    readonly supplierId: string;
    readonly deleteLinkedSales: boolean;
    readonly reason: string;
  },
): void {
  requireProduction(database);
  const eventId = requireEvent(database);
  const reason = input.reason.trim();
  const supplier = database.sqlite
    .prepare('SELECT id, name FROM food_suppliers WHERE id = ? AND event_id = ?')
    .get(input.supplierId, eventId) as { readonly id: string; readonly name: string } | undefined;
  if (supplier === undefined) throw new Error('Fornecedor não encontrado neste evento.');
  const now = Date.now();

  const productRows = database.sqlite
    .prepare('SELECT product_id FROM food_product_terms WHERE event_id = ? AND supplier_id = ?')
    .all(eventId, supplier.id) as { readonly product_id: string }[];
  const productIds = productRows.map((row) => row.product_id);
  const comboRows = database.sqlite
    .prepare('SELECT combo_id FROM food_combo_terms WHERE event_id = ? AND supplier_id = ?')
    .all(eventId, supplier.id) as { readonly combo_id: string }[];
  const comboIds = comboRows.map((row) => row.combo_id);
  const productPlaceholders = productIds.map(() => '?').join(', ');
  const comboPlaceholders = comboIds.map(() => '?').join(', ');
  const orderConditions: string[] = [];
  const orderParameters: string[] = [eventId];
  if (productIds.length > 0) {
    orderConditions.push(
      `(oi.item_kind = 'product' AND oi.item_id IN (${productPlaceholders}))
       OR (oi.item_kind = 'combo' AND oi.item_id IN (
         SELECT combo_id FROM combo_components WHERE product_id IN (${productPlaceholders})
       ))`,
    );
    orderParameters.push(...productIds, ...productIds);
  }
  if (comboIds.length > 0) {
    orderConditions.push(`oi.item_kind = 'combo' AND oi.item_id IN (${comboPlaceholders})`);
    orderParameters.push(...comboIds);
  }
  const affectedOrders =
    orderConditions.length === 0
      ? []
      : (database.sqlite
          .prepare(
            `SELECT DISTINCT o.id
             FROM orders o
             INNER JOIN order_items oi ON oi.order_id = o.id
             WHERE o.event_id = ? AND o.status IN ('open', 'paid')
               AND (${orderConditions.map((condition) => `(${condition})`).join(' OR ')})`,
          )
          .all(...orderParameters) as { readonly id: string }[]);
  if (affectedOrders.length > 0 && !input.deleteLinkedSales) {
    throw new Error(
      `O fornecedor possui ${String(affectedOrders.length)} venda(s) ou comanda(s) vinculada(s). Confirme a exclusão das vendas para continuar.`,
    );
  }

  database.sqlite.transaction(() => {
    for (const order of affectedOrders) {
      cancelOrder(database, {
        orderId: order.id,
        reason: `Exclusão do fornecedor ${supplier.name}: ${reason}`,
      });
    }
    for (const productId of productIds) {
      deleteInventoryProduct(database, {
        productId,
        mode: 'keep-sales-history',
        reason: `Exclusão do fornecedor ${supplier.name}: ${reason}`,
      });
    }
    if (comboIds.length > 0) {
      database.sqlite
        .prepare(`UPDATE combos SET active = 0, updated_at = ? WHERE id IN (${comboPlaceholders})`)
        .run(now, ...comboIds);
    }
    database.sqlite
      .prepare('DELETE FROM food_combo_terms WHERE event_id = ? AND supplier_id = ?')
      .run(eventId, supplier.id);
    database.sqlite
      .prepare('DELETE FROM food_suppliers WHERE id = ? AND event_id = ?')
      .run(supplier.id, eventId);
    appendAudit(database, {
      action: 'food.supplier-deleted',
      entityType: 'food-supplier',
      entityId: supplier.id,
      eventId,
      details: {
        cancelledOrdersCount: affectedOrders.length,
        deactivatedCombosCount: comboIds.length,
        deletedProductsCount: productIds.length,
        name: supplier.name,
        reason,
      },
    });
  })();
}

export function createExternalFoodItem(
  database: DatabaseContext,
  input: {
    readonly categoryId: string;
    readonly supplierId?: string | undefined;
    readonly name: string;
    readonly supplierUnitCents?: number | undefined;
    readonly commissionUnitCents?: number | undefined;
    readonly initialQuantity: number;
    readonly comboOnly: boolean;
  },
): DatabaseFoodState {
  requireProduction(database);
  const eventId = requireEvent(database);
  const setting = getFoodState(database);
  if (setting.supplierMode !== 'external')
    throw new Error('Configure Comida para fornecedor externo antes de cadastrar este item.');
  const directSale = !input.comboOnly;
  const supplier = directSale
    ? database.sqlite
        .prepare('SELECT id FROM food_suppliers WHERE id=? AND event_id=? AND active=1')
        .get(input.supplierId, eventId)
    : true;
  if (supplier === undefined) throw new Error('Selecione um fornecedor ativo deste evento.');
  const supplierUnitCents = input.supplierUnitCents ?? 0;
  const commissionUnitCents = input.commissionUnitCents ?? 0;
  const total = supplierUnitCents + commissionUnitCents;
  if (
    !Number.isInteger(total) ||
    (directSale && total <= 0) ||
    !Number.isInteger(input.initialQuantity) ||
    input.initialQuantity <= 0
  )
    throw new Error('Informe valores e quantidade válidos.');
  const product = createInventoryProduct(database, {
    categoryId: input.categoryId,
    name: input.name,
    kind: 'food',
    costCents: 0,
    salePriceCents: directSale ? total : 0,
    lowStockThreshold: 0,
    comboOnly: input.comboOnly,
  });
  const now = Date.now();
  database.sqlite.transaction(() => {
    if (directSale) {
      database.sqlite
        .prepare(
          'INSERT INTO food_product_terms (product_id,event_id,supplier_id,supplier_unit_cents,commission_unit_cents,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          product.id,
          eventId,
          input.supplierId,
          supplierUnitCents,
          commissionUnitCents,
          now,
          now,
        );
    }
    recordStockMovement(database, {
      productId: product.id,
      type: 'correction-positive',
      quantity: input.initialQuantity,
      note: 'Entrada de fornecedor externo',
    });
    appendAudit(database, {
      action: 'food.external-item-created',
      entityType: 'food-product',
      entityId: product.id,
      eventId,
      details: {
        supplierId: input.supplierId ?? null,
        supplierUnitCents,
        commissionUnitCents,
        initialQuantity: input.initialQuantity,
        comboOnly: input.comboOnly,
      },
    });
  })();
  return getFoodState(database);
}
