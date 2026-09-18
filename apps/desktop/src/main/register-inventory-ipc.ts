import { ipcMain } from 'electron';

import {
  createCategoryInputSchema,
  createProductInputSchema,
  deleteProductInputSchema,
  inventoryProductSchema,
  inventoryStateSchema,
  IPC_CHANNELS,
  productCategorySchema,
  productDeletionImpactSchema,
  productDeletionResultSchema,
  recordStockMovementInputSchema,
  stockTransferListSchema,
  stockTransferSchema,
  transferStockInputSchema,
  updateProductInputSchema,
} from '@gtrz/contracts';
import {
  createInventoryProduct,
  createProductCategory,
  getInventoryState,
  listStockTransfers,
  recordStockMovement,
  transferStockBetweenEvents,
  updateInventoryProduct,
  type DatabaseContext,
} from '@gtrz/database';
import {
  deleteInventoryProduct,
  previewProductDeletion,
} from '@gtrz/database/product-administration';

interface RegisterInventoryIpcOptions {
  readonly getDatabase: () => DatabaseContext;
}

const INVENTORY_CHANNELS = [
  IPC_CHANNELS.inventoryGetState,
  IPC_CHANNELS.inventoryCreateCategory,
  IPC_CHANNELS.inventoryCreateProduct,
  IPC_CHANNELS.inventoryUpdateProduct,
  IPC_CHANNELS.inventoryRecordMovement,
  IPC_CHANNELS.inventoryListTransfers,
  IPC_CHANNELS.inventoryTransferStock,
  IPC_CHANNELS.inventoryPreviewProductDeletion,
  IPC_CHANNELS.inventoryDeleteProduct,
] as const;

export function registerInventoryIpcHandlers(options: RegisterInventoryIpcOptions): void {
  for (const channel of INVENTORY_CHANNELS) ipcMain.removeHandler(channel);

  ipcMain.handle(IPC_CHANNELS.inventoryGetState, () => {
    return inventoryStateSchema.parse(getInventoryState(options.getDatabase()));
  });
  ipcMain.handle(IPC_CHANNELS.inventoryCreateCategory, (_event, payload: unknown) => {
    const input = createCategoryInputSchema.parse(payload);
    return productCategorySchema.parse(createProductCategory(options.getDatabase(), input.name));
  });
  ipcMain.handle(IPC_CHANNELS.inventoryCreateProduct, (_event, payload: unknown) => {
    const input = createProductInputSchema.parse(payload);
    const productInput = {
      categoryId: input.categoryId,
      name: input.name,
      kind: input.kind,
      costCents: input.costCents,
      salePriceCents: input.salePriceCents,
      lowStockThreshold: input.lowStockThreshold,
    };

    if (input.imageDataUrl !== undefined) {
      Object.assign(productInput, { imageDataUrl: input.imageDataUrl });
    }
    if (input.fallbackIcon !== undefined) {
      Object.assign(productInput, { fallbackIcon: input.fallbackIcon });
    }

    return inventoryProductSchema.parse(
      createInventoryProduct(options.getDatabase(), productInput),
    );
  });
  ipcMain.handle(IPC_CHANNELS.inventoryUpdateProduct, (_event, payload: unknown) => {
    const input = updateProductInputSchema.parse(payload);
    const productInput = {
      productId: input.productId,
      active: input.active,
      categoryId: input.categoryId,
      name: input.name,
      kind: input.kind,
      costCents: input.costCents,
      salePriceCents: input.salePriceCents,
      lowStockThreshold: input.lowStockThreshold,
    };

    if (input.imageDataUrl !== undefined) {
      Object.assign(productInput, { imageDataUrl: input.imageDataUrl });
    }
    if (input.fallbackIcon !== undefined) {
      Object.assign(productInput, { fallbackIcon: input.fallbackIcon });
    }

    return inventoryProductSchema.parse(
      updateInventoryProduct(options.getDatabase(), productInput),
    );
  });
  ipcMain.handle(IPC_CHANNELS.inventoryRecordMovement, (_event, payload: unknown) => {
    const input = recordStockMovementInputSchema.parse(payload);
    const movementInput = {
      productId: input.productId,
      type: input.type,
      quantity: input.quantity,
      ...(input.purchaseTotalCents === undefined
        ? {}
        : { purchaseTotalCents: input.purchaseTotalCents }),
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    return inventoryProductSchema.parse(recordStockMovement(options.getDatabase(), movementInput));
  });
  ipcMain.handle(IPC_CHANNELS.inventoryListTransfers, () => {
    return stockTransferListSchema.parse(listStockTransfers(options.getDatabase()));
  });
  ipcMain.handle(IPC_CHANNELS.inventoryTransferStock, (_event, payload: unknown) => {
    const input = transferStockInputSchema.parse(payload);
    const transferInput =
      input.note === undefined
        ? {
            productId: input.productId,
            sourceEventId: input.sourceEventId,
            destinationEventId: input.destinationEventId,
            quantity: input.quantity,
          }
        : {
            productId: input.productId,
            sourceEventId: input.sourceEventId,
            destinationEventId: input.destinationEventId,
            quantity: input.quantity,
            note: input.note,
          };
    return stockTransferSchema.parse(
      transferStockBetweenEvents(options.getDatabase(), transferInput),
    );
  });
  ipcMain.handle(IPC_CHANNELS.inventoryPreviewProductDeletion, (_event, productId: unknown) => {
    return productDeletionImpactSchema.parse(
      previewProductDeletion(options.getDatabase(), String(productId)),
    );
  });
  ipcMain.handle(IPC_CHANNELS.inventoryDeleteProduct, (_event, payload: unknown) => {
    const input = deleteProductInputSchema.parse(payload);
    return productDeletionResultSchema.parse(deleteInventoryProduct(options.getDatabase(), input));
  });
}
