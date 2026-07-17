import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { repoStateDir } from '../../_shared/state-root';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitAuthEnv } from './git-auth';
import { readForbiddenPaths } from './hydration-sidecar';

const execFileAsync = promisify(execFile);

const INDEX_LOCK_RE = /index\.lock['"]?:?\s*file exists|another git process seems to be running/i;

function normalizeNumstatRenamePath(rawPath: string): string {
  const braceMatch = rawPath.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, , after, suffix] = braceMatch;
    return `${prefix}${after}${suffix}`.trim();
  }
  if (rawPath.includes(' => ')) {
    const parts = rawPath.split(' => ');
    return parts[parts.length - 1].trim();
  }
  return rawPath.trim();
}

type DiffNameStatus = 'added' | 'modified' | 'deleted' | 'renamed';

function normalizeNameStatus(code: string): DiffNameStatus {
  const kind = code[0];
  if (kind === 'A') return 'added';
  if (kind === 'D') return 'deleted';
  if (kind === 'R') return 'renamed';
  return 'modified';
}

export interface ProjectRepo {
  repoId: string;
  gitUrl: string;
  defaultBranch: string;
  repoPath: string;
  token?: string;
}

export interface FeatureSandbox {
  repoId: string;
  branch: string;
  worktreePath: string;
  gitUrl: string;
  token?: string;
  containerId?: string;
  execUser?: string;
  warm?: boolean;
  setupScriptResult?: { ok: boolean; exitCode: number; tail: string };
}

