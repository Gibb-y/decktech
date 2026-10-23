import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ToolError } from './tool';

/** Nearest ancestor of `path` that exists (as written, links not followed). */
function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Resolves a path given by the agent. Relative paths start at `root`; the result must stay inside
 * `root` once symbolic links are followed, so an agent can neither read nor write elsewhere on disk.
 */
export function resolveInside(root: string, path: string): string {
  if (path.includes('\0')) throw new ToolError('The path contains a null character');
  const base = realpathSync(root);
  const full = resolve(base, path);
  // A file that does not exist yet is judged by where its nearest existing folder really is.
  // A link whose target is missing looks absent to existsSync but would be followed by a write.
  if (!existsSync(full) && lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new ToolError(
      `"${path}" is a link that points nowhere; choose a path that is not a link`,
    );
  }
  const ancestor = existingAncestor(full);
  const real = resolve(realpathSync(ancestor), relative(ancestor, full));
  const rel = relative(base, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(
      `The path "${path}" is outside the workspace folder (${root}). Use a path inside it.`,
    );
  }
  return full;
}
