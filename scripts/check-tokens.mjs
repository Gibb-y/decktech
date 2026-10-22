// Guards the design tokens of docs/arc42/08-crosscutting-concepts.md §8.11. Run with `npm run lint:tokens`; exits 1 on any problem.
//   1. Colour literals: chrome code (everything under src/ except styles.css, specs and the deck / slide code below)
//      must take colours from the tokens. Files that still carry literals are listed in token-baseline.json; a file may
//      not gain literals, and a new file may not have any. Run with --update to write the baseline after removing some.
//   2. Contrast: every text / control colour pair of the light and the dark set reaches WCAG AA.
//   3. Dark set: the media-query copy and the `[data-theme='dark']` copy in styles.css are identical.
// No dependencies, so it also runs without `npm ci`.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Code whose colours belong to a deck or to slide rendering, not to the app chrome (paths relative to `src/`). */
export const EXEMPT = [
  'styles.css',
  'app/core/',
  'app/renderer/',
  'app/components/host/',
  'app/components/editor/builtin-components.ts',
  'app/editor/canvas/stress-deck.ts',
  'app/library/templates.ts',
  'app/dev-stress-page.ts',
];

const SCANNED = /\.(?:ts|css|html)$/;
const LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;

export function isChromeFile(path) {
  return SCANNED.test(path) && !path.endsWith('.spec.ts') && !EXEMPT.some((e) => (e.endsWith('/') ? path.startsWith(e) : path === e));
}

/** Number of colour literals per chrome file that has any. @param {{ path: string, text: string }[]} files paths relative to `src/` */
export function countLiterals(files) {
  const counts = {};
  for (const { path, text } of files) {
    if (!isChromeFile(path)) continue;
    const n = [...text.matchAll(LITERAL)].length;
    if (n > 0) counts[path] = n;
  }
  return counts;
}

/** @returns {string[]} messages for files that gained literals; `notes` for files that lost some. */
export function findLiteralViolations(counts, baseline) {
  const problems = [];
  const notes = [];
  for (const [path, n] of Object.entries(counts)) {
    const allowed = Object.hasOwn(baseline, path) ? baseline[path] : 0;
    if (n > allowed) problems.push(`${path}: ${n} colour literal(s), ${allowed} allowed; use a token from styles.css (var(--...))`);
  }
  for (const [path, allowed] of Object.entries(baseline)) {
    const n = Object.hasOwn(counts, path) ? counts[path] : 0;
    if (n < allowed) notes.push(`${path}: baseline ${allowed} can drop to ${n} (npm run lint:tokens -- --update)`);
  }
  return { problems, notes };
}

// ---- styles.css ----

