import { randomUUID } from 'node:crypto';

import { buildStockRequirements } from './operation-stock';
import type { DatabaseOrderItem } from './operation-types';
import type { DatabaseContext } from './types';

export function recordExternalFoodSettlements(
  database: DatabaseContext,
  eventId: string,
  orderId: string,
  items: readonly DatabaseOrderItem[],
  now: number,
): void {
  const comboTermForItem = database.sqlite.prepare(
    `SELECT supplier_unit_cents, commission_unit_cents
     FROM food_combo_terms WHERE event_id = ? AND combo_id = ?`,
  );
  const insertComboSettlement = database.sqlite.prepare(
    `INSERT OR IGNORE INTO food_combo_sale_settlements
     (id,event_id,order_id,combo_id,quantity,received_cents,supplier_cents,commission_cents,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const item of items) {
    if (item.itemKind !== 'combo') continue;
    const term = comboTermForItem.get(eventId, item.itemId) as
      | { supplier_unit_cents: number; commission_unit_cents: number }
      | undefined;
    if (term === undefined) continue;
    const supplierCents = term.supplier_unit_cents * item.quantity;
    const commissionCents = term.commission_unit_cents * item.quantity;
    insertComboSettlement.run(
      randomUUID(),
      eventId,
      orderId,
      item.itemId,
      item.quantity,
      supplierCents + commissionCents,
      supplierCents,
      commissionCents,
      now,
    );
  }
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
  database.sqlite.prepare('DELETE FROM food_combo_sale_settlements WHERE order_id=?').run(orderId);
}
