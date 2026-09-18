import { randomUUID } from 'node:crypto';

import { listCombos } from './combos';
import type {
  DatabaseOperationCatalogItem,
  DatabaseOrderItem,
  DatabaseOrderItemKind,
} from './operation-types';
import { getProductPresentation } from './product-presentation';
import type { DatabaseContext } from './types';

interface ProductCatalogRow {
  readonly id: string;
  readonly name: string;
  readonly sale_price_cents: number;
  readonly active: number;
  readonly available_quantity: number;
}

interface ComboComponentRow {
  readonly product_id: string;
  readonly product_name: string;
  readonly quantity: number;
}

export interface StockRequirement {
  readonly productId: string;
  readonly productName: string;
  quantity: number;
}

interface SaleMovementRow {
  readonly product_id: string;
  readonly quantity: number;
}

function isComboAvailableInEvent(
  database: DatabaseContext,
  eventId: string,
  comboId: string,
): boolean {
  const row = database.sqlite
    .prepare(
      `SELECT
         COUNT(*) AS component_count,
         COALESCE(SUM(CASE WHEN es.product_id IS NULL THEN 0 ELSE 1 END), 0) AS pulled_count
       FROM combo_components cc
       LEFT JOIN event_stock es
         ON es.product_id = cc.product_id
        AND es.event_id = ?
       WHERE cc.combo_id = ?`,
    )
    .get(eventId, comboId) as { readonly component_count: number; readonly pulled_count: number };

  return row.component_count > 0 && row.component_count === row.pulled_count;
}

export function listOperationCatalog(
  database: DatabaseContext,
  eventId: string | null,
): readonly DatabaseOperationCatalogItem[] {
  const products =
    eventId === null
      ? []
      : (database.sqlite
          .prepare(
            `SELECT
               p.id,
               p.name,
               p.sale_price_cents,
               p.active,
               p.combo_only,
               es.quantity AS available_quantity
             FROM event_stock es
             INNER JOIN products p ON p.id = es.product_id
             WHERE es.event_id = ? AND p.combo_only = 0
             ORDER BY p.active DESC, p.name COLLATE NOCASE`,
          )
          .all(eventId) as ProductCatalogRow[]);
  const productItems = products.map((product) => {
    const presentation = getProductPresentation(database, product.id);
    return {
      id: product.id,
      kind: 'product' as const,
      name: product.name,
      salePriceCents: product.sale_price_cents,
      availableQuantity: product.available_quantity,
      active: product.active === 1,
      imageDataUrl: presentation.imageDataUrl,
      fallbackIcon: presentation.fallbackIcon,
    };
  });
  const comboItems =
    eventId === null
      ? []
      : listCombos(database)
          .filter((combo) => isComboAvailableInEvent(database, eventId, combo.id))
          .map((combo) => ({
            id: combo.id,
            kind: 'combo' as const,
            name: combo.name,
            salePriceCents: combo.salePriceCents,
            availableQuantity: combo.availableUnits,
            active: combo.active,
            imageDataUrl: null,
            fallbackIcon: 'package' as const,
          }));

  return [...productItems, ...comboItems].sort((left, right) =>
    left.name.localeCompare(right.name, 'pt-BR'),
  );
}

export function requireAvailableCatalogItem(
  database: DatabaseContext,
  eventId: string,
  itemKind: DatabaseOrderItemKind,
  itemId: string,
  quantity: number,
): DatabaseOperationCatalogItem {
  const item = listOperationCatalog(database, eventId).find(
    (candidate) => candidate.kind === itemKind && candidate.id === itemId,
  );

  if (item === undefined) {
    throw new Error('O item informado não existe no catálogo.');
  }

  if (!item.active) {
    throw new Error(`${item.name} está inativo e não pode ser vendido.`);
  }

  if (item.availableQuantity < quantity) {
    throw new Error(
      `Estoque insuficiente para ${item.name}. Disponível: ${String(item.availableQuantity)}.`,
    );
  }

  return item;
}

function addRequirement(
  requirements: Map<string, StockRequirement>,
  productId: string,
  productName: string,
  quantity: number,
): void {
  const current = requirements.get(productId);

  if (current === undefined) {
    requirements.set(productId, { productId, productName, quantity });
    return;
  }

  current.quantity += quantity;
}

