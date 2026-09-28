import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import { dialog } from 'electron';

import type { BackupKind, BackupRecord, BackupState, RestoreBackupResult } from '@gtrz/contracts';
import {
  appendAudit,
  createDatabaseSnapshot,
  getSessionState,
  verifyDatabaseFile,
} from '@gtrz/database';

import type { DatabaseRuntime } from './database-runtime';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const BACKUP_EXTENSION = '.gtrzbackup';

interface BackupEnvelope {
  readonly format: 'gtrz-backup';
  readonly formatVersion: 1;
  readonly appVersion: string;
  readonly createdAt: number;
  readonly kind: BackupKind;
  readonly databaseSha256: string;
  readonly databaseBase64: string;
}

interface BackupSettings {
  readonly destinationPath: string;
}

interface BackupServiceOptions {
  readonly appVersion: string;
  readonly defaultDestinationPath: string;
  readonly settingsPath: string;
  readonly databaseRuntime: DatabaseRuntime;
}

function checksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isBackupKind(value: unknown): value is BackupKind {
  return (
    value === 'automatic' ||
    value === 'event-close' ||
    value === 'manual' ||
    value === 'pre-restore' ||
    value === 'pre-event-reset'
  );
}

function parseEnvelope(value: unknown): BackupEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new Error('O arquivo não contém um pacote de backup válido.');
  }

  const candidate = value as Partial<BackupEnvelope>;

  if (
    candidate.format !== 'gtrz-backup' ||
    candidate.formatVersion !== 1 ||
    typeof candidate.appVersion !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    !isBackupKind(candidate.kind) ||
    typeof candidate.databaseSha256 !== 'string' ||
    typeof candidate.databaseBase64 !== 'string'
  ) {
    throw new Error('O formato do backup não é reconhecido pelo GTRZ System.');
  }

  return candidate as BackupEnvelope;
}

function formatFileTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

export class BackupService {
  readonly #appVersion: string;
  readonly #defaultDestinationPath: string;
  readonly #settingsPath: string;
  readonly #databaseRuntime: DatabaseRuntime;

  constructor(options: BackupServiceOptions) {
    this.#appVersion = options.appVersion;
    this.#defaultDestinationPath = options.defaultDestinationPath;
    this.#settingsPath = options.settingsPath;
    this.#databaseRuntime = options.databaseRuntime;
  }

  async getState(): Promise<BackupState> {
    this.#requireProduction();
    const destinationPath = await this.#getDestinationPath();
    await mkdir(destinationPath, { recursive: true });
    const entries = await readdir(destinationPath, { withFileTypes: true });
    const records: BackupRecord[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(BACKUP_EXTENSION)) {
        continue;
      }

      records.push(await this.inspect(path.join(destinationPath, entry.name)));
    }

