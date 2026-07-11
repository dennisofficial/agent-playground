import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Resolve `relOrAbs` against `root` and assert the result stays INSIDE `root` — the one gate every
 * mcp-reader filesystem read passes through (context dir, worktree tree/file). Defensively rejects any
 * `..` segment before resolving (belt-and-suspenders against a clever combination that `path.resolve`
 * would otherwise silently collapse into an escape), then re-checks the REAL (symlink-resolved) path
 * against `root` so a symlink planted inside the jail can't point back out of it. `fs.realpathSync`
 * requires the path to exist; when it doesn't (e.g. listing a not-yet-created dir) we fall back to the
 * resolved-but-unreal path, still prefix-checked.
 */
export function resolveJailed(root: string, relOrAbs: string): string {
  if (relOrAbs.split(/[\\/]/).includes('..')) {
    throw new Error('path escapes jail');
  }
  const jailRoot = resolve(root);
  const resolved = resolve(jailRoot, relOrAbs);
  const real = tryRealpath(resolved) ?? resolved;
  const realRoot = tryRealpath(jailRoot) ?? jailRoot;
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('path escapes jail');
  }
  return real;
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}
