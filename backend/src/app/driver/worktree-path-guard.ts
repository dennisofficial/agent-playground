import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, sep } from 'node:path';
import {
  isReservedContainerPath,
  MAX_MOUNT_PATH_LEN,
} from '../sandbox/container-paths';

/**
 * Path SAFETY for the worktree hydrator + mount wiring. The manifest is attacker-controllable (committed
 * in a tenant repo), and Docker binds + file writes derived from it must never escape the worktree
 * (target). Every check here is value-driven; no raw manifest string is ever used to build a path without
 * passing through this guard.
 *
 * Targets may not exist yet (secret files, mountpoint leaves), so we realpath the EXISTING ancestor chain
 * (rejecting any symlink component) and allow a nonexistent leaf.
 */

export class WorktreePathError extends Error {}

/**
 * Validate an EXTERNAL mount target — an ABSOLUTE container path (e.g. `/root/.config/gcloud`) bound outside
 * `/workspace`. Purely lexical (the container path need not exist on the host): require absolute, POSIX-
 * normalize, reject `..` segments, over-length, and any {@link isReservedContainerPath} hit (a system bind
 * or OS root). Returns the normalized absolute path. The HOST side of the bind is a managed org/repo cache
 * dir chosen by the manager — this guards only WHERE in the container it lands.
 */
export function resolveExternalMountTarget(path: string): string {
  if (!path || !posix.isAbsolute(path)) {
    throw new WorktreePathError(
      `external mount must be an absolute container path: ${path}`,
    );
  }
  if (path.length > MAX_MOUNT_PATH_LEN) {
    throw new WorktreePathError(
      `external mount path too long (> ${MAX_MOUNT_PATH_LEN}): ${path}`,
    );
  }
  const norm = posix.normalize(path).replace(/\/+$/, '') || '/';
  if (norm.split('/').includes('..')) {
    throw new WorktreePathError(`unsafe external mount (traversal): ${path}`);
  }
  if (isReservedContainerPath(norm)) {
    throw new WorktreePathError(
      `external mount targets a reserved container path: ${path}`,
    );
  }
  return norm;
}

function rejectLexical(relPath: string): string[] {
  if (
    !relPath ||
    isAbsolute(relPath) ||
    relPath.startsWith('/') ||
    relPath.startsWith('\\')
  ) {
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
export function resolveSafeTarget(
  worktreePath: string,
  relPath: string,
): string {
  const segs = rejectLexical(relPath);
  const realRoot = realpathSync(worktreePath);
  let cur = realRoot;
  let stillExists = true;
  for (const seg of segs) {
    const candidate = join(cur, seg);
    if (stillExists && existsSync(candidate)) {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new WorktreePathError(
          `unsafe path (symlink component): ${candidate}`,
        );
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
