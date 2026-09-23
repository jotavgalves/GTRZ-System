import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getSessionState } from './control';
import type { DatabaseContext } from './types';

export interface DatabaseComboComponentInput {
  readonly productId: string;
  readonly quantity: number;
  readonly choiceGroup?: string | undefined;
  readonly choiceLabel?: string | undefined;
}

interface ComboWriteInput {
  readonly name: string;
  readonly salePriceCents: number;
  readonly components: readonly DatabaseComboComponentInput[];
}

export interface DatabaseComboComponent {
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly salePriceCents: number;
  readonly availableQuantity: number;
  readonly choiceGroup: string | null;
  readonly choiceLabel: string | null;
}

export interface DatabaseComboFinancials {
  readonly costCents: number;
  readonly grossProfitCents: number;
  readonly marginPercent: number;
}

export interface DatabaseInventoryCombo {
  readonly id: string;
  readonly name: string;
  readonly salePriceCents: number;
  readonly individualSaleTotalCents: number;
  readonly savingsCents: number;
  readonly availableUnits: number;
  readonly active: boolean;
  readonly components: readonly DatabaseComboComponent[];
  readonly financials: DatabaseComboFinancials | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ComboRow {
  readonly id: string;
  readonly name: string;
  readonly sale_price_cents: number;
  readonly active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface ComponentRow {
  readonly combo_id: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly required_quantity: number;
  readonly sale_price_cents: number;
  readonly cost_cents: number;
  readonly product_active: number;
  readonly available_quantity: number;
  readonly choice_group: string | null;
  readonly choice_label: string | null;
}

interface ProductValidationRow {
  readonly id: string;
  readonly name: string;
  readonly active: number;
}

function requireProduction(database: DatabaseContext): void {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('Esta operação de combo exige o perfil Produção.');
  }
}

function requireUniqueName(database: DatabaseContext, name: string, excludedId?: string): void {
  const duplicate = database.sqlite
    .prepare(
      `SELECT id
       FROM combos
       WHERE name = ? COLLATE NOCASE
         AND (? IS NULL OR id != ?)`,
    )
    .get(name, excludedId ?? null, excludedId ?? null) as { readonly id: string } | undefined;

  if (duplicate !== undefined) {
    throw new Error('Já existe um combo com esse nome.');
  }
}

function validateComponents(
  database: DatabaseContext,
  components: readonly DatabaseComboComponentInput[],
): void {
  if (components.length === 0) {
    throw new Error('O combo precisa de pelo menos um produto.');
  }

  const uniqueOccurrences = new Set<string>();
  const choices = new Map<string, { quantity: number; label: string; optionCount: number }>();

  for (const component of components) {
    if (!Number.isInteger(component.quantity) || component.quantity <= 0) {
      throw new Error('As quantidades dos componentes devem ser inteiras e positivas.');
    }

    const choiceGroup = component.choiceGroup?.trim();
    const choiceLabel = component.choiceLabel?.trim();
    if ((choiceGroup === undefined) !== (choiceLabel === undefined)) {
      throw new Error('Uma escolha de componente precisa informar o grupo e o rótulo.');
    }
    const occurrenceKey = `${choiceGroup ?? '__fixed__'}:${component.productId}`;
    if (uniqueOccurrences.has(occurrenceKey)) {
      throw new Error('Um produto não pode repetir dentro da mesma parte do combo.');
    }
    uniqueOccurrences.add(occurrenceKey);
    if (choiceGroup !== undefined && choiceLabel !== undefined) {
      const current = choices.get(choiceGroup);
      if (current === undefined) {
        choices.set(choiceGroup, {
          quantity: component.quantity,
          label: choiceLabel,
          optionCount: 1,
        });
      } else {
        if (current.quantity !== component.quantity) {
          throw new Error(`Todas as opções de ${choiceLabel} precisam usar a mesma quantidade.`);
        }
        if (current.label !== choiceLabel) {
          throw new Error(`O grupo ${choiceGroup} possui rótulos de escolha diferentes.`);
        }
        current.optionCount += 1;
      }
    }
    const product = database.sqlite
      .prepare('SELECT id, name, active FROM products WHERE id = ?')
      .get(component.productId) as ProductValidationRow | undefined;

    if (product === undefined) {
      throw new Error('Um dos produtos informados não existe.');
    }

    if (product.active !== 1) {
      throw new Error(`O produto ${product.name} está inativo e não pode compor o combo.`);
    }
  }

  for (const choice of choices.values()) {
    if (choice.optionCount < 2) {
      throw new Error(`A escolha ${choice.label} precisa ter pelo menos duas opções.`);
    }
  }
}

function calculateMarginPercent(salePriceCents: number, costCents: number): number {
  if (salePriceCents === 0) {
    return 0;
  }

  return Math.round(((salePriceCents - costCents) / salePriceCents) * 10_000) / 100;
}

function listComponentRows(
  database: DatabaseContext,
  activeEventId: string | null,
): readonly ComponentRow[] {
  return database.sqlite
    .prepare(
      `SELECT
         cc.combo_id,
         p.id AS product_id,
         p.name AS product_name,
         cc.quantity AS required_quantity,
         p.sale_price_cents,
         p.cost_cents,
         p.active AS product_active,
         COALESCE(es.quantity, 0) AS available_quantity,
         cc.choice_group,
         cc.choice_label
       FROM combo_components cc
       INNER JOIN products p ON p.id = cc.product_id
       LEFT JOIN event_stock es
         ON es.product_id = p.id
        AND es.event_id = ?
       ORDER BY cc.combo_id, p.name COLLATE NOCASE`,
    )
    .all(activeEventId) as ComponentRow[];
}

function mapCombo(
  row: ComboRow,
  componentRows: readonly ComponentRow[],
  activeEventId: string | null,
  showFinancials: boolean,
): DatabaseInventoryCombo {
  const components = componentRows.map((component) => ({
    productId: component.product_id,
    productName: component.product_name,
    quantity: component.required_quantity,
    salePriceCents: component.sale_price_cents,
    availableQuantity: component.available_quantity,
    choiceGroup: component.choice_group,
    choiceLabel: component.choice_label,
  }));
  const fixedComponents = componentRows.filter((component) => component.choice_group === null);
  const choiceComponents = new Map<string, ComponentRow[]>();
  for (const component of componentRows) {
    if (component.choice_group === null) continue;
    const grouped = choiceComponents.get(component.choice_group) ?? [];
    grouped.push(component);
    choiceComponents.set(component.choice_group, grouped);
  }
  // A group represents alternatives, not a bundle of every option. Use the most expensive
  // valid choice for a conservative comparison shown before the operator picks one.
  const individualSaleTotalCents =
    fixedComponents.reduce(
      (total, component) => total + component.sale_price_cents * component.required_quantity,
      0,
    ) +
    [...choiceComponents.values()].reduce((total, options) => {
      const requiredQuantity = options[0]?.required_quantity ?? 0;
      const highestSalePrice = Math.max(...options.map((option) => option.sale_price_cents));
      return total + highestSalePrice * requiredQuantity;
    }, 0);
  const costCents =
    fixedComponents.reduce(
      (total, component) => total + component.cost_cents * component.required_quantity,
      0,
    ) +
    [...choiceComponents.values()].reduce((total, options) => {
      const requiredQuantity = options[0]?.required_quantity ?? 0;
      const highestCost = Math.max(...options.map((option) => option.cost_cents));
      return total + highestCost * requiredQuantity;
    }, 0);
  const hasUnavailableComponent = componentRows.some((component) => component.product_active !== 1);
  const availabilityLimits = [
    ...fixedComponents.map((component) =>
      Math.floor(component.available_quantity / component.required_quantity),
    ),
    ...[...choiceComponents.values()].map((options) =>
      Math.floor(
        options.reduce((total, option) => total + option.available_quantity, 0) /
          (options[0]?.required_quantity ?? 1),
      ),
    ),
  ];
  const availableUnits =
    activeEventId === null || availabilityLimits.length === 0 || hasUnavailableComponent
      ? 0
      : Math.min(...availabilityLimits);
  const grossProfitCents = row.sale_price_cents - costCents;

  return {
    id: row.id,
    name: row.name,
    salePriceCents: row.sale_price_cents,
    individualSaleTotalCents,
    savingsCents: individualSaleTotalCents - row.sale_price_cents,
    availableUnits,
    active: row.active === 1,
    components,
    financials: showFinancials
      ? {
          costCents,
          grossProfitCents,
          marginPercent: calculateMarginPercent(row.sale_price_cents, costCents),
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCombos(database: DatabaseContext): readonly DatabaseInventoryCombo[] {
  const session = getSessionState(database);
  const activeEventId = session.activeEvent?.id ?? null;
  const showFinancials = session.profile === 'production';
  const comboRows = database.sqlite
    .prepare(
      `SELECT id, name, sale_price_cents, active, created_at, updated_at
       FROM combos
       ORDER BY active DESC, name COLLATE NOCASE`,
    )
    .all() as ComboRow[];
  const componentRows = listComponentRows(database, activeEventId);
  const componentsByCombo = new Map<string, ComponentRow[]>();

  for (const component of componentRows) {
    const grouped = componentsByCombo.get(component.combo_id) ?? [];
    grouped.push(component);
    componentsByCombo.set(component.combo_id, grouped);
  }

  return comboRows.map((combo) =>
    mapCombo(combo, componentsByCombo.get(combo.id) ?? [], activeEventId, showFinancials),
  );
}

function requireCombo(database: DatabaseContext, comboId: string): DatabaseInventoryCombo {
  const combo = listCombos(database).find((item) => item.id === comboId);

  if (combo === undefined) {
    throw new Error('O combo informado não existe.');
  }

  return combo;
}

function insertComponents(
  database: DatabaseContext,
  comboId: string,
  components: readonly DatabaseComboComponentInput[],
): void {
  const insert = database.sqlite.prepare(
    `INSERT INTO combo_components (id, combo_id, product_id, quantity, choice_group, choice_label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const component of components) {
    insert.run(
      randomUUID(),
      comboId,
      component.productId,
      component.quantity,
      component.choiceGroup?.trim() ?? null,
      component.choiceLabel?.trim() ?? null,
    );
  }
}

export function createCombo(
  database: DatabaseContext,
  input: ComboWriteInput,
): DatabaseInventoryCombo {
  requireProduction(database);
  const name = input.name.trim();
  requireUniqueName(database, name);
  validateComponents(database, input.components);

  if (!Number.isInteger(input.salePriceCents) || input.salePriceCents < 0) {
    throw new Error('O preço do combo deve ser informado em centavos inteiros não negativos.');
  }

  const comboId = randomUUID();
  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO combos
         (id, name, sale_price_cents, active, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(comboId, name, input.salePriceCents, now, now);
    insertComponents(database, comboId, input.components);
    appendAudit(database, {
      action: 'combo.created',
      entityType: 'combo',
      entityId: comboId,
      details: {
        components: input.components,
        name,
        salePriceCents: input.salePriceCents,
      },
    });
  })();

  return requireCombo(database, comboId);
}

export function updateCombo(
  database: DatabaseContext,
  input: ComboWriteInput & { readonly comboId: string; readonly active: boolean },
): DatabaseInventoryCombo {
  requireProduction(database);
  const before = requireCombo(database, input.comboId);
  const name = input.name.trim();
  requireUniqueName(database, name, input.comboId);
  validateComponents(database, input.components);

  if (!Number.isInteger(input.salePriceCents) || input.salePriceCents < 0) {
    throw new Error('O preço do combo deve ser informado em centavos inteiros não negativos.');
  }

  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE combos
         SET name = ?, sale_price_cents = ?, active = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(name, input.salePriceCents, input.active ? 1 : 0, now, input.comboId);
    database.sqlite.prepare('DELETE FROM combo_components WHERE combo_id = ?').run(input.comboId);
    insertComponents(database, input.comboId, input.components);
    appendAudit(database, {
      action: 'combo.updated',
      entityType: 'combo',
      entityId: input.comboId,
      details: {
        after: {
          active: input.active,
          components: input.components,
          name,
          salePriceCents: input.salePriceCents,
        },
        before,
      },
    });
  })();

  return requireCombo(database, input.comboId);
}
