
export const APPROVE_ACTION_ID = 'atlas_approval:approve';
export const REQUEST_CHANGES_ACTION_ID = 'atlas_approval:request_changes';
export const DENY_ACTION_ID = 'atlas_approval:deny';
export const VIEW_PLAN_ACTION_ID = 'atlas_approval:view_plan';
export const SHIP_ACTION_ID = 'atlas_approval:ship';
export const RETRACT_SHIP_ACTION_ID = 'atlas_approval:retract_ship';
export const AMEND_APPROVE_ACTION_ID = 'atlas_approval:amend_approve';
export const AMEND_DISMISS_ACTION_ID = 'atlas_approval:amend_dismiss';
export const MERGE_ACTION_ID = 'atlas_approval:merge';
export const DB_WRITE_APPROVE_ACTION_ID = 'atlas_approval:db_write_approve';
export const DB_WRITE_DENY_ACTION_ID = 'atlas_approval:db_write_deny';

export interface ApprovalActionMeta {
  jobId: string;
  decisionRecordId?: string;
}

export interface ApprovalDecision {
  decisionClass: string;
  title: string;
  ruling: string;
  confirmedByOperator?: boolean;
}

export interface DecisionApprovalCard {
  jobId: string;
  decisionRecordId?: string;
  title: string;
  kind?: 'plan' | 'direct';
  summary: string;
  decisions?: ApprovalDecision[];
  threads: string[];
  planUrl?: string;
}

const SUMMARY_MAX = 2900;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;

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
            text: {
              type: 'mrkdwn',
              text: `*Decisions*\n${truncate(decisionList, SUMMARY_MAX)}`,
            },
          },
        ]
      : []),
    {
      type: 'thread',
      text: {
        type: 'mrkdwn',
        text: `*${listLabel}*\n${truncate(sectionList, SUMMARY_MAX)}`,
      },
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

export function verdictBlocks(
  originalBlocks: Array<Record<string, unknown>>,
  verdictLine: string,
): Array<Record<string, unknown>> {
  return [
    ...originalBlocks.filter((b) => b.type !== 'actions'),
    { type: 'context', elements: [{ type: 'mrkdwn', text: verdictLine }] },
  ];
}