export function buildStockRequirements(
  database: DatabaseContext,
  items: readonly DatabaseOrderItem[],
): readonly StockRequirement[] {
  const requirements = new Map<string, StockRequirement>();
  const findProduct = database.sqlite.prepare('SELECT name FROM products WHERE id = ?');
  const listComponents = database.sqlite.prepare(
    `SELECT p.id AS product_id, p.name AS product_name, cc.quantity
     FROM combo_components cc
     INNER JOIN products p ON p.id = cc.product_id
     WHERE cc.combo_id = ?`,
  );

  for (const item of items) {
    if (item.itemKind === 'product') {
      const product = findProduct.get(item.itemId) as { readonly name: string } | undefined;

      if (product === undefined) {
        throw new Error(`O produto ${item.itemName} não existe mais no catálogo.`);
      }

      addRequirement(requirements, item.itemId, product.name, item.quantity);
      continue;
    }

    const components = listComponents.all(item.itemId) as ComboComponentRow[];

    if (components.length === 0) {
      throw new Error(`O combo ${item.itemName} não possui composição válida.`);
    }

    for (const component of components) {
      addRequirement(
        requirements,
        component.product_id,
        component.product_name,
        component.quantity * item.quantity,
      );
    }
  }

  return [...requirements.values()];
}

export function deductOrderStock(
  database: DatabaseContext,
  eventId: string,
  orderId: string,
  items: readonly DatabaseOrderItem[],
  now: number,
): void {
  const requirements = buildStockRequirements(database, items);
  const getStock = database.sqlite.prepare(
    'SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?',
  );

  for (const requirement of requirements) {
    const stock = getStock.get(eventId, requirement.productId) as
      | { readonly quantity: number }
      | undefined;
    const available = stock?.quantity ?? 0;

    if (available < requirement.quantity) {
      throw new Error(
        `Estoque insuficiente para ${requirement.productName}. Disponível: ${String(available)}.`,
      );
    }
  }

  const updateStock = database.sqlite.prepare(
    `UPDATE event_stock
     SET quantity = quantity - ?, updated_at = ?
     WHERE event_id = ? AND product_id = ?`,
  );
  const insertMovement = database.sqlite.prepare(
    `INSERT INTO stock_movements
     (id, event_id, product_id, type, quantity, delta, note, created_at)
     VALUES (?, ?, ?, 'sale', ?, ?, ?, ?)`,
  );

  for (const requirement of requirements) {
    updateStock.run(requirement.quantity, now, eventId, requirement.productId);
    insertMovement.run(
      randomUUID(),
      eventId,
      requirement.productId,
      requirement.quantity,
      -requirement.quantity,
      `Venda da comanda ${orderId}`,
      now,
    );
  }
}

export function restoreOrderStock(
  database: DatabaseContext,
  eventId: string,
  orderId: string,
  now: number,
): number {
  const saleNote = `Venda da comanda ${orderId}`;
  const movements = database.sqlite
    .prepare(
      `SELECT product_id, SUM(quantity) AS quantity
       FROM stock_movements
       WHERE event_id = ? AND type = 'sale' AND note = ?
       GROUP BY product_id`,
    )
    .all(eventId, saleNote) as SaleMovementRow[];

  if (movements.length === 0) {
    return 0;
  }

  const productExists = database.sqlite.prepare('SELECT id FROM products WHERE id = ?');
  const updateStock = database.sqlite.prepare(
    `INSERT INTO event_stock (event_id, product_id, quantity, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id, product_id)
     DO UPDATE SET quantity = event_stock.quantity + excluded.quantity,
                   updated_at = excluded.updated_at`,
  );
  const insertMovement = database.sqlite.prepare(
    `INSERT INTO stock_movements
     (id, event_id, product_id, type, quantity, delta, note, created_at)
     VALUES (?, ?, ?, 'return', ?, ?, ?, ?)`,
  );
  let restoredUnits = 0;

  for (const movement of movements) {
    if (productExists.get(movement.product_id) === undefined) {
      continue;
    }
    updateStock.run(eventId, movement.product_id, movement.quantity, now);
    insertMovement.run(
      randomUUID(),
      eventId,
      movement.product_id,
      movement.quantity,
      movement.quantity,
      `Estorno da comanda ${orderId}`,
      now,
    );
    restoredUnits += movement.quantity;
  }

  return restoredUnits;
}
