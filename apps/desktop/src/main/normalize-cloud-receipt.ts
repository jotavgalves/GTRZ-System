import type { DatabaseOrderReceipt } from '@gtrz/database/printing';

import type { ClaimedCloudPrintJob } from './cloud-sync-service';

export function normalizeCloudReceipt(
  document: ClaimedCloudPrintJob['document'],
): DatabaseOrderReceipt {
  return {
    ...document,
    items: document.items.map((item) => ({
      ...item,
      name: item.name ?? item.itemName ?? 'Item sem nome',
      preparation:
        item.preparation ??
        item.componentAllocations
          ?.filter((choice) => Boolean(choice.choiceGroup) && Boolean(choice.productName))
          .map((choice) => ({
            label: choice.choiceLabel ?? choice.choiceGroup ?? 'Escolha',
            productName: choice.productName ?? 'Componente',
            quantity: choice.quantity ?? 1,
          })) ??
        [],
    })),
  };
}
