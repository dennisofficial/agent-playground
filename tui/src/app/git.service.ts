import { Injectable } from '@nestjs/common';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKTREES_DIR, mainWorktreeFromCommonDir } from '../domain/worktree.js';

export type GitResult = { ok: boolean; stdout: string; stderr: string };

/**
 * The only place in the TUI that shells out to `git`. Thin on purpose: it runs commands and reports
 * what happened, and every decision about WHICH command to run for a job lives in
 * `WorktreeService` — so the job-shaped rules stay testable against a plain temporary repository.
 */
@Injectable()
export class GitService {
  /**
   * The main worktree containing `path`, or null when it is not a repository.
   *
   * `--git-common-dir` rather than `--show-toplevel`: the toplevel of a linked worktree is the
   * worktree itself, which would mint a second `Project` row the moment Atlas is opened inside one.
   */
  async mainWorktree(path: string): Promise<string | null> {
    const result = await this.run({
      cwd: path,
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    });
    if (!result.ok) return null;
    return mainWorktreeFromCommonDir(result.stdout);
  }

  async isRepository(path: string): Promise<boolean> {
    return (await this.mainWorktree(path)) !== null;
  }

  /**
   * Creates the branch if it does not exist yet, and checks it out into its own directory. Reusing
   * an existing branch matters after a worktree is removed and the job is re-entered: the branch is
   * the work, the directory is only where it is unpacked.
   */
  async addWorktree(args: {
    repoPath: string;
    worktreePath: string;
    branch: string;
  }): Promise<GitResult> {
    this.excludeWorktreesDir(args.repoPath);
    mkdirSync(dirname(args.worktreePath), { recursive: true });
    // A directory someone deleted by hand stays REGISTERED, and `worktree add` then refuses the
    // path as "already exists" forever. Pruning first only forgets records whose directory is
    // already gone, so it cannot cost anything real.
    await this.run({ cwd: args.repoPath, args: ['worktree', 'prune'] });

    const exists = await this.branchExists({ repoPath: args.repoPath, branch: args.branch });
    return this.run({
      cwd: args.repoPath,
      args: exists
        ? ['worktree', 'add', args.worktreePath, args.branch]
        : ['worktree', 'add', '-b', args.branch, args.worktreePath],
    });
  }

  async branchExists(args: { repoPath: string; branch: string }): Promise<boolean> {
    const result = await this.run({
      cwd: args.repoPath,
      args: ['rev-parse', '--verify', '--quiet', `refs/heads/${args.branch}`],
    });
    return result.ok;
  }

  /**
   * The branch HEAD is on, or null when there is not one to name — a detached head, or a directory
   * git has never heard of. Both are ordinary here: plenty of jobs run in folders that are not
   * repositories, and the caller's job is to say "in place" either way.
   */
  async currentBranch(path: string): Promise<string | null> {
    const result = await this.run({
      cwd: path,
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    });
    if (!result.ok) return null;
    const branch = result.stdout.trim();
    // `--abbrev-ref` answers the literal string `HEAD` when detached, which names nothing.
    return branch.length > 0 && branch !== 'HEAD' ? branch : null;
  }

  /** Uncommitted changes OR untracked files — both are work that a delete would eat. */
  async isDirty(worktreePath: string): Promise<boolean> {
    const result = await this.run({ cwd: worktreePath, args: ['status', '--porcelain'] });
    if (!result.ok) return false;
    return result.stdout.trim().length > 0;
  }

  /**
   * Removes the directory and git's administrative record of it. The BRANCH is deliberately left
   * behind: it may be the only copy of the work and may already have a pull request open, so
   * forgetting a job must not be able to destroy it.
   */
  async removeWorktree(args: { repoPath: string; worktreePath: string }): Promise<GitResult> {
    return this.run({ cwd: args.repoPath, args: ['worktree', 'remove', args.worktreePath] });
  }

  /**
   * Brings the remote's base branch up to date, and nothing else. A ship turn rebases onto
   * `origin/<base>` rather than onto a local copy of it — the local copy is whatever was last
   * fetched, which on a worktree that has been sitting for a day is not the branch the pull request
   * will actually merge into.
   */
  async fetch(args: { cwd: string; remote: string; branch: string }): Promise<GitResult> {
    return this.run({ cwd: args.cwd, args: ['fetch', args.remote, args.branch] });
  }

  /**
   * Rebases the checked-out branch, and **cleans up after itself when it cannot**.
   *
   * A stopped rebase leaves the worktree mid-rebase, which is a state the agent has no verb to
   * leave and a trap for whoever opens the directory next. Aborting restores the branch exactly as
   * it was, so a conflict costs a sentence rather than a repository somebody has to rescue.
   */
  async rebaseOnto(args: { cwd: string; upstream: string }): Promise<GitResult> {
    const result = await this.run({ cwd: args.cwd, args: ['rebase', args.upstream] });
    if (result.ok) return result;
    await this.run({ cwd: args.cwd, args: ['rebase', '--abort'] });
    return result;
  }

  /**
   * `--force-with-lease`, which is not a nicety: a rebase rewrites the branch, so every ship after
   * the first is a non-fast-forward push. The lease is what makes that safe — it refuses if the
   * remote moved since the fetch above, which is exactly the case where somebody else's commits
   * would be the thing being discarded.
   */
  async push(args: { cwd: string; remote: string; branch: string }): Promise<GitResult> {
    return this.run({
      cwd: args.cwd,
      args: ['push', '--force-with-lease', '--set-upstream', args.remote, args.branch],
    });
  }

  async run(args: { cwd: string; args: readonly string[] }): Promise<GitResult> {
    const proc = Bun.spawn({
      cmd: ['git', ...args.args],
      cwd: args.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stdout, stderr };
  }

  /**
   * `.git/info/exclude`, not `.gitignore`: the worktree directory is Atlas's business, not the
   * repository's, and a tracked-file edit would show up in the diff Dennis is about to review.
   * Without this, every worktree makes `git status` in the tree he has open report untracked
   * content — the exact disturbance this whole feature exists to avoid.
   */
  private excludeWorktreesDir(repoPath: string): void {
    const info = join(repoPath, '.git', 'info');
    if (!existsSync(info)) return;
    const file = join(info, 'exclude');
    const line = `/${WORKTREES_DIR}/`;
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current.split('\n').includes(line)) return;
    appendFileSync(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`);
  }
}
