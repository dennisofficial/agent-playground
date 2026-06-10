import type { EnvService } from '@core/config/env/env.service';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GithubTokenStore } from '../projects/github-token-store';
import type { ProjectStore } from '../projects/project-store';
import type { ProjectRecord } from '../projects/project.types';
import { WorktreeService } from './worktree.service';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Write + commit one file in a checkout (worktrees inherit the repo's user config). */
async function commit(checkout: string, file: string, content: string): Promise<void> {
  await writeFile(join(checkout, file), content);
  await git(checkout, 'add', file);
  await git(checkout, 'commit', '-m', `edit ${file}`);
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

const record = (projectId: string, gitUrl: string): ProjectRecord => ({
  projectId,
  displayName: projectId,
  gitUrl,
  defaultBranch: 'main',
  tokenName: null,
  createdAt: '',
  updatedAt: '',
});

/** A MUTABLE in-memory registry double — tests register/repoint projects mid-flight. */
function fakeRegistry(initial: ProjectRecord[] = []) {
  const map = new Map(initial.map((r) => [r.projectId, r]));
  const projects = {
    get: async (id: string) => map.get(id),
    list: async () => [...map.values()],
  } as unknown as ProjectStore;
  return { projects, map };
}

const NO_TOKENS = { resolve: async () => undefined } as unknown as GithubTokenStore;

function makeService(
  workerRoot: string,
  opts: { registry?: ProjectStore; reposRoot?: string } = {},
): WorktreeService {
  const env = {
    get: (k: string) =>
      k === 'WORKER_ROOT' ? workerRoot : k === 'REPOS_ROOT' ? opts.reposRoot : undefined,
  } as unknown as EnvService;
  return new WorktreeService(
    env,
    opts.registry ?? fakeRegistry().projects,
    NO_TOKENS,
  );
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

describe('WorktreeService shared integration branches (real git, temp repo)', () => {
  let repo: string;
  let service: WorktreeService;

  beforeEach(async () => {
    repo = await makeRepo();
    service = makeService(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('starts a shared branch at pre-create HEAD, cuts the personal branch from it, and records the association', async () => {
    const head = await git(repo, 'rev-parse', 'HEAD');
    const { worktree } = await service.create({
      name: 'payment work',
      shared: 'Payment Flow!',
      ownerBot: 'alex',
      project: 'local',
    });
    expect(worktree.sharedBranch).toBe('shared/payment-flow');
    expect(worktree.branch).toBe('agent/alex/wt-001-payment-work');
    expect(await git(repo, 'rev-parse', 'shared/payment-flow')).toBe(head);
    expect(worktree.baseRef).toBe(head);
    expect(await git(repo, 'config', '--get', `branch.${worktree.branch}.agent-shared`)).toBe(
      'shared/payment-flow',
    );
  });

  it('a second creator joins the SAME shared branch and bases on its tip, not the new HEAD', async () => {
    const { worktree: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'local',
    });
    const sharedTip = await git(repo, 'rev-parse', 'shared/feat');
    await commit(repo, 'unrelated.md', 'trunk moved on\n'); // main HEAD advances past the shared base
    const { worktree: b } = await service.create({
      name: 'b',
      shared: 'shared/feat', // full branch name back in must not double-prefix
      ownerBot: 'riley',
      project: 'local',
    });
    expect(b.sharedBranch).toBe('shared/feat');
    expect(b.baseRef).toBe(sharedTip);
    expect(a.sharedBranch).toBe('shared/feat');
  });

  it('refuses to check the shared branch itself out', async () => {
    await expect(
      service.create({ name: 'x', branch: 'shared/feat', ownerBot: 'alex', project: 'local' }),
    ).rejects.toThrow(/never checked out/i);
  });

  it('publishes committed work fast-forward onto the shared branch', async () => {
    const { worktree } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'local',
    });
    await commit(worktree.checkout, 'a.txt', 'from alex\n');
    const res = await service.publish(worktree.id);
    expect(res).toEqual({ integrated: true, sharedBranch: 'shared/feat', dirty: false });
    expect(await git(repo, 'rev-parse', 'shared/feat')).toBe(
      await git(worktree.checkout, 'rev-parse', 'HEAD'),
    );
  });

  it('merges a teammate-advanced shared branch in, then publishes both (disjoint files)', async () => {
    const { worktree: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'local',
    });
    const { worktree: b } = await service.create({
      name: 'b',
      shared: 'feat',
      ownerBot: 'riley',
      project: 'local',
    });
    await commit(b.checkout, 'riley.txt', 'riley work\n');
    await service.publish(b.id);
    await commit(a.checkout, 'alex.txt', 'alex work\n');
    const res = await service.publish(a.id);
    expect(res.integrated).toBe(true);
    const tree = await git(repo, 'ls-tree', '--name-only', 'shared/feat');
    expect(tree).toContain('riley.txt');
    expect(tree).toContain('alex.txt');
  });

  it('reports a conflict, leaves the merge IN PROGRESS, and refuses further publishes until resolved', async () => {
    const { worktree: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'local',
    });
    const { worktree: b } = await service.create({
      name: 'b',
      shared: 'feat',
      ownerBot: 'riley',
      project: 'local',
    });
    await commit(b.checkout, 'README.md', 'riley version\n');
    await service.publish(b.id);
    await commit(a.checkout, 'README.md', 'alex version\n');
    const res = await service.publish(a.id);
    expect(res.integrated).toBe(false);
    expect(res.files).toEqual(['README.md']);
    // The merge is genuinely in progress in A's checkout (a session turn resolves it)…
    expect(await git(a.checkout, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBeTruthy();
    // …and publishing again before resolving is refused with the resolve-first message.
    await expect(service.publish(a.id)).rejects.toThrow(/merge is already in progress/i);
    await expect(service.pull(a.id)).rejects.toThrow(/merge is already in progress/i);
  });

  it('pull takes a teammate’s published work into the checkout', async () => {
    const { worktree: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'local',
    });
    const { worktree: b } = await service.create({
      name: 'b',
      shared: 'feat',
      ownerBot: 'riley',
      project: 'local',
    });
    await commit(b.checkout, 'riley.txt', 'riley work\n');
    await service.publish(b.id);
    const res = await service.pull(a.id);
    expect(res).toEqual({ integrated: true, sharedBranch: 'shared/feat' });
    expect(await git(a.checkout, 'ls-tree', '--name-only', 'HEAD')).toContain('riley.txt');
    // Pulling again is a clean no-op ("Already up to date").
    expect((await service.pull(a.id)).integrated).toBe(true);
  });

  it('refuses publish/pull on a worktree without a shared branch', async () => {
    const { worktree } = await service.create({ name: 'solo', ownerBot: 'alex', project: 'local' });
    await expect(service.publish(worktree.id)).rejects.toThrow(/not on a shared branch/i);
    await expect(service.pull(worktree.id)).rejects.toThrow(/not on a shared branch/i);
  });

  it('flags a dirty checkout on publish and does NOT publish the uncommitted content', async () => {
    const { worktree } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'local',
    });
    await commit(worktree.checkout, 'a.txt', 'committed\n');
    await writeFile(join(worktree.checkout, 'scratch.txt'), 'uncommitted\n');
    const res = await service.publish(worktree.id);
    expect(res.integrated).toBe(true);
    expect(res.dirty).toBe(true);
    expect(await git(repo, 'ls-tree', '--name-only', 'shared/feat')).not.toContain('scratch.txt');
  });

  it('boot adoption and branch re-attach both restore the shared association from branch config', async () => {
    const { worktree } = await service.create({
      name: 'survivor',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'local',
    });

    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    expect(fresh.get(worktree.id)?.sharedBranch).toBe('shared/feat');

    await fresh.remove(worktree.id);
    const { worktree: reattached } = await fresh.create({
      name: 'survivor again',
      branch: worktree.branch, // no `shared` passed — config is the truth
      ownerBot: 'alex',
      project: 'local',
    });
    expect(reattached.sharedBranch).toBe('shared/feat');
    // …and a DIFFERENT shared name on re-attach is a hard mismatch.
    await fresh.remove(reattached.id);
    await expect(
      fresh.create({
        name: 'x',
        branch: worktree.branch,
        shared: 'other',
        ownerBot: 'alex',
        project: 'local',
      }),
    ).rejects.toThrow(/already publishes to shared\/feat/);
  });
});