    records.sort((left, right) => right.createdAt - left.createdAt);
    return { destinationPath, backups: records };
  }

  async chooseDestination(): Promise<BackupState> {
    this.#requireProduction();
    const currentPath = await this.#getDestinationPath();
    const result = await dialog.showOpenDialog({
      title: 'Escolher pasta de backups do GTRZ System',
      defaultPath: currentPath,
      properties: ['openDirectory', 'createDirectory'],
    });

    if (!result.canceled && result.filePaths[0] !== undefined) {
      await this.#saveDestinationPath(result.filePaths[0]);
      appendAudit(this.#databaseRuntime.get(), {
        action: 'backup.destination-changed',
        entityType: 'backup-settings',
        details: { destinationPath: result.filePaths[0] },
      });
    }

    return this.getState();
  }

  async createBackup(kind: BackupKind): Promise<BackupRecord> {
    if (kind === 'manual' || kind === 'pre-restore') {
      this.#requireProduction();
    }

    const destinationPath = await this.#getDestinationPath();
    await mkdir(destinationPath, { recursive: true });
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-backup-'));
    const snapshotPath = path.join(temporaryDirectory, 'database.sqlite');
    const createdAt = Date.now();
    const fileName = `GTRZ-${formatFileTimestamp(createdAt)}-${kind}${BACKUP_EXTENSION}`;
    const finalPath = path.join(destinationPath, fileName);
    const temporaryPackagePath = `${finalPath}.tmp`;

    try {
      await createDatabaseSnapshot(this.#databaseRuntime.get(), snapshotPath);
      const databaseBuffer = await readFile(snapshotPath);
      const envelope: BackupEnvelope = {
        format: 'gtrz-backup',
        formatVersion: 1,
        appVersion: this.#appVersion,
        createdAt,
        kind,
        databaseSha256: checksum(databaseBuffer),
        databaseBase64: databaseBuffer.toString('base64'),
      };
      const compressed = await gzipAsync(Buffer.from(JSON.stringify(envelope), 'utf8'));
      await writeFile(temporaryPackagePath, compressed, { flag: 'wx' });
      await rename(temporaryPackagePath, finalPath);
      const record = await this.inspect(finalPath);

      if (record.integrity !== 'valid') {
        throw new Error('O backup criado não passou na verificação final.');
      }

      appendAudit(this.#databaseRuntime.get(), {
        action: 'backup.created',
        entityType: 'backup',
        entityId: fileName,
        details: { kind, sizeBytes: record.sizeBytes },
      });
      return record;
    } finally {
      await rm(temporaryPackagePath, { force: true });
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }

  async verify(filePath: string): Promise<BackupRecord> {
    this.#requireProduction();
    return this.inspect(filePath);
  }

  async inspect(filePath: string): Promise<BackupRecord> {
    const fileStats = await stat(filePath);

    try {
      const envelope = await this.#readEnvelope(filePath);
      const databaseBuffer = Buffer.from(envelope.databaseBase64, 'base64');
      const validChecksum = checksum(databaseBuffer) === envelope.databaseSha256;
      const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-verify-'));
      const snapshotPath = path.join(temporaryDirectory, 'database.sqlite');

      try {
        await writeFile(snapshotPath, databaseBuffer);
        const validDatabase = validChecksum && verifyDatabaseFile(snapshotPath);
        return {
          fileName: path.basename(filePath),
          filePath,
          kind: envelope.kind,
          createdAt: envelope.createdAt,
          sizeBytes: fileStats.size,
          integrity: validDatabase ? 'valid' : 'invalid',
        };
      } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    } catch {
      return {
        fileName: path.basename(filePath),
        filePath,
        kind: 'manual',
        createdAt: fileStats.mtimeMs,
        sizeBytes: fileStats.size,
        integrity: 'invalid',
      };
    }
  }

  async importBackup(): Promise<RestoreBackupResult> {
    this.#requireProduction();
    const result = await dialog.showOpenDialog({
      title: 'Importar backup do GTRZ System',
      filters: [{ name: 'Backup GTRZ', extensions: ['gtrzbackup'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths[0] === undefined) {
      return { status: 'cancelled' };
    }

    const sourcePath = result.filePaths[0];
    const record = await this.inspect(sourcePath);

    if (record.integrity !== 'valid') {
      throw new Error('O backup selecionado está corrompido ou não é compatível.');
    }

    await this.createBackup('pre-restore');
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'gtrz-restore-'));
    const snapshotPath = path.join(temporaryDirectory, 'database.sqlite');

    try {
      const envelope = await this.#readEnvelope(sourcePath);
      const databaseBuffer = Buffer.from(envelope.databaseBase64, 'base64');
      await writeFile(snapshotPath, databaseBuffer);
      await this.#databaseRuntime.replaceWith(snapshotPath);
      appendAudit(this.#databaseRuntime.get(), {
        action: 'backup.restored',
        entityType: 'backup',
        entityId: record.fileName,
        details: { sourceFileName: record.fileName },
      });
      return {
        status: 'restored',
        sourceFileName: record.fileName,
        restoredAt: Date.now(),
      };
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }

  async #readEnvelope(filePath: string): Promise<BackupEnvelope> {
    const compressed = await readFile(filePath);
    const jsonBuffer = await gunzipAsync(compressed);
    return parseEnvelope(JSON.parse(jsonBuffer.toString('utf8')) as unknown);
  }

  async #getDestinationPath(): Promise<string> {
    try {
      const rawSettings = await readFile(this.#settingsPath, 'utf8');
      const settings = JSON.parse(rawSettings) as Partial<BackupSettings>;
      return typeof settings.destinationPath === 'string' && settings.destinationPath.length > 0
        ? settings.destinationPath
        : this.#defaultDestinationPath;
    } catch {
      return this.#defaultDestinationPath;
    }
  }

  async #saveDestinationPath(destinationPath: string): Promise<void> {
    await mkdir(path.dirname(this.#settingsPath), { recursive: true });
    const temporaryPath = `${this.#settingsPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify({ destinationPath }, null, 2), 'utf8');
    await copyFile(temporaryPath, this.#settingsPath);
    await rm(temporaryPath, { force: true });
  }

  #requireProduction(): void {
    if (getSessionState(this.#databaseRuntime.get()).profile !== 'production') {
      throw new Error('Backups e restaurações exigem o perfil Produção.');
    }
  }
}
