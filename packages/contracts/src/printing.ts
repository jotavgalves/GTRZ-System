import { z } from 'zod';

export const thermalPaperWidthSchema = z.union([z.literal(58), z.literal(80)]);

export const printerInfoSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  isDefault: z.boolean(),
});

export const printerListSchema = z.array(printerInfoSchema);

export const printingSettingsSchema = z.object({
  automaticPrinting: z.boolean(),
  deviceName: z.string().min(1).nullable(),
  machineName: z.string().trim().min(2).max(60),
  paperWidthMm: thermalPaperWidthSchema,
});

export const updatePrintingSettingsInputSchema = printingSettingsSchema.pick({
  automaticPrinting: true,
  deviceName: true,
  machineName: true,
  paperWidthMm: true,
});

export const printOrderInputSchema = z.object({
  orderId: z.uuid(),
});

export const printOrderResultSchema = z.object({
  success: z.boolean(),
  skipped: z.boolean(),
  message: z.string().min(1),
});

export type ThermalPaperWidth = z.infer<typeof thermalPaperWidthSchema>;
export type PrinterInfo = z.infer<typeof printerInfoSchema>;
export type PrintingSettings = z.infer<typeof printingSettingsSchema>;
export type UpdatePrintingSettingsInput = z.infer<typeof updatePrintingSettingsInputSchema>;
export type PrintOrderInput = z.infer<typeof printOrderInputSchema>;
export type PrintOrderResult = z.infer<typeof printOrderResultSchema>;

export interface PrintingApi {
  listPrinters(): Promise<readonly PrinterInfo[]>;
  getSettings(): Promise<PrintingSettings>;
  updateSettings(input: UpdatePrintingSettingsInput): Promise<PrintingSettings>;
  reprintOrder(input: PrintOrderInput): Promise<PrintOrderResult>;
}
