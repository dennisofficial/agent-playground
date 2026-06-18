import type { EnvService } from '@core/config/env/env.service';
import { Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GithubTokenStore } from '../projects/github-token-store';
import type { ProjectStore } from '../projects/project-store';
import type { ProjectRecord } from '../projects/project.types';
import { WorkspaceService } from './workspace.service';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Write + commit one file in a checkout (service-created workspaces commit as their owner via
 * per-workspace identity; plain checkouts use the repo's user config). */
async function commit(
  checkout: string,
  file: string,
  content: string,
): Promise<void> {
  await writeFile(join(checkout, file), content);
  await git(checkout, 'add', file);
  await git(checkout, 'commit', '-m', `edit ${file}`);
}

/** Push a new commit to a bare origin's `main` via a scratch clone — stands in for "Dennis merged
 * a PR to main." Returns the new main tip sha. */
async function advanceOrigin(
  originDir: string,
  file: string,
  content: string,
): Promise<string> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ws-adv-')));
  await git(scratch, 'clone', originDir, '.');
  await git(scratch, 'config', 'user.email', 'adv@test');
  await git(scratch, 'config', 'user.name', 'adv');
  await writeFile(join(scratch, file), content);
  await git(scratch, 'add', file);
  await git(scratch, 'commit', '-m', `advance ${file}`);
  await git(scratch, 'push', 'origin', 'main');
  const sha = await git(scratch, 'rev-parse', 'HEAD');
  await rm(scratch, { recursive: true, force: true });
  return sha;
}

/** A throwaway real git repo — workspace behavior is git behavior, so the spec runs against git. */
async function makeRepo(): Promise<string> {
  // realpath: macOS tmpdir is symlinked (/var → /private/var) and git reports resolved paths.
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'ws-spec-')));
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
  teamId: 'local',
  projectId,
  displayName: projectId,
  description: null,
  gitUrl,
  defaultBranch: 'main',
  tokenName: null,
  createdAt: '',
  updatedAt: '',
});

/** A MUTABLE in-memory registry double — tests register/repoint projects mid-flight. Single-tenant
 * fixtures, so the team arg is accepted and ignored (lookup is by project id). */
function fakeRegistry(initial: ProjectRecord[] = []) {
  const map = new Map(initial.map((r) => [r.projectId, r]));
  const projects = {
    get: async (_team: string, id: string) => map.get(id),
    list: async () => [...map.values()],
    listAll: async () => [...map.values()],
  } as unknown as ProjectStore;
  return { projects, map };
}

const NO_TOKENS = {
  resolve: async () => undefined,
} as unknown as GithubTokenStore;

function makeService(
  workerRoot: string,
  opts: { registry?: ProjectStore; reposRoot?: string } = {},
): WorkspaceService {
  const env = {
    get: (k: string) =>
      k === 'WORKER_ROOT'
        ? workerRoot
        : k === 'REPOS_ROOT'
          ? opts.reposRoot
          : undefined,
  } as unknown as EnvService;
  return new WorkspaceService(
    env,
    opts.registry ?? fakeRegistry().projects,
    NO_TOKENS,
  );
}

