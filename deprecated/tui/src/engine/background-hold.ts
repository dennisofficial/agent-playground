import { isDelegateEvent } from "../domain/delegates.js";
import type { EngineEvent } from "../domain/message.js";

/**
 * Why a turn does not end when the model stops talking.
 *
 * A backgrounded delegate outlives the frame that launched it. The launching tool call returns
 * immediately with "running in the background", the model carries on and finishes, and the `result`
 * frame arrives while the delegate is still working. Close the input stream there — which is what
 * "the turn ended, so we are done" means to the SDK — and the CLI process goes with it, taking the
 * delegate. The symptom is written into Atlas's own tapes: a later session opened to
 * `task_notification status: "stopped"` and *"No completion record was found for background agent … it
 * may have been running when the previous Claude Code process exited"*.
 *
 * So the stream is held open past `result` until the work it spawned settles. When a delegate finishes,
 * the SDK delivers its `task_notification` into the still-live session and the model wakes and reads
 * it — which is the entire feature, and is unreachable from a process that has already exited.
 *
 * Two kinds of held work, with deliberately different patience:
 *
 * - **A subagent** is held with NO deadline. It is another agent doing real work and may legitimately
 *   run for an hour; a timeout here would kill it mid-thought for the crime of being thorough.
 * - **A backgrounded shell** is held under a cap. A `tail -f` never settles, and a session held open
 *   forever by one is a thread that can never rotate, be rotated, or be reasoned about. At the cap the
 *   model is TOLD, in a steer, rather than the stream being cut under it: it can read what it has,
 *   stop the task, or say it is waiting on purpose — and its next natural `result` ends the turn.
 *
 * Pure bookkeeping over the frames, with no timer and no engine reference in it, so the rule can be
 * table-tested. The engine owns the clock; this owns the decision.
 */

/** What the drain loop should do with a `result` frame. */
export enum EHoldVerdict {
  /** Nothing outstanding — close the input and finish the turn. */
  end = "end",
  /** A subagent is still running. Stay open, indefinitely. */
  hold = "hold",
  /** Only backgrounded shells are left. Stay open, but start the cap running. */
  holdCapped = "holdCapped",
  /**
   * Nothing is live, but this `result` was a bare wake-up that did no work — so the turn is not over
   * either. Stay open for a few seconds in case a continuation is about to start streaming, and end
   * when it does not. See `normalise/result-frames.ts` for which frames qualify.
   */
  holdBriefly = "holdBriefly",
}

/**
 * The cap on a bare backgrounded shell, in ms.
 *
 * An hour, set from the SDK's own surface rather than from taste: `Monitor`'s documented maximum
 * `timeout_ms` is 3,600,000 ms, so anything shorter caps work the tool itself says is legitimate. The
 * corpus agrees — the 17 real `Monitor` calls run from 45 s to 45 min, every one of them bounded, and
 * an earlier ten-minute cap would have steered a 45-minute CI poll at minute 10 and ended the turn at
 * the model's next stop. Killing that poll is the exact failure this whole mechanism exists to
 * prevent, arriving by a different door.
 *
 * The cost of the higher number is that a dev server started on native `Bash` can pin a lane for an
 * hour. That is bounded on three sides: the working line says the session is held, `interrupt()`
 * abandons a hold from the keyboard, and the service facility gives long-lived processes a home that
 * is not a turn at all.
 */
export const SHELL_HOLD_CAP_MS = 60 * 60 * 1000;

/**
 * How long a bare wake-up `result` keeps the turn open, in ms.
 *
 * Unlike the cap this is not patience with someone else's work — nothing is live. It is the window in
 * which a continuation would start streaming if one were coming: the CLI already holds the
 * notification and has folded it into a result, so if it is going to carry on it does so at once.
 * Five seconds is generous for that, and it is the entire cost when the guess is wrong.
 */
export const WAKE_UP_GRACE_MS = 5 * 1000;

/**
 * How long a hold whose live set has just drained stays open, in ms.
 *
 * The verdict is only ever re-evaluated at a `result`, and an uncapped hold on a live subagent arms no
 * timer at all. So when the last task settles and the model does NOT wake — a settlement it does not
 * act on, or a notification it never reads — nothing will ever look at that lane again and it holds
 * forever. This is the backstop: the transition into an empty live set is the one moment the loop can
 * see that a hold has run out of reasons.
 *
 * Thirty seconds, because it is waiting on a MODEL rather than on a keystroke. An auto-continuation
 * that is coming starts streaming well inside that; a frame of any kind cancels it.
 */
export const DRAIN_GRACE_MS = 30 * 1000;

/** What the model is told when the cap fires. Prose, because it is a message to an agent. */
export const SHELL_HOLD_CAP_STEER =
  "A background shell task has been running for over an hour and this session is being held open " +
  "only for it. Either read what it has produced so far, stop it, or say plainly that you are waiting " +
  "on it and why — then finish your turn. If it is a dev server, a watcher or anything else that " +
  "should outlive this turn, it belongs on `service_start` rather than on a backgrounded shell.";

