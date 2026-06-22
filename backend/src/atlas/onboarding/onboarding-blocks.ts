import type { OnboardingStatus } from './onboarding.service';

/**
 * Block Kit for the in-Slack onboarding flow (self-service — "no admin panels, no commands"). A card is
 * posted when Atlas is added to a channel; its button opens a modal that collects the repo + the
 * workspace's GitHub PAT + Anthropic key (the secret-collection path). Pure builders, no I/O.
 */

/** Button on the setup card → opens the setup modal. */
export const ONBOARD_SETUP_ACTION_ID = 'atlas_onboarding:setup';
/** Modal callback_id → routed to the secret-write handler. */
export const ONBOARD_SETUP_CALLBACK = 'atlas_secret:setup';

// Modal input block ids + their element action ids.
const REPO_BLOCK = 'repo';
const REPO_INPUT = 'repo_input';
const PAT_BLOCK = 'github_pat';
const PAT_INPUT = 'pat_input';
const ANTHROPIC_BLOCK = 'anthropic_key';
const ANTHROPIC_INPUT = 'key_input';

const check = (ok: boolean): string => (ok ? '✅' : '⬜️');

/** The setup card posted in a channel when Atlas joins — checklist + a "Set up" button. */
export function onboardingCardBlocks(
  status: OnboardingStatus,
): Array<Record<string, unknown>> {
  const s = status.steps;
  const checklist = [
    `${check(s.channelBound)} Channel linked to a GitHub repo`,
    `${check(s.llmKey)} Anthropic API key (this workspace's own billing)`,
    `${check(s.githubPat)} GitHub access token`,
  ].join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Set up Atlas in this channel* — connect a repo and this workspace’s own API + GitHub credentials so its usage bills separately.',
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: checklist } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          action_id: ONBOARD_SETUP_ACTION_ID,
          text: { type: 'plain_text', text: '⚙️ Set up Atlas here', emoji: true },
        },
      ],
    },
  ];
}

/** Context the modal carries through `view_submission` (where to bind). */
export interface OnboardSetupMeta {
  teamId: string;
  channelRef: string;
}

/** The setup modal — repo URL + GitHub PAT + Anthropic key (all optional so it can be filled in steps). */
export function setupModalView(meta: OnboardSetupMeta): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: ONBOARD_SETUP_CALLBACK,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Set up Atlas' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: REPO_BLOCK,
        optional: true,
        label: { type: 'plain_text', text: 'GitHub repo URL' },
        element: {
          type: 'plain_text_input',
          action_id: REPO_INPUT,
          placeholder: { type: 'plain_text', text: 'https://github.com/owner/repo' },
        },
      },
      {
        type: 'input',
        block_id: PAT_BLOCK,
        optional: true,
        label: { type: 'plain_text', text: 'GitHub access token (PAT)' },
        element: {
          type: 'plain_text_input',
          action_id: PAT_INPUT,
          placeholder: { type: 'plain_text', text: 'github_pat_… (the account this workspace builds to)' },
        },
      },
      {
        type: 'input',
        block_id: ANTHROPIC_BLOCK,
        optional: true,
        label: { type: 'plain_text', text: 'Anthropic API key' },
        element: {
          type: 'plain_text_input',
          action_id: ANTHROPIC_INPUT,
          placeholder: { type: 'plain_text', text: 'sk-ant-… (billed to this workspace)' },
        },
      },
    ],
  };
}

/** The submitted values, parsed from a `view_submission` state (empty strings → undefined). */
export interface OnboardSetupValues {
  repoUrl?: string;
  githubPat?: string;
  anthropicKey?: string;
}

/** Pull the three inputs out of a `view.state.values` map. */
export function parseSetupValues(
  values: Record<string, Record<string, { value?: string | null }>> | undefined,
): OnboardSetupValues {
  const get = (block: string, action: string): string | undefined => {
    const v = values?.[block]?.[action]?.value;
    const trimmed = typeof v === 'string' ? v.trim() : '';
    return trimmed ? trimmed : undefined;
  };
  return {
    repoUrl: get(REPO_BLOCK, REPO_INPUT),
    githubPat: get(PAT_BLOCK, PAT_INPUT),
    anthropicKey: get(ANTHROPIC_BLOCK, ANTHROPIC_INPUT),
  };
}
