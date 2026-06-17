import type { BoardEvent } from '../memory/board-events.bus';
import type { Session } from '../sessions/session-registry.port';

/**
 * The seed an Atlas-owned background session injects into Atlas (gate-bypassed) when its turn ends —
 * the wake that carries the worker's report back so Atlas can act on it (reply, close, or speak).
 *
 * Restored after the Atlas migration removed the multi-bot relay path: only Atlas runs chat turns, so
 * only ATLAS-owned sessions (its `investigate` / `create_session` workers) relay through here. Pipeline
 * stage sessions are owned by specialists and driven by PipelineRunnerService — never this path. The
 * text interpolates the report, so it's deliberately NOT under the byte-stable prompt-cache constraint.
 */
export function sessionRelayPrompt(session: Session): string {
  const sid = session.id;
  const task = session.task;
  if (session.status === 'failed') {
    return `[Session ${sid} — "${task}"] this turn FAILED: ${session.error ?? '(unknown)'}. The session is still open. reply_session("${sid}", <message>) to retry or redirect it, or close_session("${sid}") to drop it. Mention it in the channel only if it's worth a heads-up.`;
  }
  const report = session.lastReport ?? '(no report)';
  if (session.lastReportKind === 'questions') {
    return `[Session ${sid} — "${task}"] came back with QUESTIONS before it can finish (still open, still in plan mode):\n${report}\n\nRoute each: product WHAT/WHY is Dennis's call — bring it to him with your recommendation and leave it open; technical HOW you already know — answer it. Then send ALL answers in ONE reply_session("${sid}", <answers>) with NO mode change. When a question reaches the channel, restate it in one line first.`;
  }
  if (session.lastReportKind === 'plan') {
    const linked =
      session.boardTaskId !== undefined
        ? ` It's linked to board task #${session.boardTaskId}; submit_plan("${sid}") attaches the plan to the ticket once you're happy with it.`
        : '';
    return `[Session ${sid} — "${task}"] finished its PLAN (self-reviewed; planning Q&A included):\n${report}\n\nThe session is still open with full context.${linked} reply_session("${sid}", <notes>) to revise, or close_session("${sid}") when it's served its purpose. Relay to the team in the first person if it's worth sharing.`;
  }
  return `[Session ${sid} — "${task}"] reported back:\n${report}\n\nThe session is still open with full context. reply_session("${sid}", <message>) to continue it, or close_session("${sid}") when this thread of work is done. Relay the outcome to the team in the first person if it's worth sharing.`;
}

/**
 * The seed a human-facing PIPELINE board event injects into Atlas (gate-bypassed) so the pipeline's
 * milestones — its PR opening, the self-review's verdict, a ship, a stall — get narrated in chat
 * instead of happening silently. The symmetric completion of {@link sessionRelayPrompt}: the pipeline
 * runs as detached specialist sessions, so without this Atlas (the single voice) would never speak to
 * the PR/review gates.
 *
 * Returns `null` for the events the conductor must NOT consume: `ticket-approved` (the plan-gate
 * resume, owned by PipelineRunnerService.onBoardEvent) and `plan-attached` — narrating them here would
 * double-handle the transition. Only the four human-facing review/PR events get a prompt.
 */
export function boardEventRelayPrompt(event: BoardEvent): string | null {
  switch (event.kind) {
    case 'pr-ready':
      return `[Pipeline · #${event.taskId}] the PR is ready for review: ${event.prUrl}. This is the PR gate — tell Dennis it's up and what it does, in your own voice. The ticket is in_review; it goes to done when he accepts.`;
    case 'pr-opened':
      return `[Pipeline · #${event.taskId}] draft PR opened (${event.prUrl}), final review running. No action yet — give a heads-up only if it's worth it.`;
    case 'self-review-ready':
      return `[Pipeline · #${event.taskId}] review finished; findings are in ticket note #${event.noteId}, PR ${event.prUrl}. Decide: ship it (mark_pr_ready) or feed the notes into a fix. Bring it to Dennis if it's his call.`;
    case 'self-review-failed':
      return `[Pipeline · #${event.taskId}] self-review couldn't auto-clear: ${event.reason}. The pipeline is paused — decide how to proceed and let Dennis know it needs attention.`;
    case 'design-gate':
      return `[Pipeline · #${event.taskId}] the build reached the DESIGN step for the '${event.section}' section — the functional UI is up. Tell Dennis he can design it (online) and hand you the zip to attach (attach_design), OR skip it for now (skip_design) and ship the functional version. This is his call — surface it, don't decide for him.`;
    case 'section-questions':
      return `[Pipeline · #${event.taskId}] the ${event.section ? `'${event.section}' ` : ''}session has QUESTIONS before it can finish — this is NOT a plan yet, so there's nothing to approve:\n${event.questions}\n\nRoute each: a product WHAT/WHY is Dennis's call — bring it to him with your recommendation; a technical HOW you already know — answer it yourself. Then send ALL answers in ONE answer_section(${event.taskId}, <answers>); it reworks and reports back (a revised plan, or more questions).`;
    // ticket-approved (PipelineRunnerService.onBoardEvent owns the plan-gate resume), the verdict
    // events (the runner reacts), and plan-attached are NOT narrated here — return null so the
    // conductor never double-handles them.
    default:
      return null;
  }
}
