import { retryTarget } from "../domain/retry.js";
import { EMessageType } from "../generated/prisma/enums.js";
import type { OpenConversation } from "./conversation-open.js";
import type { ConversationStoreRegistry } from "./conversation-store.registry.js";
import type { TurnRunnerService } from "./turn-runner.service.js";

/**
 * Send the failed turn's prompt again — what `↻ retry` on an error block does.
 *
 * It lives beside the service rather than in it for the reason `conversation-open.ts` does: the file
 * is at its length, and this is a self-contained act with one decision in it (WHO is speaking) that
 * is worth reading without twelve injected fields around it.
 *
 * The transcript is the record of what was sent, so it is also where the thing to re-send is found —
 * nothing is held aside for this. What comes back is an ordinary turn: the prompt is persisted a
 * second time, because it WAS sent a second time, and a retry that hid its own message would leave
 * the transcript claiming one prompt produced two turns.
 *
 * Returns whether anything was fired. Declining is not an error: a closed thread, a turn already
 * running, or a transcript that has moved on are all reachable by a click that raced the state it
 * was drawn from — the pointer is slower than the store — and none is worth an error block.
 */
export async function retryLastTurn(args: {
  open: OpenConversation;
  turnRunnerService: TurnRunnerService;
  stores: ConversationStoreRegistry;
}): Promise<boolean> {
  const { open } = args;
  if (open.closed) return false;
  if (args.turnRunnerService.busy(open.thread.id)) return false;

  const target = retryTarget(
    args.stores.for(open.thread.id).getSnapshot().messages,
  );
  if (!target) return false;
  const { prompt } = target;

  await args.turnRunnerService.run({
    thread: open.thread,
    session: open.session,
    prompt: prompt.text,
    // Re-fired as whoever fired it the first time. See `promptPayload` — the absence of a variant is
    // the human, so a user prompt passes neither field here and goes back in bare.
    ...(prompt.type === EMessageType.harness
      ? {
          harnessVariant: prompt.variant,
          ...(prompt.attachments ? { attachments: prompt.attachments } : {}),
        }
      : {}),
    brief: open.brief,
    tools: open.tools,
    cwd: open.cwd,
  });
  return true;
}