/** Declarations (`--name: value;`) of the first rule that starts with `selector`, brace-matched. */
export function declarations(source, selector, from = 0) {
  const start = source.indexOf(selector + ' {', from);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  let depth = 0;
  let body = '';
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{' && depth++ === 0) continue;
    if (c === '}' && --depth === 0) break;
    body += c;
  }
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

export function tokenSets(css) {
  const light = declarations(css, ':root');
  const darkMedia = declarations(css, ":root:not([data-theme='light'])");
  const darkAttribute = declarations(css, ":root[data-theme='dark']");
  return { light, darkMedia, darkAttribute, dark: { ...light, ...darkAttribute } };
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio (the same formula as core/model/contrast.ts, which `scripts/` cannot import). */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['--surface', '--surface-raised', '--surface-sunken', '--surface-hover', '--surface-active'];

/** [foreground, background, minimum]: 4.5 for text, 3 for focus rings and the edge of a control. */
export const PAIRS = [
  ...SURFACES.flatMap((s) => [
    ['--text', s, 4.5],
    ['--text-muted', s, 4.5],
    ['--accent-ink', s, 4.5],
    ['--danger-ink', s, 4.5],
    ['--focus', s, 3],
    ['--border-control', s, 3],
  ]),
  ['--accent-text', '--accent', 4.5],
  ['--accent-text', '--accent-hover', 4.5],
  ['--accent-text', '--accent-active', 4.5],
  ['--danger-text', '--danger', 4.5],
  ['--danger-text', '--danger-hover', 4.5],
  ['--text', '--accent-subtle', 4.5],
  ['--accent-ink', '--accent-subtle', 4.5],
  ['--text', '--danger-subtle', 4.5],
  ['--danger-ink', '--danger-subtle', 4.5],
  ['--text', '--warning-subtle', 4.5],
  ['--warning-ink', '--warning-subtle', 4.5],
  ['--text', '--success-subtle', 4.5],
  ['--success-ink', '--success-subtle', 4.5],
];

export function findContrastFailures(tokens, pairs = PAIRS) {
  return pairs.flatMap(([fg, bg, min]) => {
    for (const name of [fg, bg]) if (!Object.hasOwn(tokens, name)) return [`${name} is not defined`];
    const ratio = contrast(tokens[fg], tokens[bg]);
    return ratio >= min ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)}:1, needs ${min}:1`];
  });
}

export function findCssProblems(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const problems = [];
  const { light, dark, darkMedia, darkAttribute } = tokenSets(css);
  for (const name of Object.keys(darkAttribute)) {
    if (!Object.hasOwn(light, name)) problems.push(`dark set overrides ${name}, which the light set does not define`);
  }
  for (const name of new Set([...Object.keys(darkMedia), ...Object.keys(darkAttribute)])) {
    if (darkMedia[name] !== darkAttribute[name]) problems.push(`dark copies differ for ${name}: "${darkMedia[name]}" vs "${darkAttribute[name]}"`);
  }
  for (const [mode, tokens] of [['light', light], ['dark', dark]]) {
    for (const f of findContrastFailures(tokens)) problems.push(`${mode}: ${f}`);
  }
  for (const name of ['--control-height', '--control-height-sm', '--control-height-lg']) {
    if (!(parseFloat(light[name]) * 16 >= 24)) problems.push(`${name} is below the 24px minimum target size`);
  }
  const reduced = declarations(css, ':root', css.indexOf('@media (prefers-reduced-motion'));
  for (const name of ['--duration-fast', '--duration-base', '--duration-slow']) {
    if (reduced[name] !== '0ms') problems.push(`${name} is not 0ms under prefers-reduced-motion`);
  }
  if (declarations(css, ':root:root:root', css.indexOf('@media (forced-colors'))['--focus'] !== 'Highlight') problems.push('forced-colors mode must set --focus: Highlight');
  if (!/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/.test(css)) problems.push('the :focus-visible rule must draw a 2px outline in var(--focus)');
  return problems;
}

/**
 * `var(--name)` references in `text` that no token defines. `local` names are custom properties a component
 * sets itself and are skipped; `--deck-*` belongs to the slide stage (arc42 8.11).
 */
export function findUnknownTokens(text, defined, local = []) {
  const unknown = new Set();
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!defined.has(m[1]) && !local.includes(m[1]) && !m[1].startsWith('--deck-')) unknown.add(m[1]);
  }
  return [...unknown];
}

// ---- CLI ----

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else out.push(full);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = resolve(HERE, '..', 'src');
  const baselinePath = join(HERE, 'token-baseline.json');
  const files = collect(src).map((full) => ({ path: relative(src, full).split(sep).join('/'), text: readFileSync(full, 'utf8') }));
  const counts = countLiterals(files);
  if (process.argv.includes('--update')) {
    writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + '\n');
    console.log(`Baseline written: ${Object.keys(counts).length} file(s).`);
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const { problems: literal, notes } = findLiteralViolations(counts, baseline);
  const tokensCss = readFileSync(join(src, 'styles.css'), 'utf8');
  const defined = new Set(Object.keys(tokenSets(tokensCss.replace(/\/\*[\s\S]*?\*\//g, '')).light));
  // The primitives (ui.css and shared/) may only use tokens that exist.
  const unknown = files
    .filter((f) => f.path === 'ui.css' || f.path.startsWith('app/shared/'))
    .flatMap((f) => findUnknownTokens(f.text, defined).map((name) => `${f.path}: var(${name}) is not a token in styles.css`));
  const problems = [...literal, ...unknown, ...findCssProblems(tokensCss)];
  for (const n of notes) console.log(`note: ${n}`);
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`${problems.length} design token problem(s)`);
    process.exit(1);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Design tokens hold: ${total} legacy colour literal(s) in ${Object.keys(counts).length} file(s), none new.`);
}
