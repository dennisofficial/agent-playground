import { conductor } from '../../conductor.js';
import type { Command } from './types.js';

/**
 * The human-only approval gate, surfaced as chat commands. These call the conductor directly (never a chat
 * bot), so the model can never approve its own plan; each result is a local note, not a channel message.
 *
 * `/approve` and `/approve-ticket` are intentionally kept distinct: `/approve` sniffs the `TKT-` prefix and
 * routes to either a plan job or a ticket, while `/approve-ticket` always means the board. (The prefix-sniff
 * is brittle for bare ids like `003` — tracked separately as TKT-004 — and is preserved verbatim here.)
 */

/** `/approve <jobId|TKT-id> [edits]` — approve a plan job, or a ticket when the id carries the `TKT-` prefix. */
export const approveCommand: Command = {
  name: 'approve',
  summary: '/approve <job|TKT-id> [edits] — approve a plan job or ticket',
  run(text, ctx) {
    const m = text.match(/^\/approve\s+(\S+)\s*(.*)$/i);
    if (!m) return false;
    const id = m[1];
    const edits = m[2].trim() || undefined;
    const isTicket = /^TKT-/i.test(id);
    const res = isTicket ? conductor.approveTicket(id, edits) : conductor.approvePlan(id, edits);
    ctx.note(
      res.ok
        ? isTicket
          ? `✓ Approved ticket ${id} — plans frozen, ready for the team to build.`
          : `✓ Approved ${id} — building now.`
        : `Couldn't approve ${id}: ${res.reason}`,
    );
    return true;
  },
};

/** `/reject <jobId> <reason>` — send a plan back to revise. A reason is required. */
export const rejectCommand: Command = {
  name: 'reject',
  summary: '/reject <jobId> <reason> — send a plan back to revise',
  run(text, ctx) {
    const m = text.match(/^\/reject\s+(\S+)\s*(.*)$/i);
    if (!m) return false;
    const reason = m[2].trim();
    if (!reason) {
      ctx.note('Usage: /reject <jobId> <reason>');
      return true;
    }
    const res = conductor.rejectPlan(m[1], reason);
    ctx.note(
      res.ok
        ? `✕ Rejected ${m[1]} — sent back to revise.`
        : `Couldn't reject ${m[1]}: ${res.reason}`,
    );
    return true;
  },
};

/** `/approve-ticket <TKT-id> [edits]` — the standup sign-off: freeze a ticket's plans and make it buildable. */
export const approveTicketCommand: Command = {
  name: 'approve-ticket',
  summary: '/approve-ticket <TKT-id> [edits] — standup sign-off; freezes plans',
  run(text, ctx) {
    const m = text.match(/^\/approve-ticket\s+(\S+)\s*(.*)$/i);
    if (!m) return false;
    const id = m[1];
    const edits = m[2].trim() || undefined;
    const res = conductor.approveTicket(id, edits);
    ctx.note(
      res.ok
        ? `✓ Approved ticket ${id} — plans frozen, ready for the team to build.`
        : `Couldn't approve ${id}: ${res.reason}`,
    );
    return true;
  },
};
