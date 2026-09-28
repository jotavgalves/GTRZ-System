import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceRoots = [path.join(root, 'apps', 'desktop', 'src'), path.join(root, 'packages')];
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const ignoredDirectories = new Set([
  '.types',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
]);
const defaultMaximumLines = {
  ts: 500,
  tsx: 350,
};
const transitionalLineBudgets = new Map([
  ['apps/desktop/src/main/cloud-sync-service.ts', 3439],
  ['apps/desktop/src/renderer/src/features/cloud-monitor/index.tsx', 496],
  ['apps/desktop/src/renderer/src/features/cloud-monitor/MobileOperatorsPanel.tsx', 398],
  ['apps/desktop/src/renderer/src/features/expenses/ExpenseCard.tsx', 375],
  ['apps/desktop/src/renderer/src/features/food/FoodPage.tsx', 369],
  ['apps/desktop/src/renderer/src/features/inventory/ComboForm.tsx', 393],
  ['apps/desktop/src/renderer/src/features/inventory/ProductCard.tsx', 608],
  ['apps/desktop/src/renderer/src/features/inventory/ProductForm.tsx', 509],
  ['apps/desktop/src/renderer/src/features/settings/index.tsx', 365],
  ['packages/database/src/combos.spec.ts', 652],
  ['packages/database/src/deletion-integrity.spec.ts', 521],
  ['packages/database/src/inventory.ts', 787],
]);
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await walk(absolute)));
      }
    } else if (codeExtensions.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }

  return files;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function report(file, message) {
  violations.push(`${relative(file)}: ${message}`);
}

function matches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

const files = [];
for (const sourceRoot of sourceRoots) {
  try {
    if ((await stat(sourceRoot)).isDirectory()) {
      files.push(...(await walk(sourceRoot)));
    }
  } catch {
    // Uma raiz ainda não criada não deve ocultar violações das demais raízes.
  }
}

let createRootCount = 0;
let routerCount = 0;

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const filePath = relative(file);
  const lines = content.split(/\r?\n/u).length;
  const isRenderer = filePath.startsWith('apps/desktop/src/renderer/');
  const isRendererEntry = filePath.endsWith('/renderer/src/main.tsx');
  const isFeature = filePath.includes('/features/');

  createRootCount += matches(content, /\bcreateRoot\s*\(/gu);
  routerCount += matches(content, /\bcreateHashRouter\s*\(/gu);

  if (/\bReactDOM\.render\s*\(/u.test(content)) {
    report(file, 'ReactDOM.render é proibido; existe somente uma raiz React moderna.');
  }

  if (/\b(?:innerHTML|outerHTML)\s*=/u.test(content)) {
    report(file, 'manipulação direta de HTML é proibida.');
  }

  if (
    isRenderer &&
    !isRendererEntry &&
    /\bdocument\.(?:querySelector|getElementById)\s*\(/u.test(content)
  ) {
    report(file, 'componentes não podem procurar ou disputar contêineres diretamente no DOM.');
  }

  if (isRenderer && /\bwindow\.location\.reload\s*\(/u.test(content)) {
    report(file, 'recarregar a janela para sincronizar estado é proibido.');
  }

  if (isRenderer && /\bsetTimeout\s*\(/u.test(content)) {
    report(file, 'setTimeout não pode ser usado como correção de sincronização no renderer.');
  }

  if (
    isRenderer &&
    /from\s+['"](?:electron|node:(?:fs|path)|fs|path|better-sqlite3|drizzle-orm(?:\/[^'"]*)?)['"]/u.test(
      content,
    )
  ) {
    report(file, 'o renderer importou infraestrutura proibida.');
  }

  if (/\b(?:Old|Legacy|Copy|V2)(?:[A-Z_]|\b)/u.test(path.basename(file))) {
    report(file, 'nome de arquivo indica implementação duplicada ou legado empilhado.');
  }

  if (/\.(?:bak|old|copy)\./iu.test(path.basename(file))) {
    report(file, 'arquivos de cópia ou backup não pertencem ao código-fonte.');
  }

  const maximumLines =
    transitionalLineBudgets.get(filePath) ??
    (file.endsWith('.tsx') ? defaultMaximumLines.tsx : defaultMaximumLines.ts);
  if (lines > maximumLines) {
    report(
      file,
      `arquivo excede o limite arquitetural de tamanho (${lines}/${maximumLines} linhas).`,
    );
  }

  const internalFeatureImports = content.matchAll(
    /from\s+['"][^'"]*features\/([^/'"]+)\/([^'"]+)['"]/gu,
  );
  for (const match of internalFeatureImports) {
    const targetFeature = match[1];
    const internalPath = match[2];
    const ownerMatch = filePath.match(/\/features\/([^/]+)\//u);
    const ownerFeature = ownerMatch?.[1];

    if (isFeature && targetFeature !== ownerFeature && internalPath !== 'index') {
      report(
        file,
        `import interno do módulo ${targetFeature}; use exclusivamente a API pública index.ts.`,
      );
    }
  }
}

if (createRootCount !== 1) {
  violations.push(`renderer: esperado exatamente 1 createRoot; encontrados ${createRootCount}.`);
}

if (routerCount !== 1) {
  violations.push(`renderer: esperado exatamente 1 createHashRouter; encontrados ${routerCount}.`);
}

if (violations.length > 0) {
  console.error('\nViolações arquiteturais encontradas:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log('Arquitetura validada: fronteiras, montagem e padrões obrigatórios estão íntegros.');
}
