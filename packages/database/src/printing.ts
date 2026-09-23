import { appendAudit } from './audit';
import { hostname } from 'node:os';
import { getSessionState } from './control';
import { getOrder } from './operation-core';
import type { DatabasePaymentMethod, DatabaseServicePointType } from './operation-types';
import type { DatabaseContext } from './types';

export type DatabaseThermalPaperWidth = 58 | 80;

export interface DatabasePrintingSettings {
  readonly automaticPrinting: boolean;
  readonly deviceName: string | null;
  readonly machineName: string;
  readonly paperWidthMm: DatabaseThermalPaperWidth;
}

export interface DatabaseReceiptItem {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly totalCents: number;
  readonly preparation?: readonly {
    readonly label: string;
    readonly productName: string;
    readonly quantity: number;
  }[];
}

export interface DatabaseReceiptPayment {
  readonly method: DatabasePaymentMethod;
  readonly amountCents: number;
  readonly receivedCents: number | null;
  readonly changeCents: number;
}

export interface DatabaseReceiptVoucher {
  readonly code: string;
  readonly amountCents: number;
}

export interface DatabaseOrderReceipt {
  readonly orderId: string;
  readonly eventName: string;
  readonly servicePointLabel: string;
  readonly servicePointType: DatabaseServicePointType;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly closedAt: number;
  readonly items: readonly DatabaseReceiptItem[];
  readonly payments: readonly DatabaseReceiptPayment[];
  readonly vouchers: readonly DatabaseReceiptVoucher[];
  readonly operatorName?: string;
  readonly originLabel?: string;
  readonly printedByLabel?: string;
  readonly documentType?: 'sale-batch' | 'internal-decrement';
  readonly internalReason?: string;
  readonly recipient?: string;
  readonly authorizedBy?: string;
  readonly referenceCode?: string;
}

const AUTOMATIC_KEY = 'printing.automatic';
const DEVICE_KEY = 'printing.device_name';
const MACHINE_NAME_KEY = 'printing.machine_name';
const PAPER_WIDTH_KEY = 'printing.paper_width_mm';

function readMeta(database: DatabaseContext, key: string): string | null {
  const row = database.sqlite.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
    | { readonly value: string }
    | undefined;
  return row?.value ?? null;
}

function writeMeta(database: DatabaseContext, key: string, value: string): void {
  database.sqlite
    .prepare(
      `INSERT INTO app_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

export function getPrintingSettings(database: DatabaseContext): DatabasePrintingSettings {
  const automaticPrinting = readMeta(database, AUTOMATIC_KEY) === '1';
  const rawDeviceName = readMeta(database, DEVICE_KEY);
  const rawMachineName = readMeta(database, MACHINE_NAME_KEY)?.trim();
  const rawPaperWidth = Number(readMeta(database, PAPER_WIDTH_KEY) ?? '80');

  return {
    automaticPrinting,
    deviceName: rawDeviceName === null || rawDeviceName.length === 0 ? null : rawDeviceName,
    machineName: rawMachineName && rawMachineName.length >= 2 ? rawMachineName : hostname(),
    paperWidthMm: rawPaperWidth === 58 ? 58 : 80,
  };
}

export function updatePrintingSettings(
  database: DatabaseContext,
  input: DatabasePrintingSettings,
): DatabasePrintingSettings {
  if (getSessionState(database).profile !== 'production') {
    throw new Error('A configuração de impressão exige o perfil Produção.');
  }

  const deviceName = input.deviceName?.trim() ?? '';
  const machineName = input.machineName.trim();

  database.sqlite.transaction(() => {
    writeMeta(database, AUTOMATIC_KEY, input.automaticPrinting ? '1' : '0');
    writeMeta(database, DEVICE_KEY, deviceName);
    writeMeta(database, MACHINE_NAME_KEY, machineName);
    writeMeta(database, PAPER_WIDTH_KEY, String(input.paperWidthMm));
    appendAudit(database, {
      action: 'settings.printing-updated',
      entityType: 'settings',
      eventId: getSessionState(database).activeEvent?.id ?? null,
      details: {
        automaticPrinting: input.automaticPrinting,
        deviceName: deviceName.length === 0 ? null : deviceName,
        machineName,
        paperWidthMm: input.paperWidthMm,
      },
    });
  })();

  return getPrintingSettings(database);
}

export function getOrderReceipt(database: DatabaseContext, orderId: string): DatabaseOrderReceipt {
  const order = getOrder(database, orderId);
  if (order.status !== 'paid' || order.closedAt === null) {
    throw new Error('Somente vendas pagas podem gerar nota de retirada.');
  }

  const event = database.sqlite
    .prepare('SELECT name FROM events WHERE id = ?')
    .get(order.eventId) as { readonly name: string } | undefined;
  const servicePoint = database.sqlite
    .prepare('SELECT type FROM service_points WHERE id = ?')
    .get(order.servicePointId) as { readonly type: DatabaseServicePointType } | undefined;

  if (event === undefined || servicePoint === undefined) {
    throw new Error('Os dados do evento ou do ponto de atendimento não estão disponíveis.');
  }

  return {
    orderId: order.id,
    eventName: event.name,
    servicePointLabel: order.servicePointLabel,
    servicePointType: servicePoint.type,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    closedAt: order.closedAt,
    items: order.items.map((item) => {
      const preparation = item.componentAllocations
        .filter((allocation) => allocation.choiceGroup !== null)
        .map((allocation) => ({
          label: allocation.choiceLabel ?? 'Escolha',
          productName: allocation.productName,
          quantity: allocation.quantity,
        }));
      return {
        name: item.itemName,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
        ...(preparation.length === 0 ? {} : { preparation }),
      };
    }),
    payments: order.payments.map((payment) => ({
      method: payment.method,
      amountCents: payment.amountCents,
      receivedCents: payment.receivedCents,
      changeCents: payment.changeCents,
    })),
    vouchers: order.voucherRedemptions.map((voucher) => ({
      code: voucher.code,
      amountCents: voucher.amountCents,
    })),
  };
}
