/**
 * The composer-send lifecycle every operator send renders through: staged (client-only, not yet sent) →
 * sending (server row exists, not yet delivered) → landed (delivered). Two pure helpers derive it — one for
 * a transcript message (the note bubble / review-comments card), one for a question/file/secret card's
 * answer — so every render site reads the same signal instead of re-deriving it ad hoc.
 */
export type SendState = "staged" | "sending" | "landed";

/** A transcript message's send state. `local` is the optimistic pre-server-echo row; once the server row
 *  lands it carries a `stimulusId` until `deliveredAt` is stamped. */
export function messageSendState(message: {
  local?: boolean;
  stimulusId?: string;
  deliveredAt?: string;
}): SendState {
  if (message.local) return "sending";
  if (message.stimulusId && !message.deliveredAt) return "sending";
  return "landed";
}

/** A question/file/secret card's send state, derived from whether it has an answer/value yet and whether
 *  that answer has been delivered. */
export function cardSendState(
  hasAnswer: boolean,
  deliveredAt: string | null | undefined,
): SendState {
  if (!hasAnswer) return "staged";
  return deliveredAt ? "landed" : "sending";
}
