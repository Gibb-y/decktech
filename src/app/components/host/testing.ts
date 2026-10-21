/**
 * Test helpers for the host. Not part of the app: nothing imports this file except specs, so it is
 * not bundled. `deck-runtime.js` is read from `public/` with Node's `fs` (the specs run in Node).
 */
interface NodeProcess {
  cwd(): string;
  getBuiltinModule(id: string): { readFileSync(path: string, encoding: 'utf8'): string };
}

export function readRuntimeSource(): string {
  const process = (globalThis as unknown as { process: NodeProcess }).process;
  return process.getBuiltinModule('node:fs').readFileSync(`${process.cwd()}/public/deck-runtime.js`, 'utf8');
}
