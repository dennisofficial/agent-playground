/**
 * Jarvis's Block Kit surfaces — pure constants/builders, no I/O. The keys modal is THE secrets
 * path: a `view_submission` payload is never a chat message, so keys reach the encrypted store
 * without ever touching Slack history or the harness channel log.
 */

export const JARVIS_NAME = 'Jarvis';
export const JARVIS_ICON_EMOJI = ':robot_face:';

export const SETUP_KEYS_ACTION_ID = 'jarvis:setup_keys';
export const KEYS_MODAL_CALLBACK_ID = 'jarvis:keys';

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

export const GREETING_PENDING =
  "Hi, I'm Jarvis — I'll get your AI team set up. The team runs on your own LLM API " +
  'keys (Anthropic + OpenAI, both required). Click the button to add them securely — ' +
  '*never paste keys in chat*.';

export const NUDGE_PENDING =
  'The team is still waiting on its LLM keys — hit the button above (or ask me to repost it) ' +
  'and they’ll come online right away.';

export const KEY_IN_CHAT_WARNING =
  '⚠️ That looks like an API key — never paste keys in chat (Slack keeps history). I have NOT ' +
  'stored it; please revoke it if it was real, then use the *Set up keys* button instead.';

export const REPO_PROMPT =
  'This channel isn’t linked to a repository yet. Paste the GitHub URL ' +
  '(`https://github.com/owner/repo`) and I’ll wire it up — the channel name becomes the project.';

export const KEYS_STORED =
  'Keys stored securely — bringing the engines online…';

export const ENGINES_ONLINE =
  'All keys are in — engines are online and the team is live. 🎉';

export const repoLinked = (gitUrl: string): string =>
  `Linked this channel to ${gitUrl} — the team can work this repo now. If it’s private, add a ` +
  'GitHub token via the *Set up keys* button.';

export const repoAlreadyLinked = (gitUrl: string): string =>
  `This channel’s project is already linked to ${gitUrl}.`;

export const repoConflict = (existingUrl: string): string =>
  `This channel’s project is already linked to ${existingUrl} — update it via the admin API/UI ` +
  'if it should point elsewhere.';

/** The keys modal. `private_metadata` carries the origin channel so the submission handler knows
 * where to confirm. */
export const keysModalView = (
  originChannelId: string,
  githubTokenStored: boolean,
) => ({
  type: 'modal' as const,
  callback_id: KEYS_MODAL_CALLBACK_ID,
  private_metadata: originChannelId,
  title: { type: 'plain_text' as const, text: 'Team setup — API keys' },
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
