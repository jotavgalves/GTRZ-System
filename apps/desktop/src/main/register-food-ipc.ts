import { ipcMain } from 'electron';
import {
  archiveFoodSupplierInputSchema,
  configureFoodInputSchema,
  createExternalFoodItemInputSchema,
  createFoodSupplierInputSchema,
  foodStateSchema,
  foodSupplierSchema,
  IPC_CHANNELS,
  updateFoodSupplierInputSchema,
} from '@gtrz/contracts';
import {
  archiveFoodSupplier,
  configureFood,
  createExternalFoodItem,
  createFoodSupplier,
  getFoodState,
  type DatabaseContext,
  updateFoodSupplier,
} from '@gtrz/database';
export function registerFoodIpcHandlers(options: {
  readonly getDatabase: () => DatabaseContext;
}): void {
  for (const channel of [
    IPC_CHANNELS.foodGetState,
    IPC_CHANNELS.foodConfigure,
    IPC_CHANNELS.foodCreateSupplier,
    IPC_CHANNELS.foodUpdateSupplier,
    IPC_CHANNELS.foodArchiveSupplier,
    IPC_CHANNELS.foodCreateExternalItem,
  ])
    ipcMain.removeHandler(channel);
  ipcMain.handle(IPC_CHANNELS.foodGetState, () =>
    foodStateSchema.parse(getFoodState(options.getDatabase())),
  );
  ipcMain.handle(IPC_CHANNELS.foodConfigure, (_event, payload: unknown) =>
    foodStateSchema.parse(
      configureFood(options.getDatabase(), configureFoodInputSchema.parse(payload)),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.foodCreateSupplier, (_event, payload: unknown) =>
    foodSupplierSchema.parse(
      createFoodSupplier(options.getDatabase(), createFoodSupplierInputSchema.parse(payload)),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.foodUpdateSupplier, (_event, payload: unknown) =>
    foodSupplierSchema.parse(
      updateFoodSupplier(options.getDatabase(), updateFoodSupplierInputSchema.parse(payload)),
    ),
  );
  ipcMain.handle(IPC_CHANNELS.foodArchiveSupplier, (_event, payload: unknown) => {
    archiveFoodSupplier(
      options.getDatabase(),
      archiveFoodSupplierInputSchema.parse(payload).supplierId,
    );
  });
  ipcMain.handle(IPC_CHANNELS.foodCreateExternalItem, (_event, payload: unknown) =>
    foodStateSchema.parse(
      createExternalFoodItem(
        options.getDatabase(),
        createExternalFoodItemInputSchema.parse(payload),
      ),
    ),
  );
}
