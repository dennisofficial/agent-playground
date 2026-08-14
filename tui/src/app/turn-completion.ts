import type { AccountVaultService } from "../auth/account-vault.service.js";
import type { EngineHomeService } from "../auth/engine-home.service.js";
import type { AccountUsageService } from "./account-usage.service.js";
import type { ContextPressureService } from "./context-pressure.service.js";
import type { ConversationStore } from "./conversation.store.js";
import type { SessionManagerService } from "./session-manager.service.js";
import { rotateOnContextWall, type RunningSession } from "./session-rotation.js";
import type { TurnEventApplier } from "./turn-events.js";
import type { Lane, TurnLanes } from "./turn-lanes.js";
import { closeCanaryTurn } from "./turn-nudge.js";
import type { RunTurnArgs } from "./turn-args.js";

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
  /** The pair the engine left behind, and the row it belongs to — see `adoptEngineRefresh`. */
  engineHomeService: EngineHomeService;
  accountVaultService: AccountVaultService;
  contextPressureService: ContextPressureService;
  sessionManagerService: SessionManagerService;
  threadId: string;
  /**
   * The session the turn actually RAN on — rotation may have moved it after the caller's copy. Typed
   * as running, because a turn that got this far had a credential and the read-back needs to know
   * whose it was.
   */
  session: RunningSession;
  startedAt: Date;
  ok: boolean;
  /** The turn that ran, so a forced rotation can hand its `brief`, `tools` and `cwd` to the successor. */
  turn: RunTurnArgs;
  /** The transcript itself no longer fits. The ONE rotation Atlas forces — see `rotateOnContextWall`. */
  wall: boolean;
  /** `TurnRunnerService.run`, for the successor's first turn. Not awaited: this turn is still ending. */
  run: (turn: RunTurnArgs) => void;
  onWarn: (message: string) => void;
}): Promise<void> {
  const { lane, lanes, store, session, threadId } = args;

  // The last events are still queued behind their writes; the turn is not over until they land.
  await lanes.settle(lane);
  lanes.drop({ lane, dequeue: (id) => store.dequeue(id) });

  // Whatever is STILL queued was never acknowledged by the model, and now never will be — the turn
  // is over and the query is closed. In the ordinary case there is nothing here: a late steer keeps
  // the turn open until the CLI drains it (see `STEER_DRAIN_CAP_MS`), so this is the crash, the
  // interrupt and the drain that timed out.
  //
  // Said out loud rather than swallowed, and NOT resent. The words are the human's and they never
  // reached the agent; quietly firing them into a fresh turn would be guessing that they still apply
  // to a conversation that has since died, been interrupted, or rotated. A notice keeps them on
  // screen to send again.
  for (const steer of store.drainQueue()) {
    store.notice(`not delivered — the turn ended first · ${steer.text}`);
  }

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

  // Before the meters are read anywhere else, because everything downstream authenticates with it.
  await adoptEngineRefresh({
    engineHomeService: args.engineHomeService,
    accountVaultService: args.accountVaultService,
    accountId: session.accountId,
    onWarn: args.onWarn,
  });

  // The canary is scored per TURN, so its sample closes here — one entry, or none at all when the
  // turn produced no prose to open.
  closeCanaryTurn({
    contextPressureService: args.contextPressureService,
    store,
    sessionId: session.id,
    lane,
  });

  await args.events.recordCompletion({
    threadId,
    sessionId: session.id,
    startedAt: args.startedAt,
    durationMs,
    ok: args.ok,
    usage,
    contextTokens: lane.contextTokens,
    contextLimit: lane.contextLimit,
    onWarn: args.onWarn,
  });

  // Last, so the seam falls where the failure did and the dead leg's ledger row is already written.
  // An ordinary engine crash deliberately does NOT reach here: the transcript is intact, `r` restarts
  // in place, and burning a leg on it would throw away a working context.
  if (!args.wall) return;
  args.contextPressureService.forget(session.id);
  await rotateOnContextWall({
    turn: args.turn,
    session,
    sessionManagerService: args.sessionManagerService,
    run: args.run,
  }).catch((error: unknown) => {
    args.onWarn(`context-wall rotation failed: ${String(error)}`);
    store.notice("this session is out of context and could not be rotated");
  });
}

/**
 * Take up whatever credential the engine left in its home.
 *
 * The engine refreshes the credentials file Atlas writes for it — in place, when the access token is
 * close to expiry — and the server rotates the refresh token as it does. Atlas used to write that file
 * and never read it back, so its own stored pair became scrap at the engine's first refresh, and the
 * next refresh Atlas attempted failed with a 4xx that marked a live account `expired` forever.
 *
 * Runs on the way out of EVERY turn, including a crashed one: the engine may have refreshed the
 * credential and then died, and that is precisely the pair worth keeping.
 *
 * Failures are a warning, never a throw. This is bookkeeping after the work is done, and a locked
 * database must not turn a finished turn into a failed one.
 */
async function adoptEngineRefresh(args: {
  engineHomeService: EngineHomeService;
  accountVaultService: AccountVaultService;
  accountId: string;
  onWarn: (message: string) => void;
}): Promise<void> {
  try {
    const observed = args.engineHomeService.observeClaudeCredential(
      args.accountId,
    );
    if (!observed) return;
    await args.accountVaultService.adopt({
      accountId: args.accountId,
      observed,
    });
  } catch (error: unknown) {
    args.onWarn(`could not adopt the engine's credential: ${String(error)}`);
  }
}
