import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

/**
 * Path SAFETY for the worktree hydrator + mount wiring. The manifest is attacker-controllable (committed
 * in a tenant repo), and Docker binds + file writes derived from it must never escape the worktree
 * (target) or the org-scoped source root (golden seed). Every check here is value-driven; no raw manifest
 * string is ever used to build a path without passing through this guard.
 *
 * Targets may not exist yet (secret files, seed destinations, mountpoint leaves), so we realpath the
 * EXISTING ancestor chain (rejecting any symlink component) and allow a nonexistent leaf. Sources must
 * exist and are realpath'd whole.
 */

export class WorktreePathError extends Error {}

function rejectLexical(relPath: string): string[] {
  if (!relPath || isAbsolute(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new WorktreePathError(`unsafe path (absolute/empty): ${relPath}`);
  }
  const segs = relPath.split(/[\\/]+/);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new WorktreePathError(`unsafe path (traversal): ${relPath}`);
  }
  return segs;
}

/**
 * Resolve a worktree-relative TARGET to an absolute path, allowing a nonexistent leaf. Rejects traversal,
 * absolute paths, and any symlink in the existing portion of the chain. Returns the absolute path to
 * create/write (its parent dirs may need creating by the caller).
 */
export function resolveSafeTarget(worktreePath: string, relPath: string): string {
  const segs = rejectLexical(relPath);
  const realRoot = realpathSync(worktreePath);
  let cur = realRoot;
  let stillExists = true;
  for (const seg of segs) {
    const candidate = join(cur, seg);
    if (stillExists && existsSync(candidate)) {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new WorktreePathError(`unsafe path (symlink component): ${candidate}`);
      }
      cur = candidate;
    } else {
      stillExists = false;
      cur = candidate;
    }
  }
  if (cur !== realRoot && !cur.startsWith(realRoot + sep)) {
    throw new WorktreePathError(`path escapes worktree: ${relPath}`);
  }
  return cur;
}

/**
 * Resolve a SOURCE path (golden seed) under `sourceRoot`. Must EXIST; realpath'd whole and asserted
 * inside the realpath'd source root (so a symlink can't point outside the org-scoped golden dir).
 */
export function resolveSafeSource(sourceRoot: string, relPath: string): string {
  rejectLexical(relPath);
  const realRoot = realpathSync(sourceRoot);
  const abs = realpathSync(join(realRoot, relPath));
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) {
    throw new WorktreePathError(`source escapes golden root: ${relPath}`);
  }
  return abs;
}
