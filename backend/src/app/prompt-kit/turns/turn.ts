/**
 * prompt-kit / turns — self-contained, HOST-INITIATED one-shot engine turns.
 *
 * A "turn" is the SECOND category of prompt in this kit, distinct from the `groups/` fragment library
 * (assembled multi-fragment SYSTEM prompts addressed to an `Agent` audience via `renderAgentPrompt`). A turn is
 * a single server-driven mechanical action — the host fires ONE engine run to make the brain/engine do a
 * specific thing (open the PR, promote decisions to the ADR store) — so it is NOT assembled, NOT reused across many
 * turns, and NOT an `Agent`. It is a plain, self-contained pair: an optional one-shot `system` prompt and the
 * `task` body delivered for that run.
 *
 * Use a turn (here) when the text drives one host-initiated action; use a `groups/` fragment + `Agent` when the
 * text is a persona assembled from shared fragments and/or spans a conversation.
 */
export interface HarnessTurn {
  /** The one-shot system prompt for this run. Omitted when the turn is task-only (delivered as a message body). */
  system?: string;
  /** The task body for this run — the instruction the turn drives. */
  task: string;
}