describe('WorktreeService per-project repos + origin sync (real git, file:// remotes)', () => {
  let workerRoot: string;
  let reposRoot: string;
  let originDir: string; // bare repo standing in for GitHub
  let registry: ReturnType<typeof fakeRegistry>;
  let service: WorktreeService;
  const ORIGIN_URL = () => `file://${originDir}`;

  beforeEach(async () => {
    workerRoot = await makeRepo();
    reposRoot = await realpath(await mkdtemp(join(tmpdir(), 'wt-repos-')));
    const seed = await makeRepo();
    originDir = join(await realpath(await mkdtemp(join(tmpdir(), 'wt-origin-'))), 'origin.git');
    await git(seed, 'clone', '--bare', seed, originDir);
    await rm(seed, { recursive: true, force: true });
    registry = fakeRegistry([record('proj', ORIGIN_URL())]);
    service = makeService(workerRoot, { registry: registry.projects, reposRoot });
  });

  afterEach(async () => {
    for (const dir of [workerRoot, reposRoot, join(originDir, '..')]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clones a registered project on first use and cuts worktrees inside the clone', async () => {
    const { worktree } = await service.create({
      name: 'feature',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'proj',
    });
    expect(worktree.repoRoot).toBe(join(reposRoot, 'proj'));
    expect(worktree.checkout.startsWith(join(reposRoot, 'proj', '.worktrees'))).toBe(true);
    expect(worktree.path).toBe(worktree.checkout); // subdir '' — cwd is the clone root
    expect(await git(join(reposRoot, 'proj'), 'remote', 'get-url', 'origin')).toBe(ORIGIN_URL());
    // A second create reuses the clone (no re-clone), still under the mutex.
    const second = await service.create({ name: 'b', shared: 'feat', ownerBot: 'riley', project: 'proj' });
    expect(second.worktree.repoRoot).toBe(worktree.repoRoot);
  });

  it('publish syncs the shared branch to origin; unregistered projects stay local-only', async () => {
    const { worktree } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'proj',
    });
    await commit(worktree.checkout, 'a.txt', 'work\n');
    const res = await service.publish(worktree.id);
    expect(res.integrated).toBe(true);
    expect(res.remote).toEqual({ pushed: true });
    expect(await git(originDir, 'rev-parse', 'shared/feat')).toBe(
      await git(worktree.checkout, 'rev-parse', 'HEAD'),
    );

    // Unregistered project ('' / not in registry) → no remote key at all (local behavior intact).
    const local = await service.create({ name: 'l', shared: 'x', ownerBot: 'alex', project: 'local' });
    await commit(local.worktree.checkout, 'l.txt', 'local\n');
    const localRes = await service.publish(local.worktree.id);
    expect(localRes.integrated).toBe(true);
    expect(localRes.remote).toBeUndefined();
  });

  it('a remote-push failure reports remote.pushed=false WITHOUT losing the local publish', async () => {
    const { worktree } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'proj',
    });
    await commit(worktree.checkout, 'a.txt', 'work\n');
    await rm(originDir, { recursive: true, force: true }); // origin gone → push fails
    const res = await service.publish(worktree.id);
    expect(res.integrated).toBe(true); // local publish intact
    expect(res.remote?.pushed).toBe(false);
    expect(res.remote?.detail).toBeTruthy();
    expect(await git(worktree.repoRoot, 'rev-parse', 'shared/feat')).toBeTruthy();
  });

  it('identity guard: a worktree created before its project was registered never pushes to the new origin', async () => {
    // 'late' is unregistered at create time → worktree lives in WORKER_ROOT's repo.
    const { worktree } = await service.create({
      name: 'early',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'late',
    });
    expect(worktree.repoRoot).not.toBe(join(reposRoot, 'late'));
    await commit(worktree.checkout, 'e.txt', 'pre-registration work\n');
    // Now the project gets registered with a repo + (implicitly) a token.
    registry.map.set('late', record('late', ORIGIN_URL()));

    const res = await service.publish(worktree.id);
    expect(res.integrated).toBe(true); // local publish still works
    expect(res.remote?.pushed).toBe(false);
    expect(res.remote?.detail).toMatch(/recreate the worktree/i);
    await expect(service.pushSharedToOrigin(worktree.id)).rejects.toThrow(/recreate the worktree/i);
    // And nothing reached the origin.
    await expect(git(originDir, 'rev-parse', 'shared/feat')).rejects.toThrow();
  });

  it('pushSharedToOrigin is idempotent and refuses unregistered projects', async () => {
    const { worktree } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      project: 'proj',
    });
    await commit(worktree.checkout, 'a.txt', 'work\n');
    await service.publish(worktree.id);
    await expect(service.pushSharedToOrigin(worktree.id)).resolves.toEqual({
      sharedBranch: 'shared/feat',
      gitUrl: ORIGIN_URL(),
    });
    await expect(service.pushSharedToOrigin(worktree.id)).resolves.toBeDefined(); // up-to-date push ok

    const local = await service.create({ name: 'l', shared: 'x', ownerBot: 'alex', project: 'local' });
    await expect(service.pushSharedToOrigin(local.worktree.id)).rejects.toThrow(
      /no registered GitHub repo/,
    );
  });

  it('repairs origin-URL drift on managed clones only; WORKER_ROOT origin is never rewritten', async () => {
    await service.create({ name: 'a', ownerBot: 'alex', project: 'proj' }); // materialize the clone
    // The project gets repointed at a second origin via the admin API.
    const origin2 = join(await realpath(await mkdtemp(join(tmpdir(), 'wt-origin2-'))), 'origin.git');
    await git(join(reposRoot, 'proj'), 'clone', '--bare', join(reposRoot, 'proj'), origin2);
    registry.map.set('proj', record('proj', `file://${origin2}`));

    await service.create({ name: 'b', ownerBot: 'alex', project: 'proj' });
    expect(await git(join(reposRoot, 'proj'), 'remote', 'get-url', 'origin')).toBe(
      `file://${origin2}`,
    );

    // WORKER_ROOT (unregistered path) has no origin and must stay that way.
    await service.create({ name: 'w', ownerBot: 'alex', project: 'local' });
    await expect(git(workerRoot, 'remote', 'get-url', 'origin')).rejects.toThrow();
    await rm(join(origin2, '..'), { recursive: true, force: true });
  });

  it('boot adoption scans WORKER_ROOT and every existing project clone with the right project ids', async () => {
    const a = await service.create({ name: 'cloned', shared: 'feat', ownerBot: 'alex', project: 'proj' });
    const b = await service.create({ name: 'rooted', ownerBot: 'riley', project: 'local' });

    const fresh = makeService(workerRoot, { registry: registry.projects, reposRoot });
    await fresh.onApplicationBootstrap();
    const adoptedA = fresh.get(a.worktree.id);
    const adoptedB = fresh.get(b.worktree.id);
    expect(adoptedA?.project).toBe('proj');
    expect(adoptedA?.repoRoot).toBe(join(reposRoot, 'proj'));
    expect(adoptedA?.sharedBranch).toBe('shared/feat');
    expect(adoptedB?.project).toBe('');
    expect(adoptedB?.repoRoot).not.toBe(join(reposRoot, 'proj'));
  });
});
