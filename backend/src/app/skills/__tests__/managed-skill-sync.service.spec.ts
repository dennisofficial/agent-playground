import type { EnvService } from '@core/config/env/env.service';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderElectionService } from '../../cluster/leader-election.service';
import { LocalGitService } from '../../git/local-git.service';
import { ManagedSkillSyncService } from '../managed-skill-sync.service';
import { managedGitSkillDirHost } from '../skill-store-paths';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

function initRepo(work: string): void {
  execFileSync('git', ['init', '-b', 'main', work]);
}

function commitAndBare(work: string, bare: string): void {
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'skills'], { env: GIT_ENV });
  rmSync(bare, { recursive: true, force: true });
  execFileSync('git', ['clone', '--bare', work, bare]);
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
}

let gitEntry: { url: string; subpath: string; ref: string } | undefined;
vi.mock('../system-skill-registry', () => ({
  buildSystemSkills: () =>
    gitEntry
      ? [
          {
            name: 'fixture-skill',
            description: 'd',
            surfaces: ['build'],
            git: gitEntry,
          },
        ]
      : [],
}));

describe('ManagedSkillSyncService (real git, local fixture repo)', () => {
  let tmp: string;
  let sourceUrl: string;
  let work: string;
  let store: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'atlas-managed-skill-sync-'));
    work = join(tmp, 'work', 'skills', 'fixture-skill');
    sourceUrl = join(tmp, 'origin.git');
    store = join(tmp, 'store');
    initRepo(join(tmp, 'work'));
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(work, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: v1\n---\nBody v1.\n',
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    gitEntry = undefined;
  });

  function make(): ManagedSkillSyncService {
    const env = {
      get: (key: string) => (key === 'SKILLS_ROOT' ? store : undefined),
    } as EnvService;
    const git = new LocalGitService({ get: () => undefined } as never);
    return new ManagedSkillSyncService(
      git,
      {
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as unknown as LeaderElectionService,
      env,
    );
  }

  it('vendors a git-sourced entry into the global _managed store on first sync', async () => {
    commitAndBare(join(tmp, 'work'), sourceUrl);
    gitEntry = { url: sourceUrl, subpath: 'skills/fixture-skill', ref: 'main' };

    const svc = make();
    await svc.syncAll();

    const dest = managedGitSkillDirHost(store, 'fixture-skill');
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('v1');
  });

  it('re-vendors on remote change, leaves it alone when the remote has not moved', async () => {
    commitAndBare(join(tmp, 'work'), sourceUrl);
    gitEntry = { url: sourceUrl, subpath: 'skills/fixture-skill', ref: 'main' };
    const svc = make();
    await svc.syncAll();

    const dest = managedGitSkillDirHost(store, 'fixture-skill');
    writeFileSync(join(dest, 'SENTINEL.txt'), 'stale-marker'); // detects a needless re-vendor below
    await svc.syncAll(); // remote unchanged — must be a no-op
    expect(existsSync(join(dest, 'SENTINEL.txt'))).toBe(true);

    writeFileSync(
      join(work, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: v2\n---\nBody v2.\n',
    );
    commitAndBare(join(tmp, 'work'), sourceUrl);
    await svc.syncAll();
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('v2');
    expect(existsSync(join(dest, 'SENTINEL.txt'))).toBe(false); // re-vendored — the whole dir was replaced
  });

  it('is fail-soft: a bad subpath is skipped, not thrown, and never crashes syncAll', async () => {
    commitAndBare(join(tmp, 'work'), sourceUrl);
    gitEntry = {
      url: sourceUrl,
      subpath: 'skills/does-not-exist',
      ref: 'main',
    };
    const svc = make();
    await expect(svc.syncAll()).resolves.toBeUndefined();
    expect(existsSync(managedGitSkillDirHost(store, 'fixture-skill'))).toBe(false);
  });

  it('is fail-soft: an unreachable remote is skipped, not thrown', async () => {
    gitEntry = {
      url: join(tmp, 'does-not-exist.git'),
      subpath: 'skills/fixture-skill',
      ref: 'main',
    };
    const svc = make();
    await expect(svc.syncAll()).resolves.toBeUndefined();
    expect(existsSync(managedGitSkillDirHost(store, 'fixture-skill'))).toBe(false);
  });
});
