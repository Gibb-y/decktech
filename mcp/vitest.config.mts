import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'node',
    include: ['mcp/**/*.spec.ts'],
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
});
