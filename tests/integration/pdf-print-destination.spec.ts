import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaimedCloudPrintJob } from '../../apps/desktop/src/main/cloud-sync-service';
import { ThermalPrintService } from '../../apps/desktop/src/main/thermal-print-service';

const fake = vi.hoisted(() => ({
  settings: {
    automaticPrinting: true,
    deviceName: 'Microsoft Print to PDF',
    machineName: 'PC Teste',
    paperWidthMm: 80,
  },
  print: vi.fn(),
  printToPDF: vi.fn(() => Promise.resolve(Buffer.from('%PDF-1.4\nPDF de teste\n%%EOF'))),
  openPath: vi.fn(() => Promise.resolve('')),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      getPrintersAsync: () =>
        Promise.resolve([
          { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF' },
        ]),
      print: fake.print,
      printToPDF: fake.printToPDF,
    };
    loadURL = (): Promise<void> => Promise.resolve();
    isDestroyed = (): boolean => false;
    destroy = (): void => undefined;
  },
  shell: { openPath: fake.openPath },
}));

vi.mock('@gtrz/database/printing', () => ({
  getPrintingSettings: () => fake.settings,
  getOrderReceipt: () => ({
    ...receipt,
    items: receipt.items.map((item) => ({ ...item, name: item.itemName ?? 'Item' })),
  }),
  updatePrintingSettings: () => fake.settings,
}));

const receipt: ClaimedCloudPrintJob['document'] = {
  orderId: 'test-pdf-order',
  eventName: 'Evento teste',
  servicePointLabel: 'Mesa 1',
  servicePointType: 'table',
  subtotalCents: 1500,
  discountCents: 0,
  totalCents: 1500,
  closedAt: new Date(2026, 9, 27, 12).getTime(),
  operatorName: 'Caixa',
  originLabel: 'Mobile',
  items: [{ itemName: 'Água', quantity: 1, unitPriceCents: 1500, totalCents: 1500 }],
  payments: [{ method: 'pix', amountCents: 1500, receivedCents: null, changeCents: 0 }],
  vouchers: [],
  documentType: 'sale-batch',
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  fake.print.mockClear();
  fake.printToPDF.mockClear();
  fake.openPath.mockClear();
});

describe('Microsoft Print to PDF as receipt destination', () => {
  it('archives a local sale and reprint without invoking the Windows printer', async () => {
    const archiveDirectory = mkdtempSync(path.join(tmpdir(), 'gtrz-local-pdf-test-'));
    directories.push(archiveDirectory);
    const service = new ThermalPrintService({
      archiveDirectory,
      getDatabase: () => ({}) as never,
    });
    await service.printAfterSale(receipt.orderId);
    const file = path.join(archiveDirectory, '2026', '10-27', 'Pedido-test-pdf-order.pdf');
    expect(existsSync(file)).toBe(true);
    await expect(service.reprintOrder(receipt.orderId)).resolves.toMatchObject({ success: true });
    expect(fake.print).not.toHaveBeenCalled();
    expect(fake.printToPDF).toHaveBeenCalledTimes(1);
  });

  it('registers as available and saves a cloud job without opening the Windows print dialog', async () => {
    const archiveDirectory = mkdtempSync(path.join(tmpdir(), 'gtrz-pdf-test-'));
    directories.push(archiveDirectory);
    const service = new ThermalPrintService({
      archiveDirectory,
      getDatabase: () => ({}) as never,
    });
    const registration = await service.getCloudPrinterRegistration();
    expect(registration).toMatchObject({ printerName: 'Microsoft Print to PDF', enabled: true });

    const result = await service.printCloudJob({
      jobId: 'test-job',
      claimToken: 'claim-token',
      printerLabel: 'PC Teste',
      document: receipt,
    });
    const file = path.join(archiveDirectory, '2026', '10-27', 'Pedido-test-pdf-order.pdf');
    expect(result).toMatchObject({ success: true, message: 'PDF salvo na pasta de notas.' });
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).subarray(0, 4).toString()).toBe('%PDF');
    expect(fake.print).not.toHaveBeenCalled();
    expect(fake.printToPDF).toHaveBeenCalledTimes(1);
    await expect(
      service.printCloudJob({
        jobId: 'test-job-replay',
        claimToken: 'claim-token-replay',
        printerLabel: 'PC Teste',
        document: receipt,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(fake.printToPDF).toHaveBeenCalledTimes(1);
    await expect(service.openReceiptFolder()).resolves.toBe(archiveDirectory);
    expect(fake.openPath).toHaveBeenCalledWith(archiveDirectory);
  });
});
