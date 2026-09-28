import { z } from 'zod';

export const foodSupplierModeSchema = z.enum(['gtrz', 'external']);
export const foodSupplierSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  name: z.string().trim().min(2).max(100),
  active: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const foodStateSchema = z.object({
  activeEventId: z.uuid().nullable(),
  supplierMode: foodSupplierModeSchema.nullable(),
  suppliers: z.array(foodSupplierSchema),
  summary: z.object({
    soldQuantity: z.number().int().nonnegative(),
    receivedCents: z.number().int().nonnegative(),
    supplierCents: z.number().int().nonnegative(),
    commissionCents: z.number().int().nonnegative(),
  }),
  items: z.array(
    z.object({
      productId: z.uuid(),
      name: z.string().min(1),
      supplierName: z.string().nullable(),
      soldQuantity: z.number().int().nonnegative(),
      receivedCents: z.number().int().nonnegative(),
      supplierCents: z.number().int().nonnegative(),
      commissionCents: z.number().int().nonnegative(),
    }),
  ),
});
export const configureFoodInputSchema = z.object({ supplierMode: foodSupplierModeSchema });
export const createFoodSupplierInputSchema = z.object({ name: z.string().trim().min(2).max(100) });
export const updateFoodSupplierInputSchema = createFoodSupplierInputSchema.extend({
  supplierId: z.uuid(),
});
export const archiveFoodSupplierInputSchema = z.object({ supplierId: z.uuid() });
export const deleteFoodSupplierInputSchema = z.object({
  supplierId: z.uuid(),
  deleteLinkedSales: z.boolean(),
  reason: z.string().trim().min(3).max(240),
});
export const createExternalFoodItemInputSchema = z
  .object({
    categoryId: z.uuid(),
    supplierId: z.uuid().optional(),
    name: z.string().trim().min(2).max(100),
    supplierUnitCents: z.number().int().nonnegative().optional(),
    commissionUnitCents: z.number().int().nonnegative().optional(),
    initialQuantity: z.number().int().positive(),
    comboOnly: z.boolean().default(false),
  })
  .superRefine((input, context) => {
    if (input.comboOnly) return;
    if (
      input.supplierId === undefined ||
      input.supplierUnitCents === undefined ||
      input.commissionUnitCents === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Informe fornecedor, valor e comissão para uma comida vendida diretamente.',
        path: ['supplierId'],
      });
      return;
    }
    if (input.supplierUnitCents + input.commissionUnitCents <= 0)
      context.addIssue({
        code: 'custom',
        message: 'Informe o valor do fornecedor ou a comissão.',
        path: ['supplierUnitCents'],
      });
  });
export type FoodSupplierMode = z.infer<typeof foodSupplierModeSchema>;
export type FoodSupplier = z.infer<typeof foodSupplierSchema>;
export type FoodState = z.infer<typeof foodStateSchema>;
export type ConfigureFoodInput = z.infer<typeof configureFoodInputSchema>;
export type CreateFoodSupplierInput = z.infer<typeof createFoodSupplierInputSchema>;
export type UpdateFoodSupplierInput = z.infer<typeof updateFoodSupplierInputSchema>;
export type ArchiveFoodSupplierInput = z.infer<typeof archiveFoodSupplierInputSchema>;
export type DeleteFoodSupplierInput = z.infer<typeof deleteFoodSupplierInputSchema>;
export type CreateExternalFoodItemInput = z.infer<typeof createExternalFoodItemInputSchema>;
export interface FoodApi {
  getState(): Promise<FoodState>;
  configure(input: ConfigureFoodInput): Promise<FoodState>;
  createSupplier(input: CreateFoodSupplierInput): Promise<FoodSupplier>;
  updateSupplier(input: UpdateFoodSupplierInput): Promise<FoodSupplier>;
  archiveSupplier(input: ArchiveFoodSupplierInput): Promise<void>;
  deleteSupplier(input: DeleteFoodSupplierInput): Promise<void>;
  createExternalItem(input: CreateExternalFoodItemInput): Promise<FoodState>;
}
