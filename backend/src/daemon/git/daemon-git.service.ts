import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  GithubApiService,
  type PullRequestResult,
} from '@harness/projects/github-api.service';
import {
  gitAuthEnv,
  parseGithubRepo,
  sameGitUrl,
} from '@harness/projects/git-auth';
import {
  GIT_CREDENTIAL_PROVIDER,
  type GitCredentialProvider,
  type ResolvedGitCredential,
} from './git-credential.provider';

const execFileAsync = promisify(execFile);

// Branch-config key recording the per-session branch's shared integration branch — same key the host
// `WorkspaceService` uses, so the on-disk semantics are identical. (Single-repo: there's really one
// shared branch, but recording it per-branch keeps the host's durable-association shape.)
const SHARED_CONFIG_KEY = 'agent-shared';

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

/** Turn a session id (or shared-branch input) into a short, branch/dir-safe slug. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'work'
  );
}

/** A per-WORK-AREA git worktree inside the sandbox's single clone. One work area = one branch/worktree;
 * the SESSIONS in a work area share it (so a review session sees the build session's tree). */
export interface DaemonWorktree {
  /** The work area this worktree belongs to (its key) — the host's `workAreaId` (`wa-<uuid>`). */
  workAreaId: string;
  /** The branch checked out in it. */
  branch: string;
  /** The on-disk checkout path — the engine's cwd. */
  path: string;
  /** The base sha the worktree was CUT FROM (`origin/<base>` at create time). The durable diff base
   * for `reviewRange` — matches the host `WorkspaceService` semantics of diffing against the recorded
   * cut point rather than the live origin head (which may have advanced since the cut). */
  baseSha: string;
}

/** The outcome of a publish/pull against the workspace's shared integration branch (mirrors the
 * host `IntegrationResult`, minus the multi-repo `remote.detail` nuance — single-repo always has a
 * known origin, so publish reports a plain push outcome). */
export interface DaemonIntegrationResult {
  integrated: boolean;
  sharedBranch: string;
  /** Conflicted paths when `integrated` is false — the merge is left IN PROGRESS in the worktree so
   * a session's next turn resolves and commits it. */
  files?: string[];
  /** Publish only: the worktree had uncommitted changes — those were NOT published (only commits do). */
  dirty?: boolean;
  /** Publish only: whether the shared branch was also pushed to origin. */
  remote?: { pushed: boolean; detail?: string };
  /** Pull only: whether the shared ref was first fast-forwarded from origin. */
  originFetched?: boolean;
}

/** The outcome of refreshing a session's branch against the workspace's base branch. */
export interface DaemonBaseRefreshResult {
  refreshed: boolean;
  baseBranch?: string;
  conflicted?: boolean;
  dirty?: boolean;
  files?: string[];
  detail?: string;
}

/**
 * The DAEMON's single-repo git owner — the in-container counterpart to the host `WorkspaceService`.
 *
 * ONE container = ONE fresh clone of ONE repo (at `WORKSPACE_ROOT`). The host service is multi-project
 * + registry-heavy (it resolves a repo per `(team, project)`, clones managed copies under REPOS_ROOT,
 * re-adopts workspaces across many repos, runs an origin-IDENTITY guard because a workspace may carry
 * the wrong repo's origin). NONE of that machinery exists here: the daemon's clone is the project, by
 * construction. So this service keeps the proven git PRIMITIVES (worktree add/identity, shared-branch
 * publish/pull/merge, base refresh, owner diff, the `.git/info/exclude` write) and drops the rest.
 *
 * The agent-facing unit is the SESSION: each coding session gets its own `git worktree` (branch
 * `agent/<workAreaId>`) under `<clone>/.workspaces/<workAreaId>`, isolated from sibling sessions. The
 * shared-branch model is preserved but collapsed to ONE shared branch for the whole sandbox: sessions
 * `publish` their committed work onto it and the workspace ships ONE PR (shared → origin).
 *
 * Credential resolution is behind `GitCredentialProvider` (PAT today, GitHub-App later) — `resolve()`
 * is called immediately before each authenticated op so a short-lived token is always current. The
 * origin-identity guard from the host is kept (`sameGitUrl`) as a defense-in-depth check before any
 * push: the daemon's clone origin should BE `gitUrl`, but we never push to an origin that drifted.
 *
 * NOT a Nest lifecycle hook: there's no boot adoption (the container is created fresh; `ensureClone`
 * is the explicit entry point the readiness path calls). All git ops here assume single-threaded
 * daemon use per session; the host's gitOps mutex is unnecessary because the Redis consumer loop
 * (Phase 5) serializes commands per workspace.
 */
@Injectable()
export class DaemonGitService {
  private readonly logger = new Logger(DaemonGitService.name);
  /** Set once `ensureClone` runs — the cloned repo root + its base branch + origin URL. */
  private repo?: { root: string; baseBranch: string; gitUrl: string };
  /** The single shared integration branch for this sandbox, once a session has promoted one. */
  private sharedBranch?: string;
  /** Live per-session worktrees, keyed by session id. */
  private readonly worktrees = new Map<string, DaemonWorktree>();
  /** Resolves once the boot clone (`ensureClone`) has completed — the readiness gate and the turn path
   * await this so no worktree op runs against a not-yet-cloned repo. Settled by `markCloned`/`markCloneFailed`,
   * which `DaemonBootstrapService` calls. Undefined until `expectClone()` is told a clone is coming. */
  private cloneGate?: Promise<void>;
  private resolveCloneGate?: () => void;
  private rejectCloneGate?: (err: Error) => void;

