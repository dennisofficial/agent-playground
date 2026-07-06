import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { repoStateDir } from '../state-root';
import { gitAuthEnv } from './git-auth';
import { readForbiddenPaths } from './hydration-sidecar';

const execFileAsync = promisify(execFile);

/** Matches git's `index.lock: File exists` / "Another git process seems to be running" error — a stray or
 *  concurrent external git process (e.g. the sandbox's own engine turn running `git commit`) holding the OS-
 *  level index lock. The in-process `withLock` mutex can't see this: it only serializes calls made by THIS
 *  Node process. A short retry is the standard remedy — the lock is almost always released within seconds. */
const INDEX_LOCK_RE = /index\.lock['"]?:?\s*file exists|another git process seems to be running/i;

/** A located project repo on disk + the auth context for its remote. */
export interface ProjectRepo {
  /** Stable id used for the on-disk clone dir + the worktree sandbox key. */
  repoId: string;
  /** The HTTPS clone URL (the `origin` remote). */
  gitUrl: string;
  /** The PR base / default branch. */
  defaultBranch: string;
  /** Absolute path to the bare-ish clone (the repo's main checkout). */
  repoPath: string;
  /** GitHub token for authenticated fetch/push (rides in GIT_CONFIG_* per invocation). */
  token?: string;
}

/** A cut per-feature sandbox = a git worktree on a feature branch. */
export interface FeatureSandbox {
  repoId: string;
  /** The feature branch all the job's steps stack on. */
  branch: string;
  /** Absolute path to the worktree checkout (the engine's cwd, bind-mounted at /workspace in docker mode). */
  worktreePath: string;
  gitUrl: string;
  token?: string;
  /**
   * The sandbox CONTAINER the engine turns exec into (docker mode only; set by the `SANDBOX_PROVIDER`'s
   * `attach`). Absent → host-local execution. The worktree is always bind-mounted at /workspace inside it.
   */
  containerId?: string;
  /** The user (uid:gid) to exec turns as inside the container — host-uid so /workspace stays host-owned. */
  execUser?: string;
  /**
   * TRANSIENT (set by `SandboxProvider.attach`, never persisted): true when an already-RUNNING container
   * was reused warm; false when the container was created fresh or restarted from stopped (cold — any
   * background processes from prior turns are gone). `JobLifecycleService.ensureContainer` uses this
   * to decide whether a resumed turn needs the "sandbox was reset" notice.
   */
  warm?: boolean;
}

/**
 * Atlas v2's HOST git substrate — daemon-free, Docker-free. A clean-room rewrite of v1's worktree/git
 * machinery that runs `git` directly via `execFile`. It clones/locates a project repo under a repos
 * root, cuts a per-feature WORKTREE (the "sandbox" in MVP), commits, and pushes. It deliberately
 * BYPASSES v1's daemon-gated WorkspaceGitProvider / DaemonGitAdapter (which throw without a sandbox).
 *
 * All authenticated remote ops thread the token via `gitAuthEnv` (GIT_CONFIG_* env) per invocation,
 * so the token never lands in argv, `.git/config`, or the remote URL. Mutating ops are serialized per
 * repo path via a tiny in-process mutex (concurrent `git worktree add` on one repo races on the index).
 */
@Injectable()
export class LocalGitService {
  private readonly logger = new Logger(LocalGitService.name);
  /** Per-repo-path serialization of mutating git ops (chained promises). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly env: EnvService) {}

  /** The root every project clones into — `REPOS_ROOT`, else the repo-relative `.atlas-state/repos`. */
  reposRoot(): string {
    return this.env.get('REPOS_ROOT') ?? repoStateDir('repos');
  }

  /**
   * Run one git command, returning trimmed stdout.
   *
   * HOST-GIT POLICY (R2): every git invocation runs with hooks and code-executing filters disabled
   * so tenant-repo hooks never execute on the host (the multi-tenancy invariant). The flags are
   * prepended to every call so even an accidental omission can't bypass them:
   *
   *   -c core.hooksPath=/dev/null   — disables all hooks (pre-commit, post-checkout, …)
   *   -c core.fsmonitor=false       — disables any fsmonitor daemon that could run tenant code
   *   -c filter.lfs.clean=         — disables the git-lfs clean filter (code-executing)
   *   -c filter.lfs.smudge=        — disables the git-lfs smudge filter (code-executing)
   *   -c filter.lfs.process=       — disables the git-lfs process filter (code-executing)
   *   -c filter.lfs.required=false — avoids the "required filter missing" abort
   *
   * This is the one place all host git traffic passes through; callers add no extra guards.
   */
  private async git(
    args: string[],
    opts: { cwd?: string; gitUrl?: string; token?: string } = {},
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', // never block on a credential prompt
      // Belt-and-suspenders: env-level hook disabling (complements the -c flags below).
      GIT_CONFIG_NOSYSTEM: '1', // don't source /etc/gitconfig (tenant hooks via system config)
      ...(opts.gitUrl ? gitAuthEnv(opts.gitUrl, opts.token) : {}),
    };
    // These -c flags are prepended BEFORE the subcommand so they apply to every git op.
    const safetyFlags = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'filter.lfs.clean=',
      '-c', 'filter.lfs.smudge=',
      '-c', 'filter.lfs.process=',
      '-c', 'filter.lfs.required=false',
    ];
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        const { stdout } = await execFileAsync('git', [...safetyFlags, ...args], {
          cwd: opts.cwd,
          env,
          maxBuffer: 64 * 1024 * 1024,
        });
        return stdout.trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= maxAttempts || !INDEX_LOCK_RE.test(msg)) throw err;
        this.logger.warn(
          `git ${args[0]} in ${opts.cwd ?? '(no cwd)'}: index.lock held by another process ` +
            `(attempt ${attempt}/${maxAttempts}) — retrying`,
        );
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
  }

  /**
   * Is `relPath` (worktree-relative) ignored by git in `worktreePath`? The worktree hydrator uses this
   * to refuse rendering a secret/seed to a path that ISN'T gitignored (which would let `git add -A`
   * sweep it into a PR). Goes through the hardened `git()` wrapper (hooks off). `check-ignore -q` exits
   * 0 = ignored, 1 = not ignored.
   */
  async isIgnored(worktreePath: string, relPath: string): Promise<boolean> {
    try {
      await this.git(['check-ignore', '-q', '--', relPath], { cwd: worktreePath });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 1) return false;
      throw err;
    }
  }

  /**
   * PRE-SHIP LEAK-SCAN (hard PR gate). Writers own their commits now (the host no longer runs `git add -A`
   * or commits at all), so the hydrated-secret leak-scan can no longer live inside a host commit. Instead,
   * right before the PR opens, scan EVERY commit introduced on the feature branch (`baseRef..HEAD`) for any
   * host-only forbidden (hydrated-secret/seed) path.
   *
   * Scans per-commit — NOT the net `baseRef..HEAD` tree diff — so a secret ADDED in one commit and DELETED
   * in a later one (which the net diff would show as gone) is still caught: `git rev-list baseRef..HEAD`
   * enumerates the branch's commits and `git diff-tree` lists the paths each one touched. The forbidden set
   * comes from the host-only sidecar (`readForbiddenPaths`), which the in-sandbox turn cannot read, so this
   * gate MUST run host-side.
   *
   * Returns the sorted union of forbidden paths that appeared in ANY commit (empty = clean); the caller
   * hard-blocks the ship on a non-empty result. FAILS CLOSED: a git error (can't enumerate the branch)
   * throws rather than returning "clean" — an unprovable branch must not be waved through a security gate.
   */
  async scanBranchForForbidden(worktreePath: string, baseRef: string): Promise<string[]> {
    const forbidden = readForbiddenPaths(worktreePath);
    if (!forbidden.length) return [];
    const forbiddenSet = new Set(forbidden);

    const revs = await this.git(['rev-list', `${baseRef}..HEAD`], { cwd: worktreePath });
    const shas = revs ? revs.split('\n').map((s) => s.trim()).filter(Boolean) : [];

    const leaked = new Set<string>();
    for (const sha of shas) {
      const out = await this.git(
        ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
        { cwd: worktreePath },
      );
      for (const name of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
        if (forbiddenSet.has(name)) leaked.add(name);
      }
    }
    return [...leaked].sort();
  }

  /**
   * Initialize + check out the repo's git submodules INTO a freshly cut/restored worktree, so an
   * in-sandbox build can resolve submodule-provided packages (e.g. cubix-infra's `@workspace/*`).
   *
   * Why this is needed: `git worktree add` does NOT populate submodules, and a LINKED worktree keeps
   * its OWN per-worktree submodule git dirs under `<common>/.git/worktrees/<wt>/modules/…`. So the init
   * must run IN the worktree (not the main clone) and after the branch is checked out (the gitlink is
   * branch-specific). Running it here lands the submodule git dir at exactly that per-worktree path.
   *
   * No-op for repos without a `.gitmodules` (the overwhelming common case — cheap fs check, no
   * subprocess). Auth rides the SAME per-invocation `GIT_CONFIG_*` extraheader as the clone: that config
   * key is host-scoped (`http.https://github.com/.extraheader`), so passing the superproject's token
   * authenticates private github.com submodule fetches too. Idempotent: a healthy re-run does no network.
   *
   * Self-heals the "cleared + re-cut" corruption — a dangling per-worktree submodule gitdir that makes
   * plain `--init` fail with `fatal: not a git repository … /modules/…` — by deregistering every
   * submodule (`deinit -f --all`) and re-cloning once. Serialized on the clone's common dir because
   * submodule registration lives in the SHARED `.git/config` (concurrent threads of one repo would race).
   *
   * Fail-soft: a submodule that still can't initialize is logged loudly but never throws — provisioning
   * proceeds and the resulting build failure surfaces the precise error to the operator. Deliberately
   * does NOT enable `protocol.file.allow` (keeps `file://` submodule transport disabled for tenant repos).
   */
  async ensureSubmodules(
    worktreePath: string,
    repo: { gitUrl: string; token?: string },
  ): Promise<void> {
    if (!existsSync(join(worktreePath, '.gitmodules'))) return; // repo has no submodules

    let commonDir: string;
    try {
      commonDir = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: worktreePath,
      });
    } catch {
      commonDir = worktreePath; // fall back to per-worktree serialization
    }

    await this.withLock(commonDir, async () => {
      const auth = { cwd: worktreePath, gitUrl: repo.gitUrl, token: repo.token };
      try {
        await this.git(['submodule', 'update', '--init', '--recursive'], auth);
        return;
      } catch (err) {
        this.logger.warn(
          `submodule init failed in ${worktreePath} — attempting deinit+reclone recovery: ${err}`,
        );
      }
      // Recovery: a re-cut worktree can leave a dangling submodule gitdir that plain `--init` can't
      // repair. Deregister every submodule (clears the stale gitlinks + working trees), then re-clone.
      try {
        await this.git(['submodule', 'deinit', '-f', '--all'], { cwd: worktreePath });
        await this.git(['submodule', 'update', '--init', '--recursive'], auth);
      } catch (err) {
        this.logger.error(
          `submodule init still failing after recovery in ${worktreePath} — the in-sandbox build will ` +
            `likely fail to resolve submodule packages (e.g. TS2307 on @workspace/*): ${err}`,
        );
      }
    });
  }

  /** Worktree-relative names of files currently staged in the index. */
  async stagedNames(worktreePath: string): Promise<string[]> {
    const out = await this.git(['diff', '--cached', '--name-only'], { cwd: worktreePath });
    return out ? out.split('\n').filter(Boolean) : [];
  }

  /** Files this thread has touched so far relative to `baseSha` (its start-of-thread HEAD) — tracked
   *  changes (staged/unstaged/already committed within this thread) PLUS brand-new untracked files, since
   *  this runs mid-turn before the writer commits (ADR 0005's judge needs the CURRENT thread's changes, not the
   *  whole job's). Best-effort; never blocks the gate on a git error. */
  async changedFileNames(worktreePath: string, baseSha: string): Promise<string[]> {
    try {
      const [diffOut, untrackedOut] = await Promise.all([
        this.git(['diff', '--name-only', baseSha], { cwd: worktreePath }),
        this.git(['ls-files', '--others', '--exclude-standard'], { cwd: worktreePath }),
      ]);
      const names = new Set(
        [...diffOut.split('\n'), ...untrackedOut.split('\n')].map((s) => s.trim()).filter(Boolean),
      );
      return [...names];
    } catch {
      return [];
    }
  }

  /** Serialize mutating ops against one repo path so concurrent worktree/index ops don't race. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but don't leak rejections into the stored promise.
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Ensure the project repo exists locally (clone on first use), returning a handle. Idempotent: an
   * existing clone is reused and its default branch refreshed from origin. The token authenticates the
   * clone/fetch but is NOT persisted to the clone's config.
   */
  async ensureRepo(input: {
    repoId: string;
    gitUrl: string;
    defaultBranch?: string;
    token?: string;
  }): Promise<ProjectRepo> {
    const safeId = input.repoId.replace(/[^a-z0-9_-]/gi, '_') || 'project';
    const repoPath = join(this.reposRoot(), safeId);
    const token = input.token;
    const gitUrl = input.gitUrl;

    return this.withLock(repoPath, async () => {
      if (!existsSync(join(repoPath, '.git'))) {
        await mkdir(this.reposRoot(), { recursive: true });
        this.logger.log(`Cloning ${gitUrl} → ${repoPath}`);
        await this.git(['clone', gitUrl, repoPath], { gitUrl, token });
      } else {
        // Refresh origin so worktrees cut from origin/<default> are current.
        await this.git(['fetch', 'origin', '--prune'], { cwd: repoPath, gitUrl, token });
      }
      const defaultBranch = input.defaultBranch ?? (await this.detectDefaultBranch(repoPath));
      return { repoId: input.repoId, gitUrl, defaultBranch, repoPath, token };
    });
  }

  /**
   * List the files under `subdir` at a git ref (e.g. `origin/main`) — a READ against the base clone with
   * no working tree needed. Returns repo-relative paths; empty when the dir doesn't exist at that ref.
   */
  async listFilesAtRef(repoPath: string, ref: string, subdir: string): Promise<string[]> {
    try {
      const out = await this.git(['ls-tree', '-r', '--name-only', ref, '--', subdir], {
        cwd: repoPath,
      });
      return out ? out.split('\n').filter(Boolean) : [];
    } catch {
      return []; // ref or subdir absent — treat as empty
    }
  }

  /** Read one file's contents at a git ref (`git show <ref>:<path>`); null when the path is absent there. */
  async readFileAtRef(repoPath: string, ref: string, path: string): Promise<string | null> {
    try {
      return await this.git(['show', `${ref}:${path}`], { cwd: repoPath });
    } catch {
      return null;
    }
  }

  /** Resolve the repo's default branch from origin/HEAD; fall back to `main`. */
  private async detectDefaultBranch(repoPath: string): Promise<string> {
    try {
      const ref = await this.git(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: repoPath });
      const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
      if (m) return m[1];
    } catch {
      // origin/HEAD not set — fall through.
    }
    return 'main';
  }

  /**
   * Cut a per-feature WORKTREE (the MVP "sandbox") on a fresh feature branch off origin/<defaultBranch>.
   * Idempotent: if the worktree already exists it's reused. The checkout lands at
   * `<repoPath>/.worktrees/<branch-slug>`.
   */
  async createFeatureSandbox(
    repo: ProjectRepo,
    branch: string,
  ): Promise<FeatureSandbox> {
    const slug = branch.replace(/[^a-z0-9_-]/gi, '-');
    const worktreePath = join(repo.repoPath, '.worktrees', slug);

    await this.withLock(repo.repoPath, async () => {
      if (existsSync(worktreePath)) return; // reuse
      // Make sure we have the freshest base before cutting.
      await this.git(['fetch', 'origin', repo.defaultBranch], {
        cwd: repo.repoPath,
        gitUrl: repo.gitUrl,
        token: repo.token,
      });
      const base = `origin/${repo.defaultBranch}`;
      // Reuse an existing branch ref if present (a resume); else create it off the base.
      const branchExists = await this.refExists(repo.repoPath, `refs/heads/${branch}`);
      const addArgs = branchExists
        ? ['worktree', 'add', worktreePath, branch]
        : ['worktree', 'add', '-b', branch, worktreePath, base];
      await this.git(addArgs, { cwd: repo.repoPath });
    });

    return {
      repoId: repo.repoId,
      branch,
      worktreePath,
      gitUrl: repo.gitUrl,
      token: repo.token,
    };
  }

  async refExists(repoPath: string, ref: string): Promise<boolean> {
    try {
      await this.git(['show-ref', '--verify', '--quiet', ref], { cwd: repoPath });
      return true;
    } catch {
      return false;
    }
  }

  /** True when the worktree has staged or unstaged changes. */
  async hasChanges(worktreePath: string): Promise<boolean> {
    const status = await this.git(['status', '--porcelain'], { cwd: worktreePath });
    return status.length > 0;
  }

  /**
   * Stage everything and commit. Identity is set per-invocation via `-c` so the worktree's config
   * stays clean. Returns the new commit sha, or null when there was nothing to commit.
   *
   * HOST COMMIT IS NOW A FAST-PATH-ONLY primitive. The multi-thread build pipeline no longer commits on the
   * writer's behalf — builders / fix-it / master-review each commit + push their own work, and the host only
   * READS `git rev-parse HEAD`. `commitAll` survives ONLY for the terminal/fast ship paths that write in the
   * BRAIN's own session and commit at ship time (`BuildShipService` `commitMessage`: direct-build, onboarding
   * env setup, the decision-ledger commit). The hydrated-secret leak-scan that used to live here has moved to
   * {@link scanBranchForForbidden}, run once as a HARD pre-ship gate before the PR opens — so no host commit
   * carries a per-commit secret check anymore.
   */
  async commitAll(
    worktreePath: string,
    message: string,
    author = { name: 'Atlas', email: 'atlas@users.noreply.github.com' },
  ): Promise<string | null> {
    return this.withLock(worktreePath, async () => {
      await this.git(['add', '-A'], { cwd: worktreePath });
      if (!(await this.hasChanges(worktreePath))) return null;
      await this.git(
        [
          '-c',
          `user.name=${author.name}`,
          '-c',
          `user.email=${author.email}`,
          'commit',
          '-m',
          message,
        ],
        { cwd: worktreePath },
      );
      return this.git(['rev-parse', 'HEAD'], { cwd: worktreePath });
    });
  }

  /** Push the feature branch to origin (token via GIT_CONFIG_* — never in argv/config). */
  async push(sandbox: FeatureSandbox): Promise<void> {
    await this.withLock(sandbox.worktreePath, () =>
      this.git(['push', '-u', 'origin', sandbox.branch], {
        cwd: sandbox.worktreePath,
        gitUrl: sandbox.gitUrl,
        token: sandbox.token,
      }),
    );
  }

  /**
   * Cut a per-THREAD worktree on the BASE branch (R2: thread-creation time). Unlike
   * `createFeatureSandbox` this does NOT create a new branch — it checks out the existing
   * `origin/<baseBranch>` so planning turns read the repo as-is. The worktree lands at
   * `<repoPath>/.worktrees/thread-<jobId>`.
   *
   * Idempotent: if the worktree already exists it is reused (boot recovery).
   */
  async createBaseWorktree(
    repo: ProjectRepo,
    jobId: string,
  ): Promise<FeatureSandbox> {
    const slug = `thread-${jobId.replace(/[^a-z0-9_-]/gi, '-')}`;
    const worktreePath = join(repo.repoPath, '.worktrees', slug);

    await this.withLock(repo.repoPath, async () => {
      if (existsSync(worktreePath)) return; // reuse on recovery
      // Ensure we have the freshest base.
      await this.git(['fetch', 'origin', repo.defaultBranch], {
        cwd: repo.repoPath,
        gitUrl: repo.gitUrl,
        token: repo.token,
      });
      // Check out detached at origin/<defaultBranch> — no new branch ref so it stays read-only.
      await this.git(
        ['worktree', 'add', '--detach', worktreePath, `origin/${repo.defaultBranch}`],
        { cwd: repo.repoPath },
      );
    });

    return {
      repoId: repo.repoId,
      branch: repo.defaultBranch, // still on the base; updated by switchBranch
      worktreePath,
      gitUrl: repo.gitUrl,
      token: repo.token,
    };
  }

  /**
   * Switch a base-branch worktree to a feature branch IN-PLACE (R2: approval → build start).
   * Cuts `featureBranch` off `origin/<baseBranch>` inside the existing worktree checkout. This is
   * the branch-switch that happens once: planning ran on the base, build runs on the feature.
   *
   * Idempotent: if the branch already exists locally it is checked out without recreating (resume).
   * Returns the updated `FeatureSandbox` (same worktreePath, new branch name).
   */
  async switchBranch(
    sandbox: FeatureSandbox,
    repo: ProjectRepo,
    featureBranch: string,
  ): Promise<FeatureSandbox> {
    await this.withLock(sandbox.worktreePath, async () => {
      const branchExists = await this.refExists(repo.repoPath, `refs/heads/${featureBranch}`);
      if (branchExists) {
        // Resume: the branch was already cut — just check it out.
        await this.git(['checkout', featureBranch], { cwd: sandbox.worktreePath });
      } else {
        // Fresh approval: cut the branch off the current detached HEAD (which is on base).
        await this.git(['-c', `user.name=Atlas`, '-c', `user.email=atlas@users.noreply.github.com`,
          'checkout', '-b', featureBranch], { cwd: sandbox.worktreePath });
      }
    });
    return { ...sandbox, branch: featureBranch };
  }

  /** Remove a feature worktree (cleanup). Leaves the branch ref (the PR still references it). */
  async removeSandbox(repo: ProjectRepo, worktreePath: string): Promise<void> {
    await this.withLock(repo.repoPath, async () => {
      if (!existsSync(worktreePath)) return;
      try {
        await this.git(['worktree', 'remove', '--force', worktreePath], { cwd: repo.repoPath });
      } catch (err) {
        this.logger.warn(`worktree remove failed for ${worktreePath}: ${err}`);
      }
    });
  }

  /** The current HEAD sha of a checkout. */
  async headSha(worktreePath: string): Promise<string> {
    return this.git(['rev-parse', 'HEAD'], { cwd: worktreePath });
  }

  /**
   * The branch HEAD is currently on, or null when detached / empty. OBSERVED only — this reads what
   * the in-sandbox agent did (it may `git checkout -b …` freely); Atlas never asserts the branch here.
   */
  async currentBranch(worktreePath: string): Promise<string | null> {
    try {
      const out = (await this.git(['branch', '--show-current'], { cwd: worktreePath })).trim();
      return out.length ? out : null;
    } catch {
      return null;
    }
  }

  /** List existing worktree dirs for a repo (for boot recovery / awareness). */
  async listWorktrees(repoPath: string): Promise<string[]> {
    const dir = join(repoPath, '.worktrees');
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).map((name) => join(dir, name));
  }
}
