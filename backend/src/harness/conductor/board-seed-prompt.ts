/**
 * The seed prompts a board state-transition injects into a bot (gate-bypassed, via injectSeed) —
 * the board analogue of session-relay-prompt.ts. Mechanical wake-ups for the two unambiguous
 * handoffs that today rely on prose (an owner remembering to announce, the lead's gate happening to
 * fire). Like session relays, these are per-wake messages (not under the byte-stable prompt-cache
 * constraint) and a seed is visible ONLY to the woken bot — what (if anything) it says in the
 * channel is its own call.
 */

/** Wake the lead to review a freshly-attached plan (layer 1). */
export function planReadySeed(p: {
  taskId: number;
  employee: string;
}): string {
  return `[Board] ${p.employee}'s plan on ticket #${p.taskId} just attached (or re-attached after a revision) and is pending your review. Read it with get_ticket(${p.taskId}); if it's ready, approve_plan(${p.taskId}, "${p.employee}") or reply revision notes into ${p.employee}'s planning session. If it reads mid-iteration (still rough, open TODOs, the owner hasn't signalled it's ready), hold — they'll tell the channel when it's done. This is a silent heads-up, not a message to post; only say something if you actually need to.`;
}

/**
 * Wake the plan's owner that their ticket is approved — execution is unblocked. Carries the
 * resolved worktree so the action is mechanically possible (a fresh execute session needs a
 * worktreeId; ticket state alone doesn't expose one).
 */
export function ticketApprovedSeed(p: {
  taskId: number;
  worktreeId?: string;
}): string {
  const where = p.worktreeId
    ? `Open a FRESH execute session against worktree "${p.worktreeId}" (create_session(worktreeId: "${p.worktreeId}", mode: "execute", board_task_id: ${p.taskId})) from the plan attached to the ticket.`
    : `Your planning session/worktree for this ticket isn't resolvable anymore — create_worktree, then open a fresh execute session (mode: "execute", board_task_id: ${p.taskId}) from the plan on the ticket (get_ticket(${p.taskId})).`;
  return `[Board] Ticket #${p.taskId} is APPROVED — execution is unblocked. ${where} Note: if a standup is still open and your deployment gates execution on it, the system will refuse the flip until the lead closes it — that refusal tells you to wait. This is a silent heads-up; relay to the team in the first person only if it's worth sharing.`;
}
