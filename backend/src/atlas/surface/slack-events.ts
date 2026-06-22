/**
 * The Slack INTERACTIVITY + LIFECYCLE shapes the surface emits — declared structurally (the subset of
 * fields consumers read) so bridges/specs don't need the real `@slack/*` payload types. Block-action
 * clicks (approval/onboarding buttons) and modal submissions (`view_submission`) arrive over the SAME
 * app-level Socket Mode connection as events; the surface fans them out on dedicated Subjects.
 */

/** A button/select click — `actions[].action_id` is routed by prefix (`atlas_approval:*`, `atlas_onboarding:*`). */
export interface SlackBlockAction {
  type: 'block_actions';
  user?: { id?: string };
  /** Needed to open a modal in response (`views.open`). */
  trigger_id?: string;
  team?: { id?: string };
  channel?: { id?: string };
  /** The message the buttons live on (for `chat.update` — its blocks repaint into the verdict card). */
  message?: { ts?: string; blocks?: Array<Record<string, unknown>> };
  actions?: Array<{ action_id?: string; value?: string }>;
}

/** A modal submission — `view.callback_id` is routed by prefix (`atlas_secret:*`); inputs in `state.values`. */
export interface SlackViewSubmission {
  type: 'view_submission';
  user?: { id?: string };
  team?: { id?: string };
  view?: {
    callback_id?: string;
    /** Opaque context the opener stashed (e.g. the channel/team the modal acts on). */
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string | null }>>;
    };
  };
}

/** A workspace lifecycle signal the onboarding layer reacts to (never enters the stimulus intake). */
export interface SlackLifecycleEvent {
  kind: 'bot_joined' | 'bot_left' | 'mention';
  teamId: string;
  channel: string;
  /** The user who acted (added the bot / @mentioned). */
  actorId?: string;
  /** For a mention: the message text. */
  text?: string;
}
