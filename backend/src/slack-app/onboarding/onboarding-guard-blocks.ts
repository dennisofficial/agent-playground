/**
 * The keyless-onboarding-guard Block Kit surfaces — pure constants/builders, no I/O. The keys modal is
 * THE secrets path: a `view_submission` payload is never a chat message, so keys reach the encrypted
 * store without ever touching Slack history or the harness channel log.
 *
 * Voiceless on purpose — this is a deterministic setup circuit-breaker, not a character. The
 * conversational onboarding (greeting, linking a repo, references) is Atlas's, post-keys.
 */

export const SETUP_KEYS_ACTION_ID = 'keys:setup';
export const KEYS_MODAL_CALLBACK_ID = 'keys:modal';
/** Shared prefix so the router slot can namespace on it. */
export const KEYS_PREFIX = 'keys:';

/** Modal input coordinates — `view.state.values[blockId][actionId].value`. */
export const KEYS_MODAL_BLOCKS = {
  anthropic: { blockId: 'anthropic', actionId: 'key' },
  openai: { blockId: 'openai', actionId: 'key' },
  github: { blockId: 'github', actionId: 'token' },
} as const;

export const setupButtonBlocks = (text: string) => ({
  text, // notification fallback
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          action_id: SETUP_KEYS_ACTION_ID,
          text: { type: 'plain_text', text: '🔑 Set up keys', emoji: true },
        },
      ],
    },
  ],
});

/** Terse, voiceless: the workspace can't run until its LLM keys are in. */
export const KEYS_PROMPT =
  'This workspace needs its own LLM API keys (Anthropic + OpenAI) before the team can run. ' +
  'Add them securely below — *never paste keys in chat*.';

export const KEY_IN_CHAT_WARNING =
  '⚠️ That looks like an API key — never paste keys in chat (Slack keeps history). It has NOT ' +
  'been stored; revoke it if it was real, then use the *Set up keys* button.';

export const KEYS_STORED = 'Keys stored securely — bringing the team online…';

export const ENGINES_ONLINE = 'Keys are in — the team is live.';

/** The keys modal. `private_metadata` carries the origin channel so the submission handler knows
 * where to confirm. */
export const keysModalView = (
  originChannelId: string,
  githubTokenStored: boolean,
) => ({
  type: 'modal' as const,
  callback_id: KEYS_MODAL_CALLBACK_ID,
  private_metadata: originChannelId,
  title: { type: 'plain_text' as const, text: 'Workspace setup — API keys' },
  submit: { type: 'plain_text' as const, text: 'Save keys' },
  close: { type: 'plain_text' as const, text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'Keys are encrypted at rest and can be rotated here any time — they are never ' +
          'readable back out, and never appear in chat.',
      },
    },
    {
      type: 'input',
      block_id: KEYS_MODAL_BLOCKS.anthropic.blockId,
      label: { type: 'plain_text', text: 'Anthropic API key (sk-ant-…)' },
      element: {
        type: 'plain_text_input',
        action_id: KEYS_MODAL_BLOCKS.anthropic.actionId,
        placeholder: { type: 'plain_text', text: 'sk-ant-…' },
      },
    },
    {
      type: 'input',
      block_id: KEYS_MODAL_BLOCKS.openai.blockId,
      label: { type: 'plain_text', text: 'OpenAI API key (sk-…)' },
      element: {
        type: 'plain_text_input',
        action_id: KEYS_MODAL_BLOCKS.openai.actionId,
        placeholder: { type: 'plain_text', text: 'sk-…' },
      },
    },
    {
      type: 'input',
      block_id: KEYS_MODAL_BLOCKS.github.blockId,
      optional: true,
      label: {
        type: 'plain_text',
        text: githubTokenStored
          ? 'GitHub token (optional — one is already stored; submitting replaces it)'
          : 'GitHub token (optional — needed for private repos and PRs)',
      },
      element: {
        type: 'plain_text_input',
        action_id: KEYS_MODAL_BLOCKS.github.actionId,
        placeholder: { type: 'plain_text', text: 'ghp_… / github_pat_…' },
      },
    },
  ],
});
