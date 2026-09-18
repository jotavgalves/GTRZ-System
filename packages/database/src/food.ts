import { randomUUID } from 'node:crypto';
import { appendAudit } from './audit';
import { getSessionState } from './control';
import { createInventoryProduct, recordStockMovement } from './inventory';
import { buildStockRequirements } from './operation-stock';
import type { DatabaseOrderItem } from './operation-types';
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
      .all(eventId) as Array<{
      id: string;
      event_id: string;
      name: string;
      active: number;
      created_at: number;
      updated_at: number;
    }>
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
      `SELECT p.id product_id,p.name,fs.name supplier_name,COALESCE(SUM(s.quantity),0) sold_quantity,COALESCE(SUM(s.received_cents),0) received_cents,COALESCE(SUM(s.supplier_cents),0) supplier_cents,COALESCE(SUM(s.commission_cents),0) commission_cents FROM products p INNER JOIN food_product_terms t ON t.product_id=p.id AND t.event_id=? INNER JOIN food_suppliers fs ON fs.id=t.supplier_id LEFT JOIN food_sale_settlements s ON s.product_id=p.id AND s.event_id=? GROUP BY p.id,p.name,fs.name ORDER BY p.name COLLATE NOCASE`,
    )
    .all(eventId, eventId) as Array<{
    product_id: string;
    name: string;
    supplier_name: string | null;
    sold_quantity: number;
    received_cents: number;
    supplier_cents: number;
    commission_cents: number;
  }>;
  const items = rows.map((row) => ({
    productId: row.product_id,
    name: row.name,
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
      .prepare('SELECT 1 FROM food_product_terms WHERE event_id=? LIMIT 1')
      .get(eventId) !== undefined;
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
  return listSuppliers(database, eventId).find((supplier) => supplier.id === id)!;
}

export function updateFoodSupplier(database: DatabaseContext, input: { readonly supplierId: string; readonly name: string }): DatabaseFoodSupplier { requireProduction(database); const eventId=requireEvent(database); const current=database.sqlite.prepare('SELECT id FROM food_suppliers WHERE id=? AND event_id=?').get(input.supplierId,eventId); if(current===undefined) throw new Error('Fornecedor não encontrado neste evento.'); const now=Date.now(); const name=input.name.trim(); database.sqlite.prepare('UPDATE food_suppliers SET name=?, updated_at=? WHERE id=?').run(name,now,input.supplierId); appendAudit(database,{action:'food.supplier-updated',entityType:'food-supplier',entityId:input.supplierId,eventId,details:{name}}); return listSuppliers(database,eventId).find(item=>item.id===input.supplierId)!; }
export function archiveFoodSupplier(database: DatabaseContext, supplierId: string): void { requireProduction(database); const eventId=requireEvent(database); const current=database.sqlite.prepare('SELECT id FROM food_suppliers WHERE id=? AND event_id=?').get(supplierId,eventId); if(current===undefined) throw new Error('Fornecedor não encontrado neste evento.'); database.sqlite.prepare('UPDATE food_suppliers SET active=0, updated_at=? WHERE id=?').run(Date.now(),supplierId); appendAudit(database,{action:'food.supplier-archived',entityType:'food-supplier',entityId:supplierId,eventId,details:{}}); }

export function createExternalFoodItem(
  database: DatabaseContext,
  input: {
    readonly categoryId: string;
    readonly supplierId: string;
    readonly name: string;
    readonly supplierUnitCents: number;
    readonly commissionUnitCents: number;
    readonly initialQuantity: number;
    readonly comboOnly: boolean;
  },
): DatabaseFoodState {
  requireProduction(database);
  const eventId = requireEvent(database);
  const setting = getFoodState(database);
  if (setting.supplierMode !== 'external')
    throw new Error('Configure Comida para fornecedor externo antes de cadastrar este item.');
  const supplier = database.sqlite
    .prepare('SELECT id FROM food_suppliers WHERE id=? AND event_id=? AND active=1')
    .get(input.supplierId, eventId);
  if (supplier === undefined) throw new Error('Selecione um fornecedor ativo deste evento.');
  const total = input.supplierUnitCents + input.commissionUnitCents;
  if (
    !Number.isInteger(total) ||
    total <= 0 ||
    !Number.isInteger(input.initialQuantity) ||
    input.initialQuantity <= 0
  )
    throw new Error('Informe valores e quantidade válidos.');
  const product = createInventoryProduct(database, {
    categoryId: input.categoryId,
    name: input.name,
    kind: 'food',
    costCents: 0,
    salePriceCents: total,
    lowStockThreshold: 0,
    comboOnly: input.comboOnly,
  });
  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        'INSERT INTO food_product_terms (product_id,event_id,supplier_id,supplier_unit_cents,commission_unit_cents,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        product.id,
        eventId,
        input.supplierId,
        input.supplierUnitCents,
        input.commissionUnitCents,
        now,
        now,
      );
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
        supplierId: input.supplierId,
        supplierUnitCents: input.supplierUnitCents,
        commissionUnitCents: input.commissionUnitCents,
        initialQuantity: input.initialQuantity,
        comboOnly: input.comboOnly,
      },
    });
  })();
  return getFoodState(database);
}

export function recordExternalFoodSettlements(
  database: DatabaseContext,
  eventId: string,
  orderId: string,
  items: readonly DatabaseOrderItem[],
  now: number,
): void {
  const requirements = buildStockRequirements(database, items);
  const termForProduct = database.sqlite.prepare(
    `SELECT supplier_unit_cents, commission_unit_cents FROM food_product_terms WHERE event_id=? AND product_id=?`,
  );
  const insert = database.sqlite.prepare(
    `INSERT OR IGNORE INTO food_sale_settlements (id,event_id,order_id,product_id,quantity,received_cents,supplier_cents,commission_cents,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const requirement of requirements) {
    const term = termForProduct.get(eventId, requirement.productId) as
      | { supplier_unit_cents: number; commission_unit_cents: number }
      | undefined;
    if (term === undefined) continue;
    const supplierCents = term.supplier_unit_cents * requirement.quantity;
    const commissionCents = term.commission_unit_cents * requirement.quantity;
    insert.run(
      randomUUID(),
      eventId,
      orderId,
      requirement.productId,
      requirement.quantity,
      supplierCents + commissionCents,
      supplierCents,
      commissionCents,
      now,
    );
  }
}

export function clearExternalFoodSettlements(database: DatabaseContext, orderId: string): void {
  database.sqlite.prepare('DELETE FROM food_sale_settlements WHERE order_id=?').run(orderId);
}
