/**
 * Shipping's pure half: what `gh --json` answered, which branch a ship turn is allowed to touch, and
 * the sentences that come back.
 *
 * The parses here are of JSON that `gh` was explicitly asked for, never of prose or of a command's
 * human-readable output — a `--json` field is a contract, a formatted line is a rendering. Anything
 * unrecognised answers `null` rather than throwing: the caller has a better sentence to say about a
 * missing pull request than a stack trace does, and a shipping turn must fail with an instruction.
 */

/** The two facts a pull request is worth caching: the number you click and the URL you open. */
export type PullRequestRef = { number: number; url: string };

/**
 * `gh repo view --json defaultBranchRef`. Read at ship time and never stored — it is GitHub's fact,
 * not Atlas's, and a base branch renamed under a stored copy would rebase onto a ref that is gone.
 */
export function parseDefaultBranch(stdout: string): string | null {
  const value = parseJson(stdout);
  if (!isRecord(value)) return null;
  const ref = value.defaultBranchRef;
  if (!isRecord(ref)) return null;
  return typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : null;
}

/**
 * `gh pr list --head <branch> --state open --json number,url`, which answers `[]` rather than
 * failing when there is none — the distinction this whole function exists to preserve, because
 * "no pull request" and "the question could not be asked" must not both produce a second PR.
 *
 * The first entry wins. `gh` lists newest first, and a branch with two open pull requests is
 * already a situation no automatic choice improves.
 */
export function parseOpenPullRequest(stdout: string): PullRequestRef | null {
  const value = parseJson(stdout);
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const ref = pullRequestRef(entry);
    if (ref) return ref;
  }
  return null;
}

/**
 * `gh pr create` prints the URL of what it made and nothing else, so the number — the render cache
 * the job list wants — is read back out of it rather than bought with a second shell call.
 */
export function pullRequestFromUrl(stdout: string): PullRequestRef | null {
  const url = stdout.trim().split('\n').at(-1)?.trim();
  if (!url) return null;
  const match = /\/pull\/(\d+)/.exec(url);
  const number = match?.[1];
  if (!number) return null;
  return { number: Number(number), url };
}

/** Which branch this ship turn pushes — or why it may not push at all. */
export type ShipBranch = { ok: true; branch: string } | { ok: false; reason: string };

/**
 * `Job.branch` outlives the worktree it was unpacked into, so a job can name a branch that is not
 * checked out anywhere — `workspacePath` null with `branch` set means *had a worktree, doesn't now*,
 * and the fallback cwd is the project path, where the human's own branch is checked out.
 *
 * Refusing that combination is the whole point: rebasing and force-pushing whatever HEAD happens to
 * be is how a ship turn eats the branch Dennis had open in his editor. A job that never took a
 * worktree has no recorded branch and ships what it is standing on, which is the pre-worktree
 * behaviour and is correct.
 */
export function shipBranch(args: {
  jobBranch: string | null;
  headBranch: string | null;
}): ShipBranch {
  const { jobBranch, headBranch } = args;
  if (!headBranch) {
    return {
      ok: false,
      reason:
        'nothing is checked out here to ship — HEAD names no branch (a detached head, or a folder that is not a repository).',
    };
  }
  if (!jobBranch) return { ok: true, branch: headBranch };
  if (jobBranch !== headBranch) {
    return {
      ok: false,
      reason: `this job's branch is \`${jobBranch}\` but \`${headBranch}\` is checked out here — its worktree is gone. Re-enter the worktree before shipping; rebasing and pushing whatever is checked out would be somebody else's branch.`,
    };
  }
  return { ok: true, branch: jobBranch };
}

/**
 * A pull request from the base branch to itself is not a thing, and the failure `gh` gives for it
 * reads like a bug in Atlas. Checked after the base is read, because the base is only knowable then.
 */
export function baseBranchRefusal(args: { branch: string; base: string }): string | null {
  if (args.branch !== args.base) return null;
  return `\`${args.branch}\` IS this repository's default branch — there is nothing to open a pull request from. This job never took a branch of its own; give it a worktree first.`;
}

/**
 * What the agent is told, and the one place the two outcomes are worded.
 *
 * Both say the branch was rebased and pushed, because both did: the difference between the first
 * ship and the fifth is one sentence about the pull request, and stating it plainly is what stops a
 * re-ship reading like a failure.
 */
export function shippedReply(args: {
  branch: string;
  base: string;
  pr: PullRequestRef;
  created: boolean;
}): string {
  const head = `\`${args.branch}\` is rebased onto \`${args.base}\` and pushed.`;
  return args.created
    ? `${head}\n\nPull request #${args.pr.number} opened: ${args.pr.url}\n\nThat is the whole of this phase. Nothing watches the build — say what you shipped and close.`
    : `${head}\n\nPull request #${args.pr.number} already existed and now carries the new commits: ${args.pr.url}\n\nNo second pull request was opened. Say which happened and close.`;
}

/**
 * A rebase that stops on a conflict leaves the worktree mid-rebase, which is a trap for whoever
 * opens it next and a state the agent has no verb to leave. The caller aborts; this says so, and
 * says what the human's move is — a conflict is a judgement, not a retry.
 */
export function rebaseFailedMessage(args: { base: string; stderr: string }): string {
  const detail = args.stderr.trim().split('\n').slice(0, 4).join('\n');
  return `rebase onto \`origin/${args.base}\` failed and was aborted, so the worktree is untouched:\n\n${detail}\n\nNothing was pushed. This needs a person: resolve it in the worktree, or say so and let Dennis start a phase for it.`;
}

function pullRequestRef(value: unknown): PullRequestRef | null {
  if (!isRecord(value)) return null;
  const { number, url } = value;
  if (typeof number !== 'number' || !Number.isInteger(number)) return null;
  if (typeof url !== 'string' || url.length === 0) return null;
  return { number, url };
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    // `gh` printing something that is not the JSON it was asked for is a broken/unauthenticated
    // install, and the caller's error sentence names that better than a SyntaxError does.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
