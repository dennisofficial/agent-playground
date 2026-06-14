import { tmpl } from '../_shared/tmpl';
import type { Session } from '../sessions/session-registry.port';

/**
 * The seed prompts the conductor injects into a bot (gate-bypassed) on a session turn-end or a board
 * state-transition. Per-relay/per-wake messages, NOT under the byte-stable prompt-cache constraint
 * (they interpolate the report), and a seed is visible ONLY to the woken bot. Prompt text lives in
 * `tmpl` constants here; the branching that picks a shape stays in the small dispatcher functions.
 */

// ── session turn-end relays ───────────────────────────────────────────────────
// Four shapes:
//  - failed     → brief failure relay (retry / redirect / drop).
//  - questions  → the plan turn ended by ASKING: route each (product WHAT/WHY → Dennis held OPEN;
//                 known technical HOW → answer it), then answer ALL in ONE reply_session, no mode change.
//  - plan       → a finished plan (Q&A appendix included). Board-linked: submit for approval, do NOT
//                 flip to execute. Unlinked: the owner decides (the execute gate still answers at runtime).
//  - default    → ordinary prose report.

const RELAY_FAILED = tmpl`[Session ${'sid'} — "${'task'}"] this turn FAILED: ${'error'}. The session is still open. Let the team know briefly, first person; reply_session("${'sid'}", <message>) to retry or redirect it, or close_session("${'sid'}") to drop it.`;

const RELAY_QUESTIONS = tmpl`[Session ${'sid'} — "${'task'}"] needs ANSWERS before its plan can be finished (it is still open, still in plan mode):
${'report'}

Route each question — you decide where it goes:
- Product WHAT/WHY (intent, scope, behavior, priorities): Dennis's call. Bring it to him in the channel WITH the question itself (a one-line restatement plus the options) AND your recommendation, then leave it OPEN until he answers — no converging with teammates on an answer for him, no proceeding on an assumed answer.
- Technical HOW you already know (taught before, in recall(), or your own lane): answer it yourself. If you announce a decision in the channel, restate the question in one line before your answer — nobody else can see inside your session, so a bare "Q1: option 1" is unreadable. Q-numbers only exist inside the session; never reference a question by number alone in chat.
Collect answers for ALL questions, then send them in ONE reply_session("${'sid'}", <answers by Q-number>) — do NOT change mode; the session stays in plan. Your reply is recorded as planning Q&A and shown with the plan at approval. If a question was already answered in an earlier round, repeat the answer rather than treating it as new.`;

const RELAY_PLAN_BOARD = tmpl`[Session ${'sid'} — "${'task'}"] finished its PLAN (self-reviewed; its planning Q&A is included below):
${'report'}

This session is linked to board task #${'boardTaskId'}. The plan is NOT attached yet — it came back to YOU to approve first, like reviewing your own Claude Code's plan before pushing it. Next:
- READ the plan above. Happy with it? submit_plan("${'sid'}") attaches it to ticket #${'boardTaskId'} and notifies @Sam to review — that's your explicit approval of your own plan. Want changes first? reply_session("${'sid'}", <your notes>) and it'll revise and come back; submit when it's right.
- After submitting, tell the team in the first person and brief that your plan on #${'boardTaskId'} is ready — @Sam reviews every submitted plan before anything is proposed to Dennis.
- Keep THIS session OPEN through the WHOLE approval pipeline — Sam's review AND Dennis's verdict. Sam's approval only clears layer 1; it is NOT your cue to close. Any revision notes — Sam's, then Dennis's — reply_session straight in, then submit_plan again to re-attach the revised plan with full planning context intact.
- close_session("${'sid'}") ONLY once Dennis has APPROVED (and the standup closes) — the ticket carries the plan and the execute session opens fresh from it. Closing earlier throws away the context you'll want for revisions.
Do NOT set any board status yourself and do NOT reply with mode 'execute' — the system refuses early flips.`;

const RELAY_PLAN_UNLINKED = tmpl`[Session ${'sid'} — "${'task'}"] finished its PLAN:
${'report'}

This is your own background session — still open with full context. Decide what's next:
- reply_session("${'sid'}", <message>) to refine the plan, or approve it into execution (mode: "execute") if it's small ad-hoc work clearly yours to call — the approval gate may refuse the flip; the refusal tells you what to do (board it and get it approved).
- Relay the plan to the team in the first person when it's worth sharing.
- close_session("${'sid'}") if the plan itself was the deliverable.
Route its open questions: WHAT to build or WHY is Dennis's call — bring it to him with your recommendation and leave it open until he answers. Technical HOW: answer it yourself if you already know; otherwise bring Dennis the options + your recommendation, and remember() his ruling. Either way, when a question reaches the channel, restate it in one line first — nobody else can see inside your session.`;

