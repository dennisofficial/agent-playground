/**
 * The decision-record approval card's Block Kit surfaces — a clean-room rewrite of v1's
 * `approval-blocks.ts`, pure constants/builders with NO I/O and no v1 imports. The card is a
 * stateless rendering: the button `value` carries only the ids it needs (decision record + job), so
 * verdicts survive restarts. Only universal block types (section/context/actions). v1 was
 * board-stateful (taskId-keyed); this is decision-record-keyed for the v2 approve-once gate.
 */

export const APPROVE_ACTION_ID = 'atlas_approval:approve';
export const REQUEST_CHANGES_ACTION_ID = 'atlas_approval:request_changes';
export const DENY_ACTION_ID = 'atlas_approval:deny';
export const VIEW_PLAN_ACTION_ID = 'atlas_approval:view_plan';

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
}

/** The upfront approval proposal: the decision record + the high-level section list, approved once. */
export interface DecisionApprovalCard {
  jobId: string;
  decisionRecordId?: string;
  title: string;
  /** The decision record summary (the architecture/system calls). */
  summary: string;
  /** The locked decisions (class + title + ruling) — the real calls being approved, not just a title. */
  decisions?: ApprovalDecision[];
  /** The high-level section list (one brief per section), in order. */
  sections: string[];
  /** Optional deep link to a full plan view. */
  planUrl?: string;
}

// Slack caps a section block's text at 3000 chars; stay under with room for the ellipsis line.
const SUMMARY_MAX = 2900;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;

/**
 * The proposal card: headline, the decision-record summary, the section list, a context line, and
 * the verdict buttons. When `planUrl` is given, a leading "📊 View full plan" link button opens the
 * web plan view.
 */
export function decisionApprovalBlocks(card: DecisionApprovalCard): Array<Record<string, unknown>> {
  const value = JSON.stringify({
    jobId: card.jobId,
    ...(card.decisionRecordId ? { decisionRecordId: card.decisionRecordId } : {}),
  } satisfies ApprovalActionMeta);

  const sectionList = card.sections.length
    ? card.sections.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '_(no sections)_';

  const decisionList = (card.decisions ?? [])
    .map((d) => `• *${d.title}* _(${d.decisionClass})_ — ${d.ruling}`)
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
      action_id: REQUEST_CHANGES_ACTION_ID,
      value,
      text: { type: 'plain_text', text: '✏️ Request changes', emoji: true },
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
      type: 'section',
      text: { type: 'mrkdwn', text: `*Plan proposal — ${card.title}*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(card.summary, SUMMARY_MAX) },
    },
    ...(decisionList
      ? [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Decisions*\n${truncate(decisionList, SUMMARY_MAX)}` },
          },
        ]
      : []),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Sections*\n${truncate(sectionList, SUMMARY_MAX)}` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Approve once — sections then auto-run. The verdict is Dennis’s call.',
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
