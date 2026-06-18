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

/** Write + commit one file in a worktree (worktree identity comes from the credential's author). */
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

/** A BARE repo standing in for GitHub origin (file:// URL — `gitAuthEnv` returns {} for it, so no
 * token is needed for the local mechanics). Returns the bare dir + its file:// url. */
async function makeBareOrigin(): Promise<{ dir: string; url: string }> {
  const seed = await makeRepo();
  const dir = join(
    await realpath(await mkdtemp(join(tmpdir(), 'dg-origin-'))),
    'origin.git',
  );
  await git(seed, 'clone', '--bare', seed, dir);
  await rm(seed, { recursive: true, force: true });
  return { dir, url: `file://${dir}` };
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

describe('DaemonGitService (real git, file:// origin)', () => {
  let origin: { dir: string; url: string };
  let workspaceRoot: string;
  let service: DaemonGitService;

  beforeEach(async () => {
    origin = await makeBareOrigin();
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

  it('ensureClone clones the repo once, enables worktree config, and is idempotent', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main');
    expect(root).toBe(await realpath(workspaceRoot));
    expect(await git(root, 'remote', 'get-url', 'origin')).toBe(origin.url);
    expect(await git(root, 'config', 'extensions.worktreeConfig')).toBe('true');
    expect(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    // .workspaces/ is excluded from status noise.
    expect(await readFile(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.workspaces/',
    );
    // A second ensureClone is a no-op (does not re-clone) and returns the same root.
    const headBefore = await git(root, 'rev-parse', 'HEAD');
    expect(await service.ensureClone(workspaceRoot, origin.url, 'main')).toBe(root);
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('createWorktree cuts an isolated agent/<session> branch off the base, with author identity', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main');
    const path = await service.createWorktree('sess-1');
    expect(path).toBe(service.worktreePath('sess-1'));
    expect(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/sess-1');
    // Cut from origin/main, not some stale ref.
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(
      await git(root, 'rev-parse', 'origin/main'),
    );
    // Commits in the worktree are authored as the credential's identity, not the host git config.
    await commit(path, 'work.txt', 'session work\n');
    expect(await git(path, 'log', '-1', '--format=%an <%ae>')).toBe(
      'Agent <agent@agents.noreply>',
    );
    expect(service.listWorktrees().map((w) => w.sessionId)).toEqual(['sess-1']);
  });

  it('isolates sibling sessions: each worktree has its own branch and checkout', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const a = await service.createWorktree('sess-a');
    const b = await service.createWorktree('sess-b');
    expect(a).not.toBe(b);
    await commit(a, 'a.txt', 'from a\n');
    // B never sees A's uncommitted/committed work — separate checkout + branch.
    await expect(readFile(join(b, 'a.txt'), 'utf8')).rejects.toThrow();
    expect(await git(b, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/sess-b');
  });

  it('createWorktree is idempotent for an already-open session', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const first = await service.createWorktree('sess-1');
    const second = await service.createWorktree('sess-1');
    expect(second).toBe(first);
    expect(service.listWorktrees()).toHaveLength(1);
  });

  it('removeWorktree drops the checkout but keeps the branch', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const path = await service.createWorktree('sess-1');
    await commit(path, 'x.txt', 'x\n');
    await service.removeWorktree('sess-1');
    expect(service.worktreePath('sess-1')).toBeUndefined();
    expect(await git(workspaceRoot, 'branch', '--list', 'agent/sess-1')).toContain(
      'agent/sess-1',
    );
    await expect(git(path, 'status')).rejects.toThrow();
  });

  it('ensureShared promotes a session to shared/<slug>, records the association, and pushes via publish', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main');
    const path = await service.createWorktree('sess-1');
    await commit(path, 'a.txt', 'from session\n');

    const shared = await service.ensureShared('sess-1', 'ticket-7');
    expect(shared).toBe('shared/ticket-7');
    expect(
      await git(root, 'config', 'branch.agent/sess-1.agent-shared'),
    ).toBe('shared/ticket-7');

    // sharedRef before publish = the shared branch tip (cut at the session branch tip here).
    const ref = await service.sharedRef('sess-1');
    expect(ref).toBeTruthy();

    const res = await service.publish('sess-1');
    expect(res.integrated).toBe(true);
    expect(res.sharedBranch).toBe('shared/ticket-7');
    expect(res.dirty).toBe(false);
    // Single-repo always has a known origin → publish pushes the shared branch to it.
    expect(res.remote).toEqual({ pushed: true });
    // The session branch is now integrated into shared, and origin received it.
    expect(await git(root, 'rev-parse', 'shared/ticket-7')).toBe(
      await git(path, 'rev-parse', 'HEAD'),
    );
    expect(await git(origin.dir, 'rev-parse', 'shared/ticket-7')).toBe(
      await git(path, 'rev-parse', 'HEAD'),
    );
  });

  it('ensureShared is idempotent and converges sibling sessions on ONE shared branch', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    await service.createWorktree('sess-a');
    await service.createWorktree('sess-b');
    expect(await service.ensureShared('sess-a', 'ticket-7')).toBe('shared/ticket-7');
    // A second session passing a DIFFERENT name still lands on the sandbox's one shared branch.
    expect(await service.ensureShared('sess-b', 'other-name')).toBe('shared/ticket-7');
  });

  it('publish merges a sibling-advanced shared branch in, then publishes both (disjoint files)', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const a = await service.createWorktree('sess-a');
    const b = await service.createWorktree('sess-b');
    await service.ensureShared('sess-a', 'feat');
    await service.ensureShared('sess-b', 'feat');

    await commit(b, 'b.txt', 'b work\n');
    await service.publish('sess-b');
    await commit(a, 'a.txt', 'a work\n');
    const res = await service.publish('sess-a');
    expect(res.integrated).toBe(true);
    const tree = await git(workspaceRoot, 'ls-tree', '--name-only', 'shared/feat');
    expect(tree).toContain('a.txt');
    expect(tree).toContain('b.txt');
  });

  it('publish reports a conflict, leaves the merge IN PROGRESS, and mergeState surfaces it', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const a = await service.createWorktree('sess-a');
    const b = await service.createWorktree('sess-b');
    await service.ensureShared('sess-a', 'feat');
    await service.ensureShared('sess-b', 'feat');

    await commit(b, 'README.md', 'b version\n');
    await service.publish('sess-b');
    await commit(a, 'README.md', 'a version\n');
    const res = await service.publish('sess-a');
    expect(res.integrated).toBe(false);
    expect(res.files).toEqual(['README.md']);

    // mergeState reads the in-progress merge in A's worktree.
    const st = await service.mergeState('sess-a');
    expect(st.inProgress).toBe(true);
    expect(st.files).toContain('README.md');

    // Publishing again before resolving is refused.
    await expect(service.publish('sess-a')).rejects.toThrow(
      /merge is already in progress/i,
    );
  });

  it('pull takes a sibling-published change into the worktree', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const a = await service.createWorktree('sess-a');
    const b = await service.createWorktree('sess-b');
    await service.ensureShared('sess-a', 'feat');
    await service.ensureShared('sess-b', 'feat');

    await commit(b, 'b.txt', 'b work\n');
    await service.publish('sess-b');
    const res = await service.pull('sess-a');
    expect(res.integrated).toBe(true);
    expect(await git(a, 'ls-tree', '--name-only', 'HEAD')).toContain('b.txt');
  });

  it('publish/pull refuse a session that is not on a shared branch', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    await service.createWorktree('sess-1');
    await expect(service.publish('sess-1')).rejects.toThrow(/not on a shared branch/i);
    await expect(service.pull('sess-1')).rejects.toThrow(/not on a shared branch/i);
  });

  it('ensureSharedAtBase cuts at the base divergence point so ownerDiff is non-empty', async () => {
    const root = await service.ensureClone(workspaceRoot, origin.url, 'main');
    const path = await service.createWorktree('sess-1');
    await commit(path, 'owner.txt', 'owner work\n');
    const base = await git(root, 'rev-parse', 'origin/main');

    const res = await service.ensureSharedAtBase('sess-1', 'ticket-9');
    expect(res).toEqual({ ok: true, sharedBranch: 'shared/ticket-9' });
    // Cut at the merge-base (origin/main), NOT the branch tip (which would make the diff empty).
    expect(await git(root, 'rev-parse', 'shared/ticket-9')).toBe(base);

    const ref = await service.sharedRef('sess-1');
    expect(ref).toBe(base);
    const diff = await service.ownerDiff('sess-1', ref!);
    expect(diff.range).toBe(`${base}...agent/sess-1`);
    expect(diff.files).toContain('owner.txt');
  });

  it('refreshFromBase merges origin base advances into the session worktree', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const path = await service.createWorktree('sess-1');
    await commit(path, 'local.txt', 'local\n');

    // Advance origin/main behind the session's back (stand-in for "Dennis merged a PR").
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dg-adv-')));
    await git(scratch, 'clone', origin.dir, 'c');
    const oc = join(scratch, 'c');
    await git(oc, 'config', 'user.email', 'o@test');
    await git(oc, 'config', 'user.name', 'o');
    await commit(oc, 'merged.txt', 'from main\n');
    await git(oc, 'push', 'origin', 'main');
    await rm(scratch, { recursive: true, force: true });

    const res = await service.refreshFromBase('sess-1');
    expect(res.refreshed).toBe(true);
    expect(res.baseBranch).toBe('main');
    expect(await readFile(join(path, 'local.txt'), 'utf8')).toBe('local\n');
    expect(await readFile(join(path, 'merged.txt'), 'utf8')).toBe('from main\n');
  });

  it('refreshFromBase reports a DIRTY tree and skips the merge (no clobber)', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const path = await service.createWorktree('sess-1');
    await writeFile(join(path, 'README.md'), 'uncommitted\n');
    const res = await service.refreshFromBase('sess-1');
    expect(res.refreshed).toBe(false);
    expect(res.dirty).toBe(true);
    expect(res.baseBranch).toBe('main');
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('uncommitted\n');
  });

  it('pushSharedToOrigin pushes the shared branch and is idempotent', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const path = await service.createWorktree('sess-1');
    await commit(path, 'a.txt', 'work\n');
    await service.ensureShared('sess-1', 'feat');
    await expect(service.pushSharedToOrigin('sess-1')).resolves.toEqual({
      sharedBranch: 'shared/feat',
      gitUrl: origin.url,
    });
    // A second push (already up to date) is fine.
    await expect(service.pushSharedToOrigin('sess-1')).resolves.toBeDefined();
    expect(await git(origin.dir, 'rev-parse', 'shared/feat')).toBeTruthy();
  });

  it('errors loudly before a clone exists, and for unknown sessions', async () => {
    await expect(service.createWorktree('sess-1')).rejects.toThrow(/No clone yet/i);
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    await expect(service.removeWorktree('nope')).rejects.toThrow(/No worktree/i);
    expect((await service.mergeState('nope')).inProgress).toBe(false);
  });

  it('ensureReferenceClone makes a read-only shallow clone of another repo at an in-sandbox path', async () => {
    await service.ensureClone(workspaceRoot, origin.url, 'main');
    const other = await makeBareOrigin();
    try {
      const ref = await service.ensureReferenceClone({ gitUrl: other.url });
      expect(ref.gitUrl).toBe(other.url);
      // The path is INSIDE the sandbox clone (.refs/), and is a real checkout.
      expect(ref.path.startsWith(await realpath(workspaceRoot))).toBe(true);
      expect(await readFile(join(ref.path, 'README.md'), 'utf8')).toBe('hello\n');
      // Shallow.
      expect(await git(ref.path, 'rev-parse', '--is-shallow-repository')).toBe('true');
      // A second call refreshes the same path (idempotent).
      const again = await service.ensureReferenceClone({ gitUrl: other.url });
      expect(again.path).toBe(ref.path);
    } finally {
      await rm(join(other.dir, '..'), { recursive: true, force: true });
    }
  });
});
