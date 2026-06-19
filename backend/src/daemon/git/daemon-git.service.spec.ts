import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GithubApiService } from '@harness/projects/github-api.service';
import { DaemonGitService } from './daemon-git.service';
import type {
  GitCredentialProvider,
  ResolvedGitCredential,
} from './git-credential.provider';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Write + commit one file in a checkout (identity comes from the credential's author). */
async function commit(
  checkout: string,
  file: string,
  content: string,
): Promise<void> {
  await writeFile(join(checkout, file), content);
  await git(checkout, 'add', file);
  await git(checkout, 'commit', '-m', `edit ${file}`);
}

/** A throwaway real git repo seeded with one commit on `main`. */
async function makeRepo(): Promise<string> {
  // realpath: macOS tmpdir is symlinked (/var → /private/var) and git reports resolved paths.
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'dg-spec-')));
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

/** A BARE repo standing in for GitHub origin (file:// URL — `gitAuthEnv` returns {} for it, so no token
 * is needed for the local mechanics). Returns the bare dir + its file:// url. Optionally seeds extra
 * branches off `main` (e.g. a `dev` upstream). */
async function makeBareOrigin(
  branches: string[] = [],
): Promise<{ dir: string; url: string }> {
  const seed = await makeRepo();
  for (const b of branches) {
    await git(seed, 'branch', b);
  }
  const dir = join(
    await realpath(await mkdtemp(join(tmpdir(), 'dg-origin-'))),
    'origin.git',
  );
  await git(seed, 'clone', '--bare', seed, dir);
  await rm(seed, { recursive: true, force: true });
  return { dir, url: `file://${dir}` };
}

/** Advance a branch on the bare origin behind the daemon's back (stand-in for a teammate pushing). */
async function advanceOriginBranch(
  origin: { dir: string },
  branch: string,
  file: string,
  content: string,
): Promise<void> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dg-adv-')));
  await git(scratch, 'clone', origin.dir, 'c');
  const oc = join(scratch, 'c');
  await git(oc, 'config', 'user.email', 'o@test');
  await git(oc, 'config', 'user.name', 'o');
  await git(oc, 'checkout', branch);
  await commit(oc, file, content);
  await git(oc, 'push', 'origin', branch);
  await rm(scratch, { recursive: true, force: true });
}

const CRED: ResolvedGitCredential = {
  token: '',
  authorName: 'Agent',
  authorEmail: 'agent@agents.noreply',
};

const fakeCredentials: GitCredentialProvider = {
  resolve: async () => CRED,
};

function makeService(): DaemonGitService {
  return new DaemonGitService(fakeCredentials, new GithubApiService());
}

