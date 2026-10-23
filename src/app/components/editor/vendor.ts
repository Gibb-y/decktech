import { err, ok, type Result } from '../../core/model';

/** Largest library file that is vendored into a deck. */
export const MAX_LIBRARY_BYTES = 5 * 1024 * 1024;

/** Valid npm package name (optionally scoped); also what keeps the fetched address on the CDN's host. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
/** One segment of a subpath inside a package (`client` in `react-dom/client`). */
const SUBPATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** Splits `react-dom/client` or `@scope/pkg/sub/path` into the package and its subpath (`/client`, or empty). */
function splitPackage(name: string): { pkg: string; sub: string } | undefined {
  const parts = name.split('/');
  const pkg = parts.slice(0, name.startsWith('@') ? 2 : 1).join('/');
  const rest = parts.slice(name.startsWith('@') ? 2 : 1);
  if (!PACKAGE.test(pkg) || pkg.includes('..')) return undefined;
  if (!rest.every((s) => SUBPATH_SEGMENT.test(s) && !s.includes('..'))) return undefined;
  return { pkg, sub: rest.map((s) => `/${s}`).join('') };
}

/** Whether `name` can stand for a library: an npm package name, with an optional subpath (`react-dom/client`). */
export const isLibraryName = (name: string): boolean => splitPackage(name) !== undefined;

/**
 * The CDN address of a self-contained ES module build of `name@version` (esm.sh with `bundle`, which
 * inlines the dependencies; jsDelivr's `+esm` build imports its dependencies from the CDN and would
 * not work offline). `name` may carry a subpath (`react-dom/client`). The name and version are
 * checked, so the address cannot leave that host or path.
 */
export function cdnUrl(name: string, version: string): Result<string, string> {
  const split = splitPackage(name.trim());
  const ver = version.trim() || 'latest';
  if (!split) return err(`"${name}" is not a valid npm package name`);
  if (!VERSION.test(ver)) return err(`"${version}" is not a valid version`);
  return ok(`https://esm.sh/${split.pkg}@${encodeURIComponent(ver)}${split.sub}?bundle&target=es2022`);
}

/**
 * Whether the module text still imports from somewhere else (a bare or absolute address, not data
 * or blob): a library like that would reach the network when the deck runs, which the sandbox
 * blocks, so vendoring it would silently produce a library that fails offline.
 */
export function externalImports(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) for (const m of source.matchAll(pattern)) found.add(m[2]);
  return [...found].filter((spec) => /^(?:https?:)?\/\//.test(spec) || spec.startsWith('/'));
}

/** Every place a module names another one (`export * from` ends in `from` too); group 1 precedes the specifier. */
const IMPORT_PATTERNS = [/(\bfrom\s*["'])([^"']+)(?=["'])/g, /(\bimport\s*["'])([^"']+)(?=["'])/g, /(\bimport\(\s*["'])([^"']+)(?=["']\s*\))/g];

/**
 * The library a CDN path such as `/react@19.3.1/es2022/react.mjs` stands for, if one is among `peers`
 * (library name -> specifier to import it by). A file named like the package is the package itself;
 * any other file is a subpath (`/react@19.3.1/es2022/jsx-runtime.mjs` is `react/jsx-runtime`).
 */
export function peerFor(path: string, peers: ReadonlyMap<string, string>): string | undefined {
  const m = /^\/(?:v\d+\/|stable\/)?((?:@[^/@]+\/)?[^/@]+)(?:@[^/]+)?\/(?:[A-Za-z0-9_-]+\/)?([^/]+?)(?:\.m?js)?$/.exec(path);
  if (!m) return undefined;
  const last = m[1].slice(m[1].lastIndexOf('/') + 1);
  return peers.get(m[2] === last ? m[1] : `${m[1]}/${m[2]}`);
}

/**
 * Replaces the CDN paths a bundle imports with the specifier of a library that is already vendored
 * (`peers`), so both share one instance (two copies of React break hooks). Other imports stay.
 */
