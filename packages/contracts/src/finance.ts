import { z } from 'zod';

import { paymentMethodSchema } from './operations';

export const cashRegisterStatusSchema = z.enum(['open', 'closed']);
export const cashMovementTypeSchema = z.enum(['opening', 'supply', 'withdrawal']);

export const cashRegisterSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  status: cashRegisterStatusSchema,
  openingCashCents: z.number().int().nonnegative(),
  expectedCashCents: z.number().int(),
  countedCashCents: z.number().int().nonnegative().nullable(),
  varianceCents: z.number().int().nullable(),
  openedAt: z.number().int().nonnegative(),
  closedAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
});

export const cashMovementSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  cashRegisterId: z.uuid(),
  type: cashMovementTypeSchema,
  amountCents: z.number().int().positive(),
  note: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});

export const salesByMethodSchema = z.object({
  cashCents: z.number().int().nonnegative(),
  pixCents: z.number().int().nonnegative(),
  creditCardCents: z.number().int().nonnegative(),
  debitCardCents: z.number().int().nonnegative(),
  voucherCents: z.number().int().nonnegative(),
});

export const cashStateSchema = z.object({
  activeEventId: z.uuid().nullable(),
  register: cashRegisterSchema.nullable(),
  movements: z.array(cashMovementSchema),
  salesByMethod: salesByMethodSchema,
  grossSalesCents: z.number().int().nonnegative(),
  activeExpensesCents: z.number().int().nonnegative(),
  paidExpensesCents: z.number().int().nonnegative(),
  outstandingExpensesCents: z.number().int().nonnegative(),
  stockCostCents: z.number().int().nonnegative(),
  cashExpensesCents: z.number().int().nonnegative(),
  cashRefundsCents: z.number().int().nonnegative(),
  cashCapitalReimbursementsCents: z.number().int().nonnegative(),
  recoverableCapitalCents: z.number().int().nonnegative(),
  remainingStockAssetCents: z.number().int().nonnegative(),
  terminalFeesCents: z.number().int().nonnegative(),
  expectedCashCents: z.number().int(),
  projectedResultCents: z.number().int(),
});

export const openCashRegisterInputSchema = z.object({
  openingCashCents: z.number().int().nonnegative(),
});

export const recordCashMovementInputSchema = z.object({
  type: z.enum(['supply', 'withdrawal']),
  amountCents: z.number().int().positive(),
  note: z.string().trim().max(240).optional(),
});

export const closeCashRegisterInputSchema = z.object({
  countedCashCents: z.number().int().nonnegative(),
});

export const expenseStatusSchema = z.enum(['active', 'cancelled']);
export const expensePaymentStatusSchema = z.enum(['open', 'partial', 'paid']);

export const expenseSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().min(2).max(160),
  amountCents: z.number().int().positive(),
  paymentMethod: paymentMethodSchema,
  note: z.string().nullable(),
  status: expenseStatusSchema,
  paymentStatus: expensePaymentStatusSchema,
  createdAt: z.number().int().nonnegative(),
  cancelledAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
  paidCents: z.number().int().nonnegative(),
  outstandingCents: z.number().int().nonnegative(),
});

export const expensePaymentSchema = z.object({
  id: z.uuid(),
  expenseId: z.uuid(),
  eventId: z.uuid(),
  method: paymentMethodSchema,
  amountCents: z.number().int().positive(),
  note: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});

export const expenseStateSchema = z.object({
  activeEventId: z.uuid().nullable(),
  expenses: z.array(expenseSchema),
});

export const createExpenseInputSchema = z.object({
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().min(2).max(160),
  amountCents: z.number().int().positive(),
  paymentMethod: paymentMethodSchema,
  paymentStatus: expensePaymentStatusSchema.optional(),
  note: z.string().trim().max(240).optional(),
});

export const updateExpensePaymentStatusInputSchema = z.object({
  expenseId: z.uuid(),
  paymentStatus: expensePaymentStatusSchema,
});

export const recordExpensePaymentInputSchema = z.object({
  expenseId: z.uuid(),
  method: paymentMethodSchema,
  amountCents: z.number().int().positive(),
  note: z.string().trim().max(240).optional(),
});

