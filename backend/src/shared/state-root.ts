import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function monorepoRoot(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 16; depth++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root without finding the marker
    dir = parent;
  }
  return process.cwd(); // marker not found (unexpected) — refuse to escape to $HOME anyway
}

export function repoStateRoot(): string {
  return join(monorepoRoot(), '.atlas-state');
}

export function repoStateDir(name: 'agent-home' | 'repos' | 'hydration-state' | 'skills'): string {
  return join(repoStateRoot(), name);
}
