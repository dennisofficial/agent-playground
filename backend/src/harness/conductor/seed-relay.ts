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
 * milestones — its PR opening, the self-review's verdict, a ship, a stall, a TERMINAL FAILURE — get
 * narrated in chat instead of happening silently. The symmetric completion of {@link sessionRelayPrompt}:
 * the pipeline runs as detached specialist sessions, so without this Atlas (the single voice) would never
 * speak to the PR/review gates — nor know a run died (`run-failed`), the gap that let a crashed pipeline
 * sit unnoticed until Dennis asked.
 *
 * Returns `null` for the events the conductor must NOT consume: `ticket-approved` (the plan-gate
 * resume, owned by PipelineRunnerService.onBoardEvent) and `plan-attached` — narrating them here would
 * double-handle the transition. The human-facing review/PR events, the design/question relays, and the
 * `stage-decision` wake-up (Atlas's JIT decision menu) each get a prompt.
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
    case 'run-failed':
      return `[Pipeline · #${event.taskId}] the pipeline run FAILED${event.section ? ` while on the '${event.section}' section` : ''} and was torn down — reason: ${event.reason}. The ticket is back on the OPEN backlog. You own the recovery: tell Dennis it died and why in your own voice, then decide — re-dispatch (baking in whatever caused it, e.g. the answers a planning session needed up front), or bring it to him if the failure is his call. Don't leave it silently dead — you're the orchestrator, this is yours to drive.`;
    case 'design-gate':
      return `[Pipeline · #${event.taskId}] the build reached the DESIGN step for the '${event.section}' section — the functional UI is up. Tell Dennis he can design it (online) and hand you the zip to attach (attach_design), OR skip it for now (skip_design) and ship the functional version. This is his call — surface it, don't decide for him.`;
    case 'section-questions':
      // The verbatim questions are posted to the channel as a system notice (`sectionQuestionsNotice`)
      // BEFORE this seed runs, so Dennis sees them too and Atlas needn't restate them — the seed carries
      // only the routing instruction, not the questions.
      return `[Pipeline · #${event.taskId}] the ${event.section ? `'${event.section}' ` : ''}session paused with QUESTIONS — they were just posted to the channel as a system notice (Dennis can see them too), so DON'T repeat them. This is NOT a plan yet, so there's nothing to approve. Route each, answering by number: a product WHAT/WHY is Dennis's call — bring it to him with your recommendation; a technical HOW you already know — answer it yourself. Then send ALL answers in ONE answer_section(${event.taskId}, <answers>); it reworks and reports back (a revised plan, or more questions).`;
    case 'stage-decision': {
      // The "walk Atlas's hands" wake-up: findings + the decision he owns + the menu of allowed
      // actions, default-first. A gate-bypassed seed (outside the cached system prompt), so the dynamic
      // guidance never breaks prompt caching. The run is PAUSED; it advances when Atlas picks an action.
      const actions = event.allowedActions
        .map((a) => `  • ${a.action} — ${a.description}`)
        .join('\n');
      const scope = event.section ? ` for the '${event.section}' section` : '';
      return `[Pipeline · #${event.taskId}] the ${event.stage} stage finished${scope} and flagged this — the run is PAUSED until you decide:\n${event.findings}\n\nYou own this call — pick one:\n${actions}\n\nDecide in your own voice; only loop Dennis in if it turns out to be a product/scope call rather than a code defect.`;
    }
    case 'stage-findings': {
      // ADVISORY (the run keeps advancing on its own — nothing to unblock, unlike stage-decision): a
      // stage noticed out-of-scope work while building and reported it. You're the only voice that
      // reaches Dennis, so you triage — per item: worth his eyes now → suggest_task (a chip he
      // runs/keeps/dismisses); just worth recording → enqueue_finding (silent park); or skip if noise.
      const where = event.section ? `'${event.section}' ` : '';
      return `[Pipeline · #${event.taskId}] the ${where}stage flagged out-of-scope discoveries while building — these are NOT part of this ticket, and the run keeps advancing on its own (nothing here for you to unblock):\n${event.findings}\n\nTriage per item: worth Dennis's eyes now → suggest_task it (a chip he can run / keep / dismiss); just worth recording → enqueue_finding it (silent backlog park); or skip it if it's noise. Capturing needs no permission — don't pull him in beyond a chip.`;
    }
    // ticket-approved (PipelineRunnerService.onBoardEvent owns the plan-gate resume), the verdict
    // events (the runner reacts), and plan-attached are NOT narrated here — return null so the
    // conductor never double-handles them.
    default:
      return null;
  }
}

/**
 * The seed injected into Atlas (gate-bypassed) the moment he's added to a NEW channel and the workspace
 * is ready — so HE owns the welcome instead of a deterministic concierge. Carries just the channel
 * facts (name, project slug, whether a repo is linked); Atlas's turn enriches it from memory and decides
 * what to say. Interpolates channel data, so it is NOT under the byte-stable prompt-cache constraint.
 */
export function channelWelcomeSeed(info: {
  displayName: string;
  project: string;
  hasProject: boolean;
}): string {
  const repoState = info.hasProject
    ? 'It is already linked to a repo, so just offer to get started.'
    : "It is NOT linked to a repo yet — offer to onboard one (onboard_project) so you can actually build here, and note he can also point you at any of his projects to reference (read-only).";
  return `[Channel onboarding] You were just added to ${info.displayName} (project slug "${info.project}"). Introduce yourself in ONE short line — Dennis's orchestrator; you plan + dispatch the work and can reference his other projects. ${repoState} Recall any memory about "${info.project}" first. Keep it brief and in your own voice — don't dump a feature list, and don't ask him to do setup you can do yourself.`;
}

/**
 * The deterministic, non-LLM "system notice" the conductor posts to the channel the moment a pipeline
 * section session pauses with questions — so the VERBATIM questions reach Dennis (and Atlas's shared
 * context) regardless of what Atlas's follow-up turn does. Paired with the trimmed `section-questions`
 * branch of {@link boardEventRelayPrompt}, which no longer restates them. Markdown is fine — the Slack
 * surface's `translateOutbound` converts it to mrkdwn on post.
 */
export function sectionQuestionsNotice(
  event: Extract<BoardEvent, { kind: 'section-questions' }>,
): string {
  const where = event.section ? ` · ${event.section}` : '';
  return `🟡 **Pipeline #${event.taskId}${where}** — the session paused with questions before it can produce a plan:\n\n${event.questions}`;
}
