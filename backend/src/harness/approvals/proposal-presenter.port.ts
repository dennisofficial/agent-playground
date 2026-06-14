/**
 * The plan-proposal OUTBOUND PORT — Dennis's framing made literal: proposing a plan is an outbound
 * port the hosting app maps per surface (Slack binds an approval-card adapter; TUI/headless binds
 * nothing), and the verdict is just another ingestion — it re-enters through the same inbound seam
 * as any human message (`conductor.submitFrom`), so a card click and Dennis typing are the same
 * kind of event by construction.
 *
 * The port hop is in-memory ON PURPOSE — delivery, not state. The durable proposal state is the
 * board row (status 'awaiting_approval' + the ticket's attached plans, Postgres) and the posted
 * card itself (button payloads carry the task id); a crashed post is recovered by re-proposing.
 *
 * Same idiom as CHAT_SURFACE: token + interface here, `@Optional() @Inject` at the consumer, a
 * `@Global` binding in the hosting app's surface module.
 */

export const PROPOSAL_PRESENTER = Symbol('PROPOSAL_PRESENTER');

export interface PlanProposalEvent {
  /** The tenant (team id) whose board the ticket lives on. */
  team: string;
  taskId: number;
  /** The board task's title — the card's headline. */
  title: string;
  /** The lead's consolidated, first-person summary — what Dennis reads before drilling in. */
  summary: string;
  /** Roster id of the proposing lead ('sam'). */
  proposedBy: string;
  /** The chat surface coordinate the proposal was made from (ctx.identity.surface) — routes the
   * card AND the verdict's synthesized channel message back to the same room. */
  surfaceId: string;
  /** Every attached plan, employee order — rendered in full under the card (thread replies). */
  plans: { employee: string; planMd: string }[];
}

export interface PlanProposalPresenter {
  /** Present the proposal to the boss (post the approval card). Throwing is allowed — the caller
   * degrades to the chat-words flow; it must NOT leave partial board state (it owns none). */
  present(event: PlanProposalEvent): Promise<void>;
}
