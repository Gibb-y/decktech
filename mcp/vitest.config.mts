import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `import text from './x.md'` gives the file's text, as the esbuild loader of `npm run build:mcp` does.
const markdownText = {
  name: 'markdown-text',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    return id.endsWith('.md')
      ? { code: `export default ${JSON.stringify(code)};`, map: null }
      : null;
  },
};

export default defineConfig({
  plugins: [markdownText],
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'node',
    include: ['mcp/**/*.spec.ts'],
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
});
