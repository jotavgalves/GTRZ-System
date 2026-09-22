import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getOrder, openOrder, recomputeOpenOrder, requireOpenOrderRow } from './operation-core';
import { requireAvailableCatalogItem } from './operation-stock';
import type { DatabaseOrder, DatabaseOrderItemKind } from './operation-types';
import type { DatabaseComboComponentSelectionInput } from './operation-types';
import type { DatabaseContext } from './types';

export function addOrderItem(
  database: DatabaseContext,
  input: {
    readonly orderId: string;
    readonly itemKind: DatabaseOrderItemKind;
    readonly itemId: string;
    readonly quantity: number;
    readonly componentSelections?: readonly DatabaseComboComponentSelectionInput[] | undefined;
  },
): DatabaseOrder {
  const order = requireOpenOrderRow(database, input.orderId);
  const definitions =
    input.itemKind === 'combo'
      ? (database.sqlite
          .prepare(
            `SELECT product_id, quantity, choice_group, choice_label
             FROM combo_components WHERE combo_id = ? ORDER BY product_id`,
          )
          .all(input.itemId) as readonly {
          readonly product_id: string;
          readonly quantity: number;
          readonly choice_group: string | null;
          readonly choice_label: string | null;
        }[])
      : [];
  const choiceDefinitions = new Map<string, Array<(typeof definitions)[number]>>();
  for (const definition of definitions) {
    if (definition.choice_group === null) continue;
    const choices = choiceDefinitions.get(definition.choice_group) ?? [];
    choices.push(definition);
    choiceDefinitions.set(definition.choice_group, choices);
  }
  const selections = input.componentSelections ?? [];
  if (input.itemKind === 'combo') {
    const byGroup = new Map<string, DatabaseComboComponentSelectionInput[]>();
    for (const selection of selections) {
      const group = byGroup.get(selection.choiceGroup) ?? [];
      group.push(selection);
      byGroup.set(selection.choiceGroup, group);
    }
    for (const [groupId, options] of choiceDefinitions) {
      const requested = byGroup.get(groupId) ?? [];
      const required = (options[0]?.quantity ?? 0) * input.quantity;
      const selected = requested.reduce((total, selection) => total + selection.quantity, 0);
      if (selected !== required) {
        throw new Error(
          `Escolha ${String(required)} unidade(s) para ${options[0]?.choice_label ?? groupId}.`,
        );
      }
      for (const selection of requested) {
        if (!options.some((option) => option.product_id === selection.productId)) {
          throw new Error('Uma escolha não pertence a este combo.');
        }
      }
    }
    for (const groupId of byGroup.keys()) {
      if (!choiceDefinitions.has(groupId))
        throw new Error('Uma escolha não pertence a este combo.');
    }
  } else if (selections.length > 0) {
    throw new Error('Somente combos podem receber escolhas de componentes.');
  }
  if (input.itemKind === 'combo') {
    const selectedRequirements = new Map<string, number>();
    for (const definition of definitions) {
      if (definition.choice_group !== null) continue;
      selectedRequirements.set(
        definition.product_id,
        (selectedRequirements.get(definition.product_id) ?? 0) +
          definition.quantity * input.quantity,
      );
    }
    for (const selection of selections) {
      selectedRequirements.set(
        selection.productId,
        (selectedRequirements.get(selection.productId) ?? 0) + selection.quantity,
      );
    }
    for (const [productId, requiredQuantity] of selectedRequirements) {
      const stock = database.sqlite
        .prepare('SELECT quantity FROM event_stock WHERE event_id = ? AND product_id = ?')
        .get(order.event_id, productId) as { readonly quantity: number } | undefined;
      if ((stock?.quantity ?? 0) < requiredQuantity) {
        throw new Error('A escolha do combo não possui estoque suficiente.');
      }
    }
  }
  const existing = database.sqlite
    .prepare(
      `SELECT id, quantity FROM order_items
       WHERE order_id = ? AND item_kind = ? AND item_id = ?`,
    )
    .get(input.orderId, input.itemKind, input.itemId) as
    | { readonly id: string; readonly quantity: number }
    | undefined;
  const canMerge = input.itemKind !== 'combo' || choiceDefinitions.size === 0;
  const nextQuantity = (canMerge ? (existing?.quantity ?? 0) : 0) + input.quantity;
  const item = requireAvailableCatalogItem(
    database,
    order.event_id,
    input.itemKind,
    input.itemId,
    nextQuantity,
  );
  const now = Date.now();

  database.sqlite.transaction(() => {
    if (existing === undefined || !canMerge) {
      const orderItemId = randomUUID();
      database.sqlite
        .prepare(
          `INSERT INTO order_items
           (id, order_id, item_kind, item_id, item_name, quantity,
            unit_price_cents, total_cents, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          orderItemId,
          input.orderId,
          input.itemKind,
          input.itemId,
          item.name,
          input.quantity,
          item.salePriceCents,
          item.salePriceCents * input.quantity,
          now,
        );
      if (input.itemKind === 'combo') {
        const insertAllocation = database.sqlite.prepare(
          `INSERT INTO order_item_component_allocations
           (id, order_item_id, product_id, choice_group, quantity, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const definition of definitions.filter(
          (component) => component.choice_group === null,
        )) {
          insertAllocation.run(
            randomUUID(),
            orderItemId,
            definition.product_id,
            null,
            definition.quantity * input.quantity,
            now,
          );
        }
        for (const selection of selections) {
          insertAllocation.run(
            randomUUID(),
            orderItemId,
            selection.productId,
            selection.choiceGroup,
            selection.quantity,
            now,
          );
        }
      }
    } else {
      database.sqlite
        .prepare(
          `UPDATE order_items
           SET quantity = ?, total_cents = unit_price_cents * ?
           WHERE id = ?`,
        )
        .run(nextQuantity, nextQuantity, existing.id);
      if (input.itemKind === 'combo') {
        const insertAllocation = database.sqlite.prepare(
          `INSERT INTO order_item_component_allocations
           (id, order_item_id, product_id, choice_group, quantity, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const definition of definitions.filter(
          (component) => component.choice_group === null,
        )) {
          insertAllocation.run(
            randomUUID(),
            existing.id,
            definition.product_id,
            null,
            definition.quantity * input.quantity,
            now,
          );
        }
      }
    }

    recomputeOpenOrder(database, input.orderId, now);
    appendAudit(database, {
      action: 'operations.item-added',
      entityType: 'order',
      entityId: input.orderId,
      eventId: order.event_id,
      details: {
        itemId: input.itemId,
        itemKind: input.itemKind,
        itemName: item.name,
        quantity: input.quantity,
      },
    });
  })();

  return getOrder(database, input.orderId);
}

export function startOrderWithItem(
  database: DatabaseContext,
  input: {
    readonly servicePointId: string;
    readonly itemKind: DatabaseOrderItemKind;
    readonly itemId: string;
    readonly quantity: number;
    readonly componentSelections?: readonly DatabaseComboComponentSelectionInput[] | undefined;
  },
): DatabaseOrder {
  return database.sqlite.transaction(() => {
    const order = openOrder(database, input.servicePointId);
    return addOrderItem(database, {
      orderId: order.id,
      itemKind: input.itemKind,
      itemId: input.itemId,
      quantity: input.quantity,
      ...(input.componentSelections === undefined
        ? {}
        : { componentSelections: input.componentSelections }),
    });
  })();
}

export function removeOrderItem(
  database: DatabaseContext,
  input: { readonly orderId: string; readonly orderItemId: string },
): DatabaseOrder {
  const order = requireOpenOrderRow(database, input.orderId);
  const item = database.sqlite
    .prepare('SELECT item_name, quantity FROM order_items WHERE id = ? AND order_id = ?')
    .get(input.orderItemId, input.orderId) as
    | { readonly item_name: string; readonly quantity: number }
    | undefined;

  if (item === undefined) {
    throw new Error('O item informado não pertence à comanda.');
  }

  const now = Date.now();
  database.sqlite.transaction(() => {
    database.sqlite.prepare('DELETE FROM order_items WHERE id = ?').run(input.orderItemId);
    recomputeOpenOrder(database, input.orderId, now);
    appendAudit(database, {
      action: 'operations.item-removed',
      entityType: 'order',
      entityId: input.orderId,
      eventId: order.event_id,
      details: { itemName: item.item_name, quantity: item.quantity },
    });
  })();

  return getOrder(database, input.orderId);
}
