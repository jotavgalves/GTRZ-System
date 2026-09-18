import { z } from 'zod';

import { productFallbackIconSchema, productImageDataUrlSchema } from './inventory';

export const servicePointTypeSchema = z.enum(['table', 'counter']);
export const servicePointStatusSchema = z.enum(['available', 'open']);
export const orderStatusSchema = z.enum(['open', 'paid', 'cancelled']);
export const orderItemKindSchema = z.enum(['product', 'combo']);
export const paymentMethodSchema = z.enum(['cash', 'pix', 'credit-card', 'debit-card']);

export const servicePointSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  label: z.string().trim().min(1).max(40),
  type: servicePointTypeSchema,
  pinned: z.boolean(),
  status: servicePointStatusSchema,
  activeOrderId: z.uuid().nullable(),
  activeOrderTotalCents: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const orderItemSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  itemKind: orderItemKindSchema,
  itemId: z.uuid(),
  itemName: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});

export const paymentSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  method: paymentMethodSchema,
  amountCents: z.number().int().positive(),
  receivedCents: z.number().int().positive().nullable(),
  changeCents: z.number().int().nonnegative(),
  feeRateBasisPoints: z.number().int().nonnegative().nullable(),
  feeCents: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
});

export const voucherAllocationSchema = z.object({
  voucherId: z.uuid(),
  code: z.string().min(4).max(32),
  label: z.string().trim().min(2).max(100),
  remainingBalanceCents: z.number().int().nonnegative(),
  status: z.enum(['active', 'exhausted', 'cancelled']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const voucherRedemptionSchema = z.object({
  voucherId: z.uuid(),
  code: z.string().min(4).max(32),
  amountCents: z.number().int().positive(),
});

export const orderSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  servicePointId: z.uuid(),
  servicePointLabel: z.string().trim().min(1).max(40),
  status: orderStatusSchema,
  subtotalCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  paidCents: z.number().int().nonnegative(),
  remainingCents: z.number().int().nonnegative(),
  items: z.array(orderItemSchema),
  payments: z.array(paymentSchema),
  voucherAllocation: voucherAllocationSchema.nullable(),
  voucherRedemptions: z.array(voucherRedemptionSchema),
  openedAt: z.number().int().nonnegative(),
  closedAt: z.number().int().nonnegative().nullable(),
  updatedAt: z.number().int().nonnegative(),
});

export const operationCatalogItemSchema = z.object({
  id: z.uuid(),
  kind: orderItemKindSchema,
  name: z.string().trim().min(1).max(120),
  salePriceCents: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative(),
  active: z.boolean(),
  imageDataUrl: productImageDataUrlSchema,
  fallbackIcon: productFallbackIconSchema,
});

export const operationStateSchema = z.object({
  activeEventId: z.uuid().nullable(),
  servicePoints: z.array(servicePointSchema),
  catalog: z.array(operationCatalogItemSchema),
  recentOrders: z.array(orderSchema),
});

export const createServicePointInputSchema = z.object({
  label: z.string().trim().min(1).max(40),
  type: servicePointTypeSchema,
});

export const renameServicePointInputSchema = z.object({
  servicePointId: z.uuid(),
  label: z.string().trim().min(1).max(40),
});

export const setServicePointPinnedInputSchema = z.object({
  servicePointId: z.uuid(),
  pinned: z.boolean(),
});

export const deleteServicePointModeSchema = z.enum(['delete-all', 'keep-sales-history']);

export const deleteServicePointInputSchema = z.object({
  servicePointId: z.uuid(),
  mode: deleteServicePointModeSchema,
  reason: z.string().trim().min(3).max(240),
});

export const servicePointDeletionResultSchema = z.object({
  servicePointId: z.uuid(),
  deleted: z.literal(true),
  mode: deleteServicePointModeSchema,
  cancelledOrdersCount: z.number().int().nonnegative(),
  preservedOrdersCount: z.number().int().nonnegative(),
  affectedVouchersCount: z.number().int().nonnegative(),
});

export const openOrderInputSchema = z.object({
  servicePointId: z.uuid(),
});

export const getOrderInputSchema = z.object({
  orderId: z.uuid(),
});

export const addOrderItemInputSchema = z.object({
  orderId: z.uuid(),
  itemKind: orderItemKindSchema,
  itemId: z.uuid(),
  quantity: z.number().int().positive(),
});

export const startOrderWithItemInputSchema = z.object({
  servicePointId: z.uuid(),
  itemKind: orderItemKindSchema,
  itemId: z.uuid(),
  quantity: z.number().int().positive(),
});

export const removeOrderItemInputSchema = z.object({
  orderId: z.uuid(),
  orderItemId: z.uuid(),
});

export const bindOrderVoucherInputSchema = z.object({
  orderId: z.uuid(),
  code: z.string().trim().min(4).max(32),
});

export const unbindOrderVoucherInputSchema = z.object({
  orderId: z.uuid(),
});

export const closeOrderInputSchema = z
  .object({
    orderId: z.uuid(),
    discountCents: z.number().int().nonnegative().default(0),
    payments: z
      .array(
        z.object({
          method: paymentMethodSchema,
          amountCents: z.number().int().positive(),
          receivedCents: z.number().int().positive().optional(),
        }),
      )
      .default([]),
    voucherUses: z
      .array(
        z.object({
          code: z.string().trim().min(4).max(32),
          amountCents: z.number().int().positive(),
        }),
      )
      .max(1, 'Cada comanda pode utilizar somente um voucher.')
      .default([]),
  })
  .refine((input) => input.payments.length + input.voucherUses.length > 0, {
    message: 'Informe ao menos um pagamento ou voucher.',
  });

export const cancelOrderInputSchema = z.object({
  orderId: z.uuid(),
  reason: z.string().trim().min(3).max(240),
  refunds: z.array(z.object({ method: paymentMethodSchema, amountCents: z.number().int().positive() })).optional(),
});

export type ServicePointType = z.infer<typeof servicePointTypeSchema>;
export type ServicePointStatus = z.infer<typeof servicePointStatusSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type OrderItemKind = z.infer<typeof orderItemKindSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type ServicePoint = z.infer<typeof servicePointSchema>;
export type OrderItem = z.infer<typeof orderItemSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type VoucherAllocation = z.infer<typeof voucherAllocationSchema>;
export type VoucherRedemption = z.infer<typeof voucherRedemptionSchema>;
export type Order = z.infer<typeof orderSchema>;
export type OperationCatalogItem = z.infer<typeof operationCatalogItemSchema>;
export type OperationState = z.infer<typeof operationStateSchema>;
export type CreateServicePointInput = z.infer<typeof createServicePointInputSchema>;
export type RenameServicePointInput = z.infer<typeof renameServicePointInputSchema>;
export type SetServicePointPinnedInput = z.infer<typeof setServicePointPinnedInputSchema>;
export type DeleteServicePointMode = z.infer<typeof deleteServicePointModeSchema>;
export type DeleteServicePointInput = z.infer<typeof deleteServicePointInputSchema>;
export type ServicePointDeletionResult = z.infer<typeof servicePointDeletionResultSchema>;
export type OpenOrderInput = z.infer<typeof openOrderInputSchema>;
export type GetOrderInput = z.infer<typeof getOrderInputSchema>;
export type AddOrderItemInput = z.infer<typeof addOrderItemInputSchema>;
export type StartOrderWithItemInput = z.infer<typeof startOrderWithItemInputSchema>;
export type RemoveOrderItemInput = z.infer<typeof removeOrderItemInputSchema>;
export type BindOrderVoucherInput = z.infer<typeof bindOrderVoucherInputSchema>;
export type UnbindOrderVoucherInput = z.infer<typeof unbindOrderVoucherInputSchema>;
export type CloseOrderInput = z.infer<typeof closeOrderInputSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderInputSchema>;

export interface OperationsApi {
  getState(): Promise<OperationState>;
  createServicePoint(input: CreateServicePointInput): Promise<ServicePoint>;
  renameServicePoint(input: RenameServicePointInput): Promise<ServicePoint>;
  setServicePointPinned(input: SetServicePointPinnedInput): Promise<ServicePoint>;
  deleteServicePoint(input: DeleteServicePointInput): Promise<ServicePointDeletionResult>;
  openOrder(input: OpenOrderInput): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  startOrderWithItem(input: StartOrderWithItemInput): Promise<Order>;
  addItem(input: AddOrderItemInput): Promise<Order>;
  removeItem(input: RemoveOrderItemInput): Promise<Order>;
  bindVoucher(input: BindOrderVoucherInput): Promise<Order>;
  unbindVoucher(input: UnbindOrderVoucherInput): Promise<Order>;
  closeOrder(input: CloseOrderInput): Promise<Order>;
  cancelOrder(input: CancelOrderInput): Promise<Order>;
}
