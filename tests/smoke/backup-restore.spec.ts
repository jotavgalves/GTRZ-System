import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dialog } from 'electron';
import { expect, it, vi } from 'vitest';
import { createEvent, listEvents } from '@gtrz/database';
import { BackupService } from '../../apps/desktop/src/main/backup-service';
import { DatabaseRuntime } from '../../apps/desktop/src/main/database-runtime';

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));

it('restores a verified SQLite backup into an isolated runtime', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gtrz-restore-smoke-'));
  const runtime = new DatabaseRuntime(path.join(directory, 'database.sqlite'));
  const backups = new BackupService({
    appVersion: 'test',
    defaultDestinationPath: path.join(directory, 'backups'),
    settingsPath: path.join(directory, 'settings.json'),
    databaseRuntime: runtime,
  });

  try {
    createEvent(runtime.get(), { name: 'Before backup', startsAt: Date.now() });
    const backup = await backups.createBackup('manual');
    expect((await backups.verify(backup.filePath)).integrity).toBe('valid');
    createEvent(runtime.get(), { name: 'After backup', startsAt: Date.now() });
    expect(listEvents(runtime.get())).toHaveLength(2);
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({
      canceled: false,
      filePaths: [backup.filePath],
    });

    expect((await backups.importBackup()).status).toBe('restored');
    expect(listEvents(runtime.get()).map((event) => event.name)).toEqual(['Before backup']);
  } finally {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
