import type { DatabaseContext } from './types';

interface StockCostRow {
  readonly total_cost_cents: number;
}

export function getEventStockCostCents(database: DatabaseContext, eventId: string): number {
  const rows = database.sqlite
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(lot.total_cost_cents, sm.quantity * p.cost_cents)), 0)
         AS total_cost_cents
       FROM stock_movements sm
       INNER JOIN products p ON p.id = sm.product_id
       LEFT JOIN stock_purchase_lots lot ON lot.movement_id = sm.id
       WHERE sm.event_id = ? AND sm.type = 'purchase'`,
    )
    .all(eventId) as StockCostRow[];

  return rows.reduce((total, row) => total + row.total_cost_cents, 0);
}
