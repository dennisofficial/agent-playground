import { randomUUID } from 'node:crypto';
import type { EngineSession, Thread } from '../generated/prisma/client.js';
import type { ConversationStore } from './conversation.store.js';
import type { Lane, TurnLanes } from './turn-lanes.js';

/**
 * Pushing text into a turn that is already running, in one place.
 *
 * A plain function beside the runner rather than a method on it, for the reason `turn-completion.ts`
 * is one: it owns no state, has exactly one caller, and the runner already holds every collaborator
 * it needs. What makes it worth its own file is that the three outcomes below are the whole of the
 * steering contract, and they read better without a turn's lifecycle wrapped around them.
 *
 * The steer is queued here and NOT persisted here. Writing the transcript row is the ack path's job
 * (`turn-events.ts`, `input_ack`), because a steer sits in the CLI for as long as the current tool
 * takes and the row has to land where the model actually read it. The id generated here is what
 * connects the two: it travels out as the message's SDK uuid and comes back on the replay frame.
 */
export function steerTurn(args: {
  lanes: TurnLanes;
  lane: Lane | undefined;
  store: ConversationStore;
  thread: Thread;
  session: EngineSession;
  text: string;
}): boolean {
  const { lane, store, text } = args;
  const id = randomUUID();
  store.enqueue({ id, text });

  if (lane?.turn?.steer({ id, text })) return true;

  // The turn is still in credential setup, so there is no query to push into yet. Hold it rather
  // than dropping what the user typed — the handle flushes it the moment the query opens.
  if (lane?.inFlight) {
    args.lanes.hold({ lane, steer: { id, text } });
    return true;
  }

  store.dequeue(id);
  return false;
}