export const capitalContributionKindSchema = z.enum(['cash', 'inventory']);
export const capitalContributionSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  contributorName: z.string().trim().min(2).max(100),
  kind: capitalContributionKindSchema,
  amountCents: z.number().int().positive(),
  remainingStockValueCents: z.number().int().nonnegative(),
  reimbursedCents: z.number().int().nonnegative(),
  recoverableCents: z.number().int().nonnegative(),
  recoveryPriority: z.number().int().positive(),
  note: z.string().nullable(),
  status: z.enum(['active', 'cancelled']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const capitalStateSchema = z.object({
  activeEventId: z.uuid().nullable(),
  contributions: z.array(capitalContributionSchema),
  contributedCents: z.number().int().nonnegative(),
  reimbursedCents: z.number().int().nonnegative(),
  recoverableCents: z.number().int().nonnegative(),
  remainingStockAssetCents: z.number().int().nonnegative(),
  cashReimbursementsCents: z.number().int().nonnegative(),
});
export const createCapitalContributionInputSchema = z.object({
  contributorName: z.string().trim().min(2).max(100),
  kind: capitalContributionKindSchema,
  amountCents: z.number().int().positive(),
  remainingStockValueCents: z.number().int().nonnegative().optional(),
  recoveryPriority: z.number().int().positive().optional(),
  note: z.string().trim().max(240).optional(),
});
export const updateCapitalContributionInputSchema = z.object({
  contributionId: z.uuid(),
  remainingStockValueCents: z.number().int().nonnegative(),
  note: z.string().trim().max(240).optional(),
});
export const recordCapitalReimbursementInputSchema = z.object({
  contributionId: z.uuid(),
  method: paymentMethodSchema,
  amountCents: z.number().int().positive(),
  note: z.string().trim().max(240).optional(),
});

export const updateExpenseInputSchema = z.object({
  expenseId: z.uuid(),
  category: z.string().trim().min(2).max(80),
  description: z.string().trim().min(2).max(160),
  amountCents: z.number().int().positive(),
  paymentMethod: paymentMethodSchema,
  paymentStatus: expensePaymentStatusSchema,
  note: z.string().trim().max(240).optional(),
});

export const cancelExpenseInputSchema = z.object({
  expenseId: z.uuid(),
  reason: z.string().trim().min(3).max(240),
});

export const deleteExpenseInputSchema = z.object({
  expenseId: z.uuid(),
  reason: z.string().trim().min(3).max(240),
});

export const expenseDeletionResultSchema = z.object({
  expenseId: z.uuid(),
  deleted: z.literal(true),
});

export type CashRegisterStatus = z.infer<typeof cashRegisterStatusSchema>;
export type CashMovementType = z.infer<typeof cashMovementTypeSchema>;
export type CashRegister = z.infer<typeof cashRegisterSchema>;
export type CashMovement = z.infer<typeof cashMovementSchema>;
export type SalesByMethod = z.infer<typeof salesByMethodSchema>;
export type CashState = z.infer<typeof cashStateSchema>;
export type OpenCashRegisterInput = z.infer<typeof openCashRegisterInputSchema>;
export type RecordCashMovementInput = z.infer<typeof recordCashMovementInputSchema>;
export type CloseCashRegisterInput = z.infer<typeof closeCashRegisterInputSchema>;
export type ExpenseStatus = z.infer<typeof expenseStatusSchema>;
export type ExpensePaymentStatus = z.infer<typeof expensePaymentStatusSchema>;
export type Expense = z.infer<typeof expenseSchema>;
export type ExpensePayment = z.infer<typeof expensePaymentSchema>;
export type ExpenseState = z.infer<typeof expenseStateSchema>;
export type CreateExpenseInput = z.infer<typeof createExpenseInputSchema>;
export type UpdateExpensePaymentStatusInput = z.infer<typeof updateExpensePaymentStatusInputSchema>;
export type RecordExpensePaymentInput = z.infer<typeof recordExpensePaymentInputSchema>;
export type CapitalState = z.infer<typeof capitalStateSchema>;
export type CapitalContributionKind = z.infer<typeof capitalContributionKindSchema>;
export type CapitalContribution = z.infer<typeof capitalContributionSchema>;
export type CreateCapitalContributionInput = z.infer<typeof createCapitalContributionInputSchema>;
export type UpdateCapitalContributionInput = z.infer<typeof updateCapitalContributionInputSchema>;
export type RecordCapitalReimbursementInput = z.infer<typeof recordCapitalReimbursementInputSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseInputSchema>;
export type CancelExpenseInput = z.infer<typeof cancelExpenseInputSchema>;
export type DeleteExpenseInput = z.infer<typeof deleteExpenseInputSchema>;
export type ExpenseDeletionResult = z.infer<typeof expenseDeletionResultSchema>;

export interface CashApi {
  getState(): Promise<CashState>;
  open(input: OpenCashRegisterInput): Promise<CashState>;
  recordMovement(input: RecordCashMovementInput): Promise<CashState>;
  close(input: CloseCashRegisterInput): Promise<CashState>;
}

export interface ExpenseApi {
  getState(): Promise<ExpenseState>;
  create(input: CreateExpenseInput): Promise<Expense>;
  update(input: UpdateExpenseInput): Promise<Expense>;
  updatePaymentStatus(input: UpdateExpensePaymentStatusInput): Promise<Expense>;
  recordPayment(input: RecordExpensePaymentInput): Promise<Expense>;
  cancel(input: CancelExpenseInput): Promise<Expense>;
  delete(input: DeleteExpenseInput): Promise<ExpenseDeletionResult>;
}

export interface CapitalApi {
  getState(): Promise<CapitalState>;
  create(input: CreateCapitalContributionInput): Promise<CapitalContribution>;
  update(input: UpdateCapitalContributionInput): Promise<CapitalContribution>;
  reimburse(input: RecordCapitalReimbursementInput): Promise<CapitalState>;
}
