/**
 * The credential-rotation OUTBOUND PORT — the sibling of {@link ProjectOnboardPresenter}, aimed at
 * COLLECTING a fresh secret the harness can't mint itself: a rotated API key, or a re-issued
 * Claude/Codex subscription token. A secret must NEVER pass through chat (the LLM context, Slack
 * history, traces), so the harness can't take it as a tool argument — instead it `present()`s a card,
 * and the human tap (the card's button → a Slack modal) supplies both the secret AND the `trigger_id`
 * a modal needs (a tool call / a system catch has neither).
 *
 * Two callers `present()` the same card: the `rotate_keys` tool (Atlas, on request or on a session
 * auth failure) and the system credential-health guard (when the harness's OWN key 401s and Atlas
 * may be down). Slack binds a card+modal adapter; TUI/headless binds nothing → the tool degrades to
 * asking Dennis in chat. Same idiom as PROJECT_ONBOARD_PRESENTER: token + interface here,
 * `@Optional() @Inject` at the consumer, a `@Global` binding in the surface.
 */

export const ROTATE_KEYS_PRESENTER = Symbol('ROTATE_KEYS_PRESENTER');

export interface RotateKeysEvent {
  /** The tenant (team id) whose credentials need updating. */
  team: string;
  /** The chat surface the request came from (routes the card + the post-rotation wake-up). */
  surfaceId: string;
  /** Why the card is being shown — rendered on it so Dennis knows what's being asked (e.g. "Codex
   * subscription token was rejected (401)"). */
  reason: string;
  /** Which credentials look expired/rejected, to highlight on the card (e.g. ['Codex subscription']).
   * Cosmetic — the modal always offers every field. */
  suspected?: string[];
}

export interface RotateKeysPresenter {
  /** Post the update-keys card to the boss. Throwing is allowed — the caller degrades to chat-words;
   * it must NOT leave partial state (storage only happens on the modal submission). */
  present(event: RotateKeysEvent): Promise<void>;
}
