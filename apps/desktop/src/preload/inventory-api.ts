import { ipcRenderer } from 'electron';

import {
  createCategoryInputSchema,
  correctStockPurchaseLotInputSchema,
  createProductInputSchema,
  deleteProductInputSchema,
  inventoryProductSchema,
  inventoryStateSchema,
  IPC_CHANNELS,
  productCategorySchema,
  productDeletionImpactSchema,
  productDeletionResultSchema,
  recordStockMovementInputSchema,
  stockPurchaseLotListSchema,
  stockPurchaseLotSchema,
  stockTransferListSchema,
  stockTransferSchema,
  transferStockInputSchema,
  voidStockPurchaseLotInputSchema,
  updateProductInputSchema,
  type CreateCategoryInput,
  type CorrectStockPurchaseLotInput,
  type CreateProductInput,
  type DeleteProductInput,
  type InventoryApi,
  type InventoryProduct,
  type InventoryState,
  type ProductCategory,
  type ProductDeletionImpact,
  type ProductDeletionResult,
  type RecordStockMovementInput,
  type StockTransfer,
  type StockPurchaseLot,
  type TransferStockInput,
  type UpdateProductInput,
  type VoidStockPurchaseLotInput,
} from '@gtrz/contracts';

export const inventoryApi: InventoryApi = {
  async getState(): Promise<InventoryState> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.inventoryGetState);
    return inventoryStateSchema.parse(payload);
  },
  async createCategory(input: CreateCategoryInput): Promise<ProductCategory> {
    const parsedInput = createCategoryInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryCreateCategory,
      parsedInput,
    );
    return productCategorySchema.parse(payload);
  },
  async createProduct(input: CreateProductInput): Promise<InventoryProduct> {
    const parsedInput = createProductInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryCreateProduct,
      parsedInput,
    );
    return inventoryProductSchema.parse(payload);
  },
  async updateProduct(input: UpdateProductInput): Promise<InventoryProduct> {
    const parsedInput = updateProductInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryUpdateProduct,
      parsedInput,
    );
    return inventoryProductSchema.parse(payload);
  },
  async recordMovement(input: RecordStockMovementInput): Promise<InventoryProduct> {
    const parsedInput = recordStockMovementInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryRecordMovement,
      parsedInput,
    );
    return inventoryProductSchema.parse(payload);
  },
  async listPurchaseLots(productId: string): Promise<readonly StockPurchaseLot[]> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.inventoryListPurchaseLots, productId);
    return stockPurchaseLotListSchema.parse(payload);
  },
  async correctPurchaseLot(input: CorrectStockPurchaseLotInput): Promise<StockPurchaseLot> {
    const parsedInput = correctStockPurchaseLotInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryCorrectPurchaseLot,
      parsedInput,
    );
    return stockPurchaseLotSchema.parse(payload);
  },
  async voidPurchaseLot(input: VoidStockPurchaseLotInput): Promise<StockPurchaseLot> {
    const parsedInput = voidStockPurchaseLotInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryVoidPurchaseLot,
      parsedInput,
    );
    return stockPurchaseLotSchema.parse(payload);
  },
  async listTransfers(): Promise<readonly StockTransfer[]> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.inventoryListTransfers);
    return stockTransferListSchema.parse(payload);
  },
  async transferStock(input: TransferStockInput): Promise<StockTransfer> {
    const parsedInput = transferStockInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryTransferStock,
      parsedInput,
    );
    return stockTransferSchema.parse(payload);
  },
  async previewDeletion(productId: string): Promise<ProductDeletionImpact> {
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryPreviewProductDeletion,
      productId,
    );
    return productDeletionImpactSchema.parse(payload);
  },
  async deleteProduct(input: DeleteProductInput): Promise<ProductDeletionResult> {
    const parsedInput = deleteProductInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.inventoryDeleteProduct,
      parsedInput,
    );
    return productDeletionResultSchema.parse(payload);
  },
};