  constructor(
    @Inject(GIT_CREDENTIAL_PROVIDER)
    private readonly credentials: GitCredentialProvider,
    private readonly github: GithubApiService,
  ) {}

  // ---- low-level git exec (mirrors the host's private git() helper) -------------------------------

  private async git(
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 1024 * 1024,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    return stdout.trim();
  }

  private requireRepo(): { root: string; baseBranch: string; gitUrl: string } {
    if (!this.repo) {
      throw new Error(
        'No clone yet — call ensureClone(gitUrl, baseBranch) before any worktree/git op.',
      );
    }
    return this.repo;
  }

  private requireWorktree(workAreaId: string): DaemonWorktree {
    const wt = this.worktrees.get(workAreaId);
    if (!wt) throw new Error(`No worktree for session "${workAreaId}".`);
    return wt;
  }

  /** The git auth env for one authenticated op against this clone's origin — token resolved JUST NOW
   * (so a GitHub-App impl mints a fresh short-lived token per call). TOLERANT of a missing credential:
   * a PUBLIC repo resolves no token, so fetch/clone carry no auth header (returns {}); a private op then
   * fails at git with a legible auth error rather than here. */
  private async authEnv(): Promise<Record<string, string>> {
    const cred = await this.credentials.resolve().catch(() => undefined);
    return gitAuthEnv(this.requireRepo().gitUrl, cred?.token);
  }

  /** The remote-op identity guard: the clone's origin must still BE the configured `gitUrl`. By
   * construction it is (we cloned it), but a drifted origin must never be pushed to with the token. */
  private async originGuard(): Promise<string | undefined> {
    const { root, gitUrl } = this.requireRepo();
    const origin = await this.git(
      ['remote', 'get-url', 'origin'],
      root,
    ).catch(() => '');
    if (!origin) return `This clone has no origin remote (expected ${gitUrl}).`;
    if (!sameGitUrl(origin, gitUrl)) {
      return `This clone's origin (${origin}) isn't the configured repo (${gitUrl}) — refusing to push.`;
    }
    return undefined;
  }

  // ---- clone lifecycle ---------------------------------------------------------------------------

  /**
   * The fresh clone the whole sandbox is built around: clone `gitUrl` into `WORKSPACE_ROOT` (idempotent
   * — skips when `.git` already exists), populate submodules, and enable per-worktree config so each
   * session's worktree can carry its own author identity. Records the base branch + origin for every
   * later op. Returns the cloned repo root.
   */
  async ensureClone(
    workspaceRoot: string,
    gitUrl: string,
    baseBranch: string,
  ): Promise<string> {
    if (!(await exists(join(workspaceRoot, '.git')))) {
      const parent = join(workspaceRoot, '..');
      await mkdir(parent, { recursive: true });
      // Resolve the credential, but TOLERATE its absence — a PUBLIC repo needs no token, so a
      // credential-resolution failure (host has no PAT for the project, or the cred channel refused)
      // must not block a public clone. `gitAuthEnv` already returns {} for an empty/undefined token, so
      // a no-token clone simply carries no auth header. A genuinely PRIVATE repo then fails at the clone
      // itself with git's own "Authentication failed", which is the correct, legible error.
      const cred = await this.credentials.resolve().catch((err) => {
        this.logger.warn(
          `no git credential resolved (${err instanceof Error ? err.message : String(err)}) — ` +
            `attempting an UNAUTHENTICATED clone (works for a public repo).`,
        );
        return undefined;
      });
      const auth = gitAuthEnv(gitUrl, cred?.token);
      this.logger.log(`cloning ${gitUrl} (base ${baseBranch}) → ${workspaceRoot}`);
      await this.git(
        ['clone', '--branch', baseBranch, gitUrl, workspaceRoot],
        parent,
        auth,
      );
      // Submodules must be populated before any session builds (a fresh checkout gets empty submodule
      // dirs → TS2307 on workspace packages). Authenticated (private submodules) + recursive.
      await this.git(
        ['submodule', 'update', '--init', '--recursive'],
        workspaceRoot,
        auth,
      ).catch((err) =>
        this.logger.error(
          `submodule init failed in ${workspaceRoot} — workspace packages may be unresolved: ${err}`,
        ),
      );
      // Per-session worktrees carry their own author identity via worktree-scoped config.
      await this.git(
        ['config', 'extensions.worktreeConfig', 'true'],
        workspaceRoot,
      );
      // Keep per-session checkouts out of `git status` noise without touching the repo's own files.
      await appendFile(
        join(workspaceRoot, '.git', 'info', 'exclude'),
        '\n.workspaces/\n',
      ).catch(() => {});
    }
    const root = await realpath(workspaceRoot);
    const origin = await this.git(['remote', 'get-url', 'origin'], root).catch(
      () => gitUrl,
    );
    this.repo = { root, baseBranch, gitUrl: origin || gitUrl };
    // Re-adopt any work-area worktrees that survived a daemon restart (the in-memory map is empty after
    // a restart, but `.workspaces/<workAreaId>` checkouts persist on the writable layer).
    await this.adoptWorktrees();
    return root;
  }

