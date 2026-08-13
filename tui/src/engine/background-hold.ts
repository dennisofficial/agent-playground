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
}

/**
 * The cap on a bare backgrounded shell, in ms.
 *
 * Ten minutes: long enough that an ordinary long build or test run settles inside it and the model
 * never hears about the cap at all, short enough that a `tail -f` cannot pin a thread open past the
 * point where anyone is still watching.
 */
export const SHELL_HOLD_CAP_MS = 10 * 60 * 1000;

/** What the model is told when the cap fires. Prose, because it is a message to an agent. */
export const SHELL_HOLD_CAP_STEER =
  "A background shell task has been running for over ten minutes and this session is being held open " +
  "only for it. Either read what it has produced so far, stop it, or say plainly that you are waiting " +
  "on it and why — then finish your turn.";

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
   */
  verdict(): EHoldVerdict {
    if (this.capped || this.idle) return EHoldVerdict.end;
    if (this.hasLiveAgent) return EHoldVerdict.hold;
    return EHoldVerdict.holdCapped;
  }
}
