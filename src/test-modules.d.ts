// Ambient declarations for spec files only (tsconfig.spec.json includes src/**/*.d.ts).
declare module 'jsdom' {
  /** The part of jsdom the runtime spec uses: a fresh window per test, scripts run with `eval`. */
  export class JSDOM {
    constructor(html?: string, options?: { runScripts?: 'dangerously' | 'outside-only'; url?: string; beforeParse?(window: Window & typeof globalThis & { eval(code: string): unknown }): void });
    readonly window: Window & typeof globalThis & { eval(code: string): unknown };
  }
}
