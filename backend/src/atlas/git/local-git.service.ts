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
  projectId: string;
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
  projectId: string;
  /** The feature branch all the job's phases stack on. */
  branch: string;
  /** Absolute path to the worktree checkout (the engine's cwd). */
  worktreePath: string;
  gitUrl: string;
  token?: string;
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

  /** The root every project clones into — ATLAS_REPOS_ROOT, else v1's REPOS_ROOT, else the default. */
  reposRoot(): string {
    return (
      this.env.get('ATLAS_REPOS_ROOT') ??
      this.env.get('REPOS_ROOT') ??
      join(homedir(), '.agent-playground', 'atlas-repos')
    );
  }

  /** Run one git command, returning trimmed stdout. `auth` mode adds GIT_CONFIG_* token env. */
  private async git(
    args: string[],
    opts: { cwd?: string; gitUrl?: string; token?: string } = {},
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', // never block on a credential prompt
      ...(opts.gitUrl ? gitAuthEnv(opts.gitUrl, opts.token) : {}),
    };
    const { stdout } = await execFileAsync('git', args, {
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
    projectId: string;
    gitUrl: string;
    defaultBranch?: string;
    token?: string;
  }): Promise<ProjectRepo> {
    const safeId = input.projectId.replace(/[^a-z0-9_-]/gi, '_') || 'project';
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
      return { projectId: input.projectId, gitUrl, defaultBranch, repoPath, token };
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
      projectId: repo.projectId,
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
