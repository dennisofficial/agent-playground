import type { EnvService } from '@core/config/env/env.service';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeForbiddenPaths } from '../hydration-sidecar';
import { LocalGitService } from '../local-git.service';

const execFileAsync = promisify(execFile);

describe('LocalGitService — gitignore + pre-ship leak-scan (real git)', () => {
  let repo: string;
  let stateDir: string;
  let baseSha: string;
  const prevState = process.env.ATLAS_HYDRATION_STATE;
  let git: LocalGitService;

  const g = (args: string[]) => execFileAsync('git', args, { cwd: repo });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'atlas-leak-'));
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-leak-state-'));
    process.env.ATLAS_HYDRATION_STATE = stateDir;
    git = new LocalGitService({
      get: () => undefined,
    } as unknown as EnvService);

    await g(['init', '-q']);
    await g(['config', 'user.email', 'test@atlas.dev']);
    await g(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, '.gitignore'), '.env.keys\nsecrets/\n');
    writeFileSync(join(repo, 'README.md'), '# hi');
    await g(['add', '.gitignore', 'README.md']);
    await g(['commit', '-qm', 'init']);
    baseSha = (await g(['rev-parse', 'HEAD'])).stdout.trim();
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

  it('scanBranchForForbidden flags a forbidden file force-committed on the branch', async () => {
    await writeForbiddenPaths(repo, ['.env.keys']);
    writeFileSync(join(repo, '.env.keys'), 'SECRET=1');
    await g(['add', '-f', '.env.keys']);
    await g(['commit', '-qm', 'sneak in a secret']);

    expect(await git.scanBranchForForbidden(repo, baseSha)).toEqual(['.env.keys']);
  });

  it('catches a secret ADDED then DELETED in a later commit (per-commit, not the net diff)', async () => {
    await writeForbiddenPaths(repo, ['.env.keys']);
    writeFileSync(join(repo, '.env.keys'), 'SECRET=1');
    await g(['add', '-f', '.env.keys']);
    await g(['commit', '-qm', 'add secret']);
    rmSync(join(repo, '.env.keys'), { force: true });
    await g(['rm', '-q', '--cached', '.env.keys']);
    await g(['commit', '-qm', 'remove secret again']);

    const netDiff = await g(['diff', '--name-only', `${baseSha}..HEAD`]);
    expect(netDiff.stdout).not.toContain('.env.keys');

    expect(await git.scanBranchForForbidden(repo, baseSha)).toEqual(['.env.keys']);
  });

  it('returns [] for ordinary changes (forbidden file present but never committed)', async () => {
    await writeForbiddenPaths(repo, ['.env.keys']);
    writeFileSync(join(repo, '.env.keys'), 'SECRET=1'); // ignored, never staged
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;');
    await g(['add', 'src/app.ts']);
    await g(['commit', '-qm', 'add app']);

    expect(await git.scanBranchForForbidden(repo, baseSha)).toEqual([]);
    const tracked = await g(['ls-files']);
    expect(tracked.stdout).not.toContain('.env.keys');
    expect(tracked.stdout).toContain('src/app.ts');
  });

  it('returns [] when there is no hydration sidecar (nothing forbidden to scan for)', async () => {
    writeFileSync(join(repo, '.env.keys'), 'SECRET=1');
    await g(['add', '-f', '.env.keys']);
    await g(['commit', '-qm', 'commit a would-be secret with no sidecar']);

    expect(await git.scanBranchForForbidden(repo, baseSha)).toEqual([]);
  });
});
