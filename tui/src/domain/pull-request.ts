/**
 * The pull request a job has, as a fact Atlas is TOLD rather than one it goes and gets.
 *
 * Atlas used to ship: a `ship_pr` tool rebased, force-pushed and called `gh pr create` on the
 * agent's behalf, and this module was the parsing half of that. All of it is gone. Shipping is git
 * work, git work is the agent's work, and the agent has a shell — a harness that runs
 * `git push --force-with-lease` for it is a harness making a judgement call (rewrite this branch)
 * that nobody asked it to make and that the agent cannot see, argue with, or do differently.
 *
 * What is left is the one thing the agent genuinely cannot do for itself: write to Atlas's own
 * database. That is the whole of this file.
 */

/** The two facts a pull request is worth caching: the number you click and the URL you open. */
export type PullRequestRef = { number: number; url: string };

/**
 * A pull request URL → its number.
 *
 * Takes the LAST line of whatever it is handed, because the realistic input is not a hand-typed URL
 * — it is what `gh pr create` printed, which is a URL on its own line after however much progress
 * chatter `gh` felt like emitting. Tolerating that is the difference between one tool call and a
 * round trip spent explaining what a URL is.
 *
 * `null` rather than a throw for anything unrecognised: the caller has a sentence to say about a
 * malformed URL that a stack trace does not.
 */
export function pullRequestFromUrl(value: string): PullRequestRef | null {
  const url = value.trim().split('\n').at(-1)?.trim();
  if (!url) return null;
  const match = /^https?:\/\/[^\s]*\/pull\/(\d+)(?:[/?#][^\s]*)?$/.exec(url);
  const number = match?.[1];
  if (!number) return null;
  return { number: Number(number), url };
}

/** What the agent is told when the URL it handed over was not one. */
export function pullRequestRefusal(value: string): string {
  return `\`${value.trim().split('\n').at(-1) ?? value}\` is not a pull request URL — it should look like \`https://github.com/owner/repo/pull/123\`. Nothing was recorded. Paste what \`gh pr create\` printed, or what \`gh pr view --json url\` answers.`;
}

/**
 * The reply, which says which of the two things happened.
 *
 * Recording the SAME number twice is not an error and must not read like one — a ci thread that
 * re-pushes and re-records is doing exactly what it should, and a reply that sounded like a warning
 * would teach it to stop.
 */
export function recordedReply(args: {
  pr: PullRequestRef;
  previous: number | null;
}): string {
  const { pr, previous } = args;
  if (previous === pr.number) {
    return `Still pull request #${pr.number} on this job: ${pr.url}\n\nNothing changed — it was already recorded. That is the expected answer for a re-ship.`;
  }
  const head =
    previous === null
      ? `Pull request #${pr.number} recorded against this job: ${pr.url}`
      : `This job's pull request is now #${pr.number}: ${pr.url} (it was #${previous}).`;
  return `${head}\n\nThe jobs list shows it from here. Nothing watches it — Atlas polls nothing and receives no webhooks, so this number is a note, not a status.`;
}
