import { BrowserWindow, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  PrinterInfo,
  PrintingSettings,
  PrintOrderResult,
  UpdatePrintingSettingsInput,
} from '@gtrz/contracts';
import type { DatabaseContext } from '@gtrz/database';
import {
  type DatabaseOrderReceipt,
  getOrderReceipt,
  getPrintingSettings,
  updatePrintingSettings,
} from '@gtrz/database/printing';

import { buildReceiptHtml, estimateReceiptHeightMm } from './receipt-html';
import type { ClaimedCloudPrintJob } from './cloud-sync-service';
import { normalizeCloudReceipt } from './normalize-cloud-receipt';

interface ThermalPrintServiceOptions {
  readonly archiveDirectory: string;
  readonly getDatabase: () => DatabaseContext;
}

interface CloudPrinterRegistration {
  readonly printerName: string;
  readonly enabled: boolean;
  readonly unavailableReason: string | null;
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

function isPdfOutput(settings: PrintingSettings): boolean {
  return settings.deviceName === 'Microsoft Print to PDF';
}

export class ThermalPrintService {
  readonly #getDatabase: () => DatabaseContext;
  readonly #archiveDirectory: string;
  readonly #archiveInFlight = new Map<string, Promise<void>>();
  #printerRegistrationCache: {
    readonly fingerprint: string;
    readonly value: CloudPrinterRegistration;
    readonly checkedAt: number;
  } | null = null;

  constructor(options: ThermalPrintServiceOptions) {
    this.#getDatabase = options.getDatabase;
    this.#archiveDirectory = options.archiveDirectory;
  }

