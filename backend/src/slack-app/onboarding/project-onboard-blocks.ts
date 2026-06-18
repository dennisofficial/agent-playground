/**
 * The project-onboarding Block Kit surfaces — pure constants/builders, no I/O (the suggestion/onboarding-guard
 * blocks twin). The modal is the SECRETS path: a `view_submission` payload is never a chat message,
 * so a GitHub token reaches the encrypted store without ever touching Slack history or the channel log.
 */

/** All onboarding action/callback ids share this prefix — the router slot namespaces on it. */
export const ONBOARD_PREFIX = 'onboard:';
export const ONBOARD_OPEN_ACTION_ID = 'onboard:open';
export const ONBOARD_MODAL_CALLBACK_ID = 'onboard:submit';

/** Modal input coordinates — `view.state.values[blockId][actionId].value`. */
export const ONBOARD_MODAL_BLOCKS = {
  url: { blockId: 'repo_url', actionId: 'url' },
  token: { blockId: 'repo_token', actionId: 'token' },
} as const;

/** Carried on the button (→ modal) and in the modal's private_metadata, so the submission knows where
 * to repaint and where to wake Atlas. */
export interface OnboardCardMeta {
  team: string;
  channel: string;
  /** The card message ts — repainted on submit so it can't be re-clicked. */
  cardTs?: string;
  /** The harness surface coordinate (slack:team:channel) — routes the post-register wake-up. */
  surfaceId: string;
  name: string;
  gitUrl?: string;
}

export const onboardCardBlocks = (e: {
  name: string;
  gitUrl?: string;
  reason: string;
  value: string;
}) => ({
  text: `Onboard ${e.name}? (${e.reason})`,
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Onboard \`${e.name}\` as a reference repo?*\nI couldn't register it automatically — ${e.reason}. Add it here and I'll reference it (read-only).`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          action_id: ONBOARD_OPEN_ACTION_ID,
          value: e.value,
          text: {
            type: 'plain_text',
            text: `Onboard ${e.name}`.slice(0, 75),
            emoji: true,
          },
        },
      ],
    },
  ],
});

/** Repaint the card after a disposition (registered / cancelled) so it can't be re-actioned. */
export const onboardCardDone = (
  original: Array<Record<string, unknown>>,
  line: string,
) => [
  ...original.filter((b) => b.type !== 'actions'),
  { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
];

/** The onboarding modal. `private_metadata` carries the JSON {@link OnboardCardMeta}. */
export const onboardModalView = (
  privateMetadata: string,
  name: string,
  gitUrl?: string,
) => ({
  type: 'modal' as const,
  callback_id: ONBOARD_MODAL_CALLBACK_ID,
  private_metadata: privateMetadata,
  title: { type: 'plain_text' as const, text: 'Onboard a project' },
  submit: { type: 'plain_text' as const, text: 'Register' },
  close: { type: 'plain_text' as const, text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Register \`${name}\` as a *read-only* reference repo. The token is encrypted at rest and never appears in chat.`,
      },
    },
    {
      type: 'input',
      block_id: ONBOARD_MODAL_BLOCKS.url.blockId,
      label: { type: 'plain_text', text: 'GitHub repo URL' },
      element: {
        type: 'plain_text_input',
        action_id: ONBOARD_MODAL_BLOCKS.url.actionId,
        ...(gitUrl ? { initial_value: gitUrl } : {}),
        placeholder: {
          type: 'plain_text',
          text: 'https://github.com/owner/repo',
        },
      },
    },
    {
      type: 'input',
      block_id: ONBOARD_MODAL_BLOCKS.token.blockId,
      optional: true,
      label: {
        type: 'plain_text',
        text: 'GitHub token (only if private / the default token can’t read it)',
      },
      element: {
        type: 'plain_text_input',
        action_id: ONBOARD_MODAL_BLOCKS.token.actionId,
        placeholder: { type: 'plain_text', text: 'ghp_… / github_pat_…' },
      },
    },
  ],
});
