import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import type { PullRequestRef } from '../../domain/ship.js';
import { EToolTier } from '../../domain/tool-surface.js';
import type { Job, PrismaClient as Client, Thread } from '../../generated/prisma/client.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { JobRepository } from '../../store/job.repository.js';
import { MigratorService } from '../../store/migrator.service.js';
import type { PrismaService } from '../../store/prisma.service.js';
import { ProjectRepository } from '../../store/project.repository.js';
import { GitService } from '../git.service.js';
import type { GithubCliService } from '../github-cli.service.js';
import { ShipService } from '../ship.service.js';
import type { ToolContext } from '../tools/tool.js';
import { WorktreeService } from '../worktree.service.js';

/**
 * Shipping against a REAL git triangle — a bare `origin`, the job's clone, and a second clone
 * standing in for everybody else — with only `gh` faked.
 *
 * The claims worth proving here are git's, not a mock's: that the branch really is rebased onto a
 * base that MOVED, that the second ship pushes rewritten history without being refused, and that a
 * conflict leaves the worktree exactly as it was. A faked runner would only assert that the fake
 * behaves as assumed. `gh` is the one boundary faked, because the alternative is a GitHub account.
 */
describe('ship_pr over a real repository', () => {
  const gitService = new GitService();
  let dir: string;
  let origin: string;
  let repo: string;
  /** A second clone: how `origin/main` moves under the job while it is working. */
  let other: string;
  let client: Client;
  let jobRepository: JobRepository;
  let worktreeService: WorktreeService;
  let projectId: string;

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await gitService.run({ cwd, args });
    if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  async function commit(cwd: string, file: string, body: string): Promise<void> {
    writeFileSync(join(cwd, file), body);
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '-m', `write ${file}`);
  }

  async function identify(cwd: string): Promise<void> {
    await git(cwd, 'config', 'user.email', 't@example.com');
    await git(cwd, 'config', 'user.name', 't');
  }

  /**
   * `gh`, faked at exactly the surface `GithubCliService` exposes — and STATEFUL: creating a pull
   * request makes the next `openPullRequest` find it, which is what lets the idempotence test be two
   * real ship calls rather than a flag flipped between them.
   */
  function fakeGh(seed?: { defaultBranch?: string; existing?: PullRequestRef }) {
    const created: { base: string; head: string; title: string; body: string }[] = [];
    let open: PullRequestRef | null = seed?.existing ?? null;
    const service: GithubCliService = {
      async defaultBranch(): Promise<string> {
        return seed?.defaultBranch ?? 'main';
      },
      async openPullRequest(): Promise<PullRequestRef | null> {
        return open;
      },
      async createPullRequest(args: {
        base: string;
        head: string;
        title: string;
        body: string;
      }): Promise<PullRequestRef> {
        created.push({ base: args.base, head: args.head, title: args.title, body: args.body });
        open = { number: 1, url: 'https://github.com/o/r/pull/1' };
        return open;
      },
    };
    return { service, created };
  }

  function ctxFor(args: { job: Job; cwd: string }): ToolContext {
    return {
      job: args.job,
      thread: { id: 'thread-1' } as unknown as Thread,
      phase: EPhaseKind.ci,
      cwd: args.cwd,
      tier: EToolTier.thread,
    };
  }

  /** The job as the database has it — `ship_pr` reads `Job.branch`, which `enter()` wrote. */
  async function reload(job: Job): Promise<Job> {
    const stored = await jobRepository.findById(job.id);
    if (!stored) throw new Error('job vanished');
    return stored;
  }

  beforeEach(async () => {
    // realpath: macOS hands out /var/folders/... behind a /private symlink and git answers with the
    // resolved path, so a raw mkdtemp path makes every equality check spuriously fail.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-ship-')));
    origin = join(dir, 'origin.git');
    repo = join(dir, 'repo');
    other = join(dir, 'other');

    mkdirSync(repo);
    await git(dir, 'init', '--bare', '-b', 'main', origin);
    await git(repo, 'init', '-b', 'main');
    await identify(repo);
    await commit(repo, 'README.md', '# repo\n');
    await git(repo, 'remote', 'add', 'origin', origin);
    await git(repo, 'push', '-u', 'origin', 'main');

    await git(dir, 'clone', origin, other);
    await identify(other);

    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);
    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    const prismaService = client as unknown as PrismaService;
    jobRepository = new JobRepository(prismaService);
    worktreeService = new WorktreeService(gitService, jobRepository);
    projectId = (await new ProjectRepository(prismaService).open(repo, 'repo')).id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A job in its own worktree with one commit on its branch, which is the state `ci` is entered in. */
  async function jobWithWork(title = 'add avatar upload'): Promise<{ job: Job; cwd: string }> {
    const created = await jobRepository.create({ projectId, title, kind: EPhaseKind.ci });
    const { workspacePath } = await worktreeService.enter({ job: created, projectPath: repo });
    await commit(workspacePath, 'avatar.ts', 'export const avatar = 1;\n');
    return { job: await reload(created), cwd: workspacePath };
  }

  /** Everybody else's work, landing on the base branch while the job was busy. */
  async function advanceBase(file = 'other.ts'): Promise<void> {
    await commit(other, file, '// somebody else\n');
    await git(other, 'push', 'origin', 'main');
  }

  it('rebases onto the base as it is NOW, pushes, and opens one pull request', async () => {
    const { job, cwd } = await jobWithWork();
    await advanceBase();
    const gh = fakeGh();
    const shipService = new ShipService(gitService, gh.service, jobRepository);

    const reply = await shipService.ship({
      ctx: ctxFor({ job, cwd }),
      title: 'Add avatar upload',
      body: 'What changed, why, and how it was verified.',
    });

    // The base moved after the branch was cut, so a rebase that did nothing would leave
    // `origin/main` off the branch's history entirely.
    const ancestor = await gitService.run({
      cwd,
      args: ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
    });
    expect(ancestor.ok).toBe(true);
    expect(existsSync(join(cwd, 'other.ts'))).toBe(true);

    expect(await git(origin, 'rev-parse', `${job.branch}`)).toBe(await git(cwd, 'rev-parse', 'HEAD'));
    expect(gh.created).toEqual([
      {
        base: 'main',
        head: job.branch ?? '',
        title: 'Add avatar upload',
        body: 'What changed, why, and how it was verified.',
      },
    ]);
    expect(reply).toContain('#1 opened');
    expect((await reload(job)).prNumber).toBe(1);
  });

  it('is idempotent: shipping again rebases and pushes but opens no second pull request', async () => {
    const first = await jobWithWork();
    await advanceBase();
    const gh = fakeGh();
    const shipService = new ShipService(gitService, gh.service, jobRepository);
    await shipService.ship({ ctx: ctxFor(first), title: 'Add avatar upload', body: 'body' });

    // The red-build loop: a fix lands in a new phase, the base moves again, and `ci` is re-entered.
    await commit(first.cwd, 'avatar.ts', 'export const avatar = 2;\n');
    await advanceBase('later.ts');
    const job = await reload(first.job);

    const reply = await shipService.ship({
      ctx: ctxFor({ job, cwd: first.cwd }),
      title: 'ignored — the pull request keeps its own title',
      body: 'ignored',
    });

    expect(gh.created).toHaveLength(1);
    expect(reply).toContain('already existed');
    expect(reply).toContain('No second pull request was opened');
    // The rebase rewrote the branch, so this push was a non-fast-forward — the whole reason it
    // carries a lease. A plain push here is the failure this test exists to catch.
    expect(await git(origin, 'rev-parse', `${job.branch}`)).toBe(
      await git(first.cwd, 'rev-parse', 'HEAD'),
    );
    expect(existsSync(join(first.cwd, 'later.ts'))).toBe(true);
    expect((await reload(job)).prNumber).toBe(1);
  });

  it('caches the number of a pull request somebody else opened', async () => {
    const { job, cwd } = await jobWithWork();
    const gh = fakeGh({ existing: { number: 42, url: 'https://github.com/o/r/pull/42' } });
    const shipService = new ShipService(gitService, gh.service, jobRepository);

    await shipService.ship({ ctx: ctxFor({ job, cwd }), title: 't', body: 'b' });

    expect(gh.created).toHaveLength(0);
    // The render cache is written on every ship, not only on the one that created it.
    expect((await reload(job)).prNumber).toBe(42);
  });

  it('refuses uncommitted work rather than shipping a branch that does not have it', async () => {
    const { job, cwd } = await jobWithWork();
    writeFileSync(join(cwd, 'avatar.ts'), 'export const avatar = 999;\n');
    const gh = fakeGh();
    const shipService = new ShipService(gitService, gh.service, jobRepository);

    await expect(
      shipService.ship({ ctx: ctxFor({ job, cwd }), title: 't', body: 'b' }),
    ).rejects.toThrow(/uncommitted work/);
    expect(gh.created).toHaveLength(0);
  });

  it('refuses to push when the job names a branch that is not the one checked out here', async () => {
    // `Job.branch` outlives its worktree, so the cwd falls back to the project path — where the
    // branch Dennis has open is checked out. Force-pushing that is the accident this prevents.
    const { job } = await jobWithWork();
    const gh = fakeGh();
    const shipService = new ShipService(gitService, gh.service, jobRepository);

    await expect(
      shipService.ship({ ctx: ctxFor({ job, cwd: repo }), title: 't', body: 'b' }),
    ).rejects.toThrow(/worktree is gone/);
    expect(gh.created).toHaveLength(0);
  });

  it('refuses to open a pull request from the default branch to itself', async () => {
    const created = await jobRepository.create({
      projectId,
      title: 'no worktree',
      kind: EPhaseKind.ci,
    });
    const gh = fakeGh();
    const shipService = new ShipService(gitService, gh.service, jobRepository);

    await expect(
      shipService.ship({ ctx: ctxFor({ job: created, cwd: repo }), title: 't', body: 'b' }),
    ).rejects.toThrow(/default branch/);
  });

  it('aborts a conflicting rebase, pushes nothing, and leaves the worktree usable', async () => {
    const { job, cwd } = await jobWithWork();
    // The same file, changed both sides of the fork.
    await commit(cwd, 'README.md', '# ours\n');
    await commit(other, 'README.md', '# theirs\n');
    await git(other, 'push', 'origin', 'main');
    const before = await git(cwd, 'rev-parse', 'HEAD');
    const gh = fakeGh();
    const shipService = new ShipService(gitService, gh.service, jobRepository);

    await expect(
      shipService.ship({ ctx: ctxFor({ job, cwd }), title: 't', body: 'b' }),
    ).rejects.toThrow(/aborted/);

    // A stopped rebase is a state the agent has no verb to leave, so the abort is what keeps the
    // worktree something a human can open.
    expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(cwd, '.git'))).toBe(true);
    const status = await gitService.run({ cwd, args: ['status', '--porcelain'] });
    expect(status.stdout.trim()).toBe('');
    expect(gh.created).toHaveLength(0);
    expect((await reload(job)).prNumber).toBeNull();
  });

  it('opens nothing when the does-one-exist question could not be asked', async () => {
    // The distinction idempotence rests on. A `gh pr list` that failed must never read as "none".
    const { job, cwd } = await jobWithWork();
    const gh = fakeGh();
    const service: GithubCliService = {
      defaultBranch: (cwd: string) => gh.service.defaultBranch(cwd),
      createPullRequest: (created) => gh.service.createPullRequest(created),
      async openPullRequest(): Promise<PullRequestRef | null> {
        throw new Error('gh pr list failed: could not connect');
      },
    };
    const shipService = new ShipService(gitService, service, jobRepository);

    await expect(
      shipService.ship({ ctx: ctxFor({ job, cwd }), title: 't', body: 'b' }),
    ).rejects.toThrow(/could not connect/);
    expect(gh.created).toHaveLength(0);
  });
});
