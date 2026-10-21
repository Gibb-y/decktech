// Enforces the dependency rule of docs/arc42/04-solution-strategy.md §4.4. Run with
// `npm run lint:boundaries`; It exits 1 on any violation. It has no dependencies, so it also runs without `npm ci`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Top-level folder of `src/app` -> the other folders it may import from. Files directly in `src/app` are unrestricted. */
export const ALLOWED = {
  core: [],
  renderer: ['core'],
  editor: ['renderer', 'core', 'shared'],
  presenter: ['renderer', 'core', 'shared'],
  components: ['renderer', 'core', 'shared'],
  library: ['core', 'shared'],
  shared: [],
};

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*|\.{1,2})\1/g;

/** Folder of `src/app` that `path` (relative to it, with `/`) belongs to, or `null` for app-level files. */
function folderOf(path) {
  const [first, ...rest] = path.split('/');
  return rest.length > 0 ? first : null;
}

/** @param {{ path: string, text: string }[]} files paths relative to `src/app`, with `/` */
export function findViolations(files) {
  const violations = [];
  for (const { path, text } of files) {
    const from = folderOf(path);
    if (from === null) continue;
    if (!(from in ALLOWED)) {
      violations.push({ file: path, line: 1, message: `unknown top-level folder "${from}"; add it to ALLOWED` });
      continue;
    }
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(IMPORT)) {
        const target = join(dirname(path), match[2]).split(sep).join('/');
        if (target.startsWith('..')) {
          violations.push({ file: path, line: index + 1, message: `import "${match[2]}" leaves src/app` });
          continue;
        }
        const to = folderOf(target + '/x');
        if (to === null || to === from || ALLOWED[from].includes(to)) continue;
        violations.push({
          file: path,
          line: index + 1,
          message: `"${from}" must not import from "${to}" (${match[2]}); allowed: ${ALLOWED[from].join(', ') || 'nothing'}`,
        });
      }
    });
  }
  return violations;
}

/** The rich text editor (ProseMirror) lives in one lazy chunk (arc42 §8.4): only these files may import it. */
const EDITOR_CHUNK = ['editor/text/rich-editor.ts', 'editor/text/rich-schema.ts'];
// Any way of pulling a module in: `from '...'` (also across lines), `import '...'`, `import('...')`.
const PROSEMIRROR = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])prosemirror-/g;
const STATIC_CHUNK_IMPORT = /\bimport\b[^;()]*?\bfrom\s*(['"])(?:\.{1,2}\/)+(?:text\/)?rich-(?:editor|schema)\1|\bimport\s*(['"])(?:\.{1,2}\/)+(?:text\/)?rich-(?:editor|schema)\2/g;

/** @param {{ path: string, text: string }[]} files */
export function findChunkViolations(files) {
  const violations = [];
  for (const { path, text } of files) {
    if (path.endsWith('.spec.ts') || EDITOR_CHUNK.includes(path)) continue;
    const lineOf = (index) => text.slice(0, index).split('\n').length;
    for (const m of text.matchAll(PROSEMIRROR)) {
      violations.push({ file: path, line: lineOf(m.index), message: 'ProseMirror may only be imported by the lazy editor chunk (editor/text/rich-editor.ts, rich-schema.ts)' });
    }
    for (const m of text.matchAll(STATIC_CHUNK_IMPORT)) {
      violations.push({ file: path, line: lineOf(m.index), message: 'the editor chunk must be loaded with import(), not a static import' });
    }
  }
  return violations;
}

/**
 * CodeMirror lives in the lazy chunk of the code tools (ADR-005): only `code-mirror.ts` may import
 * it, and the chunk's entry points are loaded with import(), never statically from outside the folder.
 */
const CODEMIRROR_FILE = 'components/editor/code-mirror.ts';
const CODEMIRROR = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])@codemirror\//g;
const TOOLS_CHUNK = /\bimport\b[^;()]*?\bfrom\s*(['"])(?:\.{1,2}\/)+(?:editor\/)?(?:component-tools|code-editor-dialog|library-dialog|code-mirror)\1|\bimport\s*(['"])(?:\.{1,2}\/)+(?:editor\/)?(?:component-tools|code-editor-dialog|library-dialog|code-mirror)\2/g;

/** @param {{ path: string, text: string }[]} files */
export function findCodeMirrorViolations(files) {
  const violations = [];
  for (const { path, text } of files) {
    if (path.endsWith('.spec.ts')) continue;
    const lineOf = (index) => text.slice(0, index).split('\n').length;
    if (path !== CODEMIRROR_FILE) {
      for (const m of text.matchAll(CODEMIRROR)) {
        violations.push({ file: path, line: lineOf(m.index), message: 'CodeMirror may only be imported by components/editor/code-mirror.ts' });
      }
    }
    if (!path.startsWith('components/editor/')) {
      for (const m of text.matchAll(TOOLS_CHUNK)) {
        violations.push({ file: path, line: lineOf(m.index), message: 'the code tools chunk must be loaded with import(), not a static import' });
      }
    }
  }
  return violations;
}

/** The sandbox policy of code components lives in one file (arc42 §8.2, risk R1). */
const SANDBOX_FILE = 'components/host/sandbox.ts';
const FORBIDDEN_FLAGS = /allow-(?:same-origin|top-navigation[\w-]*|popups[\w-]*|forms|modals|downloads|presentation|pointer-lock|orientation-lock)/g;
const IFRAME = /createElement\(\s*['"]iframe['"]\s*\)|<iframe\b|['"]sandbox['"]\s*,/g;

/**
 * No source may name a dangerous sandbox flag, and frames are only created in `sandbox.ts`, so the
 * one list there is the only way to get one. The deny-list in `sandbox.ts` itself is the exception.
 * @param {{ path: string, text: string }[]} files
 */
export function findSandboxViolations(files) {
  const violations = [];
  for (const { path, text } of files) {
    if (path.endsWith('.spec.ts')) continue;
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    const scanned = path === SANDBOX_FILE ? text.replace(/FORBIDDEN_SANDBOX_TOKENS[^=]*=\s*\[[^\]]*\];/, blank) : text;
    const lineOf = (index) => scanned.slice(0, index).split('\n').length;
    for (const m of scanned.matchAll(FORBIDDEN_FLAGS)) {
      violations.push({ file: path, line: lineOf(m.index), message: `sandbox flag "${m[0]}" must never be used for code components` });
    }
    if (path !== SANDBOX_FILE) {
      for (const m of scanned.matchAll(IFRAME)) {
        violations.push({ file: path, line: lineOf(m.index), message: 'frames are created by createSandboxFrame (components/host/sandbox.ts) only' });
      }
    }
  }
  return violations;
}

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.html')) out.push(full);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');
  const files = collect(root).map((full) => ({
    path: relative(root, full).split(sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
  const ts = files.filter((f) => f.path.endsWith('.ts'));
  const violations = [...findViolations(ts), ...findChunkViolations(ts), ...findCodeMirrorViolations(ts), ...findSandboxViolations(files)];
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.message}`);
  if (violations.length > 0) {
    console.error(`${violations.length} dependency rule violation(s)`);
    process.exit(1);
  }
  console.log(`Dependency rule holds for ${files.length} files.`);
}
