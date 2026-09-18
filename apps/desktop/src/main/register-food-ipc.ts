import { ipcMain } from 'electron';
import { configureFoodInputSchema, createExternalFoodItemInputSchema, createFoodSupplierInputSchema, foodStateSchema, foodSupplierSchema, IPC_CHANNELS } from '@gtrz/contracts';
import { configureFood, createExternalFoodItem, createFoodSupplier, getFoodState, type DatabaseContext } from '@gtrz/database';
export function registerFoodIpcHandlers(options:{readonly getDatabase:()=>DatabaseContext}):void {
  for(const channel of [IPC_CHANNELS.foodGetState,IPC_CHANNELS.foodConfigure,IPC_CHANNELS.foodCreateSupplier,IPC_CHANNELS.foodCreateExternalItem]) ipcMain.removeHandler(channel);
  ipcMain.handle(IPC_CHANNELS.foodGetState,()=>foodStateSchema.parse(getFoodState(options.getDatabase())));
  ipcMain.handle(IPC_CHANNELS.foodConfigure,(_event,payload:unknown)=>foodStateSchema.parse(configureFood(options.getDatabase(),configureFoodInputSchema.parse(payload))));
  ipcMain.handle(IPC_CHANNELS.foodCreateSupplier,(_event,payload:unknown)=>foodSupplierSchema.parse(createFoodSupplier(options.getDatabase(),createFoodSupplierInputSchema.parse(payload))));
  ipcMain.handle(IPC_CHANNELS.foodCreateExternalItem,(_event,payload:unknown)=>foodStateSchema.parse(createExternalFoodItem(options.getDatabase(),createExternalFoodItemInputSchema.parse(payload))));
}
