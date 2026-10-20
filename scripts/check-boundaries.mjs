// Enforces the dependency rule of docs/arc42/04-solution-strategy.md §4.4. Run with
// `npm run lint:boundaries`; CI fails on any violation. No dependencies, so it runs before `npm ci` is trusted.
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

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');
  const files = collect(root).map((full) => ({
    path: relative(root, full).split(sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));
  const violations = findViolations(files);
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.message}`);
  if (violations.length > 0) {
    console.error(`${violations.length} dependency rule violation(s)`);
    process.exit(1);
  }
  console.log(`Dependency rule holds for ${files.length} files.`);
}
