import { z } from 'zod';

export const productKindSchema = z.enum(['food', 'drink']);
export const stockMovementTypeSchema = z.enum([
  'purchase',
  'correction-positive',
  'correction-negative',
  'loss',
  'breakage',
  'internal-consumption',
  'courtesy',
  'return',
]);
export const productFallbackIconSchema = z.enum([
  'package',
  'beer',
  'cup-soda',
  'coffee',
  'sandwich',
  'pizza',
  'ice-cream',
  'glass-water',
  'candy',
]);
export const productImageDataUrlSchema = z.string().max(750000).nullable();

export const productCategorySchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(2).max(60),
  active: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const productFinancialsSchema = z.object({
  costCents: z.number().int().nonnegative(),
  grossProfitCents: z.number().int(),
  marginPercent: z.number(),
  currentStockValueCents: z.number().int().nonnegative(),
  contributedCostCents: z.number().int().nonnegative(),
  potentialGrossRevenueCents: z.number().int().nonnegative(),
  potentialGrossProfitCents: z.number().int(),
});

export const inventoryProductSchema = z.object({
  id: z.uuid(),
  categoryId: z.uuid(),
  categoryName: z.string().min(1),
  name: z.string().trim().min(2).max(100),
  kind: productKindSchema,
  salePriceCents: z.number().int().nonnegative(),
  lowStockThreshold: z.number().int().nonnegative(),
  active: z.boolean(),
  quantity: z.number().int().nonnegative(),
  soldQuantity: z.number().int().nonnegative(),
  lowStock: z.boolean(),
  imageDataUrl: productImageDataUrlSchema,
  fallbackIcon: productFallbackIconSchema,
  financials: productFinancialsSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const inventoryStateSchema = z.object({
  activeEventId: z.uuid().nullable(),
  categories: z.array(productCategorySchema),
  products: z.array(inventoryProductSchema),
});

export const createCategoryInputSchema = z.object({
  name: z.string().trim().min(2).max(60),
});

export const createProductInputSchema = z.object({
  categoryId: z.uuid(),
  name: z.string().trim().min(2).max(100),
  kind: productKindSchema,
  costCents: z.number().int().nonnegative(),
  salePriceCents: z.number().int().nonnegative(),
  lowStockThreshold: z.number().int().nonnegative(),
  imageDataUrl: productImageDataUrlSchema.optional(),
  fallbackIcon: productFallbackIconSchema.optional(),
});

export const updateProductInputSchema = createProductInputSchema.extend({
  productId: z.uuid(),
  active: z.boolean(),
});

export const recordStockMovementInputSchema = z
  .object({
    productId: z.uuid(),
    type: stockMovementTypeSchema,
    quantity: z.number().int().positive(),
    purchaseTotalCents: z.number().int().positive().optional(),
    note: z.string().trim().max(240).optional(),
  })
  .superRefine((input, context) => {
    if (input.type === 'purchase' && input.purchaseTotalCents === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Informe o valor total pago nesta compra.',
        path: ['purchaseTotalCents'],
      });
    }
    if (input.type !== 'purchase' && input.purchaseTotalCents !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'O valor da compra só pode ser informado em entradas por compra.',
        path: ['purchaseTotalCents'],
      });
    }
  });

export const transferStockInputSchema = z
  .object({
    productId: z.uuid(),
    sourceEventId: z.uuid(),
    destinationEventId: z.uuid(),
    quantity: z.number().int().positive(),
    note: z.string().trim().max(240).optional(),
  })
  .superRefine((input, context) => {
    if (input.sourceEventId === input.destinationEventId) {
      context.addIssue({
        code: 'custom',
        message: 'Os eventos de origem e destino devem ser diferentes.',
        path: ['destinationEventId'],
      });
    }
  });

export const stockPurchaseLotSchema = z.object({
  movementId: z.uuid(),
  productId: z.uuid(),
  quantity: z.number().int().positive(),
  totalCostCents: z.number().int().positive(),
  unitCostCents: z.number().int().positive(),
  voided: z.boolean(),
  canUndo: z.boolean(),
  createdAt: z.number().int().nonnegative(),
});
export const stockPurchaseLotListSchema = z.array(stockPurchaseLotSchema);
export const correctStockPurchaseLotInputSchema = z.object({
  movementId: z.uuid(),
  totalCostCents: z.number().int().positive(),
  reason: z.string().trim().min(3).max(240),
});
export const voidStockPurchaseLotInputSchema = z.object({
  movementId: z.uuid(),
  reason: z.string().trim().min(3).max(240),
});

