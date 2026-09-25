import { randomUUID } from 'node:crypto';

import { appendAudit } from './audit';
import { getSessionState } from './control';
import type { DatabaseContext } from './types';

export interface DatabaseComboComponentInput {
  readonly productId: string;
  readonly quantity: number;
  readonly choiceGroup?: string | undefined;
  readonly choiceLabel?: string | undefined;
  readonly sortOrder?: number | undefined;
}

interface ComboWriteInput {
  readonly name: string;
  readonly kind?: 'food' | 'drink' | undefined;
  readonly salePriceCents: number;
  readonly components: readonly DatabaseComboComponentInput[];
  readonly externalFoodTerms?:
    | {
        readonly supplierId: string;
        readonly supplierUnitCents: number;
        readonly commissionUnitCents: number;
      }
    | undefined;
}

export interface DatabaseComboComponent {
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly salePriceCents: number;
  readonly availableQuantity: number;
  readonly choiceGroup: string | null;
  readonly choiceLabel: string | null;
  readonly sortOrder: number;
}

export interface DatabaseExternalFoodComboTerms {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly supplierUnitCents: number;
  readonly commissionUnitCents: number;
}

export interface DatabaseComboFinancials {
  readonly costCents: number;
  readonly grossProfitCents: number;
  readonly marginPercent: number;
}

export interface DatabaseInventoryCombo {
  readonly id: string;
  readonly name: string;
  readonly kind: 'food' | 'drink';
  readonly salePriceCents: number;
  readonly individualSaleTotalCents: number;
  readonly savingsCents: number;
  readonly availableUnits: number;
  readonly active: boolean;
  readonly components: readonly DatabaseComboComponent[];
  readonly externalFoodTerms: DatabaseExternalFoodComboTerms | null;
  readonly financials: DatabaseComboFinancials | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DatabaseComboDeletionResult {
  readonly comboId: string;
  readonly deleted: true;
}

interface ComboRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'food' | 'drink';
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
  readonly sort_order: number;
}

