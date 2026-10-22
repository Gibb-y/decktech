import type { ComponentDef, Deck } from '../../core/model';

export type FlagKind = 'permission' | 'eval' | 'dynamic-import' | 'external-url' | 'network-api' | 'minified';

/** Something worth a closer look in a component. A hint for the reader, never a verdict (ADR-008). */
export interface TrustFlag {
  kind: FlagKind;
  /** One line for the dialog. */
  text: string;
}

export interface LibraryInfo {
  /** The asset id, which is also the SHA-256 digest of the file. */
  id: string;
  size: number;
  mime: string;
  /** The digest matches a library the app bundles or one the user trusted before. */
  known: boolean;
}

export interface FileInfo {
  id: string;
  size: number;
  mime: string;
}

export interface ComponentReport {
  id: string;
  name: string;
  /** 1-based numbers of the slides that use the component. */
  slides: number[];
  permissions: string[];
  libs: LibraryInfo[];
  files: FileInfo[];
  /** Characters of HTML, CSS and JavaScript together. */
  size: number;
  flags: TrustFlag[];
}

export interface TrustReport {
  components: ComponentReport[];
}

/** Library releases that ship with the app, by SHA-256 digest. None are bundled yet; trusted decks add to the known set. */
export const BUNDLED_LIBRARIES: ReadonlyMap<string, string> = new Map();

const URL_PATTERN = /(?:(?:https?|wss?):)?\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?(?:\/[^\s"'`)<>\\]*)?|(?:https?|wss?):\/\/[^\s"'`)<>\\]+/gi;
const MAX_URLS = 5;
/** A line this long, or a file of this size on one or two lines, is not meant to be read by a person. */
const LONG_LINE = 500;
const SINGLE_LINE_FILE = 2000;

function externalUrls(def: ComponentDef): string[] {
  const found = new Set<string>();
  for (const source of [def.html, def.css, def.js]) {
    for (const match of source.matchAll(URL_PATTERN)) {
      // `//` also starts a comment and `://` a scheme already matched above; a bare "//host" in code is rare enough to flag.
      found.add(match[0]);
      if (found.size >= MAX_URLS + 1) return [...found];
    }
  }
  return [...found];
}

function looksMinified(source: string): boolean {
  if (source.length <= LONG_LINE) return false;
  const lines = source.split('\n');
  return lines.some((line) => line.length > LONG_LINE) || (source.length > SINGLE_LINE_FILE && lines.length <= 2);
}

export function flagsOf(def: ComponentDef): TrustFlag[] {
  const flags: TrustFlag[] = [];
  for (const permission of def.permissions) {
    flags.push({
      kind: 'permission',
      text: permission === 'network' ? 'Asks for the network permission (it stays blocked: no address is allowed).' : `Asks for the ${permission} permission.`,
    });
  }
  const js = def.js;
  if (/\beval\s*\(|\bnew\s+Function\b|(?<![.\w])Function\s*\(/.test(js)) flags.push({ kind: 'eval', text: 'Builds code from text (eval or new Function).' });
  if (/\bimport\s*\(/.test(js)) flags.push({ kind: 'dynamic-import', text: 'Loads modules while it runs (import()).' });
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\bEventSource\b/.test(js)) flags.push({ kind: 'network-api', text: 'Uses a network API (fetch, XMLHttpRequest, WebSocket…).' });
  const urls = externalUrls(def);
  if (urls.length > 0) {
    const shown = urls.slice(0, MAX_URLS).join(', ');
    flags.push({ kind: 'external-url', text: `Mentions web addresses: ${shown}${urls.length > MAX_URLS ? ', …' : ''}` });
  }
  const minified = (['html', 'css', 'js'] as const).filter((key) => looksMinified(def[key]));
  if (minified.length > 0) flags.push({ kind: 'minified', text: `Has very long lines (${minified.map((k) => k.toUpperCase()).join(', ')}); it may be minified. Use "Format" to read it.` });
  return flags;
}

/**
 * What the trust dialog shows about a deck's code components. `knownHashes` are digests of library
 * files seen in decks the user trusted before. Pure: it reads the deck, nothing is run or fetched.
 */
export function analyzeDeck(deck: Deck, knownHashes: ReadonlySet<string> = new Set()): TrustReport {
  const slidesOf = new Map<string, Set<number>>();
  deck.slides.forEach((slide, index) => {
    for (const element of slide.elements) {
      if (element.type !== 'code') continue;
      const set = slidesOf.get(element.componentId) ?? new Set<number>();
      set.add(index + 1);
      slidesOf.set(element.componentId, set);
    }
  });
  const known = (id: string) => BUNDLED_LIBRARIES.has(id) || knownHashes.has(id);
  // Own properties only: an id such as "constructor" must not find something on Object.prototype.
  const asset = (id: string) => (Object.hasOwn(deck.assets, id) ? deck.assets[id] : undefined);
  const info = (id: string) => ({ id, size: asset(id)?.size ?? 0, mime: asset(id)?.mime ?? 'unknown' });
  return {
    components: deck.components.map((def) => ({
      id: def.id,
      name: def.name,
      slides: [...(slidesOf.get(def.id) ?? [])].sort((a, b) => a - b),
      permissions: [...def.permissions],
      libs: def.libs.map((id) => ({ ...info(id), known: known(id) })),
      files: def.files.map(info),
      size: def.html.length + def.css.length + def.js.length,
      flags: flagsOf(def),
    })),
  };
}