export const stockTransferSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  productName: z.string().min(1),
  sourceEventId: z.uuid(),
  sourceEventName: z.string().min(1),
  destinationEventId: z.uuid(),
  destinationEventName: z.string().min(1),
  quantity: z.number().int().positive(),
  note: z.string().nullable(),
  sourceQuantityBefore: z.number().int().nonnegative(),
  sourceQuantityAfter: z.number().int().nonnegative(),
  destinationQuantityBefore: z.number().int().nonnegative(),
  destinationQuantityAfter: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});

export const stockTransferListSchema = z.array(stockTransferSchema);

export const productDeletionModeSchema = z.enum([
  'keep-sales-history',
  'refund-active-event-sales',
]);
export const productDeletionImpactSchema = z.object({
  productId: z.uuid(),
  productName: z.string().min(1),
  currentQuantity: z.number().int().nonnegative(),
  openOrdersCount: z.number().int().nonnegative(),
  paidOrdersInActiveEventCount: z.number().int().nonnegative(),
  paidOrdersHistoricalCount: z.number().int().nonnegative(),
  stockMovementsCount: z.number().int().nonnegative(),
  stockTransfersCount: z.number().int().nonnegative(),
  affectedCombosCount: z.number().int().nonnegative(),
});
export const deleteProductInputSchema = z.object({
  productId: z.uuid(),
  mode: productDeletionModeSchema,
  reason: z.string().trim().min(3).max(240),
});
export const productDeletionResultSchema = z.object({
  productId: z.uuid(),
  deleted: z.literal(true),
  refundedOrdersCount: z.number().int().nonnegative(),
  preservedHistoricalOrdersCount: z.number().int().nonnegative(),
});

export type ProductKind = z.infer<typeof productKindSchema>;
export type StockMovementType = z.infer<typeof stockMovementTypeSchema>;
export type ProductFallbackIcon = z.infer<typeof productFallbackIconSchema>;
export type ProductCategory = z.infer<typeof productCategorySchema>;
export type ProductFinancials = z.infer<typeof productFinancialsSchema>;
export type InventoryProduct = z.infer<typeof inventoryProductSchema>;
export type InventoryState = z.infer<typeof inventoryStateSchema>;
export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;
export type CreateProductInput = z.infer<typeof createProductInputSchema>;
export type UpdateProductInput = z.infer<typeof updateProductInputSchema>;
export type RecordStockMovementInput = z.infer<typeof recordStockMovementInputSchema>;
export type StockPurchaseLot = z.infer<typeof stockPurchaseLotSchema>;
export type CorrectStockPurchaseLotInput = z.infer<typeof correctStockPurchaseLotInputSchema>;
export type VoidStockPurchaseLotInput = z.infer<typeof voidStockPurchaseLotInputSchema>;
export type TransferStockInput = z.infer<typeof transferStockInputSchema>;
export type StockTransfer = z.infer<typeof stockTransferSchema>;
export type ProductDeletionMode = z.infer<typeof productDeletionModeSchema>;
export type ProductDeletionImpact = z.infer<typeof productDeletionImpactSchema>;
export type DeleteProductInput = z.infer<typeof deleteProductInputSchema>;
export type ProductDeletionResult = z.infer<typeof productDeletionResultSchema>;

export interface InventoryApi {
  getState(): Promise<InventoryState>;
  createCategory(input: CreateCategoryInput): Promise<ProductCategory>;
  createProduct(input: CreateProductInput): Promise<InventoryProduct>;
  updateProduct(input: UpdateProductInput): Promise<InventoryProduct>;
  recordMovement(input: RecordStockMovementInput): Promise<InventoryProduct>;
  listPurchaseLots(productId: string): Promise<readonly StockPurchaseLot[]>;
  correctPurchaseLot(input: CorrectStockPurchaseLotInput): Promise<StockPurchaseLot>;
  voidPurchaseLot(input: VoidStockPurchaseLotInput): Promise<StockPurchaseLot>;
  listTransfers(): Promise<readonly StockTransfer[]>;
  transferStock(input: TransferStockInput): Promise<StockTransfer>;
  previewDeletion(productId: string): Promise<ProductDeletionImpact>;
  deleteProduct(input: DeleteProductInput): Promise<ProductDeletionResult>;
}
