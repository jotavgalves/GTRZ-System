import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const rendererSource = path.join(root, 'apps', 'desktop', 'src', 'renderer', 'src');

describe('SMK-INF-001 — fundação modular', () => {
  it('possui um único ponto de montagem React', async () => {
    const mainFile = await readFile(path.join(rendererSource, 'main.tsx'), 'utf8');
    const mountCount = [...mainFile.matchAll(/\bcreateRoot\s*\(/gu)].length;

    expect(mountCount).toBe(1);
    expect(mainFile).not.toContain('ReactDOM.render');
  });

  it('possui um único roteador principal', async () => {
    const routerFile = await readFile(path.join(rendererSource, 'app', 'router.tsx'), 'utf8');
    const routerCount = [...routerFile.matchAll(/\bcreateHashRouter\s*\(/gu)].length;

    expect(routerCount).toBe(1);
  });

  it('mantém as abas em diretórios de feature separados', async () => {
    const features = await readdir(path.join(rendererSource, 'features'));
    const expectedFeatures = [
      'audit',
      'backups',
      'capital',
      'cash',
      'cloud-monitor',
      'dashboard',
      'events',
    'expenses',
    'food',
    'inventory',
      'settings',
      'tables',
      'tickets',
      'vouchers',
    ];

    expect([...features].sort()).toEqual(expectedFeatures);
  });
});
