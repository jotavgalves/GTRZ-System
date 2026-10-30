import { ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  printerListSchema,
  printingSettingsSchema,
  printOrderInputSchema,
  printOrderResultSchema,
  updatePrintingSettingsInputSchema,
  type PrintingApi,
  type PrintingSettings,
  type PrinterInfo,
  type PrintOrderInput,
  type PrintOrderResult,
  type UpdatePrintingSettingsInput,
} from '@gtrz/contracts';

export const printingApi: PrintingApi = {
  async listPrinters(): Promise<readonly PrinterInfo[]> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.printingListPrinters);
    return printerListSchema.parse(payload);
  },

  async openReceiptFolder(): Promise<string> {
    const path: unknown = await ipcRenderer.invoke(IPC_CHANNELS.printingOpenReceiptFolder);
    if (typeof path !== 'string' || path.length === 0)
      throw new Error('Pasta de notas indisponível.');
    return path;
  },

  async getSettings(): Promise<PrintingSettings> {
    const payload: unknown = await ipcRenderer.invoke(IPC_CHANNELS.printingGetSettings);
    return printingSettingsSchema.parse(payload);
  },

  async updateSettings(input: UpdatePrintingSettingsInput): Promise<PrintingSettings> {
    const parsedInput = updatePrintingSettingsInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.printingUpdateSettings,
      parsedInput,
    );
    return printingSettingsSchema.parse(payload);
  },

  async reprintOrder(input: PrintOrderInput): Promise<PrintOrderResult> {
    const parsedInput = printOrderInputSchema.parse(input);
    const payload: unknown = await ipcRenderer.invoke(
      IPC_CHANNELS.printingReprintOrder,
      parsedInput,
    );
    return printOrderResultSchema.parse(payload);
  },
};
