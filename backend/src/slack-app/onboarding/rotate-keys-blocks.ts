/**
 * The credential-ROTATION Block Kit surfaces — pure constants/builders, no I/O (the onboarding-guard /
 * project-onboard blocks twin). The modal is THE secrets path: a `view_submission` payload is never a
 * chat message, so a rotated key / re-issued subscription token reaches the encrypted store without
 * ever touching Slack history or the harness channel log.
 *
 * Unlike the first-time keys modal, every field here is OPTIONAL — a rotation updates only what
 * changed (the expired one), leaving the rest in place.
 */

/** All rotate action/callback ids share this prefix — the router slot namespaces on it (no overlap
 * with `keys:` / `onboard:` / `approval:` / `suggestion:`). */
export const ROTATE_PREFIX = 'rotate:';
export const ROTATE_OPEN_ACTION_ID = 'rotate:open';
export const ROTATE_MODAL_CALLBACK_ID = 'rotate:submit';

/** Modal input coordinates — `view.state.values[blockId][actionId].value`. */
export const ROTATE_MODAL_BLOCKS = {
  /** Anthropic API key (chat/gate/embeddings + api_key-mode engine turns). */
  anthropic: { blockId: 'anthropic_key', actionId: 'value' },
  /** OpenAI API key (embeddings + api_key-mode Codex turns). */
  openai: { blockId: 'openai_key', actionId: 'value' },
  /** Claude Max subscription token (`claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN). */
  anthropicSub: { blockId: 'anthropic_sub', actionId: 'value' },
  /** Codex (ChatGPT) subscription `auth.json` blob (`codex login`). */
  openaiSub: { blockId: 'openai_sub', actionId: 'value' },
} as const;

/** Carried on the button (→ modal) and in the modal's private_metadata, so the submission knows where
 * to repaint and where to wake Atlas. */
export interface RotateCardMeta {
  team: string;
  channel: string;
  /** The card message ts — repainted on submit so it can't be re-clicked. */
  cardTs?: string;
  /** The harness surface coordinate (slack:team:channel) — routes the post-rotation wake-up. */
  surfaceId: string;
}

export const rotateCardBlocks = (e: {
  reason: string;
  suspected?: string[];
  value: string;
}) => {
  const flagged = e.suspected?.length
    ? `\n\n*Looks expired:* ${e.suspected.join(', ')}.`
    : '';
  return {
    text: `Update your API keys — ${e.reason}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Please update your keys.*\n${e.reason}${flagged}\n\nUpdate them securely below — *never paste keys in chat*.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            action_id: ROTATE_OPEN_ACTION_ID,
            value: e.value,
            text: { type: 'plain_text', text: '🔄 Update keys', emoji: true },
          },
        ],
      },
    ],
  };
};

/** Repaint the card after a disposition so it can't be re-actioned. */
export const rotateCardDone = (
  original: Array<Record<string, unknown>>,
  line: string,
) => [
  ...original.filter((b) => b.type !== 'actions'),
  { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
];

/** The rotate-keys modal. `private_metadata` carries the JSON {@link RotateCardMeta}. All fields are
 * optional — fill only what's rotating; blanks leave the stored value untouched. */
export const rotateKeysModalView = (privateMetadata: string) => ({
  type: 'modal' as const,
  callback_id: ROTATE_MODAL_CALLBACK_ID,
  private_metadata: privateMetadata,
  title: { type: 'plain_text' as const, text: 'Update API keys' },
  submit: { type: 'plain_text' as const, text: 'Save' },
  close: { type: 'plain_text' as const, text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'Update only what changed — leave the rest blank to keep it. Everything is encrypted at ' +
          'rest, never readable back out, and never appears in chat.',
      },
    },
    {
      type: 'input',
      block_id: ROTATE_MODAL_BLOCKS.anthropic.blockId,
      optional: true,
      label: { type: 'plain_text', text: 'Anthropic API key (sk-ant-…)' },
      element: {
        type: 'plain_text_input',
        action_id: ROTATE_MODAL_BLOCKS.anthropic.actionId,
        placeholder: { type: 'plain_text', text: 'sk-ant-…' },
      },
    },
    {
      type: 'input',
      block_id: ROTATE_MODAL_BLOCKS.openai.blockId,
      optional: true,
      label: { type: 'plain_text', text: 'OpenAI API key (sk-…)' },
      element: {
        type: 'plain_text_input',
        action_id: ROTATE_MODAL_BLOCKS.openai.actionId,
        placeholder: { type: 'plain_text', text: 'sk-…' },
      },
    },
    {
      type: 'input',
      block_id: ROTATE_MODAL_BLOCKS.anthropicSub.blockId,
      optional: true,
      label: {
        type: 'plain_text',
        text: 'Claude Max token (claude setup-token)',
      },
      element: {
        type: 'plain_text_input',
        action_id: ROTATE_MODAL_BLOCKS.anthropicSub.actionId,
        placeholder: { type: 'plain_text', text: 'sk-ant-oat-…' },
      },
    },
    {
      type: 'input',
      block_id: ROTATE_MODAL_BLOCKS.openaiSub.blockId,
      optional: true,
      label: { type: 'plain_text', text: 'Codex auth.json (codex login)' },
      element: {
        type: 'plain_text_input',
        multiline: true,
        action_id: ROTATE_MODAL_BLOCKS.openaiSub.actionId,
        placeholder: { type: 'plain_text', text: '{ "tokens": { … } }' },
      },
    },
  ],
});
