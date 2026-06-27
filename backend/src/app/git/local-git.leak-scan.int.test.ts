import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EnvService } from '@core/config/env/env.service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitService } from './local-git.service';
import { writeForbiddenPaths } from './hydration-sidecar';

const execFileAsync = promisify(execFile);

/**
 * Real-git verification of the worktree-secret guards in {@link LocalGitService}: `isIgnored` against a
 * real `.gitignore`, and the `commitAll` leak-scan that refuses to commit a hydrated secret even when it
 * was force-staged. Uses a throwaway local repo (no network, no Postgres, no Docker).
 */
describe('LocalGitService — gitignore + leak-scan (real git)', () => {
  let repo: string;
  let stateDir: string;
  const prevState = process.env.ATLAS_HYDRATION_STATE;
  let git: LocalGitService;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'atlas-leak-'));
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-leak-state-'));
    process.env.ATLAS_HYDRATION_STATE = stateDir;
    git = new LocalGitService({ get: () => undefined } as unknown as EnvService);

    const g = (args: string[]) => execFileAsync('git', args, { cwd: repo });
    await g(['init', '-q']);
    await g(['config', 'user.email', 'test@atlas.dev']);
    await g(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, '.gitignore'), '.env.keys\nsecrets/\n');
    writeFileSync(join(repo, 'README.md'), '# hi');
    await g(['add', '.gitignore', 'README.md']);
    await g(['commit', '-qm', 'init']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    if (prevState === undefined) delete process.env.ATLAS_HYDRATION_STATE;
    else process.env.ATLAS_HYDRATION_STATE = prevState;
  });

  it('isIgnored reflects the real .gitignore', async () => {
    expect(await git.isIgnored(repo, '.env.keys')).toBe(true);
    expect(await git.isIgnored(repo, 'secrets/sa.json')).toBe(true);
    expect(await git.isIgnored(repo, 'README.md')).toBe(false);
    expect(await git.isIgnored(repo, 'src/app.ts')).toBe(false);
  });

  it('commitAll aborts when a forbidden (hydrated) file is force-staged', async () => {
    // Hydrate a secret + record it in the sidecar (as the hydrator would).
    writeFileSync(join(repo, '.env.keys'), 'SECRET=1');
    await writeForbiddenPaths(repo, ['.env.keys']);
    // A malicious/agent step force-stages the ignored secret.
    await execFileAsync('git', ['add', '-f', '.env.keys'], { cwd: repo });

    await expect(git.commitAll(repo, 'sneak in a secret')).rejects.toThrow(/hydrated secret\/seed/i);
  });

  it('commitAll proceeds normally for ordinary changes (forbidden file present but not staged)', async () => {
    writeFileSync(join(repo, '.env.keys'), 'SECRET=1'); // ignored, never staged
    await writeForbiddenPaths(repo, ['.env.keys']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;');

    const sha = await git.commitAll(repo, 'add app');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // The secret must NOT be in the commit.
    const tracked = await execFileAsync('git', ['ls-files'], { cwd: repo });
    expect(tracked.stdout).not.toContain('.env.keys');
    expect(tracked.stdout).toContain('src/app.ts');
  });
});
