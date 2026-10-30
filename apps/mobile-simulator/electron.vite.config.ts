import { fileURLToPath } from 'node:url';

import { defineConfig } from 'electron-vite';

const resolveFromApp = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolveFromApp('./src/main/index.ts'),
      },
    },
  },
});
