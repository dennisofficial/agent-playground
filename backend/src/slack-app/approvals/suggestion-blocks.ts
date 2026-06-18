import type { TaskSuggestionEvent } from '@harness/approvals/task-suggestion-presenter.port';

/**
 * The task-suggestion chip's Block Kit surfaces — pure constants/builders, no I/O (the
 * approval-blocks twin). The chip is the Slack rendering of a parked board candidate, not a store:
 * the button `value` carries only the task id; team/channel/ts ride the click payload, so
 * dispositions are stateless and survive restarts. Only universal block types (section/context/actions).
 */

export const SUGGESTION_PREFIX = 'suggestion:';
export const SUGGESTION_RUN_ACTION_ID = 'suggestion:run';
export const SUGGESTION_BACKLOG_ACTION_ID = 'suggestion:backlog';
export const SUGGESTION_DISMISS_ACTION_ID = 'suggestion:dismiss';

/** A block_actions value payload — only the board task id (everything else rides the click). */
export interface SuggestionActionMeta {
  taskId: number;
}

// Slack caps a section block's text at 3 000 chars; stay under with room for the ellipsis line.
const BODY_MAX = 2900;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`;

const DISPOSITION_HINT: Record<NonNullable<TaskSuggestionEvent['suggestedDisposition']>, string> = {
  run: 'Atlas suggests running it now',
  backlog: 'Atlas suggests parking it for later',
};

/** The suggestion chip: headline, the why, optional detail, a context line, and the three buttons. */
export function suggestionCardBlocks(
  e: TaskSuggestionEvent,
): Record<string, unknown>[] {
  const value = JSON.stringify({
    taskId: e.taskId,
  } satisfies SuggestionActionMeta);
  const hint = e.suggestedDisposition
    ? `${DISPOSITION_HINT[e.suggestedDisposition]} · `
    : '';
  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `💡 *Suggestion — #${e.taskId}: ${e.title}*`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(e.why, BODY_MAX) },
    },
  ];
  if (e.description)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(e.description, BODY_MAX) },
    });
  blocks.push(
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${hint}parked on the backlog as #${e.taskId} — run it now, keep it, or dismiss it`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          action_id: SUGGESTION_RUN_ACTION_ID,
          value,
          text: { type: 'plain_text', text: '▶️ Run now', emoji: true },
        },
        {
          type: 'button',
          action_id: SUGGESTION_BACKLOG_ACTION_ID,
          value,
          text: { type: 'plain_text', text: '📥 Keep in backlog', emoji: true },
        },
        {
          type: 'button',
          style: 'danger',
          action_id: SUGGESTION_DISMISS_ACTION_ID,
          value,
          text: { type: 'plain_text', text: '🗑️ Dismiss', emoji: true },
        },
      ],
    },
  );
  return blocks;
}

/** The acted-on chip: the original blocks minus the buttons, plus a disposition context line —
 * what `chat.update` repaints after Dennis clicks. */
export function suggestionVerdictBlocks(
  originalBlocks: Array<Record<string, unknown>>,
  dispositionLine: string,
): Record<string, unknown>[] {
  return [
    ...originalBlocks.filter((b) => b.type !== 'actions'),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: dispositionLine }],
    },
  ];
}
