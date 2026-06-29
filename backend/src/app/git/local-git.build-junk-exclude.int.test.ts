import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EnvService } from '@core/config/env/env.service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitService } from './local-git.service';

const execFileAsync = promisify(execFile);

/**
 * Real-git verification of {@link LocalGitService.ensureBuildJunkExcluded}: a package-manager store
 * (`.pnpm-store/`) dropped at the worktree root must be ignored by git WITHOUT touching the tracked
 * `.gitignore`, so `commitAll`'s `git add -A` never sweeps it into a PR. Exercised through a real
 * LINKED worktree (the production shape — git honors only the clone's common-dir `info/exclude`).
 */
describe('LocalGitService — build-junk exclude (real git, linked worktree)', () => {
  let base: string;
  let wt: string;
  let git: LocalGitService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'atlas-junk-'));
    git = new LocalGitService({ get: () => undefined } as unknown as EnvService);

    const g = (args: string[], cwd = base) => execFileAsync('git', args, { cwd });
    await g(['init', '-q']);
    await g(['config', 'user.email', 'test@atlas.dev']);
    await g(['config', 'user.name', 'Test']);
    // Note: `.pnpm-store/` is deliberately NOT in .gitignore — that's the whole point.
    writeFileSync(join(base, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(base, 'README.md'), '# hi');
    await g(['add', '.gitignore', 'README.md']);
    await g(['commit', '-qm', 'init']);
    // Cut a linked worktree (the production shape).
    wt = join(base, '.worktrees', 'feature');
    await g(['worktree', 'add', '-q', '-b', 'feature', wt]);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const excludePath = () => join(base, '.git', 'info', 'exclude');

  it('ignores the package store but not source, in the linked worktree', async () => {
    mkdirSync(join(wt, '.pnpm-store'), { recursive: true });
    writeFileSync(join(wt, '.pnpm-store', 'x'), 'junk');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;');

    expect(await git.isIgnored(wt, '.pnpm-store')).toBe(false); // not ignored yet
    await git.ensureBuildJunkExcluded(wt);
    expect(await git.isIgnored(wt, '.pnpm-store')).toBe(true);
    expect(await git.isIgnored(wt, 'src/a.ts')).toBe(false);
  });

  it('commitAll stages only source, never the package store', async () => {
    mkdirSync(join(wt, '.pnpm-store'), { recursive: true });
    writeFileSync(join(wt, '.pnpm-store', 'big'), 'x'.repeat(1024));
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;');

    await git.ensureBuildJunkExcluded(wt);
    const sha = await git.commitAll(wt, 'add source');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const tracked = await execFileAsync('git', ['ls-files'], { cwd: wt });
    expect(tracked.stdout).toContain('src/a.ts');
    expect(tracked.stdout).not.toContain('.pnpm-store');
  });

  it('is idempotent and preserves pre-existing exclude content', async () => {
    // Seed a pre-existing user line in the common-dir exclude.
    mkdirSync(join(base, '.git', 'info'), { recursive: true });
    writeFileSync(excludePath(), '# user line\nmy-local-scratch/\n');

    await git.ensureBuildJunkExcluded(wt);
    await git.ensureBuildJunkExcluded(wt); // second call must not duplicate

    const content = readFileSync(excludePath(), 'utf8');
    expect(content).toContain('# user line');
    expect(content).toContain('my-local-scratch/');
    expect(content).toContain('.pnpm-store/');
    // Exactly one managed block (appended once, not duplicated per call).
    const blocks = content.match(/atlas build-junk \(managed\)/g) ?? [];
    expect(blocks).toHaveLength(1);
  });
});
