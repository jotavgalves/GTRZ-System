import type { DatabaseOrderVoucherAllocation } from './operation-vouchers';
import type { DatabaseProductFallbackIcon } from './product-presentation';
import type { DatabaseVoucherRedemption } from './vouchers';

export type DatabaseServicePointType = 'table' | 'counter';
export type DatabaseServicePointStatus = 'available' | 'open';
export type DatabaseOrderStatus = 'open' | 'paid' | 'cancelled';
export type DatabaseOrderItemKind = 'product' | 'combo';
export type DatabasePaymentMethod = 'cash' | 'pix' | 'credit-card' | 'debit-card';

export interface DatabaseServicePoint {
  readonly id: string;
  readonly eventId: string;
  readonly label: string;
  readonly type: DatabaseServicePointType;
  readonly pinned: boolean;
  readonly status: DatabaseServicePointStatus;
  readonly activeOrderId: string | null;
  readonly activeOrderTotalCents: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DatabaseOrderItem {
  readonly id: string;
  readonly orderId: string;
  readonly itemKind: DatabaseOrderItemKind;
  readonly itemId: string;
  readonly itemName: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly totalCents: number;
  readonly componentAllocations: readonly {
    readonly productId: string;
    readonly productName: string;
    readonly choiceGroup: string | null;
    readonly quantity: number;
  }[];
  readonly createdAt: number;
}

export interface DatabasePayment {
  readonly id: string;
  readonly orderId: string;
  readonly method: DatabasePaymentMethod;
  readonly amountCents: number;
  readonly receivedCents: number | null;
  readonly changeCents: number;
  readonly feeRateBasisPoints: number | null;
  readonly feeCents: number | null;
  readonly createdAt: number;
}

export interface DatabaseOrder {
  readonly id: string;
  readonly eventId: string;
  readonly servicePointId: string;
  readonly servicePointLabel: string;
  readonly status: DatabaseOrderStatus;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly remainingCents: number;
  readonly items: readonly DatabaseOrderItem[];
  readonly payments: readonly DatabasePayment[];
  readonly voucherAllocation: DatabaseOrderVoucherAllocation | null;
  readonly voucherRedemptions: readonly DatabaseVoucherRedemption[];
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly updatedAt: number;
}

export interface DatabaseOperationCatalogItem {
  readonly id: string;
  readonly kind: DatabaseOrderItemKind;
  readonly name: string;
  readonly salePriceCents: number;
  readonly availableQuantity: number;
  readonly active: boolean;
  readonly imageDataUrl: string | null;
  readonly fallbackIcon: DatabaseProductFallbackIcon;
  readonly choiceGroups: readonly {
    readonly id: string;
    readonly label: string;
    readonly quantity: number;
    readonly options: readonly {
      readonly productId: string;
      readonly productName: string;
      readonly availableQuantity: number;
    }[];
  }[];
}

export interface DatabaseComboComponentSelectionInput {
  readonly choiceGroup: string;
  readonly productId: string;
  readonly quantity: number;
}

export interface DatabaseOperationState {
  readonly activeEventId: string | null;
  readonly servicePoints: readonly DatabaseServicePoint[];
  readonly catalog: readonly DatabaseOperationCatalogItem[];
  readonly recentOrders: readonly DatabaseOrder[];
}

export interface DatabaseCloseOrderPaymentInput {
  readonly method: DatabasePaymentMethod;
  readonly amountCents: number;
  readonly receivedCents?: number;
}
