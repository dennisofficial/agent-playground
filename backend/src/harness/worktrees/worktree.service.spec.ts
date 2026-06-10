import type { EnvService } from '@core/config/env/env.service';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorktreeService } from './worktree.service';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** A throwaway real git repo — worktree behavior is git behavior, so the spec runs against git. */
async function makeRepo(): Promise<string> {
  // realpath: macOS tmpdir is symlinked (/var → /private/var) and git reports resolved paths.
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'wt-spec-')));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'spec@test');
  await git(repo, 'config', 'user.name', 'spec');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await mkdir(join(repo, 'app'), { recursive: true });
  await writeFile(join(repo, 'app', 'index.ts'), 'export {};\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'init');
  return repo;
}

function makeService(workerRoot: string): WorktreeService {
  const env = {
    get: (k: string) => (k === 'WORKER_ROOT' ? workerRoot : undefined),
  } as unknown as EnvService;
  return new WorktreeService(env);
}

describe('WorktreeService (real git, temp repo)', () => {
  let repo: string;
  let service: WorktreeService;

  beforeEach(async () => {
    repo = await makeRepo();
    service = makeService(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('creates a worktree on a fresh agent branch cut from HEAD by default', async () => {
    const { worktree } = await service.create({
      name: 'Auth refactor!',
      ownerBot: 'alex',
      project: 'local',
    });
    expect(worktree.id).toBe('wt-001');
    expect(worktree.branch).toBe('agent/alex/wt-001-auth-refactor');
    expect(worktree.baseRef).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect(worktree.checkout).toBe(join(repo, '.worktrees', 'wt-001-auth-refactor'));
    // WORKER_ROOT is the repo root here, so path === checkout.
    expect(worktree.path).toBe(worktree.checkout);
    expect(await git(worktree.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(worktree.branch);
    expect(service.get('wt-001')).toEqual(worktree);
    expect(service.list({ ownerBot: 'alex' })).toHaveLength(1);
  });

  it('maps a subdir WORKER_ROOT to the same subpath inside the checkout', async () => {
    const sub = makeService(join(repo, 'app'));
    const { worktree } = await sub.create({ name: 'ui', ownerBot: 'riley', project: 'local' });
    expect(worktree.path).toBe(join(worktree.checkout, 'app'));
  });

  it('attaches to an existing branch, and surfaces the git refusal when it is already checked out', async () => {
    await git(repo, 'branch', 'feature-x');
    const { worktree } = await service.create({
      name: 'feature work',
      branch: 'feature-x',
      ownerBot: 'alex',
      project: 'local',
    });
    expect(worktree.branch).toBe('feature-x');
    // A second attach to the same branch is git's own refusal — it must reach the caller.
    await expect(
      service.create({ name: 'dup', branch: 'feature-x', ownerBot: 'riley', project: 'local' }),
    ).rejects.toThrow(/already (checked out|used by worktree)/i);
  });

  it('creates a named branch from HEAD when it does not exist yet', async () => {
    const { worktree } = await service.create({
      name: 'fix',
      branch: 'fix/login',
      ownerBot: 'alex',
      project: 'local',
    });
    expect(worktree.branch).toBe('fix/login');
    expect(await git(repo, 'rev-parse', 'fix/login')).toBe(await git(repo, 'rev-parse', 'HEAD'));
  });

  it('warns (without blocking) when the base checkout is dirty', async () => {
    await writeFile(join(repo, 'README.md'), 'scratch\n');
    const { warning } = await service.create({ name: 'w', ownerBot: 'alex', project: 'local' });
    expect(warning).toMatch(/uncommitted/i);
  });

  it('removes the checkout but keeps the branch', async () => {
    const { worktree } = await service.create({ name: 'temp', ownerBot: 'alex', project: 'local' });
    await service.remove(worktree.id);
    expect(service.get(worktree.id)).toBeUndefined();
    expect(await git(repo, 'branch', '--list', worktree.branch)).toContain(worktree.branch);
    await expect(git(worktree.checkout, 'status')).rejects.toThrow();
  });

  it('rejects removing an unknown id', async () => {
    await expect(service.remove('wt-999')).rejects.toThrow(/No worktree/);
  });

  it('re-adopts surviving wt-* checkouts on boot and keeps the id counter clear of them', async () => {
    await service.create({ name: 'survivor', ownerBot: 'alex', project: 'local' });

    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    const adopted = fresh.get('wt-001');
    expect(adopted).toBeDefined();
    expect(adopted?.branch).toBe('agent/alex/wt-001-survivor');
    expect(adopted?.ownerBot).toBe('alex'); // recovered from the agent/<owner>/… branch
    expect(adopted?.baseRef).toBe('');

    const { worktree } = await fresh.create({ name: 'next', ownerBot: 'riley', project: 'local' });
    expect(worktree.id).toBe('wt-002');
  });

  it('leaves non-wt checkouts under .worktrees/ alone during adoption', async () => {
    // Simulates the playground's ticket worktrees sharing the same .worktrees/ dir.
    const foreign = join(repo, '.worktrees', 'tickets-TKT-1-alex');
    await git(repo, 'worktree', 'add', '-b', 'ticket/TKT-1', foreign, 'HEAD');

    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    expect(fresh.list()).toHaveLength(0);
    expect(await git(foreign, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ticket/TKT-1');
  });

  it('survives boot with no WORKER_ROOT (adoption skipped, create still fails loudly)', async () => {
    const bare = makeService('');
    await expect(bare.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(bare.create({ name: 'x', ownerBot: 'a', project: 'p' })).rejects.toThrow(
      /WORKER_ROOT/,
    );
  });
});