describe('WorkspaceService (real git, temp repo)', () => {
  let repo: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    repo = await makeRepo();
    service = makeService(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('creates a workspace on a fresh agent branch cut from HEAD by default', async () => {
    const { workspace } = await service.create({
      name: 'Auth refactor!',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    expect(workspace.id).toBe('ws-001');
    expect(workspace.branch).toBe('agent/alex/ws-001-auth-refactor');
    expect(workspace.baseRef).toBe(await git(repo, 'rev-parse', 'HEAD'));
    expect(workspace.checkout).toBe(
      join(repo, '.workspaces', 'ws-001-auth-refactor'),
    );
    // WORKER_ROOT is the repo root here, so path === checkout.
    expect(workspace.path).toBe(workspace.checkout);
    expect(
      await git(workspace.checkout, 'rev-parse', '--abbrev-ref', 'HEAD'),
    ).toBe(workspace.branch);
    expect(service.get('ws-001')).toEqual(workspace);
    expect(service.list({ ownerBot: 'alex' })).toHaveLength(1);
  });

  it('ensureShared promotes a solo workspace to shared/<slug> and records the association', async () => {
    const { workspace } = await service.create({
      name: 'solo work',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    expect(workspace.sharedBranch).toBeUndefined();

    const shared = await service.ensureShared(workspace.id, 'ticket-7');
    expect(shared).toBe('shared/ticket-7');
    expect(service.get(workspace.id)?.sharedBranch).toBe('shared/ticket-7');
    // The shared branch exists as a ref and the personal branch records the association durably.
    expect(await git(repo, 'rev-parse', 'shared/ticket-7')).toBe(
      await git(repo, 'rev-parse', workspace.branch),
    );
    expect(
      await git(repo, 'config', `branch.${workspace.branch}.agent-shared`),
    ).toBe('shared/ticket-7');
  });

  it('ensureShared is idempotent and respects an explicitly-joined shared branch', async () => {
    // A workspace that already joined a shared branch keeps it (no re-promotion to the ticket name).
    const { workspace } = await service.create({
      name: 'feature',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
      shared: 'big-feature',
    });
    expect(workspace.sharedBranch).toBe('shared/big-feature');
    expect(await service.ensureShared(workspace.id, 'ticket-7')).toBe(
      'shared/big-feature',
    );
    expect(service.get(workspace.id)?.sharedBranch).toBe('shared/big-feature');
  });

  it('maps a subdir WORKER_ROOT to the same subpath inside the checkout', async () => {
    const sub = makeService(join(repo, 'app'));
    const { workspace } = await sub.create({
      name: 'ui',
      ownerBot: 'riley',
      team: 'local',
      project: 'local',
    });
    expect(workspace.path).toBe(join(workspace.checkout, 'app'));
  });

  it('attaches to an existing branch, and surfaces the git refusal when it is already checked out', async () => {
    await git(repo, 'branch', 'feature-x');
    const { workspace } = await service.create({
      name: 'feature work',
      branch: 'feature-x',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    expect(workspace.branch).toBe('feature-x');
    // A second attach to the same branch is git's own refusal — it must reach the caller.
    await expect(
      service.create({
        name: 'dup',
        branch: 'feature-x',
        ownerBot: 'riley',
        team: 'local',
        project: 'local',
      }),
    ).rejects.toThrow(/already (checked out|used by worktree)/i);
  });

  it('creates a named branch from HEAD when it does not exist yet', async () => {
    const { workspace } = await service.create({
      name: 'fix',
      branch: 'fix/login',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    expect(workspace.branch).toBe('fix/login');
    expect(await git(repo, 'rev-parse', 'fix/login')).toBe(
      await git(repo, 'rev-parse', 'HEAD'),
    );
  });

  it('warns (without blocking) when the base checkout is dirty', async () => {
    await writeFile(join(repo, 'README.md'), 'scratch\n');
    const { warning } = await service.create({
      name: 'w',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    expect(warning).toMatch(/uncommitted/i);
  });

  it('logs error and warns (without fail-hard) when submodule init fails', async () => {
    // Build a standalone repo with a .gitmodules + gitlink pointing to a path that does not
    // exist — no network call, deterministic. We never run `git submodule add`, so the
    // .git/modules cache is empty and git must attempt a fresh clone on `submodule update`,
    // which immediately fails. This mirrors the real agent-workspace failure shape.
    const submodRepo = await realpath(
      await mkdtemp(join(tmpdir(), 'ws-submod-spec-')),
    );
    try {
      await git(submodRepo, 'init', '-b', 'main');
      await git(submodRepo, 'config', 'user.email', 'spec@test');
      await git(submodRepo, 'config', 'user.name', 'spec');
      await writeFile(join(submodRepo, 'README.md'), 'hello\n');
      await git(submodRepo, 'add', '.');
      await git(submodRepo, 'commit', '-m', 'init');
      // Register a submodule via .gitmodules pointing at a path that will never exist.
      await writeFile(
        join(submodRepo, '.gitmodules'),
        '[submodule "vendor/stub"]\n\tpath = vendor/stub\n\turl = /tmp/ws-spec-no-such-submod\n',
      );
      await git(submodRepo, 'add', '.gitmodules');
      // Add a gitlink entry (mode 160000) so the committed tree contains the submodule ref.
      const sha = await git(submodRepo, 'rev-parse', 'HEAD');
      await git(
        submodRepo,
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${sha},vendor/stub`,
      );
      await git(
        submodRepo,
        'commit',
        '-m',
        'add submodule stub (unreachable url)',
      );

      const submodService = makeService(submodRepo);
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      try {
        const { workspace, warning } = await submodService.create({
          name: 'submod-test',
          ownerBot: 'alex',
          team: 'local',
          project: 'local',
        });
        // create must succeed — no fail-hard on submodule init failure
        expect(workspace.id).toBeTruthy();
        // warning signals the failure and contains the remediation command
        expect(warning).toMatch(/submodule init failed/i);
        expect(warning).toContain('git submodule update --init --recursive');
        // Logger.error was called with the failure message
        expect(errorSpy).toHaveBeenCalled();
        expect(String(errorSpy.mock.calls[0][0])).toMatch(
          /submodule init failed/i,
        );
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await rm(submodRepo, { recursive: true, force: true });
    }
  });

  it('removes the checkout but keeps the branch', async () => {
    const { workspace } = await service.create({
      name: 'temp',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await service.remove(workspace.id);
    expect(service.get(workspace.id)).toBeUndefined();
    expect(await git(repo, 'branch', '--list', workspace.branch)).toContain(
      workspace.branch,
    );
    await expect(git(workspace.checkout, 'status')).rejects.toThrow();
  });

  it('rejects removing an unknown id', async () => {
    await expect(service.remove('ws-999')).rejects.toThrow(/No workspace/);
  });

  it('re-adopts surviving ws-* checkouts on boot and keeps the id counter clear of them', async () => {
    await service.create({
      name: 'survivor',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });

    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    const adopted = fresh.get('ws-001');
    expect(adopted).toBeDefined();
    expect(adopted?.branch).toBe('agent/alex/ws-001-survivor');
    expect(adopted?.ownerBot).toBe('alex'); // recovered from the agent/<owner>/… branch
    expect(adopted?.baseRef).toBe('');

    const { workspace } = await fresh.create({
      name: 'next',
      ownerBot: 'riley',
      team: 'local',
      project: 'local',
    });
    expect(workspace.id).toBe('ws-002');
  });

  it('leaves non-ws checkouts under .workspaces/ alone during adoption', async () => {
    // Simulates the playground's ticket workspaces sharing the same .workspaces/ dir.
    const foreign = join(repo, '.workspaces', 'tickets-TKT-1-alex');
    await git(repo, 'worktree', 'add', '-b', 'ticket/TKT-1', foreign, 'HEAD');

    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    expect(fresh.list()).toHaveLength(0);
    expect(await git(foreign, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'ticket/TKT-1',
    );
  });

  it('survives boot with no WORKER_ROOT (adoption skipped, create still fails loudly)', async () => {
    const bare = makeService('');
    await expect(bare.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(
      bare.create({ name: 'x', ownerBot: 'a', team: 'local', project: 'p' }),
    ).rejects.toThrow(/WORKER_ROOT/);
  });
});

describe('WorkspaceService shared integration branches (real git, temp repo)', () => {
  let repo: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    repo = await makeRepo();
    service = makeService(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('starts a shared branch at pre-create HEAD, cuts the personal branch from it, and records the association', async () => {
    const head = await git(repo, 'rev-parse', 'HEAD');
    const { workspace } = await service.create({
      name: 'payment work',
      shared: 'Payment Flow!',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    expect(workspace.sharedBranch).toBe('shared/payment-flow');
    expect(workspace.branch).toBe('agent/alex/ws-001-payment-work');
    expect(await git(repo, 'rev-parse', 'shared/payment-flow')).toBe(head);
    expect(workspace.baseRef).toBe(head);
    expect(
      await git(
        repo,
        'config',
        '--get',
        `branch.${workspace.branch}.agent-shared`,
      ),
    ).toBe('shared/payment-flow');
  });

  it('a second creator joins the SAME shared branch and bases on its tip, not the new HEAD', async () => {
    const { workspace: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    const sharedTip = await git(repo, 'rev-parse', 'shared/feat');
    await commit(repo, 'unrelated.md', 'trunk moved on\n'); // main HEAD advances past the shared base
    const { workspace: b } = await service.create({
      name: 'b',
      shared: 'shared/feat', // full branch name back in must not double-prefix
      ownerBot: 'riley',
      team: 'local',
      project: 'local',
    });
    expect(b.sharedBranch).toBe('shared/feat');
    expect(b.baseRef).toBe(sharedTip);
    expect(a.sharedBranch).toBe('shared/feat');
  });

  it('refuses to check the shared branch itself out', async () => {
    await expect(
      service.create({
        name: 'x',
        branch: 'shared/feat',
        ownerBot: 'alex',
        team: 'local',
        project: 'local',
      }),
    ).rejects.toThrow(/never checked out/i);
  });

  it('publishes committed work fast-forward onto the shared branch', async () => {
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await commit(workspace.checkout, 'a.txt', 'from alex\n');
    const res = await service.publish(workspace.id);
    // The remote outcome is ALWAYS reported now — a local-only publish must say so, not look clean.
    expect(res).toEqual({
      integrated: true,
      sharedBranch: 'shared/feat',
      dirty: false,
      remote: { pushed: false, detail: expect.stringMatching(/LOCAL ONLY/) },
    });
    expect(await git(repo, 'rev-parse', 'shared/feat')).toBe(
      await git(workspace.checkout, 'rev-parse', 'HEAD'),
    );
  });

  it('merges a teammate-advanced shared branch in, then publishes both (disjoint files)', async () => {
    const { workspace: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    const { workspace: b } = await service.create({
      name: 'b',
      shared: 'feat',
      ownerBot: 'riley',
      team: 'local',
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
    const { workspace: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    const { workspace: b } = await service.create({
      name: 'b',
      shared: 'feat',
      ownerBot: 'riley',
      team: 'local',
      project: 'local',
    });
    await commit(b.checkout, 'README.md', 'riley version\n');
    await service.publish(b.id);
    await commit(a.checkout, 'README.md', 'alex version\n');
    const res = await service.publish(a.id);
    expect(res.integrated).toBe(false);
    expect(res.files).toEqual(['README.md']);
    // The merge is genuinely in progress in A's checkout (a session turn resolves it)…
    expect(
      await git(a.checkout, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
    ).toBeTruthy();
    // …and publishing again before resolving is refused with the resolve-first message.
    await expect(service.publish(a.id)).rejects.toThrow(
      /merge is already in progress/i,
    );
    await expect(service.pull(a.id)).rejects.toThrow(
      /merge is already in progress/i,
    );
  });

  it('pull takes a teammate’s published work into the checkout', async () => {
    const { workspace: a } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    const { workspace: b } = await service.create({
      name: 'b',
      shared: 'feat',
      ownerBot: 'riley',
      team: 'local',
      project: 'local',
    });
    await commit(b.checkout, 'riley.txt', 'riley work\n');
    await service.publish(b.id);
    const res = await service.pull(a.id);
    // No registered repo here → the merge is local-only, and pull says so.
    expect(res).toEqual({
      integrated: true,
      sharedBranch: 'shared/feat',
      originFetched: false,
    });
    expect(await git(a.checkout, 'ls-tree', '--name-only', 'HEAD')).toContain(
      'riley.txt',
    );
    // Pulling again is a clean no-op ("Already up to date").
    expect((await service.pull(a.id)).integrated).toBe(true);
  });

  it('refuses publish/pull on a workspace without a shared branch', async () => {
    const { workspace } = await service.create({
      name: 'solo',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await expect(service.publish(workspace.id)).rejects.toThrow(
      /not on a shared branch/i,
    );
    await expect(service.pull(workspace.id)).rejects.toThrow(
      /not on a shared branch/i,
    );
  });

  it('flags a dirty checkout on publish and does NOT publish the uncommitted content', async () => {
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await commit(workspace.checkout, 'a.txt', 'committed\n');
    await writeFile(join(workspace.checkout, 'scratch.txt'), 'uncommitted\n');
    const res = await service.publish(workspace.id);
    expect(res.integrated).toBe(true);
    expect(res.dirty).toBe(true);
    expect(
      await git(repo, 'ls-tree', '--name-only', 'shared/feat'),
    ).not.toContain('scratch.txt');
  });

  it('boot adoption and branch re-attach both restore the shared association from branch config', async () => {
    const { workspace } = await service.create({
      name: 'survivor',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });

    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    expect(fresh.get(workspace.id)?.sharedBranch).toBe('shared/feat');

    await fresh.remove(workspace.id);
    const { workspace: reattached } = await fresh.create({
      name: 'survivor again',
      branch: workspace.branch, // no `shared` passed — config is the truth
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    expect(reattached.sharedBranch).toBe('shared/feat');
    // …and a DIFFERENT shared name on re-attach is a hard mismatch.
    await fresh.remove(reattached.id);
    await expect(
      fresh.create({
        name: 'x',
        branch: workspace.branch,
        shared: 'other',
        ownerBot: 'alex',
        team: 'local',
        project: 'local',
      }),
    ).rejects.toThrow(/already publishes to shared\/feat/);
  });
});

describe('WorkspaceService per-project repos + origin sync (real git, file:// remotes)', () => {
  let workerRoot: string;
  let reposRoot: string;
  let originDir: string; // bare repo standing in for GitHub
  let registry: ReturnType<typeof fakeRegistry>;
  let service: WorkspaceService;
  const ORIGIN_URL = () => `file://${originDir}`;

  beforeEach(async () => {
    workerRoot = await makeRepo();
    reposRoot = await realpath(await mkdtemp(join(tmpdir(), 'ws-repos-')));
    const seed = await makeRepo();
    originDir = join(
      await realpath(await mkdtemp(join(tmpdir(), 'ws-origin-'))),
      'origin.git',
    );
    await git(seed, 'clone', '--bare', seed, originDir);
    await rm(seed, { recursive: true, force: true });
    registry = fakeRegistry([record('proj', ORIGIN_URL())]);
    service = makeService(workerRoot, {
      registry: registry.projects,
      reposRoot,
    });
  });

  afterEach(async () => {
    for (const dir of [workerRoot, reposRoot, join(originDir, '..')]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clones a registered project on first use and cuts workspaces inside the clone', async () => {
    const { workspace } = await service.create({
      name: 'feature',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    expect(workspace.repoRoot).toBe(join(reposRoot, 'local', 'proj'));
    expect(
      workspace.checkout.startsWith(
        join(reposRoot, 'local', 'proj', '.workspaces'),
      ),
    ).toBe(true);
    expect(workspace.path).toBe(workspace.checkout); // subdir '' — cwd is the clone root
    expect(
      await git(
        join(reposRoot, 'local', 'proj'),
        'remote',
        'get-url',
        'origin',
      ),
    ).toBe(ORIGIN_URL());
    // A second create reuses the clone (no re-clone), still under the mutex.
    const second = await service.create({
      name: 'b',
      shared: 'feat',
      ownerBot: 'riley',
      team: 'local',
      project: 'proj',
    });
    expect(second.workspace.repoRoot).toBe(workspace.repoRoot);
  });

  it('publish syncs the shared branch to origin; unregistered projects stay local-only', async () => {
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    await commit(workspace.checkout, 'a.txt', 'work\n');
    const res = await service.publish(workspace.id);
    expect(res.integrated).toBe(true);
    expect(res.remote).toEqual({ pushed: true });
    expect(await git(originDir, 'rev-parse', 'shared/feat')).toBe(
      await git(workspace.checkout, 'rev-parse', 'HEAD'),
    );

    // Unregistered project ('' / not in registry, and WORKER_ROOT has no origin) → the publish
    // still lands locally, but the result says EXPLICITLY that GitHub never saw it.
    const local = await service.create({
      name: 'l',
      shared: 'x',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await commit(local.workspace.checkout, 'l.txt', 'local\n');
    const localRes = await service.publish(local.workspace.id);
    expect(localRes.integrated).toBe(true);
    expect(localRes.remote?.pushed).toBe(false);
    expect(localRes.remote?.detail).toMatch(/LOCAL ONLY/);
  });

  it('a remote-push failure reports remote.pushed=false WITHOUT losing the local publish', async () => {
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    await commit(workspace.checkout, 'a.txt', 'work\n');
    await rm(originDir, { recursive: true, force: true }); // origin gone → push fails
    const res = await service.publish(workspace.id);
    expect(res.integrated).toBe(true); // local publish intact
    expect(res.remote?.pushed).toBe(false);
    expect(res.remote?.detail).toBeTruthy();
    expect(
      await git(workspace.repoRoot, 'rev-parse', 'shared/feat'),
    ).toBeTruthy();
  });

  it('identity guard: a workspace created before its project was registered never pushes to the new origin', async () => {
    // 'late' is unregistered at create time → workspace lives in WORKER_ROOT's repo.
    const { workspace } = await service.create({
      name: 'early',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'late',
    });
    expect(workspace.repoRoot).not.toBe(join(reposRoot, 'late'));
    await commit(workspace.checkout, 'e.txt', 'pre-registration work\n');
    // Now the project gets registered with a repo + (implicitly) a token.
    registry.map.set('late', record('late', ORIGIN_URL()));

    const res = await service.publish(workspace.id);
    expect(res.integrated).toBe(true); // local publish still works
    expect(res.remote?.pushed).toBe(false);
    expect(res.remote?.detail).toMatch(/recreate the workspace/i);
    await expect(service.pushSharedToOrigin(workspace.id)).rejects.toThrow(
      /recreate the workspace/i,
    );
    // And nothing reached the origin.
    await expect(git(originDir, 'rev-parse', 'shared/feat')).rejects.toThrow();
  });

  it('pushSharedToOrigin is idempotent and refuses unregistered projects', async () => {
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    await commit(workspace.checkout, 'a.txt', 'work\n');
    await service.publish(workspace.id);
    await expect(service.pushSharedToOrigin(workspace.id)).resolves.toEqual({
      sharedBranch: 'shared/feat',
      gitUrl: ORIGIN_URL(),
    });
    await expect(
      service.pushSharedToOrigin(workspace.id),
    ).resolves.toBeDefined(); // up-to-date push ok

    const local = await service.create({
      name: 'l',
      shared: 'x',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await expect(service.pushSharedToOrigin(local.workspace.id)).rejects.toThrow(
      /No registered GitHub repo matches/,
    );
  });

  it('repairs origin-URL drift on managed clones only; WORKER_ROOT origin is never rewritten', async () => {
    await service.create({
      name: 'a',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    }); // materialize the clone
    // The project gets repointed at a second origin via the admin API.
    const origin2 = join(
      await realpath(await mkdtemp(join(tmpdir(), 'ws-origin2-'))),
      'origin.git',
    );
    await git(
      join(reposRoot, 'local', 'proj'),
      'clone',
      '--bare',
      join(reposRoot, 'local', 'proj'),
      origin2,
    );
    registry.map.set('proj', record('proj', `file://${origin2}`));

    await service.create({
      name: 'b',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    expect(
      await git(
        join(reposRoot, 'local', 'proj'),
        'remote',
        'get-url',
        'origin',
      ),
    ).toBe(`file://${origin2}`);

    // WORKER_ROOT (unregistered path) has no origin and must stay that way.
    await service.create({
      name: 'w',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await expect(
      git(workerRoot, 'remote', 'get-url', 'origin'),
    ).rejects.toThrow();
    await rm(join(origin2, '..'), { recursive: true, force: true });
  });

  it('boot adoption RECOVERS the project for WORKER_ROOT trees whose origin IS a registered repo (the restart bug)', async () => {
    // The production failure shape: workspaces cut from WORKER_ROOT whose repo origin is the
    // registered GitHub repo. A restart used to re-adopt them with project '' and every push
    // failed as `Project "(none)"` until Dennis "re-registered" a repo that was fine all along.
    await git(workerRoot, 'remote', 'add', 'origin', ORIGIN_URL());
    const { workspace } = await service.create({
      name: 'team intros',
      shared: 'team-intros',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    await commit(workspace.checkout, 'alex.md', 'hi\n');

    const fresh = makeService(workerRoot, {
      registry: registry.projects,
      reposRoot,
    });
    await fresh.onApplicationBootstrap();
    expect(fresh.get(workspace.id)?.project).toBe('proj'); // recovered, not ''
    // …and the whole push path works end-to-end after the restart, no re-registration needed.
    const res = await fresh.publish(workspace.id);
    expect(res.integrated).toBe(true);
    expect(res.remote).toEqual({ pushed: true });
    expect(
      await git(originDir, 'rev-parse', 'shared/team-intros'),
    ).toBeTruthy();
  });

  it('projectRecordFor falls back to the origin-URL match and backfills ws.project', async () => {
    await git(workerRoot, 'remote', 'add', 'origin', ORIGIN_URL());
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: '', // no association at all
    });
    expect((await service.projectRecordFor(workspace.id))?.projectId).toBe(
      'proj',
    );
    expect(service.get(workspace.id)?.project).toBe('proj'); // healed in place
    expect(await service.projectRecordFor('ws-999')).toBeUndefined();
  });

  it('pull and publish sync the shared ref from origin first (a GitHub-advanced branch reaches the workspace)', async () => {
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    await commit(workspace.checkout, 'a.txt', 'mine\n');
    await service.publish(workspace.id); // shared/feat now exists on origin
    // A teammate on ANOTHER machine advances origin's shared/feat behind our back.
    const elsewhere = await realpath(
      await mkdtemp(join(tmpdir(), 'ws-elsewhere-')),
    );
    await git(elsewhere, 'clone', originDir, 'c');
    const oc = join(elsewhere, 'c');
    await git(oc, 'config', 'user.email', 'o@test');
    await git(oc, 'config', 'user.name', 'o');
    await git(oc, 'checkout', 'shared/feat');
    await commit(oc, 'remote.txt', 'remote work\n');
    await git(oc, 'push', 'origin', 'shared/feat');

    const pulled = await service.pull(workspace.id);
    expect(pulled.integrated).toBe(true);
    expect(pulled.originFetched).toBe(true);
    expect(
      await git(workspace.checkout, 'ls-tree', '--name-only', 'HEAD'),
    ).toContain('remote.txt');

    // Publish after another remote advance: fetched + merged in, not rejected at the push.
    await commit(oc, 'remote2.txt', 'more remote work\n');
    await git(oc, 'push', 'origin', 'shared/feat');
    await commit(workspace.checkout, 'b.txt', 'more mine\n');
    const res = await service.publish(workspace.id);
    expect(res.integrated).toBe(true);
    expect(res.remote).toEqual({ pushed: true });
    await git(oc, 'fetch', 'origin');
    const tree = await git(oc, 'ls-tree', '--name-only', 'origin/shared/feat');
    expect(tree).toContain('remote2.txt');
    expect(tree).toContain('b.txt');
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('sharedStatus reports published state and commits origin is missing', async () => {
    const { workspace } = await service.create({
      name: 'a',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    expect(await service.sharedStatus('ws-999')).toBeUndefined();
    await commit(workspace.checkout, 'a.txt', 'x\n');
    // Committed but not published, origin never saw the branch.
    let st = await service.sharedStatus(workspace.id);
    expect(st?.published).toBe(false);
    expect(st?.aheadOfOrigin).toBeUndefined();
    await service.publish(workspace.id);
    st = await service.sharedStatus(workspace.id);
    expect(st).toEqual({ published: true, aheadOfOrigin: 0 });
  });

  it('boot adoption scans WORKER_ROOT and every existing project clone with the right project ids', async () => {
    const a = await service.create({
      name: 'cloned',
      shared: 'feat',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    const b = await service.create({
      name: 'rooted',
      ownerBot: 'riley',
      team: 'local',
      project: 'local',
    });

    const fresh = makeService(workerRoot, {
      registry: registry.projects,
      reposRoot,
    });
    await fresh.onApplicationBootstrap();
    const adoptedA = fresh.get(a.workspace.id);
    const adoptedB = fresh.get(b.workspace.id);
    expect(adoptedA?.project).toBe('proj');
    expect(adoptedA?.repoRoot).toBe(join(reposRoot, 'local', 'proj'));
    expect(adoptedA?.sharedBranch).toBe('shared/feat');
    expect(adoptedB?.project).toBe('');
    expect(adoptedB?.repoRoot).not.toBe(join(reposRoot, 'local', 'proj'));
  });

  it('cuts a NEW workspace from the latest base after origin advances (not the frozen clone HEAD)', async () => {
    // First create materializes the managed clone.
    await service.create({
      name: 'a',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    // Dennis merges a PR to main while the clone sits frozen.
    const newTip = await advanceOrigin(originDir, 'merged.txt', 'from main\n');
    // A second workspace must start from the advanced base, not the stale local HEAD.
    const second = await service.create({
      name: 'b',
      ownerBot: 'riley',
      team: 'local',
      project: 'proj',
    });
    expect(second.workspace.baseRef).toBe(newTip);
    expect(
      await readFile(join(second.workspace.checkout, 'merged.txt'), 'utf8'),
    ).toBe('from main\n');
  });

  it('refreshFromBase merges origin base advances into an existing workspace', async () => {
    const { workspace } = await service.create({
      name: 'a',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    await commit(workspace.checkout, 'local.txt', 'local work\n');
    const newTip = await advanceOrigin(originDir, 'merged.txt', 'from main\n');
    const res = await service.refreshFromBase(workspace.id);
    expect(res.refreshed).toBe(true);
    expect(res.baseBranch).toBe('main');
    // Both the local work and origin's change are present after the merge.
    expect(await readFile(join(workspace.checkout, 'local.txt'), 'utf8')).toBe(
      'local work\n',
    );
    expect(await readFile(join(workspace.checkout, 'merged.txt'), 'utf8')).toBe(
      'from main\n',
    );
    expect(await git(workspace.checkout, 'log', '--format=%H')).toContain(
      newTip,
    );
  });

  it('refreshFromBase leaves a conflict IN PROGRESS for a session to resolve', async () => {
    const { workspace } = await service.create({
      name: 'a',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    // The workspace and origin both change the SAME file from the seed → conflict.
    await commit(workspace.checkout, 'README.md', 'workspace change\n');
    await advanceOrigin(originDir, 'README.md', 'origin change\n');
    const res = await service.refreshFromBase(workspace.id);
    expect(res.refreshed).toBe(false);
    expect(res.conflicted).toBe(true);
    expect(res.files).toContain('README.md');
    // The merge is left in progress (MERGE_HEAD present) for the next turn to finish.
    await expect(
      git(workspace.checkout, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'),
    ).resolves.toBeTruthy();
  });

  it('refreshFromBase reports a DIRTY tree and skips the merge (no clobber)', async () => {
    const { workspace } = await service.create({
      name: 'a',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    // Uncommitted tracked change in the checkout — git would refuse to merge over it.
    await writeFile(join(workspace.checkout, 'README.md'), 'uncommitted edit\n');
    await advanceOrigin(originDir, 'merged.txt', 'from main\n');
    const res = await service.refreshFromBase(workspace.id);
    expect(res.refreshed).toBe(false);
    expect(res.dirty).toBe(true);
    expect(res.baseBranch).toBe('main');
    // The uncommitted edit survives and the merge never happened (origin's file is absent).
    expect(await readFile(join(workspace.checkout, 'README.md'), 'utf8')).toBe(
      'uncommitted edit\n',
    );
    await expect(
      readFile(join(workspace.checkout, 'merged.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refreshFromBase is a no-op for an unregistered workspace (no base to track)', async () => {
    const { workspace } = await service.create({
      name: 'l',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    const res = await service.refreshFromBase(workspace.id);
    expect(res.refreshed).toBe(false);
    expect(res.detail).toMatch(/no registered GitHub repo/i);
  });

  it('ensureSharedAtBase cuts the shared branch at the base divergence point, so the owner diff is non-empty', async () => {
    const { workspace } = await service.create({
      name: 'late',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    expect(workspace.sharedBranch).toBeUndefined();
    await commit(workspace.checkout, 'alex.txt', 'owner work\n');
    const base = await git(workspace.repoRoot, 'rev-parse', 'origin/main');

    const res = await service.ensureSharedAtBase(workspace.id, 'ticket-9');
    expect(res).toEqual({ ok: true, sharedBranch: 'shared/ticket-9' });
    // Cut at the merge-base (origin/main) — NOT the branch tip (which would make the diff empty).
    expect(await git(workspace.repoRoot, 'rev-parse', 'shared/ticket-9')).toBe(
      base,
    );
    const range = await git(
      workspace.checkout,
      'diff',
      '--name-only',
      `shared/ticket-9...${workspace.branch}`,
    );
    expect(range).toContain('alex.txt');
    expect(service.get(workspace.id)?.sharedBranch).toBe('shared/ticket-9');
    expect(
      await git(
        workspace.repoRoot,
        'config',
        `branch.${workspace.branch}.agent-shared`,
      ),
    ).toBe('shared/ticket-9');
  });

  it('ensureSharedAtBase excludes base-refresh merge commits from the owner range', async () => {
    const { workspace } = await service.create({
      name: 'refresh',
      ownerBot: 'alex',
      team: 'local',
      project: 'proj',
    });
    await commit(workspace.checkout, 'alex.txt', 'owner work\n');
    // Dennis merges something on main; the workspace refreshes (merges origin/main in) before review.
    await advanceOrigin(originDir, 'trunk.txt', 'trunk moved\n');
    await git(workspace.repoRoot, 'fetch', 'origin', 'main');
    await git(workspace.checkout, 'merge', '--no-edit', 'origin/main');

    const res = await service.ensureSharedAtBase(workspace.id, 'ticket-9');
    expect(res.ok).toBe(true);
    const range = await git(
      workspace.checkout,
      'diff',
      '--name-only',
      `shared/ticket-9...${workspace.branch}`,
    );
    // The owner's own file is in range; the base-refresh content (trunk.txt) is NOT.
    expect(range).toContain('alex.txt');
    expect(range).not.toContain('trunk.txt');
  });

  it('ensureSharedAtBase returns a typed failure for an unregistered workspace (no PR possible)', async () => {
    const { workspace } = await service.create({
      name: 'solo',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
    });
    const res = await service.ensureSharedAtBase(workspace.id, 'ticket-9');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no registered GitHub repo/i);
    expect(service.get(workspace.id)?.sharedBranch).toBeUndefined();
  });

  it('ensureSharedAtBase runs the origin identity guard before any authenticated fetch/promotion', async () => {
    // 'late' is unregistered at create → the workspace lives in WORKER_ROOT (origin ≠ the project repo).
    const { workspace } = await service.create({
      name: 'early',
      ownerBot: 'alex',
      team: 'local',
      project: 'late',
    });
    // Now register 'late' pointing at the project origin — the workspace's repo origin still doesn't match.
    registry.map.set('late', record('late', ORIGIN_URL()));
    const res = await service.ensureSharedAtBase(workspace.id, 'ticket-9');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/origin|recreate/i);
    expect(service.get(workspace.id)?.sharedBranch).toBeUndefined();
  });
});

describe('WorkspaceService per-workspace git identity (real git)', () => {
  let repo: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    repo = await makeRepo();
    service = makeService(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('commits inside a workspace are authored as the owning employee; the base checkout is untouched', async () => {
    const { workspace } = await service.create({
      name: 'intro',
      ownerBot: 'sam',
      team: 'local',
      project: 'local',
    });
    await commit(workspace.checkout, 'sam.md', 'hi\n');
    expect(
      await git(workspace.checkout, 'log', '-1', '--format=%an <%ae>'),
    ).toBe('Sam <sam@agents.noreply>');

    await writeFile(join(repo, 'root.md'), 'root\n');
    await git(repo, 'add', 'root.md');
    await git(repo, 'commit', '-m', 'root edit');
    expect(await git(repo, 'log', '-1', '--format=%an <%ae>')).toBe(
      'spec <spec@test>',
    );
  });

  it('adoption backfills identity onto trees from before it existed', async () => {
    const { workspace } = await service.create({
      name: 'old',
      ownerBot: 'maya',
      team: 'local',
      project: 'local',
    });
    // Simulate a pre-identity tree: strip the per-workspace config the create just wrote.
    await git(
      workspace.checkout,
      'config',
      '--worktree',
      '--unset',
      'user.name',
    );
    await git(
      workspace.checkout,
      'config',
      '--worktree',
      '--unset',
      'user.email',
    );

    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    await commit(workspace.checkout, 'maya.md', 'hi\n');
    expect(
      await git(workspace.checkout, 'log', '-1', '--format=%an <%ae>'),
    ).toBe('Maya <maya@agents.noreply>');
  });

  it('ownerless adopted trees keep the repo identity (no fake author invented)', async () => {
    // A non-agent branch (no owner segment) adopted from disk.
    await git(
      repo,
      'worktree',
      'add',
      '-b',
      'scratch',
      join(repo, '.workspaces', 'ws-009-scratch'),
    );
    const fresh = makeService(repo);
    await fresh.onApplicationBootstrap();
    await commit(join(repo, '.workspaces', 'ws-009-scratch'), 'x.md', 'x\n');
    expect(
      await git(
        join(repo, '.workspaces', 'ws-009-scratch'),
        'log',
        '-1',
        '--format=%an <%ae>',
      ),
    ).toBe('spec <spec@test>');
  });
});