  // ---- clone-readiness gate ----------------------------------------------------------------------
  //
  // The boot clone (`DaemonBootstrapService`) runs asynchronously after the DI graph is up. The
  // readiness marker must not be written — and a turn's `createWorktree` must not run — until that
  // clone has completed. These three methods coordinate that: `expectClone()` arms the gate the moment
  // the bootstrapper knows a clone is coming, `markCloned`/`markCloneFailed` settle it, and
  // `whenCloned()` is what readiness + the turn path await. With NO clone expected (a dev/standalone
  // daemon whose repo is already present, or a fixture), the gate resolves immediately.

  /** Arm the clone gate — called by `DaemonBootstrapService` before it starts the boot clone, so any
   * early `whenCloned()` awaits the in-flight clone rather than resolving prematurely. Idempotent. */
  expectClone(): void {
    if (this.cloneGate) return;
    this.cloneGate = new Promise<void>((resolve, reject) => {
      this.resolveCloneGate = resolve;
      this.rejectCloneGate = reject;
    });
  }

  /** Settle the clone gate as successful (boot clone finished). No-op if not armed. */
  markCloned(): void {
    this.resolveCloneGate?.();
  }

  /** Settle the clone gate as failed (boot clone threw) — `whenCloned()` then rejects, so readiness
   * signals WITHOUT a clone and a turn fails loudly instead of running against a missing repo. */
  markCloneFailed(err: Error): void {
    this.rejectCloneGate?.(err);
  }

  /** Await the boot clone. Resolves immediately when no clone is expected (gate never armed); otherwise
   * settles when `markCloned`/`markCloneFailed` is called. The turn path + readiness gate await this. */
  async whenCloned(): Promise<void> {
    if (this.cloneGate) await this.cloneGate;
  }

  /** Where per-work-area worktrees live inside the clone. */
  private worktreesDir(): string {
    return join(this.requireRepo().root, '.workspaces');
  }

  // ---- per-work-area worktrees -------------------------------------------------------------------

  /**
   * Realize the work area's worktree and `git worktree add` it at `.workspaces/<workAreaId>` — the dir is
   * the workAreaId VERBATIM (`wa-<uuid>`, already path-safe) so the daemon can re-adopt worktrees from
   * `git worktree list --porcelain` after a restart. Idempotent for an already-open work area (returns its
   * path) — this is what makes the SESSIONS in a work area share one worktree. Mirrors the host
   * `WorkspaceService.create` branch/shared sequencing:
   *  - opts.branch  → check out this existing branch, else create it; default `agent/[owner/]<workAreaId>`.
   *  - opts.shared  → join/start the sandbox's shared integration branch; the personal branch is cut FROM
   *                   its tip so everyone on the feature starts from the same base.
   *  - opts.ownerBot → folded into the default branch name for readability.
   */
  async createWorktree(
    workAreaId: string,
    opts: { branch?: string; shared?: string; ownerBot?: string } = {},
  ): Promise<string> {
    const existing = this.worktrees.get(workAreaId);
    if (existing) return existing.path;
    if (opts.branch?.startsWith('shared/')) {
      throw new Error(
        'Shared branches are never checked out — pass `shared` to join one, not `branch`.',
      );
    }
    const { root } = this.requireRepo();
    const checkout = join(this.worktreesDir(), workAreaId);
    await mkdir(this.worktreesDir(), { recursive: true });

    // Resolve the shared integration branch (single-repo: the FIRST shared branch wins for the sandbox).
    let shared = opts.shared
      ? (this.sharedBranch ?? this.sharedBranchName(opts.shared))
      : undefined;
    const freshBase = await this.freshBaseRef();
    if (shared) await this.ensureSharedBranch(shared, freshBase);

    let branch: string;
    let baseSha: string;
    if (opts.branch) {
      branch = opts.branch;
      const branchExists = await this.git(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        root,
      ).then(
        () => true,
        () => false,
      );
      if (branchExists) {
        // Re-attach: a recorded shared association is the truth (a reopened work area keeps publish/pull).
        const recorded = await this.readSharedConfig(branch);
        if (recorded && shared && recorded !== shared) {
          throw new Error(
            `Branch ${branch} already publishes to ${recorded} — it can't join ${shared}.`,
          );
        }
        shared = recorded ?? shared;
        baseSha = await this.git(['rev-parse', branch], root);
        await this.git(['worktree', 'add', checkout, branch], root);
      } else {
        baseSha = shared ? await this.git(['rev-parse', shared], root) : freshBase;
        await this.git(['worktree', 'add', '-b', branch, checkout, baseSha], root);
      }
    } else {
      const owner = opts.ownerBot ? `${slugify(opts.ownerBot)}/` : '';
      branch = `agent/${owner}${slugify(workAreaId)}`;
      baseSha = shared ? await this.git(['rev-parse', shared], root) : freshBase;
      await this.git(['worktree', 'add', '-b', branch, checkout, baseSha], root);
    }

    if (shared) {
      await this.git(
        ['config', `branch.${branch}.${SHARED_CONFIG_KEY}`, shared],
        root,
      );
      this.sharedBranch = shared;
    }

    // Identity is best-effort: a public-repo work area has no resolvable credential, so fall back to a
    // stable generic author rather than failing the worktree create over attribution.
    const cred = await this.credentials.resolve().catch(() => ({
      token: '',
      authorName: 'Agent',
      authorEmail: 'agent@agents.noreply',
    }));
    await this.setWorktreeIdentity(checkout, cred);

    // Populate submodules in the worktree too (the clone's are init'd, but a fresh worktree's
    // submodule dirs are empty until update runs against it).
    if (await exists(join(checkout, '.gitmodules'))) {
      await this.git(
        ['submodule', 'update', '--init', '--recursive'],
        checkout,
        await this.authEnv(),
      ).catch((err) =>
        this.logger.error(`submodule init failed in worktree ${checkout}: ${err}`),
      );
    }

    const wt: DaemonWorktree = {
      workAreaId,
      branch,
      path: await realpath(checkout),
      baseSha,
    };
    this.worktrees.set(workAreaId, wt);
    this.logger.log(
      `work area ${workAreaId}: worktree ${branch} at ${wt.path}${shared ? ` (shared: ${shared})` : ''}`,
    );
    return wt.path;
  }

