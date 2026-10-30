import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// One long-lived PowerShell compiles the winspool bindings once. Every later job is a single line
// on stdin, so a note no longer pays for a process start and a C# compile.
const HOST_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class GtrzRaw {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public class DOCINFO { [MarshalAs(UnmanagedType.LPStr)] public string pDocName; [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPStr)] public string pDataType; }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr h, int l, [In] DOCINFO d);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  public static void Send(string printer, byte[] data) {
    IntPtr h; if(!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter " + Marshal.GetLastWin32Error());
    var di = new DOCINFO{pDocName="GTRZ nota", pDataType="RAW"};
    if(!StartDocPrinter(h,1,di)){ var e=Marshal.GetLastWin32Error(); ClosePrinter(h); throw new Exception("StartDocPrinter " + e); }
    StartPagePrinter(h); int w; bool ok=WritePrinter(h,data,data.Length,out w); var we=Marshal.GetLastWin32Error();
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    if(!ok || w != data.Length) throw new Exception("WritePrinter " + we);
  }
}
'@
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $part = $line.Split("\`t")
  try {
    if ($part[0] -eq 'SEND') { [GtrzRaw]::Send($part[1], [IO.File]::ReadAllBytes($part[2])); $reply = 'OK' }
    elseif ($part[0] -eq 'DRIVER') { $reply = 'OK ' + (Get-Printer -Name $part[1]).DriverName }
    elseif ($part[0] -eq 'ENSURE') {
      $queue = $part[1]
      if (Get-Printer -Name $queue -ErrorAction SilentlyContinue) { $reply = 'OK existe' }
      else {
        $usb = @(Get-PrinterPort | Where-Object { $_.Name -like 'USB*' } | Sort-Object Name)
        if ($usb.Count -eq 0) { $reply = 'ERR Nenhuma porta de impressora USB encontrada. Ligue a impressora e conecte o cabo.' }
        else {
          if (-not (Get-PrinterDriver -Name 'Generic / Text Only' -ErrorAction SilentlyContinue)) { Add-PrinterDriver -Name 'Generic / Text Only' }
          $port = $usb[$usb.Count - 1].Name
          Add-Printer -Name $queue -DriverName 'Generic / Text Only' -PortName $port
          $reply = 'OK criada ' + $port
        }
      }
    }
    else { $reply = 'ERR comando desconhecido' }
  } catch { $reply = 'ERR ' + ($_.Exception.Message -replace '[\\r\\n]+', ' ') }
  [Console]::Out.WriteLine($reply); [Console]::Out.Flush()
}
`;

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface PendingReply {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class RawPrinterHost {
  #child: ChildProcessWithoutNullStreams | null = null;
  #scriptFile: string | null = null;
  #lines: string[] = [];
  #partial = '';
  #waiter: PendingReply | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  /** Requests run strictly one at a time, in the order they were made. */
  request(command: string): Promise<string> {
    const run = this.#chain.then(() => this.#roundTrip(command));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #roundTrip(command: string): Promise<string> {
    await this.#ensureStarted();
    const child = this.#child;
    if (child === null) throw new Error('O serviço de impressão não iniciou.');
    const reply = this.#nextLine(REQUEST_TIMEOUT_MS);
    child.stdin.write(`${command}\n`);
    try {
      return await reply;
    } catch (error: unknown) {
      this.#stop();
      throw error;
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#child !== null && this.#child.exitCode === null) return;
    this.#stop();
    const file = path.join(tmpdir(), `gtrz-raw-host-${randomUUID()}.ps1`);
    await writeFile(file, HOST_SCRIPT, 'utf8');
    this.#scriptFile = file;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true },
    );
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.#onData(chunk);
    });
    child.stderr.on('data', () => undefined);
    child.on('exit', () => {
      if (this.#child === child) this.#child = null;
      this.#fail(new Error('O serviço de impressão foi encerrado.'));
    });
    child.on('error', (error) => {
      this.#fail(error);
    });
    const ready = await this.#nextLine(START_TIMEOUT_MS).catch((error: unknown) => {
      this.#stop();
      throw error;
    });
    if (ready.trim() !== 'READY') {
      this.#stop();
      throw new Error('O serviço de impressão respondeu de forma inesperada.');
    }
  }

  #onData(chunk: string): void {
    this.#partial += chunk;
    const parts = this.#partial.split(/\r?\n/u);
    this.#partial = parts.pop() ?? '';
    for (const line of parts) {
      const waiter = this.#waiter;
      if (waiter === null) {
        this.#lines.push(line);
      } else {
        this.#waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  }

  #nextLine(timeoutMs: number): Promise<string> {
    const buffered = this.#lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error('O serviço de impressão não respondeu.'));
      }, timeoutMs);
      this.#waiter = { resolve, reject, timer };
    });
  }

  #fail(error: Error): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    if (waiter !== null) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #stop(): void {
    const child = this.#child;
    this.#child = null;
    this.#lines = [];
    this.#partial = '';
    if (child !== null && child.exitCode === null) child.kill();
    const file = this.#scriptFile;
    this.#scriptFile = null;
    if (file !== null) void rm(file, { force: true });
  }
}

const host = new RawPrinterHost();

function assertPlainName(value: string): void {
  if (/[\t\r\n]/u.test(value)) throw new Error('Nome de impressora inválido.');
}

function expectOk(reply: string): string {
  if (reply === 'OK') return '';
  if (reply.startsWith('OK ')) return reply.slice(3);
  throw new Error(reply.startsWith('ERR ') ? reply.slice(4) : 'Falha ao falar com a impressora.');
}

/** Sends bytes to a Windows print queue with the RAW datatype, bypassing the graphic driver. */
export async function sendRawToPrinter(printerName: string, data: Buffer): Promise<void> {
  assertPlainName(printerName);
  const file = path.join(tmpdir(), `gtrz-raw-${randomUUID()}.bin`);
  await writeFile(file, data);
  try {
    expectOk(await host.request(`SEND\t${printerName}\t${file}`));
  } finally {
    await rm(file, { force: true });
  }
}

const driverCache = new Map<string, { readonly raw: boolean; readonly checkedAt: number }>();
const DRIVER_CACHE_MS = 60_000;

/**
 * The "Generic / Text Only" driver cannot rasterise a page and sends no cut command, so receipts
 * for such a queue are rendered to a bitmap and sent as ESC/POS instead.
 */
export async function queueNeedsRawRaster(printerName: string): Promise<boolean> {
  assertPlainName(printerName);
  const cached = driverCache.get(printerName);
  if (cached !== undefined && Date.now() - cached.checkedAt < DRIVER_CACHE_MS) return cached.raw;
  const driver = await host
    .request(`DRIVER\t${printerName}`)
    .then(expectOk)
    .catch(() => '');
  const raw = /generic\s*\/\s*text only/iu.test(driver);
  driverCache.set(printerName, { raw, checkedAt: Date.now() });
  return raw;
}

/**
 * Makes sure a Windows print queue with the inbox "Generic / Text Only" driver exists on the first
 * USB printer port, so a fresh installation prints without a vendor driver or manual setup.
 * Resolves to a short description of what happened; rejects when it could not be done.
 */
export async function ensureThermalQueue(printerName: string): Promise<string> {
  assertPlainName(printerName);
  driverCache.delete(printerName);
  return expectOk(await host.request(`ENSURE\t${printerName}`));
}
