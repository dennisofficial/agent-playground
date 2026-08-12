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
import { PrismaClient } from '../../generated/prisma/client.js';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { JobRepository } from '../../store/job.repository.js';
import { MigratorService } from '../../store/migrator.service.js';
import type { PrismaService } from '../../store/prisma.service.js';
import { ProjectRepository } from '../../store/project.repository.js';
import { GitService } from '../git.service.js';
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
});
