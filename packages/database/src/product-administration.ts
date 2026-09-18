import { appendAudit } from './audit';
import { getSessionState } from './control';
import { cancelOrder } from './operation-cancellation';
import { clearProductPresentation } from './product-presentation';
import type { DatabaseContext } from './types';

export type DatabaseProductDeletionMode = 'keep-sales-history' | 'refund-active-event-sales';

export interface DatabaseProductEconomics {
  readonly averagePurchaseCostCents: number;
  readonly currentStockValueCents: number;
  readonly contributedCostCents: number;
}

export interface DatabaseProductDeletionImpact {
  readonly productId: string;
  readonly productName: string;
  readonly currentQuantity: number;
  readonly openOrdersCount: number;
  readonly paidOrdersInActiveEventCount: number;
  readonly paidOrdersHistoricalCount: number;
  readonly stockMovementsCount: number;
  readonly stockTransfersCount: number;
  readonly affectedCombosCount: number;
}

export interface DatabaseProductDeletionResult {
  readonly productId: string;
  readonly deleted: true;
  readonly refundedOrdersCount: number;
  readonly preservedHistoricalOrdersCount: number;
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('A administração de produtos exige o perfil Produção.');
  }
}

function requireProduct(
  database: DatabaseContext,
  productId: string,
): { readonly id: string; readonly name: string; readonly costCents: number } {
  const row = database.sqlite
    .prepare('SELECT id, name, cost_cents FROM products WHERE id = ?')
    .get(productId) as
    | { readonly id: string; readonly name: string; readonly cost_cents: number }
    | undefined;
  if (row === undefined) {
    throw new Error('O produto informado não existe.');
  }
  return { id: row.id, name: row.name, costCents: row.cost_cents };
}

export function getProductEconomics(
  database: DatabaseContext,
  productId: string,
  eventId: string | null,
): DatabaseProductEconomics {
  const product = requireProduct(database, productId);
  if (eventId === null) {
    return { averagePurchaseCostCents: product.costCents, currentStockValueCents: 0, contributedCostCents: 0 };
  }

  const stock = database.sqlite
    .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
    .get(eventId, productId) as { readonly quantity: number } | undefined;
  const contribution = database.sqlite
    .prepare(
      `SELECT
         COALESCE(SUM(sm.quantity), 0) AS units,
         COALESCE(SUM(COALESCE(lot.total_cost_cents, sm.quantity * p.cost_cents)), 0)
           AS total_cost_cents
       FROM stock_movements sm
       INNER JOIN products p ON p.id = sm.product_id
       LEFT JOIN stock_purchase_lots lot ON lot.movement_id = sm.id
       WHERE sm.event_id = ? AND sm.product_id = ? AND sm.type = 'purchase'`,
    )
    .get(eventId, productId) as {
    readonly units: number;
    readonly total_cost_cents: number;
  };
  const averagePurchaseCostCents =
    contribution.units === 0
      ? product.costCents
      : Math.round(contribution.total_cost_cents / contribution.units);

  return {
    averagePurchaseCostCents,
    currentStockValueCents: Math.max((stock?.quantity ?? 0) * averagePurchaseCostCents, 0),
    contributedCostCents: contribution.total_cost_cents,
  };
}

function orderProductPredicate(): string {
  return `(
    (oi.item_kind = 'product' AND oi.item_id = ?)
    OR
    (oi.item_kind = 'combo' AND oi.item_id IN (
      SELECT combo_id FROM combo_components WHERE product_id = ?
    ))
  )`;
}

function countOrders(
  database: DatabaseContext,
  productId: string,
  status: 'open' | 'paid',
  eventId?: string,
): number {
  const eventClause = eventId === undefined ? '' : 'AND o.event_id = ?';
  const params: unknown[] = [productId, productId, status];
  if (eventId !== undefined) params.push(eventId);
  const row = database.sqlite
    .prepare(
      `SELECT COUNT(DISTINCT o.id) AS amount
       FROM orders o
       INNER JOIN order_items oi ON oi.order_id = o.id
       WHERE ${orderProductPredicate()} AND o.status = ? ${eventClause}`,
    )
    .get(...params) as { readonly amount: number };
  return row.amount;
}

