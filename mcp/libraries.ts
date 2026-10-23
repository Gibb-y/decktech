import { parse } from 'acorn';
import type { ComponentDef } from '../src/app/core/model';
import { MAX_LIBRARY_BYTES, type Fetcher } from '../src/app/components/editor/vendor';
import type { DeckSession } from './workspace';

const ASSET_ID = /^[0-9a-f]{64}$/;

interface Specifier {
  value: string;
  /** Offsets of the string literal, quotes included. */
  start: number;
  end: number;
}

/** The module specifiers a script names (static imports, re-exports and `import()` with a literal), or `undefined` if it does not parse. */
export function importSpecifiers(js: string): Specifier[] | undefined {
  let ast: unknown;
  try {
    ast = parse(js, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
  } catch {
    return undefined;
  }
  const found: Specifier[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as { type?: string; source?: unknown } & Record<string, unknown>;
    if (
      n.type === 'ImportDeclaration' ||
      n.type === 'ExportNamedDeclaration' ||
      n.type === 'ExportAllDeclaration' ||
      n.type === 'ImportExpression'
    ) {
      const s = n.source as { type?: string; value?: unknown; start: number; end: number } | null;
      if (s?.type === 'Literal' && typeof s.value === 'string')
        found.push({ value: s.value, start: s.start, end: s.end });
    }
    for (const key of Object.keys(n)) if (key !== 'type') visit(n[key]);
  };
  visit(ast);
  return found.sort((a, b) => a.start - b.start);
}

/**
 * How the libraries of a component can be named in its script: by package name (`react`) or by
 * name and version (`react@19.3.1`), each resolving to the asset id the runtime's import map is
 * keyed by. A name that two attached libraries share is ambiguous and resolves to nothing.
 */
export function specifierNames(
  session: Pick<DeckSession, 'libraries'>,
  ids: readonly string[],
): { names: Map<string, string>; ambiguous: Set<string> } {
  const names = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const id of ids) {
    const lib = session.libraries.get(id);
    if (!lib) continue;
    for (const key of new Set([lib.name, lib.label])) {
      if (names.has(key) && names.get(key) !== id) ambiguous.add(key);
      names.set(key, id);
    }
  }
  for (const key of ambiguous) names.delete(key);
  return { names, ambiguous };
}

/** Replaces specifiers that name an attached library by the asset id the runtime resolves. Other specifiers stay. */
export function resolveSpecifiers(js: string, names: ReadonlyMap<string, string>): { js: string; rewritten: Record<string, string> } {
  const rewritten: Record<string, string> = {};
  if (names.size === 0) return { js, rewritten };
  const specifiers = importSpecifiers(js) ?? [];
  let out = js;
  for (const s of specifiers.filter((s) => names.has(s.value)).reverse()) {
    const id = names.get(s.value)!;
    out = out.slice(0, s.start) + JSON.stringify(id) + out.slice(s.end);
    rewritten[s.value] = id;
  }
  return { js: out, rewritten };
}

/**
 * Problems with the libraries a script imports, as sentences for the agent. The sandbox resolves a
 * specifier only if it is the asset id of a library in `def.libs`; anything else fails to load, and
 * the frame then reports only that the script could not be loaded.
 */
export function importProblems(
  def: Pick<ComponentDef, 'js' | 'libs'>,
  session: Pick<DeckSession, 'libraries'>,
  assetIds: ReadonlySet<string>,
): string[] {
  const specifiers = importSpecifiers(def.js);
  const problems: string[] = [];
  const { ambiguous } = specifierNames(session, def.libs);
  const known = def.libs.map((id) => `${session.libraries.get(id)?.name ?? id.slice(0, 12)} (${id.slice(0, 12)}…)`).join(', ') || 'none';
  const seen = new Set<string>();
  for (const { value } of specifiers ?? []) {
    if (seen.has(value)) continue;
    seen.add(value);
    if (ASSET_ID.test(value)) {
      if (def.libs.includes(value)) continue;
      problems.push(
        assetIds.has(value)
          ? `The script imports "${value}", an asset of the deck that is not in this component's libs; add it to libs.`
          : `The script imports "${value}", which is not a library of this deck (add one with add_library_from_package or add_library_from_file).`,
      );
    } else if (ambiguous.has(value)) {
      problems.push(`The script imports "${value}", but two attached libraries have that name; import one by its asset id.`);
    } else if (/^(?:[a-z]+:)?\/\/|^[./]/.test(value)) {
      problems.push(`The script imports "${value}", which cannot load: the sandbox has no network and no other files. Vendor the library and import it by name.`);
    } else {
      problems.push(`The script imports "${value}", which is not an attached library, so the sandbox cannot resolve it. Attached libraries: ${known}. Add one with add_library_from_package or add_library_from_file and list it in libs.`);
    }
  }
  return problems;
}

/**
 * Downloads for `add_library_from_package`: only from the CDN host (a redirect elsewhere is
 * refused), with a timeout, and the body is read only up to the library limit, so a reply of
 * unknown length cannot fill memory. This is the only place the server reaches the network; the
 * sandbox keeps `connect-src 'none'`.
 */
export const cdnFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30_000) });
  if (new URL(response.url).hostname !== new URL(url).hostname) {
    await response.body?.cancel();
    throw new Error('The CDN redirected to another host');
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    async blob() {
      const parts: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      while (reader && size <= MAX_LIBRARY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.length;
      }
      await reader?.cancel();
      return new Blob(parts as BlobPart[]);
    },
  };
};
