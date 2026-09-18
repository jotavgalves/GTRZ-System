import { ipcRenderer } from 'electron';
import {
  archiveFoodSupplierInputSchema,
  configureFoodInputSchema,
  createExternalFoodItemInputSchema,
  createFoodSupplierInputSchema,
  foodStateSchema,
  foodSupplierSchema,
  IPC_CHANNELS,
  updateFoodSupplierInputSchema,
  type ArchiveFoodSupplierInput,
  type ConfigureFoodInput,
  type CreateExternalFoodItemInput,
  type CreateFoodSupplierInput,
  type FoodApi,
  type FoodState,
  type FoodSupplier,
  type UpdateFoodSupplierInput,
} from '@gtrz/contracts';
export const foodApi: FoodApi = {
  async getState(): Promise<FoodState> {
    return foodStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.foodGetState));
  },
  async configure(input: ConfigureFoodInput): Promise<FoodState> {
    return foodStateSchema.parse(
      await ipcRenderer.invoke(IPC_CHANNELS.foodConfigure, configureFoodInputSchema.parse(input)),
    );
  },
  async createSupplier(input: CreateFoodSupplierInput): Promise<FoodSupplier> {
    return foodSupplierSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.foodCreateSupplier,
        createFoodSupplierInputSchema.parse(input),
      ),
    );
  },
  async updateSupplier(input: UpdateFoodSupplierInput): Promise<FoodSupplier> {
    return foodSupplierSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.foodUpdateSupplier,
        updateFoodSupplierInputSchema.parse(input),
      ),
    );
  },
  async archiveSupplier(input: ArchiveFoodSupplierInput): Promise<void> {
    await ipcRenderer.invoke(
      IPC_CHANNELS.foodArchiveSupplier,
      archiveFoodSupplierInputSchema.parse(input),
    );
  },
  async createExternalItem(input: CreateExternalFoodItemInput): Promise<FoodState> {
    return foodStateSchema.parse(
      await ipcRenderer.invoke(
        IPC_CHANNELS.foodCreateExternalItem,
        createExternalFoodItemInputSchema.parse(input),
      ),
    );
  },
};
