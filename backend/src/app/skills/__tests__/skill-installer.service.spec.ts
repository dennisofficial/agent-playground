import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitService } from '../../git/local-git.service';
import type { WorkspaceSkillEntity } from '../../persistence/entities';
import type { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { SkillInstallerService } from '../skill-installer.service';
import { skillDirHost } from '../skill-store-paths';
import { WorkspaceSkillStore } from '../workspace-skill.store';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

class FakeRepo {
  rows: WorkspaceSkillEntity[] = [];
  constructor(private readonly delayMs = 0) {}
  create(p: Partial<WorkspaceSkillEntity>): WorkspaceSkillEntity {
    return { ...p } as WorkspaceSkillEntity;
  }
  async save(row: WorkspaceSkillEntity): Promise<WorkspaceSkillEntity> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const i = this.rows.findIndex(
      (r) => r.org_id === row.org_id && r.scope === row.scope && r.name === row.name,
    );
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({
    where,
  }: {
    where: Partial<WorkspaceSkillEntity>;
  }): Promise<WorkspaceSkillEntity | null> {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }
  async find(): Promise<WorkspaceSkillEntity[]> {
    return this.rows;
  }
  async delete(): Promise<void> {}
  private match(r: WorkspaceSkillEntity, where: Partial<WorkspaceSkillEntity>): boolean {
    return Object.entries(where).every(
      ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
    );
  }
}

function commitAndBare(tmp: string, work: string, bareName: string): string {
  const bare = join(tmp, bareName);
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'skills'], { env: GIT_ENV });
  rmSync(bare, { recursive: true, force: true });
  execFileSync('git', ['clone', '--bare', work, bare]);
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return bare;
}

function initRepo(work: string): void {
  execFileSync('git', ['init', '-b', 'main', work]);
}

function makeSingleSkillRepo(tmp: string): string {
  const work = join(tmp, 'single-work');
  initRepo(work);
  mkdirSync(join(work, 'references'), { recursive: true });
  writeFileSync(
    join(work, 'SKILL.md'),
    '---\nname: my-skill\ndescription: Use when doing the thing\n---\n\nBody.\n',
  );
  writeFileSync(join(work, 'references', 'x.md'), '# reference\n');
  return commitAndBare(tmp, work, 'single.git');
}