export function resolvePeers(source: string, peers: ReadonlyMap<string, string>): string {
  if (peers.size === 0) return source;
  let text = source;
  for (const pattern of IMPORT_PATTERNS) {
    text = text.replace(pattern, (whole, head: string, spec: string) => {
      const peer = spec.startsWith('/') && !spec.startsWith('//') ? peerFor(spec, peers) : undefined;
      return peer === undefined ? whole : head + peer;
    });
  }
  return text;
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; blob(): Promise<Blob> }>;

/** A root-relative module path on the CDN (the stub of a package re-exports its bundle from one); `//host` is not one. */
const CDN_PATH = /^\/[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._~+-]+)*$/;

async function download(url: string, fetcher: Fetcher): Promise<Result<string, string>> {
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await fetcher(url);
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
  return ok(text);
}

/** A vendored library: the module text ready for the asset store, its label and the CDN imports that were pointed at libraries already vendored. */
export interface FetchedLibrary {
  blob: Blob;
  label: string;
  /** CDN paths in the bundle that now import a library from `peers` instead (they share one instance). */
  shared: string[];
}

/**
 * Fetches a library from the CDN once, while online, as a JavaScript blob ready for `putAsset`.
 * Imports of a package that is among `peers` (name -> specifier, see `resolvePeers`) are pointed at
 * that library. Refuses a response that is not JavaScript, is too large, or still imports from elsewhere.
 */
export async function fetchLibrary(name: string, version: string, fetcher: Fetcher, peers: ReadonlyMap<string, string> = new Map()): Promise<Result<FetchedLibrary, string>> {
  const url = cdnUrl(name, version);
  if (!url.ok) return url;
  const first = await download(url.value, fetcher);
  if (!first.ok) return first;
  let text = first.value;
  // The address of a package answers with a stub that re-exports one bundle file from a path on the
  // same CDN. Follow that once, to a path on the same host, and keep the bundle. Imports of a peer
  // do not count: the stub of `react-dom/client` names `react` next to its bundle.
  const stub = externalImports(text).filter((spec) => peerFor(spec, peers) === undefined);
  if (stub.length === 1 && CDN_PATH.test(stub[0])) {
    const bundle = await download(new URL(stub[0], url.value).href, fetcher);
    if (!bundle.ok) return bundle;
    text = bundle.value;
  }
  const before = externalImports(text);
  text = resolvePeers(text, peers);
  const external = externalImports(text);
  if (external.length > 0) {
    const unresolved = external.slice(0, 2).join(', ');
    return err(`The library imports from the network (${unresolved}) and would not work offline. If it depends on another library (a package such as react), add that one first so this one can share it; otherwise download a bundled build and add it from a file.`);
  }
  return ok({ blob: new Blob([text], { type: 'text/javascript' }), label: `${name.trim()}@${version.trim() || 'latest'}`, shared: before.filter((spec) => !external.includes(spec)) });
}

/** Checks the text of a library file: self-contained once the imports of `peers` are resolved. Resolves to the text to store. */
export function checkLibraryText(text: string, peers: ReadonlyMap<string, string> = new Map()): Result<string, string> {
  const resolved = resolvePeers(text, peers);
  const external = externalImports(resolved);
  if (external.length > 0) return err(`The file imports from elsewhere (${external.slice(0, 2).join(', ')}). Use a bundled build.`);
  return ok(resolved);
}

/** Checks a library file picked from disk: JavaScript, small, self-contained. Resolves to a blob typed for the asset store. */
export async function readLibraryFile(file: File): Promise<Result<Blob, string>> {
  if (file.size > MAX_LIBRARY_BYTES) return err('The file is larger than 5 MiB');
  if (!/\.(?:m?js)$/i.test(file.name)) return err('Choose a JavaScript module file (.js or .mjs)');
  const checked = checkLibraryText(await file.text());
  return checked.ok ? ok(new Blob([checked.value], { type: 'text/javascript' })) : checked;
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
