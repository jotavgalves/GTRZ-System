import { ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  printerListSchema,
  printingSettingsSchema,
  printOrderInputSchema,
  printOrderResultSchema,
  updatePrintingSettingsInputSchema,
} from '@gtrz/contracts';

import type { ThermalPrintService } from './thermal-print-service';

interface RegisterPrintingIpcOptions {
  readonly printService: ThermalPrintService;
}

const PRINTING_CHANNELS = [
  IPC_CHANNELS.printingListPrinters,
  IPC_CHANNELS.printingOpenReceiptFolder,
  IPC_CHANNELS.printingGetSettings,
  IPC_CHANNELS.printingUpdateSettings,
  IPC_CHANNELS.printingReprintOrder,
] as const;

export function registerPrintingIpcHandlers(options: RegisterPrintingIpcOptions): void {
  for (const channel of PRINTING_CHANNELS) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(IPC_CHANNELS.printingListPrinters, async () => {
    return printerListSchema.parse(await options.printService.listPrinters());
  });

  ipcMain.handle(IPC_CHANNELS.printingOpenReceiptFolder, () =>
    options.printService.openReceiptFolder(),
  );

  ipcMain.handle(IPC_CHANNELS.printingGetSettings, () => {
    return printingSettingsSchema.parse(options.printService.getSettings());
  });

  ipcMain.handle(IPC_CHANNELS.printingUpdateSettings, (_event, payload: unknown) => {
    const input = updatePrintingSettingsInputSchema.parse(payload);
    return printingSettingsSchema.parse(options.printService.updateSettings(input));
  });

  ipcMain.handle(IPC_CHANNELS.printingReprintOrder, async (_event, payload: unknown) => {
    const input = printOrderInputSchema.parse(payload);
    return printOrderResultSchema.parse(await options.printService.reprintOrder(input.orderId));
  });
}
