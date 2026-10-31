import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync('supabase/functions/gtrz-sync-fallback/index.ts', 'utf8');
const script = transpileModule(source, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
const context = {
  exports: {},
  require: () => ({ createClient: () => undefined }),
  Deno: { serve: () => undefined },
  Response,
  URL,
  crypto,
  globalThis: {} as Record<string, unknown>,
};
vm.runInNewContext(`${script}\nglobalThis.compactMobileCatalog=compactMobileCatalog;`, context);
const compactMobileCatalog = context.globalThis.compactMobileCatalog as (
  value: unknown,
) => Record<string, unknown>;

describe('canonical mobile catalog response', () => {
  it('excludes inline images without changing the stored catalog or stock', () => {
    const catalog = {
      products: [
        {
          productId: 'arepa',
          label: 'Arepa',
          quantity: 8,
          unitPriceCents: 2000,
          imageDataUrl: 'data:image/png;base64,' + 'A'.repeat(100_000),
        },
      ],
      currentSequence: 42,
    };
    const compact = compactMobileCatalog(catalog);
    const product = (compact.products as Array<Record<string, unknown>>)[0];
    expect(product).toMatchObject({ productId: 'arepa', quantity: 8, unitPriceCents: 2000 });
    expect(product).not.toHaveProperty('imageDataUrl');
    expect(compact.currentSequence).toBe(42);
    expect(catalog.products[0]?.imageDataUrl).toHaveLength(100_022);
  });
});
