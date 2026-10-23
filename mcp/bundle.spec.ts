import { build } from 'esbuild';

describe('bundle', () => {
  it('pulls in no Angular code and no browser-only app code (ADR-013)', async () => {
    const result = await build({
      entryPoints: ['mcp/main.ts'],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      external: ['playwright'],
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).map((p) => p.replaceAll('\\', '/'));
    expect(
      inputs.filter((p) => p.includes('node_modules/@angular') || p.includes('node_modules/rxjs')),
    ).toEqual([]);
    const app = inputs.filter((p) => p.startsWith('src/app/'));
    expect(app.length).toBeGreaterThan(10);
    expect(
      app.filter((p) => !/^src\/app\/(core|library\/archive|components\/trust\/analysis)/.test(p)),
    ).toEqual([]);
    expect(
      app.filter((p) =>
        /deck-store|history\.ts|deck-archive|file-access|indexeddb|persistence\/(index|providers|tokens)/.test(
          p,
        ),
      ),
    ).toEqual([]);
  });
});
