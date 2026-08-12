import { Injectable } from '@nestjs/common';
import {
  parseDefaultBranch,
  parseOpenPullRequest,
  pullRequestFromUrl,
  type PullRequestRef,
} from '../domain/ship.js';

/**
 * The only place in the TUI that shells out to `gh`. A sibling of `GitService` rather than a method
 * on it: they are different binaries with different failure modes — git is always there, `gh` may be
 * missing, unauthenticated, or pointed at no remote at all — and a caller reading `githubCliService`
 * knows it is about to depend on the second.
 *
 * **Every method throws on a non-zero exit**, and that asymmetry with `GitService` is deliberate.
 * `GitService` reports what happened because most of its callers have a fallback; here, a question
 * that could not be asked must never be mistaken for an answer — "no pull request exists" read off a
 * failed `gh pr list` is how a re-ship opens a second pull request.
 *
 * No private members: shipping is tested against a fake of exactly this surface, and a private
 * method would make the class un-implementable by anything but itself.
 */
@Injectable()
export class GithubCliService {
  /** GitHub's fact, read at ship time. Never stored — a renamed base under a stored copy is a rebase onto nothing. */
  async defaultBranch(cwd: string): Promise<string> {
    const result = await runGh({
      cwd,
      args: ['repo', 'view', '--json', 'defaultBranchRef'],
    });
    const branch = parseDefaultBranch(result.stdout);
    if (!branch) {
      throw new Error(
        `gh could not name this repository's default branch: ${firstLine(result.stdout)}`,
      );
    }
    return branch;
  }

  /**
   * The open pull request for a branch, or null when there is genuinely none.
   *
   * `pr list --state open`, not `pr view`: `view` exits non-zero when there is no pull request, and
   * an exit code means both "none" and "gh is broken". The list answers `[]` for the first and
   * fails for the second, which is the whole of what idempotence needs to tell apart.
   */
  async openPullRequest(args: { cwd: string; branch: string }): Promise<PullRequestRef | null> {
    const result = await runGh({
      cwd: args.cwd,
      args: ['pr', 'list', '--head', args.branch, '--state', 'open', '--json', 'number,url'],
    });
    const trimmed = result.stdout.trim();
    if (trimmed === '[]') return null;
    const pr = parseOpenPullRequest(result.stdout);
    if (!pr) {
      // Neither a pull request nor an empty list: refuse rather than guess, because guessing "none"
      // is what opens a duplicate.
      throw new Error(`gh pr list answered something unreadable: ${firstLine(result.stdout)}`);
    }
    return pr;
  }

  /** Opens one. The number comes back out of the URL it prints, rather than from a second call. */
  async createPullRequest(args: {
    cwd: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<PullRequestRef> {
    const result = await runGh({
      cwd: args.cwd,
      args: [
        'pr',
        'create',
        '--base',
        args.base,
        '--head',
        args.head,
        '--title',
        args.title,
        // `--body` and not `--body-file`: the body is the agent's prose, already in memory, and a
        // temp file would be one more thing to clean up on a failure path.
        '--body',
        args.body,
      ],
    });
    const pr = pullRequestFromUrl(result.stdout);
    if (!pr) {
      throw new Error(`gh pr create printed no pull request URL: ${firstLine(result.stdout)}`);
    }
    return pr;
  }
}

/**
 * Module-level rather than a method so the class above has nothing private in it — see the class
 * comment. Throwing here is what makes every method's failure identical and unignorable.
 */
async function runGh(args: { cwd: string; args: readonly string[] }): Promise<{ stdout: string }> {
  const proc = Bun.spawn({
    cmd: ['gh', ...args.args],
    cwd: args.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`gh ${args.args[0] ?? ''} failed: ${firstLine(stderr) || firstLine(stdout)}`);
  }
  return { stdout };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