  getSettings(): PrintingSettings {
    return getPrintingSettings(this.#getDatabase());
  }

  updateSettings(input: UpdatePrintingSettingsInput): PrintingSettings {
    const settings = updatePrintingSettings(this.#getDatabase(), input);
    this.#printerRegistrationCache = null;
    return settings;
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
    // Never hand a receipt to Windows' implicit default target. On a new PC it
    // is commonly "Microsoft Print to PDF", which opens a save dialog and can
    // make a completed sale look as if it was printed by the thermal station.
    await this.archiveOrder(orderId).catch(() => undefined);
    if (isPdfOutput(getPrintingSettings(this.#getDatabase()))) return;
    const registration = await this.getCloudPrinterRegistration();
    if (!registration.enabled) return;
    await this.#printOrder(orderId, false, false).catch(() => undefined);
  }

  async archiveOrder(orderId: string): Promise<void> {
    const receipt = getOrderReceipt(this.#getDatabase(), orderId);
    await this.#archiveReceiptDocument(receipt);
  }

  async openReceiptFolder(): Promise<string> {
    await mkdir(this.#archiveDirectory, { recursive: true });
    const error = await shell.openPath(this.#archiveDirectory);
    if (error) throw new Error(error);
    return this.#archiveDirectory;
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
      ...normalizeCloudReceipt(job.document),
      printedByLabel: settings.machineName,
    };
    if (isPdfOutput(settings)) {
      try {
        await this.#archiveReceiptDocument(receipt);
        return { success: true, skipped: false, message: 'PDF salvo na pasta de notas.' };
      } catch (error: unknown) {
        return {
          success: false,
          skipped: false,
          message: error instanceof Error ? error.message : 'Não foi possível salvar o PDF.',
        };
      }
    }
    return this.#printReceipt(receipt, settings);
  }

  async getCloudPrinterRegistration(): Promise<CloudPrinterRegistration> {
    const settings = getPrintingSettings(this.#getDatabase());
    const fingerprint = [
      settings.automaticPrinting,
      settings.deviceName ?? '',
      settings.paperWidthMm,
    ].join('|');
    const cached = this.#printerRegistrationCache;
    if (
      cached !== null &&
      cached.fingerprint === fingerprint &&
      Date.now() - cached.checkedAt < 30_000
    )
      return cached.value;

    if (!settings.automaticPrinting) {
      const value = {
        printerName: settings.deviceName ?? '__windows_default__',
        enabled: false,
        unavailableReason: 'A impressão automática está desativada neste computador.',
      };
      this.#printerRegistrationCache = { fingerprint, value, checkedAt: Date.now() };
      return value;
    }

    if (settings.deviceName === null) {
      const value = {
        printerName: '__windows_default__',
        enabled: false,
        unavailableReason:
          'Selecione uma impressora térmica nas Configurações antes de ativar a impressão automática.',
      };
      this.#printerRegistrationCache = { fingerprint, value, checkedAt: Date.now() };
      return value;
    }

    if (
      /^(OneNote(?: \(Desktop\))?|AnyDesk Printer|RustDesk Printer)$/iu.test(settings.deviceName)
    ) {
      const value = {
        printerName: settings.deviceName,
        enabled: false,
        unavailableReason:
          'A impressora configurada é virtual e não aceita impressão automática silenciosa. Selecione uma impressora térmica nas Configurações.',
      };
      this.#printerRegistrationCache = { fingerprint, value, checkedAt: Date.now() };
      return value;
    }

    const printers = await this.listPrinters();
    const selectedPrinter = printers.find((printer) => printer.name === settings.deviceName);
    if (selectedPrinter === undefined) {
      const value = {
        printerName: settings.deviceName,
        enabled: false,
        unavailableReason: `A impressora configurada (${settings.deviceName}) não está disponível neste computador.`,
      };
      this.#printerRegistrationCache = { fingerprint, value, checkedAt: Date.now() };
      return value;
    }

    const value = {
      printerName: selectedPrinter.name,
      enabled: true,
      unavailableReason: null,
    };
    this.#printerRegistrationCache = { fingerprint, value, checkedAt: Date.now() };
    return value;
  }

  async #printOrder(orderId: string, force: boolean, archive = true): Promise<PrintOrderResult> {
    const settings = getPrintingSettings(this.#getDatabase());
    if (!force && !settings.automaticPrinting) {
      return { success: true, skipped: true, message: 'Impressão automática desativada.' };
    }

    try {
      const receipt = getOrderReceipt(this.#getDatabase(), orderId);
      if (isPdfOutput(settings)) {
        await this.#archiveReceiptDocument(receipt);
        return { success: true, skipped: false, message: 'PDF salvo na pasta de notas.' };
      }
      return await this.#printReceipt(receipt, settings, archive);
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
    archive = true,
  ): Promise<PrintOrderResult> {
    try {
      const html = await buildReceiptHtml(receipt, settings.paperWidthMm);
      const window = createHiddenWindow();

      try {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        if (archive) await this.#archiveReceipt(window, receipt);
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

  async #archiveReceiptDocument(receipt: DatabaseOrderReceipt): Promise<void> {
    const existing = this.#archiveInFlight.get(receipt.orderId);
    if (existing) return existing;
    const saving = this.#renderAndArchiveReceipt(receipt);
    this.#archiveInFlight.set(receipt.orderId, saving);
    try {
      await saving;
    } finally {
      if (this.#archiveInFlight.get(receipt.orderId) === saving) {
        this.#archiveInFlight.delete(receipt.orderId);
      }
    }
  }

  async #renderAndArchiveReceipt(receipt: DatabaseOrderReceipt): Promise<void> {
    const html = await buildReceiptHtml(
      receipt,
      getPrintingSettings(this.#getDatabase()).paperWidthMm,
    );
    const window = createHiddenWindow();
    try {
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await this.#archiveReceipt(window, receipt);
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  async #archiveReceipt(window: BrowserWindow, receipt: DatabaseOrderReceipt): Promise<void> {
    const occurredAt = new Date(receipt.closedAt);
    const folder = path.join(
      this.#archiveDirectory,
      String(occurredAt.getFullYear()),
      `${String(occurredAt.getMonth() + 1).padStart(2, '0')}-${String(occurredAt.getDate()).padStart(2, '0')}`,
    );
    await mkdir(folder, { recursive: true });
    const target = path.join(folder, `Pedido-${receipt.orderId}.pdf`);
    const previous = await readFile(target).catch(() => null);
    if (
      previous !== null &&
      previous.subarray(0, 5).toString() === '%PDF-' &&
      previous.subarray(-16).toString().includes('%%EOF')
    ) {
      return;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        await window.webContents.printToPDF({
          printBackground: true,
          pageSize: {
            width: getPrintingSettings(this.#getDatabase()).paperWidthMm / 25.4,
            height: estimateReceiptHeightMm(receipt) / 25.4,
          },
          preferCSSPageSize: false,
        }),
      );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
