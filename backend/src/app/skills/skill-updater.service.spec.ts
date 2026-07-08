import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import type { EnvService } from '@core/config/env/env.service';
import type { LeaderElectionService } from '../cluster';
import type { CredentialResolver } from '../onboarding';
import type { WorkspaceSkillEntity } from '../persistence/entities';
import { LocalGitService } from '../git/local-git.service';
import { SkillInstallerService } from './skill-installer.service';
import { SkillUpdaterService } from './skill-updater.service';
import { WorkspaceSkillStore } from './workspace-skill.store';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** Same minimal in-memory `workspace_skills` repo as `skill-installer.service.spec.ts`. */
class FakeRepo {
  rows: WorkspaceSkillEntity[] = [];
  create(p: Partial<WorkspaceSkillEntity>): WorkspaceSkillEntity {
    // Real TypeORM applies the entity's `@Column({default:false})` for `update_available` — this fake
    // must mirror that so a freshly-created row behaves like a freshly-migrated one.
    return { update_available: false, ...p } as WorkspaceSkillEntity;
  }
  async save(row: WorkspaceSkillEntity): Promise<WorkspaceSkillEntity> {
    const i = this.rows.findIndex((r) => r.org_id === row.org_id && r.scope === row.scope && r.name === row.name);
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({ where }: { where: Partial<WorkspaceSkillEntity> }): Promise<WorkspaceSkillEntity | null> {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }
  async find({ where }: { where?: Partial<WorkspaceSkillEntity> } = {}): Promise<WorkspaceSkillEntity[]> {
    return where ? this.rows.filter((r) => this.match(r, where)) : this.rows;
  }
  async update(where: Partial<WorkspaceSkillEntity>, patch: Partial<WorkspaceSkillEntity>): Promise<void> {
    for (const r of this.rows) if (this.match(r, where)) Object.assign(r, patch);
  }
  async delete(): Promise<void> {}
  private match(r: WorkspaceSkillEntity, where: Partial<WorkspaceSkillEntity>): boolean {
    return Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v);
  }
}

function initRepo(work: string): void {
  execFileSync('git', ['init', '-b', 'main', work]);
}

/** Commit whatever's in `work` and (re-)materialize a `--bare` clone at a STABLE path — simulates pushing
 *  a new commit to the same remote the skill was installed from. */
function commitAndBare(tmp: string, work: string, bare: string): void {
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'skills'], { env: GIT_ENV });
  rmSync(bare, { recursive: true, force: true });
  execFileSync('git', ['clone', '--bare', work, bare]);
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
}

describe('SkillUpdaterService (real git, local fixture repo)', () => {
  let tmp: string;
  let sourceUrl: string;
  let work: string;
  let installer: SkillInstallerService;
  let updater: SkillUpdaterService;
  let store: WorkspaceSkillStore;
  let repo: FakeRepo;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'atlas-skill-updater-'));
    work = join(tmp, 'work');
    sourceUrl = join(tmp, 'origin.git');
    initRepo(work);
    writeFileSync(join(work, 'SKILL.md'), '---\nname: my-skill\ndescription: v1\n---\nBody v1.\n');
    commitAndBare(tmp, work, sourceUrl);

    const env = { get: (key: string) => (key === 'SKILLS_ROOT' ? join(tmp, 'store') : undefined) } as EnvService;
    const git = new LocalGitService({ get: () => undefined } as never);
    const creds = { githubToken: async () => undefined } as unknown as CredentialResolver;
    repo = new FakeRepo();
    store = new WorkspaceSkillStore(repo as unknown as Repository<WorkspaceSkillEntity>);
    installer = new SkillInstallerService(env, git, creds, store);
    updater = new SkillUpdaterService(
      repo as unknown as Repository<WorkspaceSkillEntity>,
      installer,
      git,
      creds,
      { onPromote: () => ({ unsubscribe() {} }), onDemote: () => ({ unsubscribe() {} }) } as unknown as LeaderElectionService,
      env,
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('leaves installed_sha untouched and no badge when the remote has not moved', async () => {
    const [before] = await installer.install({ orgId: 'org1', scope: '*', sourceUrl, updatePolicy: 'pinned' });
    await updater.reconcileAll();
    const after = await store.get('org1', '*', 'my-skill');
    expect(after!.installed_sha).toBe(before.installed_sha);
    expect(after!.update_available).toBe(false);
  });

  it('track-ref: auto-updates (re-vendors + bumps installed_sha) on remote change', async () => {
    const [before] = await installer.install({ orgId: 'org1', scope: '*', sourceUrl, updatePolicy: 'track-ref' });

    writeFileSync(join(work, 'SKILL.md'), '---\nname: my-skill\ndescription: v2\n---\nBody v2.\n');
    commitAndBare(tmp, work, sourceUrl);

    await updater.reconcileAll();
    const after = await store.get('org1', '*', 'my-skill');
    expect(after!.installed_sha).not.toBe(before.installed_sha);
    expect(after!.description).toBe('v2');
    expect(after!.update_available).toBe(false);
  });

  it('pinned: flags update_available but does NOT re-vendor until applyNow', async () => {
    const [before] = await installer.install({ orgId: 'org1', scope: '*', sourceUrl, updatePolicy: 'pinned' });

    writeFileSync(join(work, 'SKILL.md'), '---\nname: my-skill\ndescription: v2\n---\nBody v2.\n');
    commitAndBare(tmp, work, sourceUrl);

    await updater.reconcileAll();
    const badged = await store.get('org1', '*', 'my-skill');
    expect(badged!.installed_sha).toBe(before.installed_sha); // NOT auto-applied
    expect(badged!.update_available).toBe(true);

    await updater.applyNow('org1', '*', 'my-skill');
    const applied = await store.get('org1', '*', 'my-skill');
    expect(applied!.installed_sha).not.toBe(before.installed_sha);
    expect(applied!.description).toBe('v2');
    expect(applied!.update_available).toBe(false); // badge clears on apply
  });

  it('reconcileOrgAsync fire-and-forget check eventually clears/sets the same as reconcileAll', async () => {
    await installer.install({ orgId: 'org1', scope: '*', sourceUrl, updatePolicy: 'pinned' });
    writeFileSync(join(work, 'SKILL.md'), '---\nname: my-skill\ndescription: v2\n---\nBody v2.\n');
    commitAndBare(tmp, work, sourceUrl);

    updater.reconcileOrgAsync('org1');
    await new Promise((r) => setTimeout(r, 500)); // fire-and-forget — give the async chain time to settle
    const row = await store.get('org1', '*', 'my-skill');
    expect(row!.update_available).toBe(true);
  });
});
