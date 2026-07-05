import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { repoStateDir } from '../state-root';

/**
 * The host-only record of which worktree-relative paths were HYDRATED as secrets/seed into a given
 * worktree — the source of truth for `LocalGitService.scanBranchForForbidden`'s pre-ship leak-scan.
 *
 * It lives OUTSIDE the worktree (under `$ATLAS_HYDRATION_STATE`, default the repo-relative
 * `.atlas-state/hydration-state`), keyed by `sha256(worktreePath)`, so an in-sandbox agent can neither read nor
 * mutate it. This is deliberately a STANDALONE helper with no Nest/DI surface: the pre-ship scan consults it
 * with a pure file read so the git layer takes no dependency on the driver/sandbox layers, and a member
 * who edits the in-worktree `.atlas/worktree.json` (or `git add -f`s a secret) cannot defeat the scan.
 */

function stateRoot(): string {
  return process.env.ATLAS_HYDRATION_STATE ?? repoStateDir('hydration-state');
}

/** Deterministic host path of the sidecar for a worktree. */
export function hydrationSidecarPath(worktreePath: string): string {
  const digest = createHash('sha256').update(worktreePath).digest('hex');
  return join(stateRoot(), `${digest}.json`);
}

/** Persist the forbidden (hydrated secret/seed) paths for a worktree. Overwrites. */
export async function writeForbiddenPaths(
  worktreePath: string,
  forbiddenPaths: string[],
): Promise<void> {
  const file = hydrationSidecarPath(worktreePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ worktreePath, forbiddenPaths }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * The forbidden paths previously hydrated into a worktree (worktree-relative, normalised). Returns `[]`
 * when there is no sidecar (a non-hydrated worktree) or it is unreadable — a missing record must never
 * block a ship, only a positive match does. Synchronous: called from the pre-ship branch scan.
 */
export function readForbiddenPaths(worktreePath: string): string[] {
  const file = hydrationSidecarPath(worktreePath);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { forbiddenPaths?: unknown };
    if (!Array.isArray(parsed.forbiddenPaths)) return [];
    return parsed.forbiddenPaths.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}