describe('DaemonGitService — per-branch workstation (real git, file:// origin)', () => {
  let origin: { dir: string; url: string };
  let workspaceRoot: string;
  let service: DaemonGitService;

  beforeEach(async () => {
    origin = await makeBareOrigin(['dev']);
    workspaceRoot = join(
      await realpath(await mkdtemp(join(tmpdir(), 'dg-ws-'))),
      'repo',
    );
    service = makeService();
  });

  afterEach(async () => {
    await rm(join(origin.dir, '..'), { recursive: true, force: true });
    await rm(join(workspaceRoot, '..'), { recursive: true, force: true });
  });

  // ── boot checkout ────────────────────────────────────────────────────────────────────────────

  it('ensureClone (no opts) checks out the base branch directly and is idempotent', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main');
    expect(root).toBe(await realpath(workspaceRoot));
    expect(await git(root, 'remote', 'get-url', 'origin')).toBe(origin.url);
    expect(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(service.root()).toBe(root);
    expect(service.branch()).toBe('main');
    // A second ensureClone is a no-op (does not re-clone) and returns the same root.
    const headBefore = await git(root, 'rev-parse', 'HEAD');
    expect(await service.ensureClone(workspaceRoot, origin.url, 'main')).toBe(root);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('ensureClone CREATES a fresh branch from the base ref, pushes it -u, and records upstream/base', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/search',
      baseRef: 'dev',
      upstream: 'dev',
    });
    // Checked out directly on the new branch.
    expect(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feature/search',
    );
    // Cut from origin/dev (the base ref), not main.
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(
      await git(root, 'rev-parse', 'origin/dev'),
    );
    // Pushed up so the team converges on it.
    expect(await git(origin.dir, 'rev-parse', 'feature/search')).toBe(
      await git(root, 'rev-parse', 'HEAD'),
    );
    // Durable association recorded on the branch (recovered on a restart).
    expect(
      await git(root, 'config', 'branch.feature/search.agent-upstream'),
    ).toBe('dev');
    expect(
      await git(root, 'config', 'branch.feature/search.agent-base'),
    ).toBe('dev');
    expect(service.branch()).toBe('feature/search');
  });

  it('ensureClone CHECKS OUT an EXISTING origin branch tracking it (no fresh cut)', async () => {
    // Seed the branch on origin first (a teammate already created it).
    await advanceOriginBranch(origin, 'main', 'pre.txt', 'pre\n');
    const seeded = await makeBareOrigin();
    // Build feature/login on `seeded`'s origin via a scratch clone, then point at it.
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dg-seed-')));
    await git(scratch, 'clone', seeded.dir, 'c');
    const oc = join(scratch, 'c');
    await git(oc, 'config', 'user.email', 'o@test');
    await git(oc, 'config', 'user.name', 'o');
    await git(oc, 'checkout', '-b', 'feature/login');
    await commit(oc, 'login.ts', 'export const login = 1;\n');
    await git(oc, 'push', '-u', 'origin', 'feature/login');
    await rm(scratch, { recursive: true, force: true });

    try {
      const root = await service.ensureClone(
        workspaceRoot,
        seeded.url,
        'main',
        { branch: 'feature/login', baseRef: 'main', upstream: 'main' },
      );
      expect(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
        'feature/login',
      );
      // It tracks origin/feature/login and has the teammate's commit.
      expect(await readFile(join(root, 'login.ts'), 'utf8')).toBe(
        'export const login = 1;\n',
      );
      expect(await git(root, 'rev-parse', 'HEAD')).toBe(
        await git(root, 'rev-parse', 'origin/feature/login'),
      );
    } finally {
      await rm(join(seeded.dir, '..'), { recursive: true, force: true });
    }
  });

  it('a RESTARTED daemon over the same clone re-adopts the branch + upstream (idempotent ensureClone)', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/x',
      baseRef: 'dev',
      upstream: 'dev',
    });
    // A FRESH service over the SAME clone (a daemon restart): ensureClone is a no-op re-attach.
    const restarted = makeService();
    const root = await restarted.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/x',
      baseRef: 'dev',
      upstream: 'dev',
    });
    expect(restarted.branch()).toBe('feature/x');
    expect(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'feature/x',
    );
  });

  it('commits in the checkout are authored as the credential identity, not the host git config', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/auth',
      baseRef: 'main',
      upstream: 'main',
    });
    await commit(root, 'work.txt', 'session work\n');
    expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe(
      'Agent <agent@agents.noreply>',
    );
  });

  // ── publish (push the branch to origin) ────────────────────────────────────────────────────────

  it('publish pushes the workstation branch to origin (no shared branch)', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/pub',
      baseRef: 'dev',
      upstream: 'dev',
    });
    await commit(root, 'a.txt', 'from session\n');
    const res = await service.publish();
    expect(res.integrated).toBe(true);
    expect(res.sharedBranch).toBe('feature/pub');
    expect(res.dirty).toBe(false);
    expect(res.remote).toEqual({ pushed: true });
    // Origin received the branch tip.
    expect(await git(origin.dir, 'rev-parse', 'feature/pub')).toBe(
      await git(root, 'rev-parse', 'HEAD'),
    );
  });

  it('publish reports dirty when there are uncommitted changes (only commits are pushed)', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/dirty',
      baseRef: 'main',
      upstream: 'main',
    });
    await commit(root, 'a.txt', 'committed\n');
    await writeFile(join(root, 'b.txt'), 'uncommitted\n');
    const res = await service.publish();
    expect(res.integrated).toBe(true);
    expect(res.dirty).toBe(true);
    // Only the committed file reached origin.
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dg-chk-')));
    await git(scratch, 'clone', origin.dir, 'c');
    const oc = join(scratch, 'c');
    await git(oc, 'checkout', 'feature/dirty');
    expect(await readFile(join(oc, 'a.txt'), 'utf8')).toBe('committed\n');
    await expect(readFile(join(oc, 'b.txt'), 'utf8')).rejects.toThrow();
    await rm(scratch, { recursive: true, force: true });
  });

  it('publish reports a REJECTED push (teammate advanced origin) without force-pushing', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/race',
      baseRef: 'main',
      upstream: 'main',
    });
    await commit(root, 'mine.txt', 'mine\n');
    await service.publish(); // establish the branch on origin
    // A teammate pushes another commit onto the SAME branch.
    await advanceOriginBranch(origin, 'feature/race', 'theirs.txt', 'theirs\n');
    // Local advances independently → a non-fast-forward push is rejected (NOT forced).
    await commit(root, 'mine2.txt', 'mine2\n');
    const res = await service.publish();
    expect(res.integrated).toBe(false);
    expect(res.remote?.pushed).toBe(false);
    // Origin still has the teammate's commit (we did not clobber it).
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dg-chk2-')));
    await git(scratch, 'clone', origin.dir, 'c');
    const oc = join(scratch, 'c');
    await git(oc, 'checkout', 'feature/race');
    expect(await readFile(join(oc, 'theirs.txt'), 'utf8')).toBe('theirs\n');
    await rm(scratch, { recursive: true, force: true });
  });

  // ── pull (merge teammates' work on the same branch from origin) ────────────────────────────────

  it('pull merges a teammate-advanced branch from origin into the checkout', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/team',
      baseRef: 'main',
      upstream: 'main',
    });
    await commit(root, 'mine.txt', 'mine\n');
    await service.publish();
    await advanceOriginBranch(origin, 'feature/team', 'teammate.txt', 'theirs\n');
    const res = await service.pull();
    expect(res.integrated).toBe(true);
    expect(res.sharedBranch).toBe('feature/team');
    expect(res.originFetched).toBe(true);
    expect(await readFile(join(root, 'teammate.txt'), 'utf8')).toBe('theirs\n');
    // Local work is preserved.
    expect(await readFile(join(root, 'mine.txt'), 'utf8')).toBe('mine\n');
  });

  it('pull reports a CONFLICT, leaves the merge IN PROGRESS, and mergeState surfaces it', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/conflict',
      baseRef: 'main',
      upstream: 'main',
    });
    await commit(root, 'README.md', 'mine version\n');
    await service.publish();
    // Teammate edits the SAME file on origin.
    await advanceOriginBranch(origin, 'feature/conflict', 'README.md', 'their version\n');
    // Local diverges on the same file too.
    await commit(root, 'README.md', 'my divergent version\n');
    const res = await service.pull();
    expect(res.integrated).toBe(false);
    expect(res.files).toEqual(['README.md']);

    const st = await service.mergeState();
    expect(st.inProgress).toBe(true);
    expect(st.files).toContain('README.md');

    // Pulling again before resolving is refused.
    await expect(service.pull()).rejects.toThrow(/merge is already in progress/i);
  });

  // ── refreshFromBase (merge the upstream in) ────────────────────────────────────────────────────

  it('refreshFromBase merges origin/<upstream> advances into the checkout', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/refresh',
      baseRef: 'dev',
      upstream: 'dev',
    });
    await commit(root, 'local.txt', 'local\n');
    // Advance the UPSTREAM (dev) behind the daemon's back (a PR merged into dev).
    await advanceOriginBranch(origin, 'dev', 'merged.txt', 'from dev\n');

    const res = await service.refreshFromBase();
    expect(res.refreshed).toBe(true);
    expect(res.baseBranch).toBe('dev');
    expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('local\n');
    expect(await readFile(join(root, 'merged.txt'), 'utf8')).toBe('from dev\n');
  });

  it('refreshFromBase reports a DIRTY tree and skips the merge (no clobber)', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/dirtyrefresh',
      baseRef: 'dev',
      upstream: 'dev',
    });
    await writeFile(join(root, 'README.md'), 'uncommitted\n');
    const res = await service.refreshFromBase();
    expect(res.refreshed).toBe(false);
    expect(res.dirty).toBe(true);
    expect(res.baseBranch).toBe('dev');
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('uncommitted\n');
  });

  // ── reviewRange / ownerDiff (diff against the upstream merge-base) ──────────────────────────────

  it('reviewRange diffs the branch since its merge-base with the upstream', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/review',
      baseRef: 'dev',
      upstream: 'dev',
    });
    const cut = await git(root, 'rev-parse', 'origin/dev');
    await commit(root, 'feature.ts', 'export const x = 1;\n');
    await commit(root, 'helper.ts', 'export const y = 2;\n');

    const rr = await service.reviewRange();
    expect(rr.baseBranch).toBe('dev');
    // The range is <merge-base(branch, dev)>...<branch> — the cut point against the upstream.
    expect(rr.range).toBe(`${cut}...feature/review`);
    expect(rr.files.sort()).toEqual(['feature.ts', 'helper.ts']);
  });

  it('reviewRange does NOT widen when the upstream advances after the cut (uses the merge-base)', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/stable',
      baseRef: 'dev',
      upstream: 'dev',
    });
    const cut = await git(root, 'rev-parse', 'origin/dev');
    await commit(root, 'mine.ts', 'mine\n');
    // Advance the upstream after the branch was cut (a teammate merged into dev).
    await advanceOriginBranch(origin, 'dev', 'theirs.ts', 'theirs\n');

    const rr = await service.reviewRange();
    // The diff base is the merge-base (the divergence point), so the advanced upstream file is NOT in scope.
    expect(rr.range).toBe(`${cut}...feature/stable`);
    expect(rr.files).toEqual(['mine.ts']);
  });

  it('ownerDiff isolates the branch contribution against an arbitrary ref', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main', {
      branch: 'feature/diff',
      baseRef: 'main',
      upstream: 'main',
    });
    const base = await git(root, 'rev-parse', 'HEAD');
    await commit(root, 'owner.txt', 'owner work\n');
    const diff = await service.ownerDiff(base);
    expect(diff.range).toBe(`${base}...feature/diff`);
    expect(diff.files).toContain('owner.txt');
  });

  // ── errors / reference clones / design / orientation ───────────────────────────────────────────

  it('errors loudly before a clone exists', async () => {
    await expect(service.publish()).rejects.toThrow(/No clone yet/i);
    expect((await service.mergeState()).inProgress).toBe(false);
  });

  it('ensureReferenceClone makes a read-only shallow clone of another repo at an in-sandbox path', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const other = await makeBareOrigin();
    try {
      const ref = await service.ensureReferenceClone({ gitUrl: other.url });
      expect(ref.gitUrl).toBe(other.url);
      expect(ref.path.startsWith(await realpath(workspaceRoot))).toBe(true);
      expect(await readFile(join(ref.path, 'README.md'), 'utf8')).toBe('hello\n');
      expect(await git(ref.path, 'rev-parse', '--is-shallow-repository')).toBe('true');
      const again = await service.ensureReferenceClone({ gitUrl: other.url });
      expect(again.path).toBe(ref.path);
    } finally {
      await rm(join(other.dir, '..'), { recursive: true, force: true });
    }
  });

  it('attachDesign unzips a base64 artifact into the checkout root design/', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main');
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dg-design-')));
    await writeFile(join(scratch, 'spec.md'), '# design\n');
    await execFileAsync('zip', ['-j', join(scratch, 'd.zip'), join(scratch, 'spec.md')]);
    const b64 = (await readFile(join(scratch, 'd.zip'))).toString('base64');
    await rm(scratch, { recursive: true, force: true });

    const res = await service.attachDesign(b64);
    expect(res.ok).toBe(true);
    expect(await readFile(join(root, 'design', 'spec.md'), 'utf8')).toBe('# design\n');
  });

  it('attachDesign returns a structured failure (never throws) for a bad artifact', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const res = await service.attachDesign('not-a-zip');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/couldn't unzip/i);
  });

  it('referenceOrientation summarizes an in-sandbox reference clone (top level + README head)', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const other = await makeBareOrigin();
    try {
      const ref = await service.ensureReferenceClone({ gitUrl: other.url });
      const orient = await service.referenceOrientation(ref.path);
      expect(orient).toContain('Top level:');
      expect(orient).toContain('README.md');
      expect(orient).toContain('hello');
    } finally {
      await rm(join(other.dir, '..'), { recursive: true, force: true });
    }
  });
});
