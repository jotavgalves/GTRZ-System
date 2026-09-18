import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }).notNull(),
});

export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['open', 'closed', 'archived'] }).notNull(),
  startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
  endsAt: integer('ends_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const productCategories = sqliteTable('product_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  categoryId: text('category_id')
    .notNull()
    .references(() => productCategories.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['food', 'drink'] }).notNull(),
  costCents: integer('cost_cents').notNull(),
  salePriceCents: integer('sale_price_cents').notNull(),
  lowStockThreshold: integer('low_stock_threshold').notNull(),
  comboOnly: integer('combo_only', { mode: 'boolean' }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const eventStock = sqliteTable(
  'event_stock',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    quantity: integer('quantity').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.productId] })],
);

export const stockMovements = sqliteTable('stock_movements', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  type: text('type', {
    enum: [
      'purchase',
      'correction-positive',
      'correction-negative',
      'loss',
      'breakage',
      'internal-consumption',
      'courtesy',
      'return',
      'sale',
    ],
  }).notNull(),
  quantity: integer('quantity').notNull(),
  delta: integer('delta').notNull(),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const stockPurchaseLots = sqliteTable('stock_purchase_lots', {
  movementId: text('movement_id')
    .primaryKey()
    .references(() => stockMovements.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  quantity: integer('quantity').notNull(),
  totalCostCents: integer('total_cost_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const stockTransfers = sqliteTable('stock_transfers', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  productName: text('product_name').notNull(),
  sourceEventId: text('source_event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  sourceEventName: text('source_event_name').notNull(),
  destinationEventId: text('destination_event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  destinationEventName: text('destination_event_name').notNull(),
  quantity: integer('quantity').notNull(),
  note: text('note'),
  sourceQuantityBefore: integer('source_quantity_before').notNull(),
  sourceQuantityAfter: integer('source_quantity_after').notNull(),
  destinationQuantityBefore: integer('destination_quantity_before').notNull(),
  destinationQuantityAfter: integer('destination_quantity_after').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const combos = sqliteTable('combos', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  salePriceCents: integer('sale_price_cents').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const comboComponents = sqliteTable(
  'combo_components',
  {
    comboId: text('combo_id')
      .notNull()
      .references(() => combos.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    quantity: integer('quantity').notNull(),
  },
  (table) => [primaryKey({ columns: [table.comboId, table.productId] })],
);

export const servicePoints = sqliteTable('service_points', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  label: text('label').notNull(),
  type: text('type', { enum: ['table', 'counter'] }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  servicePointId: text('service_point_id')
    .notNull()
    .references(() => servicePoints.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  servicePointLabel: text('service_point_label').notNull(),
  status: text('status', { enum: ['open', 'paid', 'cancelled'] }).notNull(),
  subtotalCents: integer('subtotal_cents').notNull(),
  discountCents: integer('discount_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
  closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  itemKind: text('item_kind', { enum: ['product', 'combo'] }).notNull(),
  itemId: text('item_id').notNull(),
  itemName: text('item_name').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  method: text('method', { enum: ['cash', 'pix', 'credit-card', 'debit-card'] }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  receivedCents: integer('received_cents'),
  changeCents: integer('change_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const vouchers = sqliteTable('vouchers', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  code: text('code').notNull(),
  label: text('label').notNull(),
  initialBalanceCents: integer('initial_balance_cents').notNull(),
  remainingBalanceCents: integer('remaining_balance_cents').notNull(),
  status: text('status', { enum: ['active', 'exhausted', 'cancelled'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const voucherTransactions = sqliteTable('voucher_transactions', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  voucherId: text('voucher_id')
    .notNull()
    .references(() => vouchers.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  voucherCode: text('voucher_code').notNull(),
  orderId: text('order_id').references(() => orders.id, {
    onDelete: 'restrict',
    onUpdate: 'cascade',
  }),
  type: text('type', {
    enum: ['issue', 'redemption', 'cancellation', 'reactivation', 'refund'],
  }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  balanceBeforeCents: integer('balance_before_cents').notNull(),
  balanceAfterCents: integer('balance_after_cents').notNull(),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const cashRegisters = sqliteTable('cash_registers', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  status: text('status', { enum: ['open', 'closed'] }).notNull(),
  openingCashCents: integer('opening_cash_cents').notNull(),
  expectedCashCents: integer('expected_cash_cents').notNull(),
  countedCashCents: integer('counted_cash_cents'),
  varianceCents: integer('variance_cents'),
  openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
  closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const cashMovements = sqliteTable('cash_movements', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  cashRegisterId: text('cash_register_id')
    .notNull()
    .references(() => cashRegisters.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  type: text('type', { enum: ['opening', 'supply', 'withdrawal'] }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const expenses = sqliteTable('expenses', {
  id: text('id').primaryKey(),
  eventId: text('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
  category: text('category').notNull(),
  description: text('description').notNull(),
  amountCents: integer('amount_cents').notNull(),
  paymentMethod: text('payment_method', {
    enum: ['cash', 'pix', 'credit-card', 'debit-card'],
  }).notNull(),
  note: text('note'),
  status: text('status', { enum: ['active', 'cancelled'] }).notNull(),
  paymentStatus: text('payment_status', { enum: ['open', 'partial', 'paid'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: text('event_id'),
  profile: text('profile', { enum: ['production', 'cashier'] }).notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  detailsJson: text('details_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const technicalSchema = {
  appMeta,
  auditLog,
  cashMovements,
  cashRegisters,
  comboComponents,
  combos,
  eventStock,
  events,
  expenses,
  orderItems,
  orders,
  payments,
  productCategories,
  products,
  schemaMigrations,
  servicePoints,
  stockMovements,
  stockTransfers,
  voucherTransactions,
  vouchers,
};