interface ExternalFoodComboTermsRow {
  readonly combo_id: string;
  readonly supplier_id: string;
  readonly supplier_name: string;
  readonly supplier_unit_cents: number;
  readonly commission_unit_cents: number;
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

function requireExternalFoodTerms(
  database: DatabaseContext,
  input: ComboWriteInput,
): string | null {
  const terms = input.externalFoodTerms;
  if (terms === undefined) return null;
  if ((input.kind ?? 'drink') !== 'food') {
    throw new Error('Somente um combo de comida pode usar condições de fornecedor externo.');
  }
  if (
    !Number.isInteger(terms.supplierUnitCents) ||
    !Number.isInteger(terms.commissionUnitCents) ||
    terms.supplierUnitCents < 0 ||
    terms.commissionUnitCents < 0 ||
    terms.supplierUnitCents + terms.commissionUnitCents <= 0
  ) {
    throw new Error('Informe o valor do fornecedor ou a comissão da GTRZ.');
  }
  if (input.salePriceCents !== terms.supplierUnitCents + terms.commissionUnitCents) {
    throw new Error('O preço do combo externo deve ser a soma do fornecedor e da comissão GTRZ.');
  }
  const event = getSessionState(database).activeEvent;
  if (event === null) throw new Error('Selecione um evento aberto antes de cadastrar este combo.');
  const supplier = database.sqlite
    .prepare(
      `SELECT supplier.id
       FROM food_suppliers supplier
       INNER JOIN food_event_settings setting ON setting.event_id = supplier.event_id
       WHERE supplier.id = ? AND supplier.event_id = ? AND supplier.active = 1
         AND setting.supplier_mode = 'external'`,
    )
    .get(terms.supplierId, event.id);
  if (supplier === undefined) {
    throw new Error('Selecione um fornecedor ativo configurado para comida externa neste evento.');
  }
  return event.id;
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
         cc.choice_label,
         cc.sort_order
       FROM combo_components cc
       INNER JOIN products p ON p.id = cc.product_id
       LEFT JOIN event_stock es
         ON es.product_id = p.id
        AND es.event_id = ?
       ORDER BY cc.combo_id, cc.sort_order, cc.id`,
    )
    .all(activeEventId) as ComponentRow[];
}

function mapCombo(
  row: ComboRow,
  componentRows: readonly ComponentRow[],
  activeEventId: string | null,
  showFinancials: boolean,
  externalFoodTerms: DatabaseExternalFoodComboTerms | null,
): DatabaseInventoryCombo {
  const components = componentRows.map((component) => ({
    productId: component.product_id,
    productName: component.product_name,
    quantity: component.required_quantity,
    salePriceCents: component.sale_price_cents,
    availableQuantity: component.available_quantity,
    choiceGroup: component.choice_group,
    choiceLabel: component.choice_label,
    sortOrder: component.sort_order,
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
  const effectiveCostCents = externalFoodTerms?.supplierUnitCents ?? costCents;
  const grossProfitCents = row.sale_price_cents - effectiveCostCents;

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    salePriceCents: row.sale_price_cents,
    individualSaleTotalCents,
    savingsCents: individualSaleTotalCents - row.sale_price_cents,
    availableUnits,
    active: row.active === 1,
    components,
    externalFoodTerms,
    financials: showFinancials
      ? {
          costCents: effectiveCostCents,
          grossProfitCents,
          marginPercent: calculateMarginPercent(row.sale_price_cents, effectiveCostCents),
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
      `SELECT id, name, kind, sale_price_cents, active, created_at, updated_at
       FROM combos
       ORDER BY active DESC, name COLLATE NOCASE`,
    )
    .all() as ComboRow[];
  const componentRows = listComponentRows(database, activeEventId);
  const externalTermsByCombo = new Map<string, DatabaseExternalFoodComboTerms>();
  if (activeEventId !== null) {
    const rows = database.sqlite
      .prepare(
        `SELECT terms.combo_id, terms.supplier_id, supplier.name AS supplier_name,
                terms.supplier_unit_cents, terms.commission_unit_cents
         FROM food_combo_terms terms
         INNER JOIN food_suppliers supplier ON supplier.id = terms.supplier_id
         WHERE terms.event_id = ?`,
      )
      .all(activeEventId) as ExternalFoodComboTermsRow[];
    for (const row of rows) {
      externalTermsByCombo.set(row.combo_id, {
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        supplierUnitCents: row.supplier_unit_cents,
        commissionUnitCents: row.commission_unit_cents,
      });
    }
  }
  const componentsByCombo = new Map<string, ComponentRow[]>();

  for (const component of componentRows) {
    const grouped = componentsByCombo.get(component.combo_id) ?? [];
    grouped.push(component);
    componentsByCombo.set(component.combo_id, grouped);
  }

  return comboRows.map((combo) =>
    mapCombo(
      combo,
      componentsByCombo.get(combo.id) ?? [],
      activeEventId,
      showFinancials,
      externalTermsByCombo.get(combo.id) ?? null,
    ),
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
    `INSERT INTO combo_components
     (id, combo_id, product_id, quantity, choice_group, choice_label, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const [index, component] of components.entries()) {
    insert.run(
      randomUUID(),
      comboId,
      component.productId,
      component.quantity,
      component.choiceGroup?.trim() ?? null,
      component.choiceLabel?.trim() ?? null,
      component.sortOrder ?? index,
    );
  }
}

function saveExternalFoodTerms(
  database: DatabaseContext,
  comboId: string,
  eventId: string | null,
  terms: ComboWriteInput['externalFoodTerms'],
  now: number,
): void {
  if (terms === undefined) {
    database.sqlite.prepare('DELETE FROM food_combo_terms WHERE combo_id = ?').run(comboId);
    return;
  }
  if (eventId === null) throw new Error('Selecione um evento aberto antes de salvar o combo.');
  database.sqlite
    .prepare(
      `INSERT INTO food_combo_terms
       (combo_id, event_id, supplier_id, supplier_unit_cents, commission_unit_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(combo_id, event_id) DO UPDATE SET
         supplier_id = excluded.supplier_id,
         supplier_unit_cents = excluded.supplier_unit_cents,
         commission_unit_cents = excluded.commission_unit_cents,
         updated_at = excluded.updated_at`,
    )
    .run(
      comboId,
      eventId,
      terms.supplierId,
      terms.supplierUnitCents,
      terms.commissionUnitCents,
      now,
      now,
    );
}

export function createCombo(
  database: DatabaseContext,
  input: ComboWriteInput,
): DatabaseInventoryCombo {
  requireProduction(database);
  const name = input.name.trim();
  requireUniqueName(database, name);
  validateComponents(database, input.components);
  const externalFoodEventId = requireExternalFoodTerms(database, input);

  if (!Number.isInteger(input.salePriceCents) || input.salePriceCents < 0) {
    throw new Error('O preço do combo deve ser informado em centavos inteiros não negativos.');
  }

  const comboId = randomUUID();
  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `INSERT INTO combos
         (id, name, kind, sale_price_cents, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(comboId, name, input.kind ?? 'drink', input.salePriceCents, now, now);
    insertComponents(database, comboId, input.components);
    saveExternalFoodTerms(database, comboId, externalFoodEventId, input.externalFoodTerms, now);
    appendAudit(database, {
      action: 'combo.created',
      entityType: 'combo',
      entityId: comboId,
      details: {
        components: input.components,
        externalFoodTerms: input.externalFoodTerms,
        kind: input.kind ?? 'drink',
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
  const externalFoodEventId = requireExternalFoodTerms(database, input);

  if (!Number.isInteger(input.salePriceCents) || input.salePriceCents < 0) {
    throw new Error('O preço do combo deve ser informado em centavos inteiros não negativos.');
  }

  const now = Date.now();

  database.sqlite.transaction(() => {
    database.sqlite
      .prepare(
        `UPDATE combos
         SET name = ?, kind = ?, sale_price_cents = ?, active = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        name,
        input.kind ?? 'drink',
        input.salePriceCents,
        input.active ? 1 : 0,
        now,
        input.comboId,
      );
    database.sqlite.prepare('DELETE FROM combo_components WHERE combo_id = ?').run(input.comboId);
    insertComponents(database, input.comboId, input.components);
    saveExternalFoodTerms(
      database,
      input.comboId,
      externalFoodEventId,
      input.externalFoodTerms,
      now,
    );
    appendAudit(database, {
      action: 'combo.updated',
      entityType: 'combo',
      entityId: input.comboId,
      details: {
        after: {
          active: input.active,
          components: input.components,
          externalFoodTerms: input.externalFoodTerms,
          kind: input.kind ?? 'drink',
          name,
          salePriceCents: input.salePriceCents,
        },
        before,
      },
    });
  })();

  return requireCombo(database, input.comboId);
}

