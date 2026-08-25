import { EMessageType } from '../generated/prisma/enums.js';
import type { Message, PromptPayload } from './message.js';

/**
 * What a retry would re-fire, and which block offers it.
 *
 * `errorMessageId` is here so the affordance can hang on ONE block rather than on every retryable
 * error in the scrollback. A failed turn from an hour ago is history: clicking it could only re-send
 * whatever the transcript's last prompt happens to be now, which is not what the block says it does.
 */
export type RetryTarget = {
  errorMessageId: string;
  /** The prompt to send again — the human's words, or Atlas's envelope, exactly as first stored. */
  prompt: PromptPayload;
};

/**
 * Is the transcript sitting on a failed turn, and if so what would be sent again?
 *
 * Only the LAST message qualifies, deliberately. A retryable error is terminal — the turn ended on
 * it — so it is the last thing written when it is the one you can still act on; anything after it
 * means another turn has happened since and the failure has been superseded.
 *
 * The prompt is the nearest one ABOVE the error, which is the one the dead turn was fired from. It
 * may be several blocks back: a turn that streamed prose and ran three tools before dying leaves all
 * of them in between, and none of them is a thing to re-send.
 */
export function retryTarget(messages: readonly Message[]): RetryTarget | null {
  const last = messages[messages.length - 1];
  if (!last) return null;
  if (last.payload.type !== EMessageType.error) return null;
  if (last.payload.retryable !== true) return null;

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const payload = messages[index]?.payload;
    if (!payload) continue;
    // A harness prompt retries as a harness prompt, envelope and attachments intact — re-sending
    // Atlas's hand-off as if Dennis had typed it would strip the one thing that says who spoke.
    if (payload.type === EMessageType.user || payload.type === EMessageType.harness)
      return { errorMessageId: last.id, prompt: payload };
  }

  // An error with no prompt above it: nothing was ever sent, so there is nothing to send again.
  return null;
}
