import type { DescriptionChangeEvent } from '@harness/approvals/board-notifier.port';
import type { PlanProposalEvent } from '@harness/approvals/proposal-presenter.port';

/**
 * The approval card's Block Kit surfaces — pure constants/builders, no I/O (the onboarding-guard-blocks
 * twin). The card is the Slack rendering of board state, not a store: the button `value` carries
 * only the task id; team/channel/ts ride the click payload, so verdicts are fully stateless and
 * survive restarts. Only universal block types (section/context/actions) — no `markdown` block,
 * no invalid_blocks fallback needed.
 */

export const APPROVE_ACTION_ID = 'approval:approve';
export const REQUEST_CHANGES_ACTION_ID = 'approval:request_changes';
export const DENY_ACTION_ID = 'approval:deny';
export const VIEW_PLAN_ACTION_ID = 'approval:view_plan';
export const REVISION_MODAL_CALLBACK_ID = 'approval:revision_notes';

/** A block_actions value / view private_metadata payload. `channel`/`ts` only travel through the
 * modal (a view_submission payload has no message coordinate of its own). */
export interface ApprovalActionMeta {
  taskId: number;
  channel?: string;
  ts?: string;
  surfaceId?: string;
}

// Slack caps a section block's text at 3 000 chars; stay under with room for the ellipsis line.
const SUMMARY_MAX = 2900;
const PLAN_CHUNK = 3500;
const PLAN_MAX_CHUNKS = 10;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;

/**
 * The proposal card: headline, the lead's summary, a context line, and the verdict buttons. When a
 * `planUrl` is given, a leading "📊 View full plan" link button opens the web Plan Viewer (rendered
 * diagrams + phase timeline + prose) — the way to read the plan without wading through the thread.
 */
export function proposalCardBlocks(
  e: PlanProposalEvent,
  planUrl?: string,
): Record<string, unknown>[] {
  const value = JSON.stringify({
    taskId: e.taskId,
  } satisfies ApprovalActionMeta);
  const planAuthors = e.plans.map((p) => p.employee).join(', ');
  const actionElements: Record<string, unknown>[] = [];
  if (planUrl) {
    // A url button still dispatches a block_actions event; its action_id is acked as a no-op.
    actionElements.push({
      type: 'button',
      action_id: VIEW_PLAN_ACTION_ID,
      url: planUrl,
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
  const viewerHint = planUrl ? ' · 📊 View full plan (with diagrams) above' : '';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Proposal — ticket #${e.taskId}: ${e.title}*`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(e.summary, SUMMARY_MAX) },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Proposed by ${e.proposedBy} · plans by ${planAuthors} — full text in this thread${viewerHint} · the verdict is Dennis's call`,
        },
      ],
    },
    {
      type: 'actions',
      elements: actionElements,
    },
  ];
}

/** The ruled-on card: the original blocks minus the buttons, plus a verdict context line —
 * what `chat.update` repaints after a verdict lands. */
export function verdictBlocks(
  originalBlocks: Array<Record<string, unknown>>,
  verdictLine: string,
): Record<string, unknown>[] {
  return [
    ...originalBlocks.filter((b) => b.type !== 'actions'),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: verdictLine }],
    },
  ];
}

/** The request-changes modal: one multiline input for Dennis's revision notes.
 * `private_metadata` carries the card coordinate (JSON ApprovalActionMeta). */
export function revisionModalView(meta: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: REVISION_MODAL_CALLBACK_ID,
    private_metadata: meta,
    title: { type: 'plain_text', text: 'Request changes' },
    submit: { type: 'plain_text', text: 'Send to the team' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'notes',
        label: { type: 'plain_text', text: 'What should change?' },
        element: {
          type: 'plain_text_input',
          action_id: 'notes',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Your notes go straight to the team and into the planning sessions.',
          },
        },
      },
    ],
  };
}

/** The description-change notification card: headline, context line with @mention + actor, then
 * full old and new descriptions (each truncated at SUMMARY_MAX). No action buttons — purely
 * informational. `bossMention` is the `<@Uxxxx>` string for Dennis (or a literal name fallback). */
export function descriptionChangeCardBlocks(
  e: DescriptionChangeEvent,
  bossMention?: string,
): Record<string, unknown>[] {
  const contextText = [bossMention, `Changed by ${e.changedBy}`]
    .filter(Boolean)
    .join(' · ');
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Description changed — ticket #${e.taskId}: ${e.title}*`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextText }],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Old description*\n${truncate(e.oldDescription, SUMMARY_MAX)}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*New description*\n${truncate(e.newDescription, SUMMARY_MAX)}`,
      },
    },
  ];
}

/** Split a plan into thread-reply-sized chunks at line boundaries, capped — the ticket holds the
 * full text (get_ticket), the thread is the readable copy. */
export function chunkPlan(planMd: string, max = PLAN_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = planMd;
  while (rest.length > 0 && chunks.length < PLAN_MAX_CHUNKS) {
    if (rest.length <= max) {
      chunks.push(rest);
      return chunks;
    }
    const slice = rest.slice(0, max);
    const nl = slice.lastIndexOf('\n');
    const cut = nl > max / 2 ? nl : max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 && chunks.length === PLAN_MAX_CHUNKS) {
    chunks[PLAN_MAX_CHUNKS - 1] +=
      '\n…(truncated — the ticket holds the full plan: get_ticket)';
  }
  return chunks;
}
