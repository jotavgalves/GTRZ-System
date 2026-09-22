import { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  PrinterInfo,
  PrintingSettings,
  PrintOrderResult,
  UpdatePrintingSettingsInput,
} from '@gtrz/contracts';
import type { DatabaseContext } from '@gtrz/database';
import type { DatabaseOrderReceipt } from '@gtrz/database/printing';
import {
  getOrderReceipt,
  getPrintingSettings,
  updatePrintingSettings,
} from '@gtrz/database/printing';

import { buildReceiptHtml, estimateReceiptHeightMm } from './receipt-html';
import type { ClaimedCloudPrintJob } from './cloud-sync-service';

interface ThermalPrintServiceOptions {
  readonly archiveDirectory: string;
  readonly getDatabase: () => DatabaseContext;
}

function createHiddenWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

export class ThermalPrintService {
  readonly #getDatabase: () => DatabaseContext;
  readonly #archiveDirectory: string;

  constructor(options: ThermalPrintServiceOptions) {
    this.#getDatabase = options.getDatabase;
    this.#archiveDirectory = options.archiveDirectory;
  }

  getSettings(): PrintingSettings {
    return getPrintingSettings(this.#getDatabase());
  }

  updateSettings(input: UpdatePrintingSettingsInput): PrintingSettings {
    return updatePrintingSettings(this.#getDatabase(), input);
  }

  async listPrinters(): Promise<readonly PrinterInfo[]> {
    const window = createHiddenWindow();
    try {
      await window.loadURL(
        'data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%3E%3C/body%3E%3C/html%3E',
      );
      const printers = await window.webContents.getPrintersAsync();
      return printers.map((printer) => ({
        name: printer.name,
        displayName: printer.displayName || printer.name,
        isDefault: false,
      }));
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  async printAfterSale(orderId: string): Promise<void> {
    await this.#printOrder(orderId, false).catch(() => undefined);
  }

  async reprintOrder(orderId: string): Promise<PrintOrderResult> {
    return this.#printOrder(orderId, true);
  }

  async printCloudJob(job: ClaimedCloudPrintJob): Promise<PrintOrderResult> {
    const settings = getPrintingSettings(this.#getDatabase());
    if (!settings.automaticPrinting) {
      return {
        success: false,
        skipped: true,
        message: 'Este PC não está habilitado para imprimir.',
      };
    }
    const receipt: DatabaseOrderReceipt = {
      ...job.document,
      printedByLabel: settings.machineName,
    };
    return this.#printReceipt(receipt, settings);
  }

  async #printOrder(orderId: string, force: boolean): Promise<PrintOrderResult> {
    const settings = getPrintingSettings(this.#getDatabase());
    if (!force && !settings.automaticPrinting) {
      return { success: true, skipped: true, message: 'Impressão automática desativada.' };
    }

    try {
      const receipt = getOrderReceipt(this.#getDatabase(), orderId);
      return await this.#printReceipt(receipt, settings);
    } catch (error: unknown) {
      return {
        success: false,
        skipped: false,
        message: error instanceof Error ? error.message : 'Falha ao imprimir a nota de retirada.',
      };
    }
  }

  async #printReceipt(
    receipt: DatabaseOrderReceipt,
    settings: PrintingSettings,
  ): Promise<PrintOrderResult> {
    try {
      const html = buildReceiptHtml(receipt, settings.paperWidthMm);
      const window = createHiddenWindow();

      try {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await this.#archiveReceipt(window, receipt.orderId, receipt.closedAt);
        const success = await new Promise<boolean>((resolve) => {
          const printOptions = {
            silent: true,
            printBackground: true,
            margins: { marginType: 'none' as const },
            pageSize: {
              width: settings.paperWidthMm * 1000,
              height: estimateReceiptHeightMm(receipt) * 1000,
            },
            ...(settings.deviceName === null ? {} : { deviceName: settings.deviceName }),
          };
          window.webContents.print(printOptions, (printed) => {
            resolve(printed);
          });
        });

        return success
          ? { success: true, skipped: false, message: 'Nota enviada para a impressora.' }
          : {
              success: false,
              skipped: false,
              message: 'A impressora recusou o trabalho de impressão.',
            };
      } finally {
        if (!window.isDestroyed()) window.destroy();
      }
    } catch (error: unknown) {
      return {
        success: false,
        skipped: false,
        message: error instanceof Error ? error.message : 'Falha ao imprimir a nota de retirada.',
      };
    }
  }

  async #archiveReceipt(window: BrowserWindow, orderId: string, closedAt: number): Promise<void> {
    const occurredAt = new Date(closedAt);
    const folder = path.join(
      this.#archiveDirectory,
      String(occurredAt.getFullYear()),
      `${String(occurredAt.getMonth() + 1).padStart(2, '0')}-${String(occurredAt.getDate()).padStart(2, '0')}`,
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, `Pedido-${orderId}.pdf`),
      await window.webContents.printToPDF({ printBackground: true }),
    );
  }
}
