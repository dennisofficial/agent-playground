import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, sep } from 'node:path';
import { isReservedContainerPath, MAX_MOUNT_PATH_LEN } from '../sandbox/container-paths';


export class WorktreePathError extends Error {}

export function resolveExternalMountTarget(path: string): string {
  if (!path || !posix.isAbsolute(path)) {
    throw new WorktreePathError(`external mount must be an absolute container path: ${path}`);
  }
  if (path.length > MAX_MOUNT_PATH_LEN) {
    throw new WorktreePathError(`external mount path too long (> ${MAX_MOUNT_PATH_LEN}): ${path}`);
  }
  const norm = posix.normalize(path).replace(/\/+$/, '') || '/';
  if (norm.split('/').includes('..')) {
    throw new WorktreePathError(`unsafe external mount (traversal): ${path}`);
  }
  if (isReservedContainerPath(norm)) {
    throw new WorktreePathError(`external mount targets a reserved container path: ${path}`);
  }
  return norm;
}

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
