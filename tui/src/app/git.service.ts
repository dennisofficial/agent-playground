import { Injectable } from '@nestjs/common';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WORKTREES_DIR, mainWorktreeFromCommonDir } from '../domain/worktree.js';
import { parseWorktreeList, type GitWorktree } from '../domain/worktree-list.js';

export type GitResult = { ok: boolean; stdout: string; stderr: string };

/**
 * The only place in the TUI that shells out to `git`. Thin on purpose: it runs commands and reports
 * what happened, and every decision about WHICH command to run for a job lives in
 * `WorktreeService` — so the job-shaped rules stay testable against a plain temporary repository.
 *
 * **Its scope is Atlas's own workspace, and nothing else.** Worktrees, because Atlas is the one that
 * has to know where a job's turns run, and reads — is this a repository, what is checked out, is it
 * dirty — that the UI and the purge path need. It used to also `fetch`, `rebase` and
 * `push --force-with-lease`, on the agent's behalf, behind a `ship_pr` tool. That is gone: the agent
 * has a shell, shipping is its work, and a harness that silently rewrites a branch is making a call
 * that is not its to make. Nothing here pushes, and nothing here talks to a remote.
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
   * Every worktree of the repository containing `path`, main one first, as git lists them.
   *
   * An empty array for a folder that is not a repository — and for a git that failed for any other
   * reason too. The caller cannot tell those apart and does not need to: both mean "no worktrees to
   * show", and the job list falls back to an ungrouped run of rows either way.
   *
   * Deliberately NOT pruned first, unlike `addWorktree`. A record whose directory is gone is exactly
   * what the list wants to report; pruning would delete the evidence on the way to displaying it.
   */
  async worktrees(path: string): Promise<GitWorktree[]> {
    const result = await this.run({ cwd: path, args: ['worktree', 'list', '--porcelain'] });
    if (!result.ok) return [];
    return parseWorktreeList(result.stdout);
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
   * Generic escape hatch, and the reason there is no `push` beside it.
   *
   * `fetch`, `rebaseOnto` and `push --force-with-lease` used to live here as named methods, called
   * by `ShipService` inside a `ship_pr` tool call. Deleting them is the point of that change rather
   * than a side effect of it: a named `push` on this class is an invitation to ship from the harness
   * again, and the next person to add one should have to argue for it.
   */
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
