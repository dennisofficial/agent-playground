/**
 * The description-change OUTBOUND PORT — same idiom as PROPOSAL_PRESENTER: one symbol token,
 * one interface, bound @Global in the Slack surface module; TUI/headless hosts bind nothing
 * and the consumer uses `@Optional() @Inject`.
 *
 * Fires whenever `update_board_task` is called with a description change on a ticket whose
 * pre-update status is `approved`, `executing`, `self_review`, or `in_review`. The notification
 * is best-effort and informational: it gates nothing and carries no board state.
 */

export const BOARD_NOTIFIER = Symbol('BOARD_NOTIFIER');

export interface DescriptionChangeEvent {
  /** Tenant whose board the ticket lives on. */
  team: string;
  taskId: number;
  /** Ticket title — the card's headline. */
  title: string;
  /** Roster id of whoever called update_board_task (in practice: Sam the lead). */
  changedBy: string;
  /** The description text as it was BEFORE this update. */
  oldDescription: string;
  /** The description text AFTER this update. */
  newDescription: string;
  /** The chat surface coordinate the call was made from — routes the card to the same channel. */
  surfaceId: string;
}

export interface BoardNotifier {
  /** Post a description-change notification card. Throwing is allowed — the caller wraps in
   * try/catch, logs the warning, and lets the board write succeed regardless. */
  notifyDescriptionChange(e: DescriptionChangeEvent): Promise<void>;
}
