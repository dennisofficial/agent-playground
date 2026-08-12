import type { EngineSession } from "../generated/prisma/client.js";
import type { AccountUsageService } from "./account-usage.service.js";
import type { ConversationStore } from "./conversation.store.js";
import type { TurnEventApplier } from "./turn-events.js";
import type { Lane, TurnLanes } from "./turn-lanes.js";

/**
 * Everything a turn does on its way out, whether it succeeded, failed or never started.
 *
 * Split out of `TurnRunnerService.execute()` because it is the one part of a turn with no branching
 * left in it: the interesting decisions are all upstream, and what remains is a fixed sequence that
 * MUST run even when the engine threw before it opened — an expired credential otherwise leaves the
 * store `running` forever, which on screen is a spinner that never stops and a composer steering
 * into nothing.
 *
 * A plain function rather than a provider: it owns no state and has exactly one caller, and the
 * runner already holds every collaborator it needs.
 */
export async function finaliseTurn(args: {
  lane: Lane;
  lanes: TurnLanes;
  store: ConversationStore;
  events: TurnEventApplier;
  accountUsageService: AccountUsageService;
  threadId: string;
  /** The session the turn actually RAN on — rotation may have moved it after the caller's copy. */
  session: EngineSession;
  startedAt: Date;
  ok: boolean;
  onWarn: (message: string) => void;
}): Promise<void> {
  const { lane, lanes, store, session, threadId } = args;

  // The last events are still queued behind their writes; the turn is not over until they land.
  await lanes.settle(lane);
  lanes.drop({ lane, dequeue: (id) => store.dequeue(id) });

  const durationMs = Date.now() - args.startedAt.getTime();
  // Read through a method rather than off the lane directly: the only assignment TS can see in the
  // caller is the `undefined` reset before the turn — the real one happens inside the event callback
  // — so a direct read there narrows to `never`.
  const usage = lanes.takeUsage(lane);
  // Real counts if the engine reported any; otherwise the store keeps showing its estimate and the
  // row records the duration with zero tokens. An estimate is fine on screen and wrong in a ledger —
  // a number read back tomorrow should be one the engine actually said.
  store.endTurn(
    usage ? { durationMs, outputTokens: usage.outputTokens } : undefined,
  );
  // The turn's last tokens land after it ends, so this is the reading worth keeping.
  args.accountUsageService.stopTracking({
    accountId: session.accountId,
    threadId,
  });

  await args.events.recordCompletion({
    threadId,
    sessionId: session.id,
    startedAt: args.startedAt,
    durationMs,
    ok: args.ok,
    usage,
    contextPercent: lane.contextPercent,
    onWarn: args.onWarn,
  });
}