export function previewProductDeletion(
  database: DatabaseContext,
  productId: string,
): DatabaseProductDeletionImpact {
  requireProduction(database);
  const product = requireProduct(database, productId);
  const activeEventId = getSessionState(database).activeEvent?.id;
  const quantity = database.sqlite
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS amount FROM event_stock WHERE product_id = ?')
    .get(productId) as { readonly amount: number };
  const movements = database.sqlite
    .prepare('SELECT COUNT(*) AS amount FROM stock_movements WHERE product_id = ?')
    .get(productId) as { readonly amount: number };
  const transfers = database.sqlite
    .prepare('SELECT COUNT(*) AS amount FROM stock_transfers WHERE product_id = ?')
    .get(productId) as { readonly amount: number };
  const combos = database.sqlite
    .prepare('SELECT COUNT(*) AS amount FROM combo_components WHERE product_id = ?')
    .get(productId) as { readonly amount: number };

  return {
    productId,
    productName: product.name,
    currentQuantity: quantity.amount,
    openOrdersCount: countOrders(database, productId, 'open'),
    paidOrdersInActiveEventCount:
      activeEventId === undefined ? 0 : countOrders(database, productId, 'paid', activeEventId),
    paidOrdersHistoricalCount: countOrders(database, productId, 'paid'),
    stockMovementsCount: movements.amount,
    stockTransfersCount: transfers.amount,
    affectedCombosCount: combos.amount,
  };
}

export function deleteInventoryProduct(
  database: DatabaseContext,
  input: {
    readonly productId: string;
    readonly mode: DatabaseProductDeletionMode;
    readonly reason: string;
  },
): DatabaseProductDeletionResult {
  requireProduction(database);
  const product = requireProduct(database, input.productId);
  const impact = previewProductDeletion(database, product.id);
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new Error('Informe o motivo da exclusão do produto.');
  }
  if (impact.openOrdersCount > 0) {
    throw new Error(
      `O produto ainda está em ${String(impact.openOrdersCount)} comanda(s) aberta(s). Remova-o antes de excluir.`,
    );
  }

  const activeEventId = getSessionState(database).activeEvent?.id ?? null;
  let refundedOrdersCount = 0;

  if (input.mode === 'refund-active-event-sales') {
    if (activeEventId === null) {
      throw new Error('Selecione o evento das vendas que deseja estornar.');
    }
    const rows = database.sqlite
      .prepare(
        `SELECT DISTINCT o.id
         FROM orders o
         INNER JOIN order_items oi ON oi.order_id = o.id
         WHERE ${orderProductPredicate()} AND o.status = 'paid' AND o.event_id = ?`,
      )
      .all(product.id, product.id, activeEventId) as { readonly id: string }[];
    for (const row of rows) {
      cancelOrder(database, {
        orderId: row.id,
        reason: `Exclusão do produto ${product.name}: ${reason}`,
      });
      refundedOrdersCount += 1;
    }
  }

  const now = Date.now();
  database.sqlite.transaction(() => {
    const affectedCombos = database.sqlite
      .prepare('SELECT combo_id FROM combo_components WHERE product_id = ?')
      .all(product.id) as { readonly combo_id: string }[];
    for (const combo of affectedCombos) {
      database.sqlite
        .prepare('UPDATE combos SET active = 0, updated_at = ? WHERE id = ?')
        .run(now, combo.combo_id);
    }

    database.sqlite.prepare('DELETE FROM combo_components WHERE product_id = ?').run(product.id);
    database.sqlite.prepare('DELETE FROM stock_transfers WHERE product_id = ?').run(product.id);
    database.sqlite.prepare('DELETE FROM stock_purchase_lots WHERE product_id = ?').run(product.id);
    database.sqlite.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(product.id);
    database.sqlite.prepare('DELETE FROM event_stock WHERE product_id = ?').run(product.id);
    clearProductPresentation(database, product.id);
    database.sqlite.prepare('DELETE FROM products WHERE id = ?').run(product.id);

    appendAudit(database, {
      action: 'inventory.product-deleted',
      entityType: 'product',
      entityId: product.id,
      eventId: activeEventId,
      details: {
        affectedCombosCount: impact.affectedCombosCount,
        mode: input.mode,
        name: product.name,
        preservedHistoricalOrdersCount: Math.max(
          impact.paidOrdersHistoricalCount - refundedOrdersCount,
          0,
        ),
        reason,
        refundedOrdersCount,
        removedStockMovementsCount: impact.stockMovementsCount,
        removedStockTransfersCount: impact.stockTransfersCount,
      },
    });
  })();

  return {
    productId: product.id,
    deleted: true,
    refundedOrdersCount,
    preservedHistoricalOrdersCount: Math.max(
      impact.paidOrdersHistoricalCount - refundedOrdersCount,
      0,
    ),
  };
}