export function deleteCombo(
  database: DatabaseContext,
  input: { readonly comboId: string; readonly reason: string },
): DatabaseComboDeletionResult {
  requireProduction(database);
  const combo = requireCombo(database, input.comboId);
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new Error('Informe o motivo da exclusão do combo.');
  }
  const referencedOrders = database.sqlite
    .prepare(
      `SELECT COUNT(DISTINCT o.id) AS amount
       FROM orders o
       INNER JOIN order_items item ON item.order_id = o.id
       WHERE item.item_kind = 'combo' AND item.item_id = ? AND o.status != 'cancelled'`,
    )
    .get(combo.id) as { readonly amount: number };
  if (referencedOrders.amount > 0) {
    throw new Error(
      'O combo possui vendas ou comandas registradas. Cancele-as ou zere o evento antes de excluí-lo.',
    );
  }

  database.sqlite.transaction(() => {
    database.sqlite.prepare('DELETE FROM food_combo_sale_settlements WHERE combo_id = ?').run(combo.id);
    database.sqlite.prepare('DELETE FROM food_combo_terms WHERE combo_id = ?').run(combo.id);
    database.sqlite.prepare('DELETE FROM combo_components WHERE combo_id = ?').run(combo.id);
    database.sqlite.prepare('DELETE FROM combos WHERE id = ?').run(combo.id);
    appendAudit(database, {
      action: 'combo.deleted',
      entityType: 'combo',
      entityId: combo.id,
      details: { name: combo.name, reason },
    });
  })();

  return { comboId: combo.id, deleted: true };
}
