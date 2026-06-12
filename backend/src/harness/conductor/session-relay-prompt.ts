import type { Session } from '../sessions/session-registry.port';

/**
 * The seed prompt a session turn-end injects into its owner bot (gate-bypassed) — extracted from
 * the conductor so the branching is unit-testable. Seeds are per-relay messages, NOT under the
 * byte-stable prompt-cache constraint (they already interpolate the report).
 *
 * Four shapes:
 *  - failed     → brief failure relay (retry / redirect / drop).
 *  - questions  → the session ended its plan turn by ASKING: route each question (product WHAT/WHY
 *                 → Dennis, with a recommendation, held OPEN until he answers; known technical HOW
 *                 → answer it yourself), then answer ALL of them in ONE reply_session, no mode
 *                 change. The reply is recorded as planning Q&A and travels with the plan.
 *  - plan       → a finished plan (Q&A appendix included). Board-linked: post it for approval and
 *                 do NOT flip to execute — that unlocks only after Dennis approves. Unlinked: the
 *                 owner decides (the execute gate still answers at runtime, per the approval dial).
 *  - default    → ordinary prose report; unchanged behavior.
 */
export function sessionRelayPrompt(session: Session): string {
  const sid = session.id;
  if (session.status === 'failed') {
    return `[Session ${sid} — "${session.task}"] this turn FAILED: ${session.error ?? '(unknown)'}. The session is still open. Let the team know briefly, first person; reply_session("${sid}", <message>) to retry or redirect it, or close_session("${sid}") to drop it.`;
  }
  const report = session.lastReport ?? '(no report)';

  if (session.lastReportKind === 'questions') {
    return `[Session ${sid} — "${session.task}"] needs ANSWERS before its plan can be finished (it is still open, still in plan mode):
${report}

Route each question — you decide where it goes:
- Product WHAT/WHY (intent, scope, behavior, priorities): Dennis's call. Bring it to him in the channel WITH your recommendation, then leave it OPEN until he answers — no converging with teammates on an answer for him, no proceeding on an assumed answer.
- Technical HOW you already know (taught before, in recall(), or your own lane): answer it yourself.
Collect answers for ALL questions, then send them in ONE reply_session("${sid}", <answers by Q-number>) — do NOT change mode; the session stays in plan. Your reply is recorded as planning Q&A and shown with the plan at approval. If a question was already answered in an earlier round, repeat the answer rather than treating it as new.`;
  }

  if (session.lastReportKind === 'plan') {
    if (session.boardTaskId !== undefined) {
      return `[Session ${sid} — "${session.task}"] finished its PLAN (its planning Q&A is included below):
${report}

This session is linked to board task #${session.boardTaskId}. Next: post the plan for approval — update_board_task(${session.boardTaskId}, status 'awaiting_approval') — and give the team a short first-person summary of the plan's substance and its Q&A. Do NOT reply with mode 'execute': execution unlocks only after Dennis approves at a planning sitting and the team lead records it ('approved') — an early flip is refused. reply_session in plan mode is fine for refining the plan.`;
    }
    return `[Session ${sid} — "${session.task}"] finished its PLAN:
${report}

This is your own background session — still open with full context. Decide what's next:
- reply_session("${sid}", <message>) to refine the plan, or approve it into execution (mode: "execute") if it's small ad-hoc work clearly yours to call — the approval gate may refuse the flip; the refusal tells you what to do (board it and get it approved).
- Relay the plan to the team in the first person when it's worth sharing.
- close_session("${sid}") if the plan itself was the deliverable.
Route its open questions: WHAT to build or WHY is Dennis's call — bring it to him with your recommendation and leave it open until he answers. Technical HOW: answer it yourself if you already know; otherwise bring Dennis the options + your recommendation, and remember() his ruling.`;
  }

  return `[Session ${sid} — "${session.task}"] reported back:
${report}

This is your own background session — it's still open with full context. Decide what's next:
- reply_session("${sid}", <message>) to continue it — answer its question, ask a follow-up, or approve its plan into execution (mode: "execute").
- Relay the outcome to the team in the first person when it's worth sharing.
- close_session("${sid}") when this thread of work is finished.
Route its questions: WHAT to build or WHY is Dennis's call — bring it to him with your recommendation. Technical HOW: answer it yourself if you already know (taught before, in memory, or the teammate whose area it is); otherwise bring Dennis the options + your recommendation, and remember() his ruling.`;
}
