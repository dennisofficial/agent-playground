/**
 * The decision-record approval card's Block Kit surfaces — a clean-room rewrite of v1's
 * `approval-blocks.ts`, pure constants/builders with NO I/O and no v1 imports. The card is a
 * stateless rendering: the button `value` carries only the ids it needs (decision record + job), so
 * verdicts survive restarts. Only universal block types (thread/context/actions). v1 was
 * board-stateful (taskId-keyed); this is decision-record-keyed for the v2 approve-once gate.
 */

export const APPROVE_ACTION_ID = 'atlas_approval:approve';
export const REQUEST_CHANGES_ACTION_ID = 'atlas_approval:request_changes';
export const DENY_ACTION_ID = 'atlas_approval:deny';
export const VIEW_PLAN_ACTION_ID = 'atlas_approval:view_plan';
/** The SHIP-REVIEW gate's "Ship it" button — the SECOND human gate (after `APPROVE_ACTION_ID` at the plan
 *  stage). Clicked at `awaiting_ship_review` to open the PR; its button `value` carries only `{ jobId }`
 *  (no decision record — nothing to re-rule, just resume the driver). Routed through the SAME `/approve`
 *  endpoint + `approval$` bridge, but the bridge dispatches it to the driver's ship-resume, not a verdict. */
export const SHIP_ACTION_ID = 'atlas_approval:ship';
/** Retract the ship-review gate back to planning — the manual "Back to building" click, the sibling of
 *  `SHIP_ACTION_ID`. Also carries only `{ jobId }`; routed to `ThreadDriver.retractShipDurably`. */
export const RETRACT_SHIP_ACTION_ID = 'atlas_approval:retract_ship';
/** The brain's "Amend build?" PROPOSAL card buttons. The brain's `withdraw_ship` tool can only PROPOSE
 *  amending (it no longer retracts directly); it posts a card carrying `{ jobId }`. Approving it runs the
 *  SAME operator retract path (`ThreadDriver.retractShipDurably`) AND wakes the brain to do the work;
 *  dismissing it just neutralizes the card and leaves the gate parked. Dedicated ids (not reused
 *  `RETRACT_SHIP_ACTION_ID`) so the plain ship-card "Amend build" click keeps its existing no-wake behavior. */
export const AMEND_APPROVE_ACTION_ID = 'atlas_approval:amend_approve';
export const AMEND_DISMISS_ACTION_ID = 'atlas_approval:amend_dismiss';

/** What rides in a button `value` / a verdict payload — the ids needed to resolve the gate. */
export interface ApprovalActionMeta {
  jobId: string;
  decisionRecordId?: string;
}

/** One locked architecture/system call shown on the card. */
export interface ApprovalDecision {
  decisionClass: string;
  title: string;
  ruling: string;
  /** PROVENANCE — true when the operator confirmed this call; false/absent = Atlas authored the default. */
  confirmedByOperator?: boolean;
}

/** The upfront approval proposal: the decision record + the high-level thread list, approved once. */
export interface DecisionApprovalCard {
  jobId: string;
  decisionRecordId?: string;
  title: string;
  /**
   * Which build path this approval gates:
   * - `plan` (default) — the full ceremony: a multi-thread build runs after approval.
   * - `direct` — the fast path: the brain implements the change itself in-sandbox after approval.
   *   `threads` then carries a short CHANGE OUTLINE rather than a thread list.
   */
  kind?: 'plan' | 'direct';
  /** The decision record summary (the architecture/system calls). */
  summary: string;
  /** The locked decisions (class + title + ruling) — the real calls being approved, not just a title. */
  decisions?: ApprovalDecision[];
  /** The high-level thread list (plan), or the change outline (direct), in order. */
  threads: string[];
  /** Optional deep link to a full plan view. */
  planUrl?: string;
}

// Slack caps a thread block's text at 3000 chars; stay under with room for the ellipsis line.
const SUMMARY_MAX = 2900;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;

/**
 * The proposal card: headline, the decision-record summary, the thread list, a context line, and
 * the verdict buttons. When `planUrl` is given, a leading "📊 View full plan" link button opens the
 * web plan view.
 */
export function decisionApprovalBlocks(card: DecisionApprovalCard): Array<Record<string, unknown>> {
  const value = JSON.stringify({
    jobId: card.jobId,
    ...(card.decisionRecordId ? { decisionRecordId: card.decisionRecordId } : {}),
  } satisfies ApprovalActionMeta);

  const isDirect = card.kind === 'direct';
  const headline = isDirect ? `*Direct build — ${card.title}*` : `*Plan proposal — ${card.title}*`;
  const listLabel = isDirect ? 'Changes' : 'Threads';
  const contextLine = isDirect
    ? 'Approve to let Atlas implement this change directly. The verdict is Dennis’s call.'
    : 'Approve once — threads then auto-run. The verdict is Dennis’s call.';

  const sectionList = card.threads.length
    ? card.threads.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : isDirect
      ? '_(see summary)_'
      : '_(no threads)_';

  // A leading `[confirmed]`/`[authored]` provenance tag rides in the bullet text so the web surface can
  // recover it from these blocks (the web card is reconstructed by regex-parsing this format). Leading,
  // not trailing, so the greedy ruling capture stays intact.
  const decisionList = (card.decisions ?? [])
    .map(
      (d) =>
        `• ${d.confirmedByOperator ? '[confirmed]' : '[authored]'} *${d.title}* _(${d.decisionClass})_ — ${d.ruling}`,
    )
    .join('\n');

  const actionElements: Array<Record<string, unknown>> = [];
  if (card.planUrl) {
    actionElements.push({
      type: 'button',
      action_id: VIEW_PLAN_ACTION_ID,
      url: card.planUrl,
      value,
      text: { type: 'plain_text', text: '📊 View full plan', emoji: true },
    });
  }
  actionElements.push(
    {
      type: 'button',
      style: 'primary',
      action_id: APPROVE_ACTION_ID,
      value,
      text: { type: 'plain_text', text: '✅ Approve', emoji: true },
    },
    {
      type: 'button',
      style: 'danger',
      action_id: DENY_ACTION_ID,
      value,
      text: { type: 'plain_text', text: '❌ Deny', emoji: true },
    },
  );

  return [
    {
      type: 'thread',
      text: { type: 'mrkdwn', text: headline },
    },
    {
      type: 'thread',
      text: { type: 'mrkdwn', text: truncate(card.summary, SUMMARY_MAX) },
    },
    ...(decisionList
      ? [
          {
            type: 'thread',
            text: { type: 'mrkdwn', text: `*Decisions*\n${truncate(decisionList, SUMMARY_MAX)}` },
          },
        ]
      : []),
    {
      type: 'thread',
      text: { type: 'mrkdwn', text: `*${listLabel}*\n${truncate(sectionList, SUMMARY_MAX)}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextLine,
        },
      ],
    },
    { type: 'actions', elements: actionElements },
  ];
}

/** The ruled-on card: the original blocks minus the buttons, plus a verdict context line — what a
 * `chat.update` repaints after a verdict lands. */
export function verdictBlocks(
  originalBlocks: Array<Record<string, unknown>>,
  verdictLine: string,
): Array<Record<string, unknown>> {
  return [
    ...originalBlocks.filter((b) => b.type !== 'actions'),
    { type: 'context', elements: [{ type: 'mrkdwn', text: verdictLine }] },
  ];
}
