/**
 * The project-onboarding OUTBOUND PORT — the sibling of {@link TaskSuggestionPresenter}, but aimed at
 * COLLECTING what the harness can't resolve on its own: a repo URL it couldn't auto-find, or a GitHub
 * token the default one can't cover. Atlas's `onboard_project` resolves+registers a repo itself when
 * his default token already reads it; only when it CAN'T does the service `present()` a card, and the
 * human tap (the card's button → a Slack modal) is what supplies the trigger_id a modal needs (a tool
 * call has none). Slack binds a card+modal adapter; TUI/headless binds nothing → the tool degrades to
 * asking Dennis in chat for the URL.
 *
 * The port hop is in-memory ON PURPOSE — delivery, not state. There's no durable artifact to carry
 * (unlike the suggestion chip's board row): a registered project IS the durable result, written by the
 * modal-submission handler when it lands. Same idiom as CHAT_SURFACE / TASK_SUGGESTION_PRESENTER:
 * token + interface here, `@Optional() @Inject` at the consumer, a `@Global` binding in the surface.
 */

export const PROJECT_ONBOARD_PRESENTER = Symbol('PROJECT_ONBOARD_PRESENTER');

export interface ProjectOnboardEvent {
  /** The tenant (team id) the project would be registered under. */
  team: string;
  /** The chat surface the onboarding was requested from (routes the card + the post-register wake-up). */
  surfaceId: string;
  /** The name/slug Atlas used — the card title and the modal's default project id. */
  name: string;
  /** A resolved repo URL to prefill the modal with, when known (a URL request, or a single guess). */
  gitUrl?: string;
  /** Why a human tap is needed (no token stored / the default token can't read it / ambiguous) —
   * rendered on the card so Dennis knows what he's being asked for. */
  reason: string;
}

export interface ProjectOnboardPresenter {
  /** Post the onboarding card to the boss. Throwing is allowed — the caller degrades to the chat-words
   * flow; it must NOT leave partial state (registration only happens on the modal submission). */
  present(event: ProjectOnboardEvent): Promise<void>;
}