@Injectable()
export class LocalGitService {
  private readonly logger = new Logger(LocalGitService.name);
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly env: EnvService) {}

  reposRoot(): string {
    return this.env.get('REPOS_ROOT') ?? repoStateDir('repos');
  }

  private async git(
    args: string[],
    opts: {
      cwd?: string;
      gitUrl?: string;
      token?: string;
      trim?: boolean;
    } = {},
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', // never block on a credential prompt
      GIT_CONFIG_NOSYSTEM: '1', // don't source /etc/gitconfig (tenant hooks via system config)
      ...(opts.gitUrl ? gitAuthEnv(opts.gitUrl, opts.token) : {}),
    };
    const safetyFlags = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false',
    ];
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        const { stdout } = await execFileAsync('git', [...safetyFlags, ...args], {
          cwd: opts.cwd,
          env,
          maxBuffer: 64 * 1024 * 1024,
        });
        return opts.trim === false ? stdout : stdout.trim();
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

  async isIgnored(worktreePath: string, relPath: string): Promise<boolean> {
    try {
      await this.git(['check-ignore', '-q', '--', relPath], {
        cwd: worktreePath,
      });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 1) return false;
      throw err;
    }
  }

  async scanBranchForForbidden(worktreePath: string, baseRef: string): Promise<string[]> {
    const forbidden = readForbiddenPaths(worktreePath);
    if (!forbidden.length) return [];
    const forbiddenSet = new Set(forbidden);

    const revs = await this.git(['rev-list', `${baseRef}..HEAD`], {
      cwd: worktreePath,
    });
    const shas = revs
      ? revs
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const leaked = new Set<string>();
    for (const sha of shas) {
      const out = await this.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], {
        cwd: worktreePath,
      });
      for (const name of out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (forbiddenSet.has(name)) leaked.add(name);
      }
    }

    const [tracked, untracked] = await Promise.all([
      this.git(['diff', '--name-only', 'HEAD'], { cwd: worktreePath }),
      this.git(['ls-files', '--others', '--exclude-standard'], {
        cwd: worktreePath,
      }),
    ]);
    for (const name of [...tracked.split('\n'), ...untracked.split('\n')]
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (forbiddenSet.has(name)) leaked.add(name);
    }

    return [...leaked].sort();
  }

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
      const auth = {
        cwd: worktreePath,
        gitUrl: repo.gitUrl,
        token: repo.token,
      };
      try {
        await this.git(['submodule', 'update', '--init', '--recursive'], auth);
        return;
      } catch (err) {
        this.logger.warn(
          `submodule init failed in ${worktreePath} — attempting deinit+reclone recovery: ${err}`,
        );
      }
      try {
        await this.git(['submodule', 'deinit', '-f', '--all'], {
          cwd: worktreePath,
        });
        await this.git(['submodule', 'update', '--init', '--recursive'], auth);
      } catch (err) {
        this.logger.error(
          `submodule init still failing after recovery in ${worktreePath} — the in-sandbox build will ` +
            `likely fail to resolve submodule packages (e.g. TS2307 on @workspace/*): ${err}`,
        );
      }
    });
  }

  async stagedNames(worktreePath: string): Promise<string[]> {
    const out = await this.git(['diff', '--cached', '--name-only'], {
      cwd: worktreePath,
    });
    return out ? out.split('\n').filter(Boolean) : [];
  }

  async changedFileNames(worktreePath: string, baseSha: string): Promise<string[]> {
    try {
      const [diffOut, untrackedOut] = await Promise.all([
        this.git(['diff', '--name-only', baseSha], { cwd: worktreePath }),
        this.git(['ls-files', '--others', '--exclude-standard'], {
          cwd: worktreePath,
        }),
      ]);
      const names = new Set(
        [...diffOut.split('\n'), ...untrackedOut.split('\n')].map((s) => s.trim()).filter(Boolean),
      );
      return [...names];
    } catch {
      return [];
    }
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

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
        await this.git(['fetch', 'origin', '--prune'], {
          cwd: repoPath,
          gitUrl,
          token,
        });
      }
      const defaultBranch = input.defaultBranch ?? (await this.detectDefaultBranch(repoPath));
      return { repoId: input.repoId, gitUrl, defaultBranch, repoPath, token };
    });
  }

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

  async readFileAtRef(repoPath: string, ref: string, path: string): Promise<string | null> {
    try {
      return await this.git(['show', `${ref}:${path}`], { cwd: repoPath });
    } catch {
      return null;
    }
  }

  async listTrackedFiles(worktreePath: string): Promise<string[]> {
    try {
      const out = await this.git(['ls-files'], { cwd: worktreePath });
      return out ? out.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async diffFromMergeBase(worktreePath: string, baseRef: string): Promise<string> {
    try {
      return await this.git(['diff', '--no-color', '--find-renames', '--merge-base', baseRef], {
        cwd: worktreePath,
        trim: false,
      });
    } catch (err) {
      this.logger.warn(`diffFromMergeBase(${baseRef}) in ${worktreePath} failed: ${String(err)}`);
      return '';
    }
  }

  async diffNumstatFromMergeBase(
    worktreePath: string,
    baseRef: string,
  ): Promise<
    Array<{
      path: string;
      additions: number;
      deletions: number;
      binary: boolean;
    }>
  > {
    try {
      const out = await this.git(['diff', '--numstat', '--find-renames', '--merge-base', baseRef], {
        cwd: worktreePath,
      });
      if (!out) return [];
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [additions, deletions, rawPath] = line.split('\t');
          const path = normalizeNumstatRenamePath(rawPath ?? '');
          if (additions === '-' && deletions === '-') {
            return { path, additions: 0, deletions: 0, binary: true };
          }
          return {
            path,
            additions: parseInt(additions, 10),
            deletions: parseInt(deletions, 10),
            binary: false,
          };
        });
    } catch {
      return [];
    }
  }

  async diffNameStatusFromMergeBase(
    worktreePath: string,
    baseRef: string,
  ): Promise<Array<{ path: string; oldPath?: string; status: DiffNameStatus }>> {
    try {
      const out = await this.git(
        ['diff', '--name-status', '--find-renames', '--merge-base', baseRef],
        { cwd: worktreePath },
      );
      if (!out) return [];
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [code, firstPath, secondPath] = line.split('\t');
          const status = normalizeNameStatus(code ?? '');
          if (status === 'renamed') {
            return {
              path: (secondPath ?? firstPath ?? '').trim(),
              oldPath: (firstPath ?? '').trim(),
              status,
            };
          }
          return { path: (firstPath ?? '').trim(), status };
        })
        .filter((entry) => entry.path.length > 0);
    } catch {
      return [];
    }
  }

  async isTracked(worktreePath: string, relPath: string): Promise<boolean> {
    try {
      await this.git(['ls-files', '--error-unmatch', '--', relPath], {
        cwd: worktreePath,
      });
      return true;
    } catch {
      return false;
    }
  }

  async hasSubmodules(repo: ProjectRepo): Promise<boolean> {
    return (
      (await this.readFileAtRef(repo.repoPath, `origin/${repo.defaultBranch}`, '.gitmodules')) !==
      null
    );
  }

  private async detectDefaultBranch(repoPath: string): Promise<string> {
    try {
      const ref = await this.git(['symbolic-ref', 'refs/remotes/origin/HEAD'], {
        cwd: repoPath,
      });
      const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
      if (m) return m[1];
    } catch {
    }
    return 'main';
  }

  async createFeatureSandbox(repo: ProjectRepo, branch: string): Promise<FeatureSandbox> {
    const slug = branch.replace(/[^a-z0-9_-]/gi, '-');
    const worktreePath = join(repo.repoPath, '.worktrees', slug);

    await this.withLock(repo.repoPath, async () => {
      if (existsSync(worktreePath)) return; // reuse
      await this.git(['fetch', 'origin', repo.defaultBranch], {
        cwd: repo.repoPath,
        gitUrl: repo.gitUrl,
        token: repo.token,
      });
      const base = `origin/${repo.defaultBranch}`;
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
      await this.git(['show-ref', '--verify', '--quiet', ref], {
        cwd: repoPath,
      });
      return true;
    } catch {
      return false;
    }
  }

  async hasChanges(worktreePath: string): Promise<boolean> {
    const status = await this.git(['status', '--porcelain'], {
      cwd: worktreePath,
    });
    return status.length > 0;
  }


  async worktreeSafeToRecut(worktreePath: string, branch: string): Promise<boolean> {
    try {
      const dotGit = join(worktreePath, '.git');
      const isClone = existsSync(dotGit) && (await stat(dotGit)).isDirectory();
      if (!isClone) return true; // linked worktree — branch ref + objects live in the shared common dir
      const remoteRef = `refs/remotes/origin/${branch}`;
      if (!(await this.refExists(worktreePath, remoteRef))) return false; // never pushed → would be lost
      const ahead = await this.git(['rev-list', '--count', `origin/${branch}..HEAD`], {
        cwd: worktreePath,
      });
      return parseInt(ahead.trim(), 10) === 0;
    } catch {
      return false; // fail-closed — refuse the destructive reset if we can't prove safety
    }
  }

  async push(sandbox: FeatureSandbox): Promise<void> {
    await this.withLock(sandbox.worktreePath, () =>
      this.git(['push', '-u', 'origin', sandbox.branch], {
        cwd: sandbox.worktreePath,
        gitUrl: sandbox.gitUrl,
        token: sandbox.token,
      }),
    );
  }

  async createBaseWorktree(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    const slug = `thread-${jobId.replace(/[^a-z0-9_-]/gi, '-')}`;
    const worktreePath = join(repo.repoPath, '.worktrees', slug);

    await this.withLock(repo.repoPath, async () => {
      if (existsSync(worktreePath)) return; // reuse on recovery
      await this.git(['fetch', 'origin', repo.defaultBranch], {
        cwd: repo.repoPath,
        gitUrl: repo.gitUrl,
        token: repo.token,
      });
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

  async createBaseClone(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    const slug = `thread-${jobId.replace(/[^a-z0-9_-]/gi, '-')}`;
    const worktreePath = join(repo.repoPath, '.worktrees', slug);

    await this.withLock(repo.repoPath, async () => {
      if (existsSync(worktreePath)) return; // reuse on recovery
      await this.git(['fetch', 'origin', repo.defaultBranch], {
        cwd: repo.repoPath,
        gitUrl: repo.gitUrl,
        token: repo.token,
      });
      await this.git(['clone', repo.repoPath, worktreePath]);
      await this.git(['remote', 'set-url', 'origin', repo.gitUrl], {
        cwd: worktreePath,
      });
      await this.git(['fetch', 'origin', repo.defaultBranch], {
        cwd: worktreePath,
        gitUrl: repo.gitUrl,
        token: repo.token,
      });
      await this.git(['checkout', '--detach', `origin/${repo.defaultBranch}`], {
        cwd: worktreePath,
      });
    });

    return {
      repoId: repo.repoId,
      branch: repo.defaultBranch,
      worktreePath,
      gitUrl: repo.gitUrl,
      token: repo.token,
    };
  }

  async switchBranch(
    sandbox: FeatureSandbox,
    repo: ProjectRepo,
    featureBranch: string,
  ): Promise<FeatureSandbox> {
    await this.withLock(sandbox.worktreePath, async () => {
      const dotGit = join(sandbox.worktreePath, '.git');
      let isClone = false;
      try {
        isClone = existsSync(dotGit) && (await stat(dotGit)).isDirectory();
      } catch {
      }

      const localBranchExists = await this.refExists(
        sandbox.worktreePath,
        `refs/heads/${featureBranch}`,
      );
      if (localBranchExists) {
        await this.git(['checkout', featureBranch], {
          cwd: sandbox.worktreePath,
        });
        return;
      }

      if (isClone) {
        try {
          await this.git(['fetch', 'origin', featureBranch], {
            cwd: sandbox.worktreePath,
            gitUrl: repo.gitUrl,
            token: repo.token,
          });
        } catch {
        }
        if (await this.refExists(sandbox.worktreePath, `refs/remotes/origin/${featureBranch}`)) {
          await this.git(['checkout', '-b', featureBranch, `origin/${featureBranch}`], {
            cwd: sandbox.worktreePath,
          });
          return;
        }
      }

      await this.git(['checkout', '-b', featureBranch], {
        cwd: sandbox.worktreePath,
      });
    });
    return { ...sandbox, branch: featureBranch };
  }

  async removeSandbox(repo: ProjectRepo, worktreePath: string): Promise<void> {
    await this.withLock(repo.repoPath, async () => {
      if (!existsSync(worktreePath)) return;
      const dotGit = join(worktreePath, '.git');
      let isClone = false;
      try {
        isClone = existsSync(dotGit) && (await stat(dotGit)).isDirectory();
      } catch {
      }
      if (isClone) {
        await rm(worktreePath, { recursive: true, force: true }).catch((err) =>
          this.logger.warn(`clone remove failed for ${worktreePath}: ${err}`),
        );
      } else {
        try {
          await this.git(['worktree', 'remove', '--force', worktreePath], {
            cwd: repo.repoPath,
          });
        } catch (err) {
          this.logger.warn(`worktree remove failed for ${worktreePath}: ${err}`);
        }
      }
    });
  }

  async headSha(worktreePath: string): Promise<string> {
    return this.git(['rev-parse', 'HEAD'], { cwd: worktreePath });
  }

  async currentBranch(worktreePath: string): Promise<string | null> {
    try {
      const out = (await this.git(['branch', '--show-current'], { cwd: worktreePath })).trim();
      return out.length ? out : null;
    } catch {
      return null;
    }
  }

  async listWorktrees(repoPath: string): Promise<string[]> {
    const dir = join(repoPath, '.worktrees');
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).map((name) => join(dir, name));
  }

  async resolveRemoteRef(
    gitUrl: string,
    ref: string | undefined,
    token?: string,
  ): Promise<{ ref: string; sha: string }> {
    if (ref) {
      const out = await this.git(['ls-remote', gitUrl, ref], { gitUrl, token });
      const sha = out.split('\n')[0]?.split('\t')[0];
      if (!sha) throw new Error(`ref '${ref}' not found on ${gitUrl}`);
      return { ref, sha };
    }
    const out = await this.git(['ls-remote', '--symref', gitUrl, 'HEAD'], {
      gitUrl,
      token,
    });
    const lines = out.split('\n');
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(lines[0] ?? '');
    const shaLine = lines.find((l) => l.endsWith('\tHEAD') && !l.startsWith('ref:'));
    const sha = shaLine?.split('\t')[0];
    if (!symref || !sha) throw new Error(`could not resolve default branch for ${gitUrl}`);
    return { ref: symref[1], sha };
  }

  async shallowCloneToPath(
    gitUrl: string,
    ref: string,
    destPath: string,
    token?: string,
  ): Promise<string> {
    await this.git(['clone', '--depth', '1', '--branch', ref, gitUrl, destPath], { gitUrl, token });
    return this.git(['rev-parse', 'HEAD'], { cwd: destPath });
  }
}
