import { repoStateDir } from '@shared/state-root';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';


function stateRoot(): string {
  return process.env.ATLAS_HYDRATION_STATE ?? repoStateDir('hydration-state');
}

export function hydrationSidecarPath(worktreePath: string): string {
  const digest = createHash('sha256').update(worktreePath).digest('hex');
  return join(stateRoot(), `${digest}.json`);
}

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

export function readForbiddenPaths(worktreePath: string): string[] {
  const file = hydrationSidecarPath(worktreePath);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      forbiddenPaths?: unknown;
    };
    if (!Array.isArray(parsed.forbiddenPaths)) return [];
    return parsed.forbiddenPaths.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}
