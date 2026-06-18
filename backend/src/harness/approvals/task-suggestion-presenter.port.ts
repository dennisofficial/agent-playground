/**
 * The task-suggestion OUTBOUND PORT — the twin of {@link PlanProposalPresenter}, but aimed at Dennis
 * as a low-friction "here's something worth doing" CHIP rather than a plan to ratify. Atlas
 * `suggest_task`s a unit of work; the hosting app maps this port per surface (Slack binds a chip
 * adapter with Run / Keep / Dismiss buttons; TUI/headless binds nothing → the tool degrades to
 * chat-words). Dennis's one-click disposition re-enters the system through the same inbound seam as
 * any card click.
 *
 * The port hop is in-memory ON PURPOSE — delivery, not state. The durable suggestion IS the board
 * row (a freshly-captured `open` task — exactly `enqueue_finding`); the chip's button payloads carry
 * only that task id, so dispositions are stateless and survive a restart. A crashed post just leaves
 * the item parked on the backlog (capture is the durable part).
 *
 * Same idiom as CHAT_SURFACE / PROPOSAL_PRESENTER: token + interface here, `@Optional() @Inject` at
 * the consumer, a `@Global` binding in the hosting app's surface module.
 */

export const TASK_SUGGESTION_PRESENTER = Symbol('TASK_SUGGESTION_PRESENTER');

export interface TaskSuggestionEvent {
  /** The tenant (team id) whose board the suggestion was captured on. */
  team: string;
  /** The board task id of the freshly-parked candidate — the only thing the chip's buttons carry. */
  taskId: number;
  /** The suggestion's headline — the chip's title. */
  title: string;
  /** Why it's worth doing — the chip's body (what Dennis weighs before clicking). */
  why: string;
  /** Optional extra detail beyond the why. */
  description?: string;
  /** Atlas's recommended disposition — a non-binding hint rendered on the chip's context line. */
  suggestedDisposition?: 'run' | 'backlog';
  /** Roster id of the suggesting orchestrator (Atlas) — the chip posts as them. */
  proposedBy: string;
  /** The chat surface coordinate the suggestion was made from (ctx.identity.surface) — routes the
   * chip AND the disposition's wake-up back to the same room. */
  surfaceId: string;
}

export interface TaskSuggestionPresenter {
  /** Present the suggestion to the boss (post the chip). Throwing is allowed — the caller degrades to
   * the chat-words flow; it must NOT leave partial state (it owns none — the board row already exists). */
  present(event: TaskSuggestionEvent): Promise<void>;
}
