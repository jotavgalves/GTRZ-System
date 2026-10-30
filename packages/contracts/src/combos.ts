import { z } from 'zod';

export const comboKindSchema = z
  .enum(['food', 'drink', 'combo'])
  .transform((value): 'food' | 'drink' => (value === 'combo' ? 'drink' : value));

export const comboComponentInputSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().positive().max(10_000),
  choiceGroup: z.string().trim().min(1).max(60).optional(),
  choiceLabel: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().nonnegative().max(10_000).optional(),
});

export const externalFoodComboTermsInputSchema = z
  .object({
    supplierId: z.uuid(),
    supplierUnitCents: z.number().int().nonnegative(),
    commissionUnitCents: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if (value.supplierUnitCents + value.commissionUnitCents <= 0) {
      context.addIssue({
        code: 'custom',
        message: 'Informe o valor do fornecedor ou a comissão da GTRZ.',
        path: ['supplierUnitCents'],
      });
    }
  });

const comboWriteFields = {
  name: z.string().trim().min(2).max(100),
  kind: comboKindSchema.optional(),
  salePriceCents: z.number().int().nonnegative(),
  components: z.array(comboComponentInputSchema).min(1).max(50),
  externalFoodTerms: externalFoodComboTermsInputSchema.optional(),
} as const;

interface ComponentCollection {
  readonly components: readonly {
    readonly productId: string;
    readonly choiceGroup?: string | undefined;
  }[];
}

function validateUniqueComponents(value: ComponentCollection, context: z.RefinementCtx): void {
  const occurrences = value.components.map(
    (component) => `${component.choiceGroup ?? '__fixed__'}:${component.productId}`,
  );
  const uniqueOccurrences = new Set(occurrences);

  if (uniqueOccurrences.size !== value.components.length) {
    context.addIssue({
      code: 'custom',
      message: 'Um produto não pode repetir dentro da mesma parte do combo.',
      path: ['components'],
    });
  }
}

export const createComboInputSchema = z
  .object(comboWriteFields)
  .superRefine(validateUniqueComponents);

export const updateComboInputSchema = z
  .object({
    ...comboWriteFields,
    comboId: z.uuid(),
    active: z.boolean(),
  })
  .superRefine(validateUniqueComponents);

export const deleteComboInputSchema = z.object({
  comboId: z.uuid(),
  reason: z.string().trim().min(3).max(240),
});

export const comboDeletionResultSchema = z.object({
  comboId: z.uuid(),
  deleted: z.literal(true),
});

export const comboComponentSchema = z.object({
  productId: z.uuid(),
  productName: z.string().min(1),
  quantity: z.number().int().positive(),
  salePriceCents: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative(),
  choiceGroup: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  choiceLabel: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  sortOrder: z.number().int().nonnegative().optional(),
});

export const externalFoodComboTermsSchema = externalFoodComboTermsInputSchema.extend({
  supplierName: z.string().min(1),
});

export const comboFinancialsSchema = z.object({
  costCents: z.number().int().nonnegative(),
  grossProfitCents: z.number().int(),
  marginPercent: z.number(),
});

export const comboSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(2).max(100),
  kind: comboKindSchema.default('drink'),
  salePriceCents: z.number().int().nonnegative(),
  individualSaleTotalCents: z.number().int().nonnegative(),
  savingsCents: z.number().int(),
  availableUnits: z.number().int().nonnegative(),
  active: z.boolean(),
  components: z.array(comboComponentSchema).min(1),
  externalFoodTerms: externalFoodComboTermsSchema.nullish().transform((value) => value ?? null),
  financials: comboFinancialsSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const comboListSchema = z.array(comboSchema);

export type ComboComponentInput = z.infer<typeof comboComponentInputSchema>;
export type ComboKind = z.infer<typeof comboKindSchema>;
export type ExternalFoodComboTermsInput = z.infer<typeof externalFoodComboTermsInputSchema>;
export type ExternalFoodComboTerms = z.infer<typeof externalFoodComboTermsSchema>;
export type CreateComboInput = z.infer<typeof createComboInputSchema>;
export type UpdateComboInput = z.infer<typeof updateComboInputSchema>;
export type DeleteComboInput = z.infer<typeof deleteComboInputSchema>;
export type ComboDeletionResult = z.infer<typeof comboDeletionResultSchema>;
export type ComboComponent = z.infer<typeof comboComponentSchema>;
export type ComboFinancials = z.infer<typeof comboFinancialsSchema>;
export type InventoryCombo = z.infer<typeof comboSchema>;

export interface ComboApi {
  list(): Promise<readonly InventoryCombo[]>;
  create(input: CreateComboInput): Promise<InventoryCombo>;
  update(input: UpdateComboInput): Promise<InventoryCombo>;
  delete(input: DeleteComboInput): Promise<ComboDeletionResult>;
}
