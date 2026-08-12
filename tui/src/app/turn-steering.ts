import { randomUUID } from 'node:crypto';
import { EMessageType } from '../generated/prisma/enums.js';
import type { EngineSession, Thread } from '../generated/prisma/client.js';
import type { ConversationStore } from './conversation.store.js';
import type { TurnEventApplier } from './turn-events.js';
import type { Lane, TurnLanes } from './turn-lanes.js';

/**
 * Pushing text into a turn that is already running, in one place.
 *
 * A plain function beside the runner rather than a method on it, for the reason `turn-completion.ts`
 * is one: it owns no state, has exactly one caller, and the runner already holds every collaborator
 * it needs. What makes it worth its own file is that the three outcomes below are the whole of the
 * steering contract, and they read better without a turn's lifecycle wrapped around them.
 */
export function steerTurn(args: {
  lanes: TurnLanes;
  lane: Lane | undefined;
  store: ConversationStore;
  events: TurnEventApplier;
  thread: Thread;
  session: EngineSession;
  text: string;
  /** How a queued write reports a failure — the runner's logger, threaded through. */
  record: (record: { lane: Lane; work: () => Promise<void> }) => void;
}): boolean {
  const { lane, store, text } = args;
  const id = randomUUID();
  store.enqueue({ id, text });

  const deliver = (): void => {
    // Fired when the SDK actually PULLED it — the ack, not a hope.
    store.dequeue(id);
    if (!lane) return;
    args.record({
      lane,
      work: () =>
        args.events.persist({
          store,
          threadId: args.thread.id,
          sessionId: args.session.id,
          payload: { type: EMessageType.user, text },
        }),
    });
  };

  if (lane?.turn?.steer(text, deliver)) return true;

  // The turn is still in credential setup, so there is no query to push into yet. Hold it rather
  // than dropping what the user typed — the handle flushes it the moment the query opens.
  if (lane?.inFlight) {
    args.lanes.hold({ lane, steer: { id, text, deliver } });
    return true;
  }

  store.dequeue(id);
  return false;
}