function makeMarketplaceRepo(tmp: string): string {
  const work = join(tmp, 'marketplace-work');
  initRepo(work);
  mkdirSync(join(work, '.claude-plugin'), { recursive: true });
  mkdirSync(join(work, 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(work, 'skills', 'beta'), { recursive: true });
  writeFileSync(
    join(work, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'test-marketplace',
      plugins: [
        {
          name: 'test-plugin',
          source: './',
          skills: ['./skills/alpha', './skills/beta'],
        },
      ],
    }),
  );
  writeFileSync(
    join(work, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: Alpha skill\n---\nBody.\n',
  );
  writeFileSync(
    join(work, 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\ndescription: Beta skill\n---\nBody.\n',
  );
  writeFileSync(
    join(work, 'skills', 'beta', 'asset.bin'),
    Buffer.from([0, 1, 2, 255, 254, 253, 0, 10]),
  );
  return commitAndBare(tmp, work, 'marketplace.git');
}

function makeMultiPluginMarketplaceRepo(tmp: string): string {
  const work = join(tmp, 'multi-work');
  initRepo(work);
  mkdirSync(join(work, '.claude-plugin'), { recursive: true });
  const skillNames = ['one', 'two', 'three', 'four', 'five', 'six'];
  for (const name of skillNames) {
    mkdirSync(join(work, 'skills', name), { recursive: true });
    writeFileSync(
      join(work, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Skill ${name}\n---\nBody.\n`,
    );
  }
  writeFileSync(
    join(work, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'multi-marketplace',
      plugins: [
        {
          name: 'plugin-a',
          source: './',
          skills: skillNames.slice(0, 3).map((n) => `./skills/${n}`),
        },
        {
          name: 'plugin-b',
          source: './',
          skills: skillNames.slice(3).map((n) => `./skills/${n}`),
        },
      ],
    }),
  );
  return commitAndBare(tmp, work, 'multi.git');
}

function makeDirScanMarketplaceRepo(tmp: string): string {
  const work = join(tmp, 'dirscan-work');
  initRepo(work);
  mkdirSync(join(work, '.claude-plugin'), { recursive: true });
  mkdirSync(join(work, 'skills', 'gamma'), { recursive: true });
  mkdirSync(join(work, 'skills', 'delta'), { recursive: true });
  writeFileSync(
    join(work, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'dirscan-marketplace',
      plugins: [{ name: 'dirscan-plugin', source: './' }],
    }),
  );
  writeFileSync(
    join(work, 'skills', 'gamma', 'SKILL.md'),
    '---\nname: gamma\ndescription: Gamma skill\n---\nBody.\n',
  );
  writeFileSync(
    join(work, 'skills', 'delta', 'SKILL.md'),
    '---\nname: delta\ndescription: Delta skill\n---\nBody.\n',
  );
  return commitAndBare(tmp, work, 'dirscan.git');
}

describe('SkillInstallerService (real git, local fixture repos)', () => {
  let tmp: string;
  let storeRoot: string;
  let installer: SkillInstallerService;
  let store: WorkspaceSkillStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'atlas-skill-installer-'));
    storeRoot = join(tmp, 'store');
    const env = {
      get: (key: string) => (key === 'SKILLS_ROOT' ? storeRoot : undefined),
    } as never;
    const git = new LocalGitService({ get: () => undefined } as never); // reposRoot unused — scratch clones use os.tmpdir()
    const creds = {
      githubToken: async () => undefined,
      hostGithubToken: async () => undefined,
    } as unknown as CredentialResolver; // local paths need no token
    store = new WorkspaceSkillStore(new FakeRepo() as unknown as Repository<WorkspaceSkillEntity>);
    installer = new SkillInstallerService(env, git, creds, store);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('installs a single skill at the repo root — vendors the dir + upserts a git-provenance row', async () => {
    const sourceUrl = makeSingleSkillRepo(tmp);
    const [skill] = await installer.install({
      orgId: 'org1',
      scope: '*',
      sourceUrl,
    });

    expect(skill.name).toBe('my-skill');
    expect(skill.description).toBe('Use when doing the thing');
    expect(skill.provenance).toBe('git');
    expect(skill.source_url).toBe(sourceUrl);
    expect(skill.source_ref).toBe('main'); // no ref given → resolved default branch
    expect(skill.source_subpath).toBeNull();
    expect(skill.installed_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(skill.update_policy).toBe('track-ref'); // default when unspecified

    const dest = skillDirHost(storeRoot, 'org1', '*', 'my-skill');
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('Use when doing the thing');
    expect(existsSync(join(dest, 'references', 'x.md'))).toBe(true);

    expect(await store.get('org1', '*', 'my-skill')).toEqual(skill);
  });

  it('expands a marketplace repo into one vendored skill + row per manifest entry, binaries intact', async () => {
    const sourceUrl = makeMarketplaceRepo(tmp);
    const skills = await installer.install({
      orgId: 'org1',
      scope: 'repo-1',
      sourceUrl,
      updatePolicy: 'pinned',
    });

    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    for (const s of skills) {
      expect(s.provenance).toBe('git');
      expect(s.update_policy).toBe('pinned');
      expect(s.source_url).toBe(sourceUrl);
    }
    const alpha = skills.find((s) => s.name === 'alpha')!;
    const beta = skills.find((s) => s.name === 'beta')!;
    expect(alpha.source_subpath).toBe('skills/alpha');
    expect(beta.source_subpath).toBe('skills/beta');

    const betaDest = skillDirHost(storeRoot, 'org1', 'repo-1', 'beta');
    const assetBytes = readFileSync(join(betaDest, 'asset.bin'));
    expect([...assetBytes]).toEqual([0, 1, 2, 255, 254, 253, 0, 10]); // byte-identical, not mangled as text
  });

  it(
    'expands EVERY skill across multiple plugins even with slow (real-DB-like) per-skill writes — the ' +
      'scratch-dir-cleanup race regression',
    async () => {
      const sourceUrl = makeMultiPluginMarketplaceRepo(tmp);
      const slowStore = new WorkspaceSkillStore(
        new FakeRepo(20) as unknown as Repository<WorkspaceSkillEntity>,
      );
      const slowInstaller = new SkillInstallerService(
        {
          get: (key: string) => (key === 'SKILLS_ROOT' ? storeRoot : undefined),
        } as never,
        new LocalGitService({ get: () => undefined } as never),
        {
          githubToken: async () => undefined,
          hostGithubToken: async () => undefined,
        } as unknown as CredentialResolver,
        slowStore,
      );

      const skills = await slowInstaller.install({
        orgId: 'org1',
        scope: '*',
        sourceUrl,
      });
      expect(skills.map((s) => s.name).sort()).toEqual([
        'five',
        'four',
        'one',
        'six',
        'three',
        'two',
      ]);
    },
  );

  it('expands a plugin that omits `skills` — scans its `skills/` subdir for SKILL.md dirs', async () => {
    const sourceUrl = makeDirScanMarketplaceRepo(tmp);
    const skills = await installer.install({
      orgId: 'org1',
      scope: '*',
      sourceUrl,
    });
    expect(skills.map((s) => s.name).sort()).toEqual(['delta', 'gamma']);
  });

  it('rejects a subpath with neither a SKILL.md nor a marketplace manifest', async () => {
    const sourceUrl = makeSingleSkillRepo(tmp);
    await expect(
      installer.install({
        orgId: 'org1',
        scope: '*',
        sourceUrl,
        subpath: 'references',
      }),
    ).rejects.toThrow(/no SKILL.md/);
  });

  it(
    'preview() resolves the real frontmatter name/description WITHOUT writing, and flags an overwrite ' +
      'conflict only once the name already exists',
    async () => {
      const sourceUrl = makeSingleSkillRepo(tmp);

      const before = await installer.preview({
        orgId: 'org1',
        scope: '*',
        sourceUrl,
      });
      expect(before).toEqual([
        {
          name: 'my-skill',
          description: 'Use when doing the thing',
          overwrites: false,
        },
      ]);
      expect(existsSync(skillDirHost(storeRoot, 'org1', '*', 'my-skill'))).toBe(false);
      expect(await store.get('org1', '*', 'my-skill')).toBeNull();

      await installer.install({ orgId: 'org1', scope: '*', sourceUrl });
      const after = await installer.preview({
        orgId: 'org1',
        scope: '*',
        sourceUrl,
      });
      expect(after[0]).toMatchObject({ name: 'my-skill', overwrites: true });
    },
  );

  it('preview() rejects a marketplace-root subpath — the brain install path is single-skill only', async () => {
    const sourceUrl = makeMarketplaceRepo(tmp);
    await expect(installer.preview({ orgId: 'org1', scope: '*', sourceUrl })).rejects.toThrow(
      /marketplace root/,
    );
  });

  it('re-installing (the update path) re-vendors content and bumps installed_sha on a new commit', async () => {
    const work = join(tmp, 'single-work');
    initRepo(work);
    writeFileSync(join(work, 'SKILL.md'), '---\nname: my-skill\ndescription: v1\n---\nBody v1.\n');
    const sourceUrl = commitAndBare(tmp, work, 'single.git');
    const [first] = await installer.install({
      orgId: 'org1',
      scope: '*',
      sourceUrl,
    });

    writeFileSync(join(work, 'SKILL.md'), '---\nname: my-skill\ndescription: v2\n---\nBody v2.\n');
    commitAndBare(tmp, work, 'single.git');
    const [second] = await installer.install({
      orgId: 'org1',
      scope: '*',
      sourceUrl,
    });

    expect(second.description).toBe('v2');
    expect(second.installed_sha).not.toBe(first.installed_sha);
    const dest = skillDirHost(storeRoot, 'org1', '*', 'my-skill');
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('Body v2.');
  });
});
