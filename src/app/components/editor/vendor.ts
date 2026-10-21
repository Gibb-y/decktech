import { err, ok, type Result } from '../../core/model';

/** Largest library file that is vendored into a deck. */
export const MAX_LIBRARY_BYTES = 5 * 1024 * 1024;

/** Valid npm package name (optionally scoped); also what keeps the fetched address on the CDN's host. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * The CDN address of a self-contained ES module build of `name@version` (esm.sh with `bundle`, which
 * inlines the dependencies; jsDelivr's `+esm` build imports its dependencies from the CDN and would
 * not work offline). The name and version are checked, so the address cannot leave that host or path.
 */
export function cdnUrl(name: string, version: string): Result<string, string> {
  const pkg = name.trim();
  const ver = version.trim() || 'latest';
  if (!PACKAGE.test(pkg) || pkg.includes('..')) return err(`"${name}" is not a valid npm package name`);
  if (!VERSION.test(ver)) return err(`"${version}" is not a valid version`);
  return ok(`https://esm.sh/${pkg}@${encodeURIComponent(ver)}?bundle&target=es2022`);
}

/**
 * Whether the module text still imports from somewhere else (a bare or absolute address, not data
 * or blob): a library like that would reach the network when the deck runs, which the sandbox
 * blocks, so vendoring it would silently produce a library that fails offline.
 */
export function externalImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /\bexport\s*\*\s*from\s*["']([^"']+)["']/g];
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) found.add(m[1]);
  return [...found].filter((spec) => /^(?:https?:)?\/\//.test(spec) || spec.startsWith('/'));
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; blob(): Promise<Blob> }>;

/**
 * Fetches a library from the CDN once, while online, as a JavaScript blob ready for `putAsset`.
 * Refuses a response that is not JavaScript, is too large, or still imports from elsewhere.
 */
export async function fetchLibrary(name: string, version: string, fetcher: Fetcher): Promise<Result<{ blob: Blob; label: string }, string>> {
  const url = cdnUrl(name, version);
  if (!url.ok) return url;
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await fetcher(url.value);
  } catch {
    return err('The library could not be downloaded. You need to be online once to add it.');
  }
  if (!response.ok) return err(`The library could not be downloaded (${response.status}). Check the name and version.`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_LIBRARY_BYTES) return err('The library is larger than 5 MiB');
  const raw = await response.blob();
  if (raw.size > MAX_LIBRARY_BYTES) return err('The library is larger than 5 MiB');
  const text = await raw.text();
  if (!/javascript|ecmascript/i.test(response.headers.get('content-type') ?? '') && !/^\s*(?:\/\*|\/\/|import|export|var|const|let|\()/.test(text)) {
    return err('The download is not JavaScript');
  }
  const external = externalImports(text);
  if (external.length > 0) return err(`The library imports from the network (${external.slice(0, 2).join(', ')}) and would not work offline. Download a bundled build and add it from a file.`);
  return ok({ blob: new Blob([text], { type: 'text/javascript' }), label: `${name.trim()}@${version.trim() || 'latest'}` });
}

/** Checks a library file picked from disk: JavaScript, small, self-contained. Resolves to a blob typed for the asset store. */
export async function readLibraryFile(file: File): Promise<Result<Blob, string>> {
  if (file.size > MAX_LIBRARY_BYTES) return err('The file is larger than 5 MiB');
  if (!/\.(?:m?js)$/i.test(file.name)) return err('Choose a JavaScript module file (.js or .mjs)');
  const text = await file.text();
  const external = externalImports(text);
  if (external.length > 0) return err(`The file imports from elsewhere (${external.slice(0, 2).join(', ')}). Use a bundled build.`);
  return ok(new Blob([text], { type: 'text/javascript' }));
}

/** An address that makes a component depend on the network to run (flagged as an offline risk, 8.6). */
export function networkDependencies(sources: { html: string; css: string; js: string }): string[] {
  const found = new Set<string>();
  const add = (m: RegExpMatchArray) => found.add(m[1]);
  for (const m of sources.html.matchAll(/\b(?:src|href|data|poster)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) add(m);
  for (const m of sources.css.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)/gi)) add(m);
  for (const m of sources.css.matchAll(/@import\s+["'](https?:\/\/[^"']+)["']/gi)) add(m);
  for (const m of sources.js.matchAll(/\b(?:from|import)\s*\(?\s*["'](https?:\/\/[^"']+)["']/g)) add(m);
  for (const m of sources.js.matchAll(/\bfetch\(\s*["'](https?:\/\/[^"']+)["']/g)) add(m);
  return [...found];
}

/** Quick checks for the accessibility checklist of the code editor (8.8): hints, not proof. */
export function accessibilityHints(sources: { html: string; css: string; js: string }): string[] {
  const hints: string[] = [];
  if (/<img\b(?![^>]*\balt\s*=)[^>]*>/i.test(sources.html)) hints.push('An <img> has no alt attribute.');
  if (/<(?:div|span)\b[^>]*\bonclick\s*=/i.test(sources.html)) hints.push('A <div> or <span> has a click handler; use a <button> so it works with the keyboard.');
  if (/<button\b[^>]*>\s*<\/button>/i.test(sources.html)) hints.push('A <button> has no text; give it a label.');
  if (/<(?:input|select|textarea)\b(?![^>]*\b(?:aria-label|aria-labelledby|id)\s*=)[^>]*>/i.test(sources.html)) hints.push('A form control has no label or id to connect a label to.');
  if (/(?:@keyframes|animation\s*:|transition\s*:)/i.test(sources.css) && !/prefers-reduced-motion/i.test(sources.css)) hints.push('The CSS animates but does not check prefers-reduced-motion.');
  if (/outline\s*:\s*(?:none|0)\b/i.test(sources.css)) hints.push('The CSS removes the focus outline.');
  return hints;
}
