import type { CliJobView, CliThreadView } from '../views.js';

/**
 * The job's structure as plain text sized for a MODEL, not a table drawn for a human: no box
 * drawing, no colour, no column alignment that shifts when a title grows. Indentation carries the
 * tree and `key=value` carries the facts, so a reader can skim it and an agent can grep it.
 *
 * Ids are printed in full. They are the argument to the next command (`atlas transcript <threadId>`),
 * and a shortened id would have to be pasted back as a shortened id, which nothing accepts.
 */
export function formatThreadTree(job: CliJobView): string {
  const threads = job.phases.flatMap((phase) => phase.threads);
  const lines: string[] = [
    `job ${job.id}  ${job.title}`,
    ...(job.workspacePath === null ? [] : [`workspace ${job.workspacePath}`]),
    ...(job.branch === null ? [] : [`branch ${job.branch}`]),
    `phases ${job.phases.length}  threads ${threads.length}  messages ${totalMessages(threads)}`,
  ];

  if (job.phases.length === 0) {
    // A job always has a phase (it is created with one), so this is a broken invariant worth saying
    // out loud rather than an empty section to shrug at.
    lines.push('', 'no phases — this job is in an impossible state');
    return lines.join('\n');
  }

  for (const phase of job.phases) {
    lines.push('', `phase ${phase.kind}${phase.current ? '  (current)' : ''}  id=${phase.id}`);
    if (phase.threads.length === 0) {
      lines.push('  (no threads yet)');
      continue;
    }
    for (const thread of phase.threads) {
      lines.push(`  ${threadLine(thread)}`);
      for (const session of thread.sessions) {
        const ended = session.endReason === null ? 'open' : `ended=${session.endReason}`;
        lines.push(`    session ${session.ordinal}  ${ended}`);
      }
    }
  }

  return lines.join('\n');
}

function threadLine(thread: CliThreadView): string {
  const parts = [
    `thread ${thread.id}`,
    `role=${thread.role}`,
    `status=${thread.status}`,
    `messages=${thread.messageCount}`,
    `sessions=${thread.sessions.length}`,
    `opened=${isoSeconds(thread.createdAt)}`,
  ];
  if (thread.closedAt !== null) parts.push(`closed=${isoSeconds(thread.closedAt)}`);
  return parts.join('  ');
}

function totalMessages(threads: readonly CliThreadView[]): number {
  return threads.reduce((total, thread) => total + thread.messageCount, 0);
}

/** Seconds are enough to order events and milliseconds are eleven characters of noise per line. */
function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}
