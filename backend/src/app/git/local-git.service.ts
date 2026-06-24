import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitAuthEnv } from './git-auth';

const execFileAsync = promisify(execFile);

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
  /** The feature branch all the job's phases stack on. */
  branch: string;
  /** Absolute path to the worktree checkout (the engine's cwd, bind-mounted at /work in docker mode). */
  worktreePath: string;
  gitUrl: string;
  token?: string;
  /**
   * The sandbox CONTAINER the engine turns exec into (docker mode only; set by the `SANDBOX_PROVIDER`'s
   * `attach`). Absent → host-local execution. The worktree is always bind-mounted at /work inside it.
   */
  containerId?: string;
  /** The user (uid:gid) to exec turns as inside the container — host-uid so /work stays host-owned. */
  execUser?: string;
  /**
   * TRANSIENT (set by `SandboxProvider.attach`, never persisted): true when an already-RUNNING container
   * was reused warm; false when the container was created fresh or restarted from stopped (cold — any
   * background processes from prior turns are gone). `ThreadLifecycleService.ensureContainer` uses this
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

  /** The root every project clones into — REPOS_ROOT, else v1's REPOS_ROOT, else the default. */
  reposRoot(): string {
    return (
      this.env.get('REPOS_ROOT') ??
      join(homedir(), '.agent-playground', 'atlas-repos')
    );
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
    const { stdout } = await execFileAsync('git', [...safetyFlags, ...args], {
      cwd: opts.cwd,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
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

  private async refExists(repoPath: string, ref: string): Promise<boolean> {
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
   */
  async commitAll(
    worktreePath: string,
    message: string,
    author = { name: 'Atlas', email: 'atlas@users.noreply.github.com' },
  ): Promise<string | null> {
    return this.withLock(worktreePath, async () => {
      await this.git(['add', '-A'], { cwd: worktreePath });
      if (!(await this.hasChanges(worktreePath))) {
        // `add` may have staged nothing (e.g. only ignored files) — check staged too.
        const staged = await this.git(['diff', '--cached', '--name-only'], { cwd: worktreePath });
        if (!staged) return null;
      }
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
   * `<repoPath>/.worktrees/thread-<threadId>`.
   *
   * Idempotent: if the worktree already exists it is reused (boot recovery).
   */
  async createBaseWorktree(
    repo: ProjectRepo,
    threadId: string,
  ): Promise<FeatureSandbox> {
    const slug = `thread-${threadId.replace(/[^a-z0-9_-]/gi, '-')}`;
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

  /** List existing worktree dirs for a repo (for boot recovery / awareness). */
  async listWorktrees(repoPath: string): Promise<string[]> {
    const dir = join(repoPath, '.worktrees');
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).map((name) => join(dir, name));
  }
}