const RELAY_DEFAULT = tmpl`[Session ${'sid'} — "${'task'}"] reported back:
${'report'}

This is your own background session — it's still open with full context. Decide what's next:
- reply_session("${'sid'}", <message>) to continue it — answer its question, ask a follow-up, or send a course correction.
- Relay the outcome to the team in the first person when it's worth sharing.
- close_session("${'sid'}") when this thread of work is finished.
Route its questions: WHAT to build or WHY is Dennis's call — bring it to him with your recommendation. Technical HOW: answer it yourself if you already know (taught before, in memory, or the teammate whose area it is); otherwise bring Dennis the options + your recommendation, and remember() his ruling. Either way, when a question reaches the channel, restate it in one line first — nobody else can see inside your session.`;

/** The seed prompt a session turn-end injects into its owner bot (gate-bypassed). */
export function sessionRelayPrompt(session: Session): string {
  const sid = session.id;
  const task = session.task;
  if (session.status === 'failed') {
    return RELAY_FAILED({ sid, task, error: session.error ?? '(unknown)' });
  }
  const report = session.lastReport ?? '(no report)';

  if (session.lastReportKind === 'questions') {
    return RELAY_QUESTIONS({ sid, task, report });
  }

  if (session.lastReportKind === 'plan') {
    if (session.boardTaskId !== undefined) {
      return RELAY_PLAN_BOARD({
        sid,
        task,
        report,
        boardTaskId: String(session.boardTaskId),
      });
    }
    return RELAY_PLAN_UNLINKED({ sid, task, report });
  }

  return RELAY_DEFAULT({ sid, task, report });
}

// ── board state-transition wake-ups ──────────────────────────────────────────
// The board analogue of the session relays: mechanical wake-ups for the two unambiguous handoffs that
// otherwise rely on prose (an owner remembering to announce, the lead's gate happening to fire).

const PLAN_READY_SEED = tmpl`[Board] ${'employee'}'s plan on ticket #${'taskId'} just attached (or re-attached after a revision) and is pending your review. Read it with get_ticket(${'taskId'}); if it's ready, approve_plan(${'taskId'}, "${'employee'}") or reply revision notes into ${'employee'}'s planning session. If it reads mid-iteration (still rough, open TODOs, the owner hasn't signalled it's ready), hold — they'll tell the channel when it's done. This is a silent heads-up, not a message to post; only say something if you actually need to.`;

/** Wake the lead to review a freshly-attached plan (layer 1). */
export function planReadySeed(p: { taskId: number; employee: string }): string {
  return PLAN_READY_SEED({ employee: p.employee, taskId: String(p.taskId) });
}

const APPROVED_WHERE_WORKTREE = tmpl`Open a FRESH execute session against worktree "${'worktreeId'}" (create_session(worktreeId: "${'worktreeId'}", mode: "execute", board_task_id: ${'taskId'})) from the plan attached to the ticket.`;
const APPROVED_WHERE_GONE = tmpl`Your planning session/worktree for this ticket isn't resolvable anymore — create_worktree, then open a fresh execute session (mode: "execute", board_task_id: ${'taskId'}) from the plan on the ticket (get_ticket(${'taskId'})).`;
const APPROVED_SEED = tmpl`[Board] Ticket #${'taskId'} is APPROVED — execution is unblocked. ${'where'} Note: if a standup is still open and your deployment gates execution on it, the system will refuse the flip until the lead closes it — that refusal tells you to wait. This is a silent heads-up; relay to the team in the first person only if it's worth sharing.`;

/**
 * Wake the plan's owner that their ticket is approved — execution is unblocked. Carries the resolved
 * worktree so the action is mechanically possible (a fresh execute session needs a worktreeId).
 */
export function ticketApprovedSeed(p: {
  taskId: number;
  worktreeId?: string;
}): string {
  const taskId = String(p.taskId);
  const where = p.worktreeId
    ? APPROVED_WHERE_WORKTREE({ worktreeId: p.worktreeId, taskId })
    : APPROVED_WHERE_GONE({ taskId });
  return APPROVED_SEED({ taskId, where });
}
