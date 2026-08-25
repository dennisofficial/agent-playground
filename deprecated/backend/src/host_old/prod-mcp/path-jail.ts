import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

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
