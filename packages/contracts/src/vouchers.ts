import { z } from 'zod';

export const voucherStatusSchema = z.enum(['active', 'exhausted', 'cancelled']);
export const voucherTransactionTypeSchema = z.enum([
  'issue',
  'redemption',
  'cancellation',
  'reactivation',
  'refund',
]);

export const voucherServicePointSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1).max(100),
});

export const voucherSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  code: z.string().trim().min(4).max(32),
  label: z.string().trim().min(2).max(100),
  initialBalanceCents: z.number().int().positive(),
  remainingBalanceCents: z.number().int().nonnegative(),
  status: voucherStatusSchema,
  servicePointId: z.uuid().nullable(),
  servicePointLabel: z.string().trim().min(1).max(100).nullable(),
  servicePointActive: z.boolean(),
  deletedAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const voucherTransactionSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  voucherId: z.uuid(),
  voucherCode: z.string().min(4).max(32),
  orderId: z.uuid().nullable(),
  type: voucherTransactionTypeSchema,
  amountCents: z.number().int().nonnegative(),
  balanceBeforeCents: z.number().int().nonnegative(),
  balanceAfterCents: z.number().int().nonnegative(),
  note: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});

export const voucherStateSchema = z.object({
  activeEventId: z.uuid().nullable(),
  vouchers: z.array(voucherSchema),
  deletedVouchers: z.array(voucherSchema),
  servicePoints: z.array(voucherServicePointSchema),
  transactions: z.array(voucherTransactionSchema),
});

export const createVoucherInputSchema = z.object({
  code: z.string().trim().min(4).max(32).optional(),
  label: z.string().trim().min(2).max(100),
  initialBalanceCents: z.number().int().positive(),
  servicePointId: z.uuid(),
});

export const changeVoucherStatusInputSchema = z.object({
  voucherId: z.uuid(),
  status: z.enum(['active', 'cancelled']),
});

export const updateVoucherInputSchema = z.object({
  voucherId: z.uuid(),
  code: z.string().trim().min(4).max(32),
  label: z.string().trim().min(2).max(100),
  servicePointId: z.uuid(),
});

export const addVoucherBalanceInputSchema = z.object({
  voucherId: z.uuid(),
  amountCents: z.number().int().positive(),
});

export const setVoucherTotalInputSchema = z.object({
  voucherId: z.uuid(),
  initialBalanceCents: z.number().int().positive(),
  reason: z.string().trim().min(2).max(250),
});

export const deleteVoucherInputSchema = z.object({
  voucherId: z.uuid(),
  reason: z.string().trim().min(2).max(250),
});

export const deleteVoucherResultSchema = z.object({
  mode: z.enum(['deleted', 'reversed-and-hidden']),
});

export type VoucherStatus = z.infer<typeof voucherStatusSchema>;
export type VoucherTransactionType = z.infer<typeof voucherTransactionTypeSchema>;
export type VoucherServicePoint = z.infer<typeof voucherServicePointSchema>;
export type Voucher = z.infer<typeof voucherSchema>;
export type VoucherTransaction = z.infer<typeof voucherTransactionSchema>;
export type VoucherState = z.infer<typeof voucherStateSchema>;
export type CreateVoucherInput = z.infer<typeof createVoucherInputSchema>;
export type ChangeVoucherStatusInput = z.infer<typeof changeVoucherStatusInputSchema>;
export type UpdateVoucherInput = z.infer<typeof updateVoucherInputSchema>;
export type AddVoucherBalanceInput = z.infer<typeof addVoucherBalanceInputSchema>;
export type SetVoucherTotalInput = z.infer<typeof setVoucherTotalInputSchema>;
export type DeleteVoucherInput = z.infer<typeof deleteVoucherInputSchema>;
export type DeleteVoucherResult = z.infer<typeof deleteVoucherResultSchema>;

export interface VoucherApi {
  getState(): Promise<VoucherState>;
  create(input: CreateVoucherInput): Promise<Voucher>;
  changeStatus(input: ChangeVoucherStatusInput): Promise<Voucher>;
  update(input: UpdateVoucherInput): Promise<Voucher>;
  addBalance(input: AddVoucherBalanceInput): Promise<Voucher>;
  setTotal(input: SetVoucherTotalInput): Promise<Voucher>;
  delete(input: DeleteVoucherInput): Promise<DeleteVoucherResult>;
}
