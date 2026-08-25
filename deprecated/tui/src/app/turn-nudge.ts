import { EHarnessVariant, promptPayload, renderPrompt } from '../domain/message.js';
import type { EngineSession, Thread } from '../generated/prisma/client.js';
import type { ContextPressureService } from './context-pressure.service.js';
import type { ConversationStore } from './conversation.store.js';
import type { TurnEventApplier } from './turn-events.js';
import type { Lane } from './turn-lanes.js';

/**
 * The nudge, at the boundary where it is cheapest to hear it.
 *
 * Split out of `TurnRunnerService` for the reason everything else is: the runner must not learn what
 * a phase, a tool or — here — a context budget is. It hands over the lane's last reading and gets
 * back the string to give the model, or nothing.
 */

/**
 * Called after every tool call. Returns what to append to that tool's result, or `undefined`.
 *
 * Three things are true here at once and all three are deliberate:
 *
 * - **Nothing is cut.** The most this can do is put a sentence in front of the agent asking it to
 *   call `rotate`. The agent may ignore it and keep working, and that IS the suppression mechanism —
 *   which is why there is no suppression tool.
 * - **It is the same request `/rotate` sends**, with a reason prepended. One wording of what a
 *   rotation is, whether Dennis asked or the meter did.
 * - **It is persisted, and renders under the tool call that carried it.** Atlas injecting text into
 *   a conversation invisibly would be the one thing a transcript must never hide: what the agent did
 *   next was in answer to this.
 */
export async function nudgeAtToolBoundary(args: {
  contextPressureService: ContextPressureService;
  events: TurnEventApplier;
  store: ConversationStore;
  thread: Thread;
  session: EngineSession;
  lane: Lane;
  /** Queues a write on the lane's chain, so a nudge lands in order with the turn's own frames. */
  record: (work: () => Promise<void>) => void;
}): Promise<string | undefined> {
  const { lane, session, store } = args;
  // The occupancy reading arrives on the frame BEFORE this boundary, but every frame is applied on
  // the lane's write chain, so without this the decision would read a lane one frame stale — and one
  // frame stale, at exactly the crossing, is a nudge that arrives a tool call late for no reason.
  await lane.chain;
  // No reading yet — the turn's first assistant frame has not arrived. Legacy skipped unknown
  // occupancy rather than assuming a floor, and it is the right instinct: Codex reports only at a
  // turn boundary, so "unknown" is a normal state and nudging on a guess would be nudging on noise.
  if (lane.contextTokens === undefined || lane.contextLimit === undefined) return undefined;

  const nudge = args.contextPressureService.consider({
    session,
    role: args.thread.role,
    tokens: lane.contextTokens,
    contextLimit: lane.contextLimit,
  });
  if (!nudge) return undefined;

  const payload = promptPayload({
    text: nudge.text,
    harnessVariant: EHarnessVariant.transition,
  });
  args.record(() =>
    args.events.persist({
      store,
      threadId: args.thread.id,
      sessionId: session.id,
      payload,
    }),
  );
  // The envelope, not the bare prose: this arrives on the same channel as every other harness
  // message, and an untagged one would read as the human asking.
  return renderPrompt(payload);
}

/**
 * The canary's turn-boundary bookkeeping: record whether this turn opened with the glyph.
 *
 * The sample is the whole point — a dead canary is what turns the `ctx` meter's signal from `budget`
 * to `canary` (`ContextPressureService.observe`), and the meter is where the human reads it. It used
 * to also draw a transcript row saying the session had stopped following a standing instruction;
 * that row is gone with the rest of the harness commentary, and nothing about the MEASUREMENT
 * changed with it.
 */
export function closeCanaryTurn(args: {
  contextPressureService: ContextPressureService;
  sessionId: string;
  lane: Lane;
}): void {
  args.contextPressureService.endTurn({
    sessionId: args.sessionId,
    canary: args.lane.canary,
  });
}
