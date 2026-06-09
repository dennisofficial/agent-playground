import type { TicketStatus } from './board/index.js';
import type { Job } from './jobs.js';

/**
 * Decide a ticket's status after one of its execute jobs reached a terminal state. PURE (no I/O) so it's
 * unit-testable without standing up the conductor singleton. Inputs: the just-finished job, ALL execute
 * jobs for the ticket, and the ticket's approved-plan owners. Returns the new status, or `undefined` to
 * leave it unchanged.
 *
 * The ticket goes `done` only once EVERY approved-plan discipline has an integrated (done) execute job —
 * not merely when no sibling is currently active — so a discipline that hasn't started its build yet can't
 * be locked out of an executable ticket (the multi-discipline bug). Order-independent: a discipline that
 * FAILED blocks the ticket whether it finished first or last.
 */
export function ticketStatusAfterExecute(
  finished: Job,
  ticketExecuteJobs: Job[],
  approvedOwners: string[],
): TicketStatus | undefined {
  const active = ticketExecuteJobs.some(
    (j) => j.id !== finished.id && (j.status === 'running' || j.status === 'awaiting'),
  );
  if (active) return undefined; // a sibling discipline is still building — leave it in_progress

  // Per approved discipline: `done` if it has ANY done job (publish-on-done ⇒ integrated), else `failed`
  // if it has a failed job, else `pending` (hasn't built, or only cancelled — still retryable).
  const stateOf = (owner: string): 'done' | 'failed' | 'pending' => {
    const js = ticketExecuteJobs.filter((j) => j.ownerBot === owner);
    if (js.some((j) => j.status === 'done')) return 'done';
    if (js.some((j) => j.status === 'failed')) return 'failed';
    return 'pending';
  };
  const states = approvedOwners.map(stateOf);
  if (states.length > 0 && states.every((s) => s === 'done')) return 'done';
  if (states.some((s) => s === 'failed')) return 'blocked';
  return undefined; // a discipline still owes a build — stay in_progress
}