  /** The latest base: fetch `origin/<base>` and resolve it to a sha (falls back to local HEAD on a
   * fetch miss, with a warning — the worktree is then cut from local state). */
  private async freshBaseRef(): Promise<string> {
    const { root, baseBranch } = this.requireRepo();
    try {
      await this.git(['fetch', 'origin', baseBranch], root, await this.authEnv());
      return this.git(['rev-parse', `origin/${baseBranch}`], root);
    } catch (err) {
      this.logger.warn(
        `couldn't refresh base ${baseBranch} from origin — cutting from local state: ${err}`,
      );
      return this.git(['rev-parse', 'HEAD'], root);
    }
  }

  /** Set the worktree's author identity from the credential (best-effort — attribution must never
   * fail a create). Worktree-scoped so it covers every engine (SDK, codex subprocess) + this service's
   * own merge commits, and survives in `.git/worktrees/<id>/config.worktree`. */
  private async setWorktreeIdentity(
    checkout: string,
    cred: ResolvedGitCredential,
  ): Promise<void> {
    try {
      await this.git(['config', '--worktree', 'user.name', cred.authorName], checkout);
      await this.git(
        ['config', '--worktree', 'user.email', cred.authorEmail],
        checkout,
      );
    } catch (err) {
      this.logger.warn(`could not set git identity at ${checkout}: ${err}`);
    }
  }

  worktreePath(workAreaId: string): string | undefined {
    return this.worktrees.get(workAreaId)?.path;
  }

  listWorktrees(): DaemonWorktree[] {
    return [...this.worktrees.values()];
  }

  /**
   * The host's metadata bridge: rebuild the work-area view from DURABLE git state
   * (`git worktree list --porcelain`), NOT the in-memory map — so it's correct even after a daemon
   * restart (the map is empty then, but `.workspaces/<workAreaId>` checkouts survive). The host
   * `WorkspaceReader`/registry reconcile from this. Each entry: workAreaId (the dir basename), its branch,
   * path, and its recorded shared branch. The main clone worktree (not under `.workspaces/`) is excluded.
   */
  async describeWorktrees(): Promise<
    Array<{ workAreaId: string; branch: string; path: string; shared?: string }>
  > {
    if (!this.repo) return [];
    const wtDir = this.worktreesDir();
    const porcelain = await this.git(
      ['worktree', 'list', '--porcelain'],
      this.repo.root,
    ).catch(() => '');

    const entries: Array<{
      workAreaId: string;
      branch: string;
      path: string;
      shared?: string;
    }> = [];
    let curPath: string | undefined;
    let curBranch = '';
    const flush = async (): Promise<void> => {
      if (curPath && curPath.startsWith(wtDir)) {
        const shared = curBranch
          ? await this.readSharedConfig(curBranch)
          : undefined;
        entries.push({
          workAreaId: basename(curPath),
          branch: curBranch,
          path: curPath,
          ...(shared ? { shared } : {}),
        });
      }
      curPath = undefined;
      curBranch = '';
    };
    for (const line of porcelain.split('\n')) {
      if (line.startsWith('worktree ')) {
        await flush();
        curPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        curBranch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line === '') {
        await flush();
      }
    }
    await flush();
    return entries;
  }

  /**
   * Rebuild the in-memory worktree map from durable git state — called after clone-on-boot so a turn or
   * git op after a daemon RESTART finds its work area's worktree (the host re-dispatches the same
   * workAreaId). Without this, `worktreePath` returns undefined post-restart and `createWorktree` would
   * collide with the surviving on-disk branch/dir.
   */
  async adoptWorktrees(): Promise<void> {
    const found = await this.describeWorktrees();
    let adopted = 0;
    for (const w of found) {
      if (this.worktrees.has(w.workAreaId)) continue;
      const baseSha = await this.git(
        ['rev-parse', w.branch],
        this.requireRepo().root,
      ).catch(() => '');
      this.worktrees.set(w.workAreaId, {
        workAreaId: w.workAreaId,
        branch: w.branch,
        path: w.path,
        baseSha,
      });
      if (w.shared && !this.sharedBranch) this.sharedBranch = w.shared;
      adopted++;
    }
    if (adopted) this.logger.log(`adopted ${adopted} work-area worktree(s) from git`);
  }

