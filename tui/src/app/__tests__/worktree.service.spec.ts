import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { EToolTier } from '../../domain/tool-surface.js';
import { worktreeNameFor } from '../../domain/worktree.js';
import { PrismaClient, type Job, type Thread } from '../../generated/prisma/client.js';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { JobRepository } from '../../store/job.repository.js';
import { MigratorService } from '../../store/migrator.service.js';
import type { PrismaService } from '../../store/prisma.service.js';
import { ProjectRepository } from '../../store/project.repository.js';
import { GitService } from '../git.service.js';
import type { ToolContext } from '../tools/tool.js';
import { WorktreeService } from '../worktree.service.js';

/**
 * Runs against a REAL temporary git repository. The claims under test — "a linked worktree resolves
 * to the main one", "a dirty worktree refuses to be removed" — are claims about git's behaviour, and
 * a faked runner would only assert that the fake behaves as assumed.
 */
describe('worktrees over a real repository', () => {
  const gitService = new GitService();
  let dir: string;
  let repo: string;
  let client: PrismaClient;
  let jobRepository: JobRepository;
  let projectRepository: ProjectRepository;
  let worktreeService: WorktreeService;
  let projectId: string;

  async function git(cwd: string, ...args: string[]): Promise<void> {
    const result = await gitService.run({ cwd, args });
    if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  async function newJob(title: string) {
    const job = await jobRepository.create({ projectId, title, kind: EPhaseKind.charting });
    return job;
  }

  beforeEach(async () => {
    // realpath: macOS hands out /var/folders/... behind a /private symlink, and git always answers
    // with the resolved path — a raw mkdtemp path would make every equality check spuriously fail.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-worktree-')));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    await git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# repo\n');
    await git(repo, 'add', '.');
    await git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'init');

    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);
    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    const prismaService = client as unknown as PrismaService;
    jobRepository = new JobRepository(prismaService);
    projectRepository = new ProjectRepository(prismaService);
    worktreeService = new WorktreeService(gitService, jobRepository);

    projectId = (await projectRepository.open(repo, 'repo')).id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('canonicalisation', () => {
    it('resolves the main worktree from the repository root', async () => {
      expect(await gitService.mainWorktree(repo)).toBe(repo);
    });

    it('resolves the main worktree from a subdirectory', async () => {
      const nested = join(repo, 'src', 'deep');
      mkdirSync(nested, { recursive: true });
      expect(await gitService.mainWorktree(nested)).toBe(repo);
    });

    it('resolves the main worktree from INSIDE a linked worktree — the second-project bug', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });

      expect(await gitService.mainWorktree(workspacePath)).toBe(repo);
      // Which is what keeps `Project.path` (@unique) pointing at one row rather than two.
      const opened = await projectRepository.open(
        (await gitService.mainWorktree(workspacePath)) ?? workspacePath,
      );
      expect(opened.id).toBe(projectId);
    });

    it('reports null for a folder that is not a repository, so the caller keeps its own path', async () => {
      const plain = join(dir, 'plain');
      mkdirSync(plain);
      expect(await gitService.mainWorktree(plain)).toBeNull();
    });
  });

  describe('enter', () => {
    it('creates a branch and a worktree named for the job, and records both', async () => {
      const job = await newJob('fix the drain');
      const { branch, workspacePath } = await worktreeService.enter({ job, projectPath: repo });

      expect(branch).toBe(`atlas/fix-the-drain-${job.id.replace(/-/g, '').slice(0, 8)}`);
      expect(workspacePath).toBe(join(repo, '.worktrees', `fix-the-drain-${job.id.replace(/-/g, '').slice(0, 8)}`));
      expect(existsSync(join(workspacePath, 'README.md'))).toBe(true);

      const stored = await jobRepository.findById(job.id);
      expect(stored?.branch).toBe(branch);
      expect(stored?.workspacePath).toBe(workspacePath);
    });

    it('never checks the branch out in the tree the editor has open', async () => {
      const job = await newJob('fix the drain');
      await worktreeService.enter({ job, projectPath: repo });

      const head = await gitService.run({ cwd: repo, args: ['rev-parse', '--abbrev-ref', 'HEAD'] });
      expect(head.stdout.trim()).toBe('main');
    });

    it('leaves the main worktree CLEAN — the worktree dir is excluded, not untracked noise', async () => {
      const job = await newJob('fix the drain');
      await worktreeService.enter({ job, projectPath: repo });

      const status = await gitService.run({ cwd: repo, args: ['status', '--porcelain'] });
      expect(status.stdout.trim()).toBe('');
      expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.worktrees/');
    });

    it('is idempotent — the tool may be called at any time, including twice', async () => {
      const job = await newJob('fix the drain');
      const first = await worktreeService.enter({ job, projectPath: repo });
      const reloaded = await jobRepository.findById(job.id);
      const second = await worktreeService.enter({
        job: reloaded ?? job,
        projectPath: repo,
      });

      expect(second).toEqual(first);
    });

    it('recovers a worktree whose directory was deleted by hand but is still registered', async () => {
      const job = await newJob('fix the drain');
      const first = await worktreeService.enter({ job, projectPath: repo });
      rmSync(first.workspacePath, { recursive: true, force: true });

      const stored = await jobRepository.findById(job.id);
      if (!stored) throw new Error('job vanished');
      // Without `worktree prune`, git still holds the record and `add` refuses this path forever.
      const again = await worktreeService.enter({ job: stored, projectPath: repo });
      expect(again).toEqual(first);
      expect(existsSync(join(again.workspacePath, 'README.md'))).toBe(true);
    });

    it('refuses a folder that is not a repository', async () => {
      const plain = join(dir, 'plain');
      mkdirSync(plain);
      const job = await newJob('fix the drain');
      expect(worktreeService.enter({ job, projectPath: plain })).rejects.toThrow(
        'not a git repository',
      );
    });

    it('keeps two jobs with the same title apart', async () => {
      const one = await worktreeService.enter({ job: await newJob('same'), projectPath: repo });
      const two = await worktreeService.enter({ job: await newJob('same'), projectPath: repo });
      expect(one.workspacePath).not.toBe(two.workspacePath);
    });
  });

  /**
   * `take` — the same operation as `enter`, reached through a tool call, and the door whose absence
   * meant an agent asked for a worktree could only shell out to `git worktree add` and leave
   * `Job.workspacePath` null.
   *
   * What it adds over `enter` is the project lookup and the words. Both are tested here rather than
   * mocked because the project lookup is the part `enter` cannot do for itself — a `ToolContext`
   * carries a job, not a repository.
   */
  describe('take', () => {
    function ctxFor(job: { id: string }): ToolContext {
      return {
        job: job as Job,
        thread: { id: 'thread-1' } as unknown as Thread,
        phase: EPhaseKind.build,
        cwd: repo,
        tier: EToolTier.thread,
      };
    }

    it('resolves the project from the job, takes the worktree, and records it', async () => {
      const job = await newJob('fix the drain');
      const reply = await worktreeService.take({ ctx: ctxFor(job) });

      const stored = await jobRepository.findById(job.id);
      expect(stored?.workspacePath).toBe(join(repo, '.worktrees', worktreeNameFor({ title: 'fix the drain', jobId: job.id })));
      expect(stored?.branch).toBe(`atlas/${worktreeNameFor({ title: 'fix the drain', jobId: job.id })}`);
      expect(existsSync(join(stored?.workspacePath ?? '', 'README.md'))).toBe(true);
      expect(reply).toContain(stored?.workspacePath ?? 'nowhere');
    });

    /**
     * The load-bearing half of the reply. A turn's directory is handed to a subprocess already
     * running in it, so nothing can relocate the agent that made this call — and an agent told only
     * "you have a worktree at X" carries on editing through relative paths that still resolve into
     * the project tree. Every one of those writes lands in the tree it just took a worktree to avoid.
     */
    it('tells the caller it has NOT moved yet, and to stop writing', async () => {
      const reply = await worktreeService.take({ ctx: ctxFor(await newJob('fix the drain')) });
      expect(reply).toContain('You are not in it yet');
      expect(reply).toContain('make no further edits this turn');
    });

    /**
     * Re-entering says so instead, because nothing moved — the turn is already running in the right
     * place, and a "stop writing" it did not need would cost a turn for no reason.
     */
    it('says nothing moved when the job is already standing in its worktree', async () => {
      const job = await newJob('fix the drain');
      await worktreeService.take({ ctx: ctxFor(job) });
      const again = await worktreeService.take({ ctx: ctxFor(job) });

      expect(again).toContain('Already in this worktree');
      expect(again).not.toContain('make no further edits');
    });

    /**
     * The context is resolved once when a thread OPENS and is fixed for its life, so its job is a
     * snapshot: another thread of the same job, or the human through the build confirm, may have
     * taken the worktree since. Trusting the snapshot would mint a SECOND one.
     */
    it('re-reads the job rather than trusting the thread-open snapshot', async () => {
      const job = await newJob('fix the drain');
      const already = await worktreeService.enter({ job, projectPath: repo });

      // The stale context still says the job has no worktree, exactly as a long-lived thread's would.
      const reply = await worktreeService.take({ ctx: ctxFor(job) });

      expect(reply).toContain('Already in this worktree');
      expect((await jobRepository.findById(job.id))?.workspacePath).toBe(already.workspacePath);
      const worktrees = await gitService.worktrees(repo);
      expect(worktrees.filter((tree) => tree.path !== repo)).toHaveLength(1);
    });

    it('refuses a job whose project is not a repository, without recording anything', async () => {
      const plain = join(dir, 'plain');
      mkdirSync(plain);
      const plainProject = await projectRepository.open(plain, 'plain');
      const job = await jobRepository.create({
        projectId: plainProject.id,
        title: 'fix the drain',
        kind: EPhaseKind.charting,
      });

      expect(worktreeService.take({ ctx: ctxFor(job) })).rejects.toThrow('not a git repository');
      expect((await jobRepository.findById(job.id))?.workspacePath).toBeNull();
    });
  });

  describe('cwdFor', () => {
    it('runs a job without a worktree in the project path, exactly as before', async () => {
      const job = await newJob('no worktree');
      expect(worktreeService.cwdFor({ job, projectPath: repo })).toBe(repo);
    });

    it('runs a job that took one in its worktree', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      const stored = await jobRepository.findById(job.id);
      expect(stored).not.toBeNull();
      if (stored) expect(worktreeService.cwdFor({ job: stored, projectPath: repo })).toBe(workspacePath);
    });

    it('refuses to silently fall back when the recorded worktree is gone', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      rmSync(workspacePath, { recursive: true, force: true });
      const stored = await jobRepository.findById(job.id);
      expect(stored).not.toBeNull();
      // Falling back to the project path would run the agent in the very tree the worktree exists
      // to keep it out of.
      if (stored) expect(() => worktreeService.cwdFor({ job: stored, projectPath: repo })).toThrow(/worktree is gone/);
    });
  });

  describe('release', () => {
    it('refuses to remove a worktree holding uncommitted work', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      writeFileSync(join(workspacePath, 'README.md'), '# edited\n');
      const stored = await jobRepository.findById(job.id);
      expect(stored).not.toBeNull();
      if (!stored) return;

      expect(worktreeService.release({ job: stored, projectPath: repo })).rejects.toThrow(
        /uncommitted changes/,
      );
      expect(existsSync(workspacePath)).toBe(true);
    });

    it('refuses over an untracked file too — a new file nobody added is still work', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      writeFileSync(join(workspacePath, 'scratch.md'), 'notes\n');
      const stored = await jobRepository.findById(job.id);
      if (!stored) throw new Error('job vanished');

      expect(worktreeService.release({ job: stored, projectPath: repo })).rejects.toThrow(
        /uncommitted changes/,
      );
    });

    it('removes a clean worktree and clears the path, keeping the branch', async () => {
      const job = await newJob('fix the drain');
      const { branch, workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      const stored = await jobRepository.findById(job.id);
      if (!stored) throw new Error('job vanished');

      await worktreeService.release({ job: stored, projectPath: repo });

      expect(existsSync(workspacePath)).toBe(false);
      const after = await jobRepository.findById(job.id);
      expect(after?.workspacePath).toBeNull();
      // The branch may already carry a pull request; forgetting a directory must not destroy it.
      expect(after?.branch).toBe(branch);
      expect(await gitService.branchExists({ repoPath: repo, branch })).toBe(true);
    });

    it('re-entering after a release reuses the branch rather than failing on it', async () => {
      const job = await newJob('fix the drain');
      const first = await worktreeService.enter({ job, projectPath: repo });
      const released = await jobRepository.findById(job.id);
      if (!released) throw new Error('job vanished');
      await worktreeService.release({ job: released, projectPath: repo });

      const reloaded = await jobRepository.findById(job.id);
      if (!reloaded) throw new Error('job vanished');
      const again = await worktreeService.enter({ job: reloaded, projectPath: repo });
      expect(again.branch).toBe(first.branch);
      expect(existsSync(again.workspacePath)).toBe(true);
    });

    it('does nothing for a job that never took a worktree', async () => {
      const job = await newJob('no worktree');
      await worktreeService.release({ job, projectPath: repo });
      expect((await jobRepository.findById(job.id))?.workspacePath).toBeNull();
    });
  });

  /**
   * Adoption, and the guard that makes it survivable.
   *
   * A hand-made worktree on a `dennis/…` branch is somebody else's tree: Atlas may stand a job in it
   * and must never remove it. These run against real `git worktree add` output for the same reason
   * the rest of the file does — the claim is about what git and the filesystem actually hold.
   */
  describe('adopting a worktree Atlas did not create', () => {
    async function handMade(branch: string): Promise<string> {
      const path = join(dir, 'hand', branch.replace(/\//g, '-'));
      await git(repo, 'worktree', 'add', '-b', branch, path);
      return path;
    }

    it('stands the job in it and records both, minting nothing', async () => {
      const path = await handMade('dennis/eng-203');
      const job = await newJob('risk matrix');

      const workspace = await worktreeService.adopt({
        job,
        branch: 'dennis/eng-203',
        workspacePath: path,
      });

      expect(workspace).toEqual({ branch: 'dennis/eng-203', workspacePath: path });
      const stored = await jobRepository.findById(job.id);
      expect(stored?.branch).toBe('dennis/eng-203');
      expect(stored?.workspacePath).toBe(path);
      // No `atlas/…` branch appeared alongside it — adoption is not `enter()` with a different name.
      expect(await gitService.branchExists({ repoPath: repo, branch: 'atlas/risk-matrix' })).toBe(
        false,
      );
    });

    it('refuses a directory that is not there, rather than recording a cwd that throws', async () => {
      const job = await newJob('risk matrix');
      expect(
        worktreeService.adopt({
          job,
          branch: 'dennis/eng-203',
          workspacePath: join(dir, 'nope'),
        }),
      ).rejects.toThrow('no such worktree');
    });

    it('runs the job’s turns in the adopted tree', async () => {
      const path = await handMade('dennis/eng-203');
      const job = await newJob('risk matrix');
      await worktreeService.adopt({ job, branch: 'dennis/eng-203', workspacePath: path });
      const stored = await jobRepository.findById(job.id);
      expect(stored && worktreeService.cwdFor({ job: stored, projectPath: repo })).toBe(path);
    });

    it('hands the adopted workspace back from enter(), minting no second one', async () => {
      // `enter()` opens by asking whether the job is already in a live worktree. That is what makes
      // the worktree TOOL safe to call on an adopted job — it reports, rather than relocating.
      const path = await handMade('dennis/eng-203');
      const job = await newJob('risk matrix');
      await worktreeService.adopt({ job, branch: 'dennis/eng-203', workspacePath: path });
      const stored = await jobRepository.findById(job.id);
      expect(stored && (await worktreeService.enter({ job: stored, projectPath: repo }))).toEqual({
        branch: 'dennis/eng-203',
        workspacePath: path,
      });
    });

    it('FORGETS an adopted worktree on release and leaves the directory standing', async () => {
      // The hazard this closes: deleting a job removed a tree the human made and may have an editor
      // open on. Consent to delete a job is not consent to delete that.
      const path = await handMade('dennis/eng-203');
      const job = await newJob('risk matrix');
      await worktreeService.adopt({ job, branch: 'dennis/eng-203', workspacePath: path });
      const stored = await jobRepository.findById(job.id);
      if (!stored) throw new Error('job vanished');

      await worktreeService.release({ job: stored, projectPath: repo });

      expect(existsSync(path)).toBe(true);
      expect((await jobRepository.findById(job.id))?.workspacePath).toBeNull();
      expect(await gitService.branchExists({ repoPath: repo, branch: 'dennis/eng-203' })).toBe(true);
    });

    it('forgets a DIRTY adopted worktree too, since nothing is being removed', async () => {
      // The dirty check exists to protect work a removal would eat. Nothing is removed here, so
      // refusing would only block deleting a job over a file the deletion cannot touch.
      const path = await handMade('dennis/eng-203');
      writeFileSync(join(path, 'scratch.txt'), 'in progress\n');
      const job = await newJob('risk matrix');
      await worktreeService.adopt({ job, branch: 'dennis/eng-203', workspacePath: path });
      const stored = await jobRepository.findById(job.id);
      if (!stored) throw new Error('job vanished');

      await worktreeService.release({ job: stored, projectPath: repo });
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(join(path, 'scratch.txt'), 'utf8')).toBe('in progress\n');
    });

    it('still REMOVES a worktree Atlas minted itself', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      const stored = await jobRepository.findById(job.id);
      if (!stored) throw new Error('job vanished');

      await worktreeService.release({ job: stored, projectPath: repo });
      expect(existsSync(workspacePath)).toBe(false);
    });
  });

  describe('releasing a worktree no job is standing in', () => {
    it('removes the directory and leaves the branch behind', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath, branch } = await worktreeService.enter({ job, projectPath: repo });
      // The job goes; its worktree is now an orphan the list draws with `no jobs`.
      await jobRepository.clearWorkspace(job.id);
      await jobRepository.remove(job.id);

      await worktreeService.releasePath({ repoPath: repo, worktreePath: workspacePath });

      expect(existsSync(workspacePath)).toBe(false);
      expect(await gitService.branchExists({ repoPath: repo, branch })).toBe(true);
    });

    it('refuses while a job records it, naming the job — the display cannot know this', async () => {
      // `no jobs` is only true of the list you are LOOKING at. An archived job, or one another
      // terminal made a second ago, records paths this list never showed.
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });

      expect(
        worktreeService.releasePath({ repoPath: repo, worktreePath: workspacePath }),
      ).rejects.toThrow('“fix the drain” is working in that worktree');
      expect(existsSync(workspacePath)).toBe(true);
    });

    it('refuses while an ARCHIVED job records it', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      await jobRepository.setArchived({ jobId: job.id, archived: true });

      expect(
        worktreeService.releasePath({ repoPath: repo, worktreePath: workspacePath }),
      ).rejects.toThrow('is working in that worktree');
    });

    it('refuses while it holds uncommitted work', async () => {
      const job = await newJob('fix the drain');
      const { workspacePath } = await worktreeService.enter({ job, projectPath: repo });
      writeFileSync(join(workspacePath, 'scratch.txt'), 'unsaved\n');
      await jobRepository.clearWorkspace(job.id);
      await jobRepository.remove(job.id);

      expect(
        worktreeService.releasePath({ repoPath: repo, worktreePath: workspacePath }),
      ).rejects.toThrow('uncommitted changes');
      expect(existsSync(workspacePath)).toBe(true);
    });
  });
});
