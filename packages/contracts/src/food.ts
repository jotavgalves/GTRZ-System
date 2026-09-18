import { z } from 'zod';

export const foodSupplierModeSchema = z.enum(['gtrz', 'external']);
export const foodSupplierSchema = z.object({
  id: z.uuid(), eventId: z.uuid(), name: z.string().trim().min(2).max(100), active: z.boolean(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
});
export const foodStateSchema = z.object({
  activeEventId: z.uuid().nullable(), supplierMode: foodSupplierModeSchema.nullable(), suppliers: z.array(foodSupplierSchema),
  summary: z.object({ soldQuantity: z.number().int().nonnegative(), receivedCents: z.number().int().nonnegative(), supplierCents: z.number().int().nonnegative(), commissionCents: z.number().int().nonnegative() }),
  items: z.array(z.object({ productId: z.uuid(), name: z.string().min(1), supplierName: z.string().nullable(), soldQuantity: z.number().int().nonnegative(), receivedCents: z.number().int().nonnegative(), supplierCents: z.number().int().nonnegative(), commissionCents: z.number().int().nonnegative() })),
});
export const configureFoodInputSchema = z.object({ supplierMode: foodSupplierModeSchema });
export const createFoodSupplierInputSchema = z.object({ name: z.string().trim().min(2).max(100) });
export const createExternalFoodItemInputSchema = z.object({ categoryId: z.uuid(), supplierId: z.uuid(), name: z.string().trim().min(2).max(100), supplierUnitCents: z.number().int().nonnegative(), commissionUnitCents: z.number().int().nonnegative(), initialQuantity: z.number().int().positive(), comboOnly: z.boolean().default(false) }).superRefine((input,context)=>{if(input.supplierUnitCents+input.commissionUnitCents<=0) context.addIssue({code:'custom',message:'Informe o valor do fornecedor ou a comissão.',path:['supplierUnitCents']});});
export type FoodSupplierMode = z.infer<typeof foodSupplierModeSchema>;
export type FoodSupplier = z.infer<typeof foodSupplierSchema>;
export type FoodState = z.infer<typeof foodStateSchema>;
export type ConfigureFoodInput = z.infer<typeof configureFoodInputSchema>;
export type CreateFoodSupplierInput = z.infer<typeof createFoodSupplierInputSchema>;
export type CreateExternalFoodItemInput = z.infer<typeof createExternalFoodItemInputSchema>;
export interface FoodApi {
  getState(): Promise<FoodState>;
  configure(input: ConfigureFoodInput): Promise<FoodState>;
  createSupplier(input: CreateFoodSupplierInput): Promise<FoodSupplier>;
  createExternalItem(input: CreateExternalFoodItemInput): Promise<FoodState>;
}