/**
 * Is this frame the SESSION being used — the model writing, or reading a tool back — as opposed to
 * anything else that happens to arrive on the same stream?
 *
 * This is the question that lifts a hold, and it is far narrower than "a frame arrived". A held turn's
 * stream is mostly NOT the model: a live subagent ticks `task_progress` every few seconds, forwards its
 * own tool calls and prose, and settles through `task_notification`, and the quota meter rides in
 * whenever it likes. Read any of those as the model coming back and the hold lifts within a frame or
 * two of being entered — and, because the verdict is only ever re-evaluated at a `result` that is not
 * coming, never re-holds. That costs all three of the things the hold is for at once: esc falls back to
 * the cooperative branch and is a no-op again, the drain backstop cannot arm because it keys off
 * `holding`, and the shell cap is cancelled and never re-armed.
 *
 * Two discriminants, because one is not enough:
 *
 * - **`delegateFrame`** — the raw frame carried a `parent_tool_use_id`, so it is a delegate's own
 *   output. It has to be read off the FRAME: `text` and `thinking` reach `domain/` with no parent id
 *   on them, so the event union genuinely cannot answer this and a per-event test silently misses a
 *   subagent's prose.
 * - **`isDelegateEvent`** — `domain/delegates.ts`'s canonical answer to "does this name a delegate",
 *   reused rather than restated. A second, weaker copy of it living here is exactly how a subagent's
 *   forwarded tool_result got read as a sign of life.
 */
export function isSessionInUse(args: {
  event: EngineEvent;
  delegateFrame: boolean;
}): boolean {
  if (args.delegateFrame) return false;
  if (isDelegateEvent(args.event)) return false;
  // A quota reading is the API talking about the ACCOUNT, not the model talking. It rides in on
  // whatever frame is passing and can land at any point in a long hold, so treating it as life would
  // lift holds at random — the rarer twin of the delegate bug above.
  if (args.event.kind === "rate_limit") return false;
  return true;
}

export class BackgroundHold {
  /** Every task that has started and not settled, and which of them are agents. */
  private readonly live = new Set<string>();
  private readonly agents = new Set<string>();
  private capped = false;

  /**
   * Fold a frame in. Takes whole engine events rather than SDK messages so the normaliser stays the
   * only place SDK types are touched.
   */
  observe(event: EngineEvent): void {
    if (event.kind === "task_started") {
      this.live.add(event.taskId);
      // A `task_type` of `local_agent`, or any named agent type, is another agent. `local_bash` and
      // everything else is a shell — the distinction the two patiences are built on.
      if (event.agentType !== undefined || event.taskType === "local_agent")
        this.agents.add(event.taskId);
      return;
    }
    if (event.kind === "task_settled") {
      this.live.delete(event.taskId);
      this.agents.delete(event.taskId);
      return;
    }
    // The membership LEVEL. It can only ever teach this about work it has not seen start — a
    // background task inherited from a resumed session emits no `task_started` of its own — and it is
    // explicitly NOT allowed to retire anything, because a foreground subagent never appears in it.
    if (event.kind === "background_tasks") {
      for (const task of event.tasks) {
        if (this.live.has(task.taskId)) continue;
        this.live.add(task.taskId);
        if (task.taskType === "local_agent") this.agents.add(task.taskId);
      }
    }
  }

  /** Nothing outstanding — the turn is genuinely over. */
  get idle(): boolean {
    return this.live.size === 0;
  }

  /** A held agent is the one thing that suspends the cap entirely. */
  get hasLiveAgent(): boolean {
    return this.agents.size > 0;
  }

  /** Set once the cap has fired, so it fires once per turn and not once per `result`. */
  markCapped(): void {
    this.capped = true;
  }

  /**
   * What to do with a `result`.
   *
   * Once capped, the turn ends at the model's next natural stopping point whatever is still live: the
   * model has been told and answered, and holding a second time would make the cap advisory in name
   * only.
   *
   * `nonTerminal` is the frame's own claim that it is a bare wake-up rather than a turn end. It is
   * consulted LAST, and only when nothing is live, because live work is a better reason to stay open
   * than a hint is — and because an empty set with a wake-up is the one case where `end` would
   * otherwise throw away a turn that never started.
   */
  verdict(args: { nonTerminal: boolean } = { nonTerminal: false }): EHoldVerdict {
    if (this.capped) return EHoldVerdict.end;
    if (this.hasLiveAgent) return EHoldVerdict.hold;
    if (!this.idle) return EHoldVerdict.holdCapped;
    return args.nonTerminal ? EHoldVerdict.holdBriefly : EHoldVerdict.end;
  }
}