  /** Remove a session's worktree checkout. The branch (and its commits) survive — work is never lost. */
  async removeWorktree(workAreaId: string): Promise<void> {
    const wt = this.worktrees.get(workAreaId);
    if (!wt) throw new Error(`No worktree for session "${workAreaId}".`);
    await this.git(
      ['worktree', 'remove', '--force', wt.path],
      this.requireRepo().root,
    );
    this.worktrees.delete(workAreaId);
    this.logger.log(`session ${workAreaId}: worktree removed (branch ${wt.branch} kept)`);
  }

  // ---- merge state / base refresh ----------------------------------------------------------------

  private async mergeInProgress(checkout: string): Promise<boolean> {
    return this.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], checkout).then(
      () => true,
      () => false,
    );
  }

  private async conflictedFiles(checkout: string): Promise<string[]> {
    return this.git(['diff', '--name-only', '--diff-filter=U'], checkout)
      .then((s) => s.split('\n').filter(Boolean))
      .catch(() => []);
  }

  private async refuseMidMerge(checkout: string): Promise<void> {
    if (await this.mergeInProgress(checkout)) {
      throw new Error(
        'A merge is already in progress in this worktree — resolve and commit it first.',
      );
    }
  }

  /** Read-only: whether a merge is in progress in this session's worktree, and the conflicted paths. */
  async mergeState(
    workAreaId: string,
  ): Promise<{ inProgress: boolean; files: string[] }> {
    const wt = this.worktrees.get(workAreaId);
    if (!wt) return { inProgress: false, files: [] };
    const inProgress = await this.mergeInProgress(wt.path);
    return {
      inProgress,
      files: inProgress ? await this.conflictedFiles(wt.path) : [],
    };
  }

  /**
   * Bring a session's branch up to date with the workspace's base branch: fetch `origin/<base>` and
   * merge it into the worktree. A dirty tree (git would refuse), a fetch miss, or a conflict are
   * structured no-ops (`refreshed:false` + detail/conflicted), never throws — same shape as the host.
   */
  async refreshFromBase(workAreaId: string): Promise<DaemonBaseRefreshResult> {
    const wt = this.requireWorktree(workAreaId);
    await this.refuseMidMerge(wt.path);
    const { root, baseBranch } = this.requireRepo();
    const dirty = !!(
      await this.git(
        ['status', '--porcelain', '--untracked-files=no'],
        wt.path,
      ).catch(() => '')
    ).trim();
    if (dirty) {
      return {
        refreshed: false,
        dirty: true,
        baseBranch,
        detail: `the worktree has uncommitted changes — commit them, then refresh against ${baseBranch}`,
      };
    }
    try {
      await this.git(['fetch', 'origin', baseBranch], root, await this.authEnv());
    } catch (err) {
      return {
        refreshed: false,
        baseBranch,
        detail: `couldn't fetch ${baseBranch} from origin: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      await this.git(['merge', '--no-edit', `origin/${baseBranch}`], wt.path);
    } catch (err) {
      if (await this.mergeInProgress(wt.path)) {
        return {
          refreshed: false,
          conflicted: true,
          baseBranch,
          files: await this.conflictedFiles(wt.path),
        };
      }
      throw err;
    }
    return { refreshed: true, baseBranch };
  }

  // ---- shared integration branch -----------------------------------------------------------------

  /** Normalize an input to `shared/<slug>` (a leading `shared/` is stripped first so a full name
   * passed back in can't double-prefix). */
  sharedBranchName(input: string): string {
    return `shared/${slugify(input.replace(/^shared\//, ''))}`;
  }

  private async ensureSharedBranch(
    shared: string,
    startPoint: string,
  ): Promise<void> {
    await this.git(['branch', shared, startPoint], this.requireRepo().root).catch(
      (e) => {
        if (!/already exists/i.test(String(e))) throw e;
      },
    );
  }

  private async readSharedConfig(branch: string): Promise<string | undefined> {
    return this.git(
      ['config', '--get', `branch.${branch}.${SHARED_CONFIG_KEY}`],
      this.requireRepo().root,
    ).then(
      (v) => v || undefined,
      () => undefined,
    );
  }

  /**
   * Promote a session's branch to the sandbox's shared integration branch if it isn't on one already.
   * Idempotent: once a shared branch exists for the sandbox, every session converges on it (the
   * workspace ships ONE PR). Cut from the session branch's tip by default; an explicit `startPoint`
   * (see `ensureSharedAtBase`) cuts elsewhere. Returns the shared branch name.
   */
  async ensureShared(
    workAreaId: string,
    name: string,
    startPoint?: string,
  ): Promise<string> {
    const wt = this.requireWorktree(workAreaId);
    const { root } = this.requireRepo();
    // Single-repo: the FIRST shared branch wins for the whole sandbox; later sessions join it.
    const shared = this.sharedBranch ?? this.sharedBranchName(name);
    const start =
      startPoint ?? (await this.git(['rev-parse', wt.branch], root));
    await this.ensureSharedBranch(shared, start);
    // Record the per-branch association (durable, mirrors the host).
    await this.git(
      ['config', `branch.${wt.branch}.${SHARED_CONFIG_KEY}`, shared],
      root,
    );
    this.sharedBranch = shared;
    this.logger.log(`session ${workAreaId}: ${wt.branch} → shared branch ${shared}`);
    return shared;
  }

  /**
   * Retroactively promote a session that ALREADY has commits, cutting the shared branch at the
   * branch's DIVERGENCE POINT from the base (`merge-base`) — so the owner's self-review range
   * `<sharedRef>...<branch>` is exactly their own commits (a tip cut would make it empty). Returns a
   * typed failure when the worktree is gone, the merge-base can't be resolved, or the origin guard
   * refuses.
   */
  async ensureSharedAtBase(
    workAreaId: string,
    name: string,
  ): Promise<{ ok: true; sharedBranch: string } | { ok: false; reason: string }> {
    const wt = this.worktrees.get(workAreaId);
    if (!wt) return { ok: false, reason: `no worktree for session ${workAreaId}` };
    if (this.sharedBranch) return { ok: true, sharedBranch: this.sharedBranch };
    const guard = await this.originGuard();
    if (guard) return { ok: false, reason: guard };
    const { root, baseBranch } = this.requireRepo();
    await this.git(
      ['fetch', 'origin', baseBranch],
      root,
      await this.authEnv(),
    ).catch(() => undefined);
    const startPoint = (
      await this.git(
        ['merge-base', wt.branch, `origin/${baseBranch}`],
        root,
      ).catch(() => '')
    ).trim();
    if (!startPoint) {
      return {
        ok: false,
        reason: `couldn't resolve the base divergence point (merge-base ${wt.branch}..origin/${baseBranch})`,
      };
    }
    const shared = await this.ensureShared(workAreaId, name, startPoint);
    return { ok: true, sharedBranch: shared };
  }

  /** The current tip sha of the sandbox's shared branch (captured before publish so a self-review can
   * diff `<sharedRef>...<ownerBranch>`). Undefined if no shared branch exists yet. */
  async sharedRef(workAreaId: string): Promise<string | undefined> {
    if (!this.sharedBranch) return undefined;
    return this.git(
      ['rev-parse', this.sharedBranch],
      this.requireRepo().root,
    ).catch(() => undefined);
  }

  /** The git range isolating a session's own contribution: changed files in `<sinceRef>...<branch>`. */
  async ownerDiff(
    workAreaId: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }> {
    const wt = this.requireWorktree(workAreaId);
    const range = `${sinceRef}...${wt.branch}`;
    const out = await this.git(['diff', '--name-only', range], wt.path).catch(
      () => '',
    );
    const files = out
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    return { range, files };
  }

  /**
   * Git-derived shared-branch status for `list_workspaces` — the in-sandbox counterpart to the host
   * `WorkspaceService.sharedStatus`. `published` = the session's branch is an ancestor of the sandbox's
   * shared branch (its work is on the shared branch); `aheadOfOrigin` = shared commits origin doesn't have
   * yet (undefined when origin's ref is unknown locally). `undefined` when no shared branch exists yet.
   * Read-only; closes the host-only `DaemonGitAdapter.sharedStatus` rejection.
   */
  async sharedStatus(
    workAreaId: string,
  ): Promise<{ published: boolean; aheadOfOrigin?: number } | undefined> {
    const wt = this.worktrees.get(workAreaId);
    if (!wt || !this.sharedBranch) return undefined;
    const shared = this.sharedBranch;
    const { root } = this.requireRepo();
    const published = await this.git(
      ['merge-base', '--is-ancestor', wt.branch, shared],
      root,
    ).then(
      () => true,
      () => false,
    );
    const ahead = await this.git(
      ['rev-list', '--count', `origin/${shared}..${shared}`],
      root,
    ).then(
      (s) => Number(s),
      () => undefined,
    );
    return {
      published,
      ...(ahead !== undefined ? { aheadOfOrigin: ahead } : {}),
    };
  }

  /**
   * The review diff-scope for a session — the in-sandbox counterpart to the host
   * `ReviewPipelineService.ticketRange`. The host diffs the workspace branch since its recorded CUT
   * POINT (`baseRef`); here the equivalent durable base is the worktree's `baseSha` (captured at
   * `createWorktree` from `origin/<base>`), so the range matches the host semantics rather than diffing
   * against a possibly-advanced live origin head. Returns the range + changed files + the base branch
   * name (for the review prompt). Empty `files` ⇒ nothing to review. The host doesn't need its
   * `projectRecordFor`/`baseRef` lookup on the sandbox path — the daemon owns the base by construction.
   */
  async reviewRange(
    workAreaId: string,
  ): Promise<{ range: string; files: string[]; baseBranch: string }> {
    const wt = this.requireWorktree(workAreaId);
    const { baseBranch } = this.requireRepo();
    const { range, files } = await this.ownerDiff(workAreaId, wt.baseSha);
    return { range, files, baseBranch };
  }

  // ---- publish / pull / push ---------------------------------------------------------------------

  private requireShared(workAreaId: string): {
    wt: DaemonWorktree;
    shared: string;
  } {
    const wt = this.requireWorktree(workAreaId);
    if (!this.sharedBranch) {
      throw new Error(
        `session ${workAreaId} is not on a shared branch — call ensureShared first.`,
      );
    }
    return { wt, shared: this.sharedBranch };
  }

  /** Best-effort authenticated fast-forward of the local shared ref from origin (so a branch advanced
   * on GitHub merges into the next publish/pull instead of rejecting at push). */
  private async fetchSharedFromOrigin(shared: string): Promise<boolean> {
    if (await this.originGuard()) return false;
    return this.git(
      ['fetch', 'origin', `${shared}:${shared}`],
      this.requireRepo().root,
      await this.authEnv(),
    ).then(
      () => true,
      () => false,
    );
  }

  /**
   * Publish a session's COMMITTED work onto the sandbox's shared integration branch (fast-forward push
   * from the worktree; on a teammate-advanced shared branch, merge their work in and push again). On
   * conflict the merge is left IN PROGRESS in the worktree and the conflicted paths returned. Always
   * also pushes the shared branch to origin (the daemon's clone always has a known origin).
   */
  async publish(workAreaId: string): Promise<DaemonIntegrationResult> {
    const { wt, shared } = this.requireShared(workAreaId);
    await this.refuseMidMerge(wt.path);
    await this.fetchSharedFromOrigin(shared);
    const dirty = !!(
      await this.git(['status', '--porcelain'], wt.path).catch(() => '')
    ).trim();
    const tryPush = () =>
      this.git(['push', '.', `HEAD:${shared}`], wt.path).then(
        () => true,
        () => false,
      );
    let local: DaemonIntegrationResult;
    if (await tryPush()) {
      local = { integrated: true, sharedBranch: shared, dirty };
    } else {
      try {
        await this.git(['merge', '--no-edit', shared], wt.path);
      } catch (err) {
        if (await this.mergeInProgress(wt.path)) {
          return {
            integrated: false,
            sharedBranch: shared,
            files: await this.conflictedFiles(wt.path),
            dirty,
          };
        }
        throw err;
      }
      local = { integrated: await tryPush(), sharedBranch: shared, dirty };
    }
    if (local.integrated) {
      local = { ...local, remote: await this.syncSharedToOrigin(shared) };
    }
    return local;
  }

  /** Merge the shared integration branch into a session's worktree (take teammates' published work),
   * syncing the shared ref from origin first. Same conflict shape as publish. */
  async pull(workAreaId: string): Promise<DaemonIntegrationResult> {
    const { wt, shared } = this.requireShared(workAreaId);
    await this.refuseMidMerge(wt.path);
    const originFetched = await this.fetchSharedFromOrigin(shared);
    try {
      await this.git(['merge', '--no-edit', shared], wt.path);
    } catch (err) {
      if (await this.mergeInProgress(wt.path)) {
        return {
          integrated: false,
          sharedBranch: shared,
          files: await this.conflictedFiles(wt.path),
          originFetched,
        };
      }
      throw err;
    }
    return { integrated: true, sharedBranch: shared, originFetched };
  }

  /** Publish's origin sync: ALWAYS the push outcome, never a throw — a shared branch that didn't reach
   * GitHub must say so. */
  private async syncSharedToOrigin(
    shared: string,
  ): Promise<NonNullable<DaemonIntegrationResult['remote']>> {
    const guard = await this.originGuard();
    if (guard) return { pushed: false, detail: guard };
    try {
      await this.git(
        ['push', 'origin', shared],
        this.requireRepo().root,
        await this.authEnv(),
      );
      return { pushed: true };
    } catch (err) {
      return {
        pushed: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Push the sandbox's shared branch to origin (for open_pr — also publish's engine). Throws on a
   * missing shared branch or an origin-guard refusal. */
  async pushSharedToOrigin(
    workAreaId: string,
  ): Promise<{ sharedBranch: string; gitUrl: string }> {
    const { shared } = this.requireShared(workAreaId);
    const { root, gitUrl } = this.requireRepo();
    const guard = await this.originGuard();
    if (guard) throw new Error(guard);
    await this.git(['push', 'origin', shared], root, await this.authEnv());
    return { sharedBranch: shared, gitUrl };
  }

  // ---- pull request (GithubApiService, verbatim) -------------------------------------------------

  /** Open (or find) the workspace's PR: shared branch → the repo's base branch, draft by default. */
  async openPr(args: {
    title: string;
    body?: string;
    draft?: boolean;
  }): Promise<PullRequestResult> {
    const { gitUrl, baseBranch } = this.requireRepo();
    if (!this.sharedBranch) {
      throw new Error('No shared branch to open a PR from — call ensureShared first.');
    }
    const { owner, repo } = parseGithubRepo(gitUrl);
    const { token } = await this.credentials.resolve();
    return this.github.openPullRequest(token, {
      owner,
      repo,
      head: this.sharedBranch,
      base: baseBranch,
      title: args.title,
      body: args.body,
      draft: args.draft ?? true,
    });
  }

  /** Flip the workspace's draft PR to ready-for-review. */
  async markReady(prNumber: number): Promise<{ isDraft: boolean }> {
    const { owner, repo } = parseGithubRepo(this.requireRepo().gitUrl);
    const { token } = await this.credentials.resolve();
    return this.github.markReadyForReview(token, { owner, repo, number: prNumber });
  }

  /** Post a comment on the workspace's PR (advisory self-review findings ride this — the pipeline ship's
   * informational comment). Reuses `GithubApiService.commentOnPullRequest` verbatim; the daemon resolves
   * its own repo coordinates + token, so the host never needs them on the containerized ship path. */
  async commentPr(prNumber: number, body: string): Promise<void> {
    const { owner, repo } = parseGithubRepo(this.requireRepo().gitUrl);
    const { token } = await this.credentials.resolve();
    await this.github.commentOnPullRequest(token, {
      owner,
      repo,
      number: prNumber,
      body,
    });
  }

  // ---- design artifact (interim human-gate) ------------------------------------------------------

  /**
   * Write a design artifact (a base64-encoded zip the host sends over the git RPC) into the sandbox
   * clone's `design/` — the in-sandbox counterpart to the host pipeline's `attachDesign` unzip into
   * `workspace.path/design`. Writes to the CLONE ROOT (NOT a per-session worktree): at the design gate
   * no engine session exists yet (the implementer session opens AFTER the gate), so there's no worktree
   * to key off — the artifact lands at the shared clone root. KNOWN GAP (the same per-session-worktree
   * accumulation gap that affects in-sandbox section pipelines generally): a later implementer worktree
   * is cut from `origin/<base>` and so does NOT automatically see this clone-root `design/`; making the
   * design flow into the implementer's worktree needs the broader in-sandbox accumulation work and is out
   * of scope for this flag-off closure. The base64 transfer is the heaviest RPC payload but acceptable for
   * v1. Returns a structured ok/message (never throws on an unzip failure — the caller relays the message).
   */
  async attachDesign(
    artifactBase64: string,
  ): Promise<{ ok: boolean; message: string }> {
    const { root } = this.requireRepo();
    const designDir = join(root, 'design');
    let tmp: string | undefined;
    try {
      tmp = await mkdtemp(join(tmpdir(), 'daemon-design-'));
      const zipPath = join(tmp, 'design.zip');
      await writeFile(zipPath, Buffer.from(artifactBase64, 'base64'));
      await mkdir(designDir, { recursive: true });
      await execFileAsync('unzip', ['-o', zipPath, '-d', designDir]);
      return { ok: true, message: `design attached to ${designDir}` };
    } catch (err) {
      return {
        ok: false,
        message: `couldn't unzip the design artifact into the sandbox: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---- reference clones (read-only, for investigate) ---------------------------------------------

  /**
   * A READ-ONLY shallow clone of ANOTHER repo so a session can read it without it being the sandbox's
   * main project. Lives under `<clone>/.refs/<slug>` (in-sandbox path the engine reads). Kept current
   * on each call. SIMPLIFIED from the host: no project registry / per-tenant `_refs` path / token
   * naming — the daemon resolves the credential the same way as its main repo (the env/Redis token),
   * which works for repos the token can see. Returns the in-sandbox path.
   */
  async ensureReferenceClone(target: {
    gitUrl: string;
  }): Promise<{ path: string; gitUrl: string }> {
    const { gitUrl } = target;
    const refsDir = join(this.requireRepo().root, '.refs');
    const slug = slugify(
      gitUrl.replace(/\.git$/, '').split('/').slice(-2).join('-'),
    );
    const root = join(refsDir, slug);
    const { token } = await this.credentials.resolve();
    const auth = gitAuthEnv(gitUrl, token);
    if (!(await exists(join(root, '.git')))) {
      await mkdir(refsDir, { recursive: true });
      this.logger.log(`reference clone ${gitUrl} → ${root}`);
      await this.git(['clone', '--depth', '1', gitUrl, root], refsDir, auth);
    } else {
      const branch = await this.git(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        root,
      ).catch(() => 'HEAD');
      await this.git(
        ['fetch', '--depth', '1', 'origin', branch],
        root,
        auth,
      ).catch(() => {});
      await this.git(['reset', '--hard', `origin/${branch}`], root).catch(
        () => {},
      );
    }
    return { path: await realpath(root), gitUrl };
  }

  /**
   * A quick at-a-glance orientation (top level + README head) for an in-sandbox reference-clone path —
   * the in-sandbox counterpart to the host `WorkspaceService.referenceOrientation`. Same shape/limits so
   * the chat-side peek reads identically whether the clone is host- or sandbox-resident. Closes the
   * host-only `DaemonGitAdapter.referenceOrientation` rejection.
   */
  async referenceOrientation(path: string): Promise<string> {
    const tree = await this.git(['ls-tree', '--name-only', 'HEAD'], path).catch(
      () => '',
    );
    const top = tree.split('\n').filter(Boolean).slice(0, 40).join(', ');
    let readme = '';
    for (const name of ['README.md', 'README.MD', 'readme.md', 'README']) {
      const r = await readFile(join(path, name), 'utf8').catch(() => undefined);
      if (r) {
        readme = r.slice(0, 1200);
        break;
      }
    }
    return [
      `Top level: ${top || '(empty)'}`,
      readme ? `README (head):\n${readme}` : '(no README found)',
    ].join('\n\n');
  }
}
