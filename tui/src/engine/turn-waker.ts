/**
 * The one channel by which something other than a frame ends the drain loop's wait.
 *
 * The loop spends its life parked on the SDK iterator, and two things now have to be able to end a
 * turn while it is parked there: a deadline (a wake-up that produced no continuation, a hold whose
 * live set drained) and the user (esc on a held turn). Neither can `break` a loop it is not inside.
 *
 * The obvious way out — `input.close()` from the timer or the keystroke — is wrong twice over, and was
 * built and rejected once already:
 *
 * 1. **It loses a steer, visibly and permanently.** Every other termination path runs through the
 *    drain loop's `finally`, which sets `state.live = false` BEFORE `input.close()`. Closing the input
 *    directly inverts that: in the window before the CLI exits, `RunningTurn.steer` returns `true`,
 *    `MessageQueue.push` drops the message because it is closed, `onConsumed` never fires, and the
 *    queued chip in the UI is stuck for the life of the thread with the user's text gone.
 * 2. **It can wedge the lane.** Closing stdin only ends the child's input; `done` resolves when the
 *    CLI *exits*. That makes the CLI's behaviour the terminator — the exact failure the hold's
 *    allowlist polarity exists to prevent, one level down.
 *
 * So the frame wait is RACED against this instead, and the race being won `break`s: the same
 * terminator every other path already uses, reaching the `finally` in the right order.
 *
 * A tiny class rather than three closures in the loop because there are now two callers with
 * different lifetimes, and because "while the loop is parked in a hold there is always an open
 * channel" is an invariant worth being able to read in one place.
 */

/** What the loop sees when the wait was ended by something other than a frame. */
export const WAIT_ENDED = Symbol("wait ended");
export type WaitEnded = typeof WAIT_ENDED;

export class TurnWaker {
  private timer: NodeJS.Timeout | undefined;
  private promise: Promise<WaitEnded> | undefined;
  private resolve: ((value: WaitEnded) => void) | undefined;
  /**
   * Sticky, and deliberately not cleared by `clear()`. An abandon that arrives in the same tick as a
   * frame must still end the turn — the frame is processed, and the next `open()` resolves at once
   * rather than parking again on a channel nobody is going to fire.
   */
  private fired = false;

  /** What the drain loop races its frame wait against, or `undefined` when nothing can end it. */
  get pending(): Promise<WaitEnded> | undefined {
    return this.promise;
  }

  /** Has anything asked for the wait to end? The loop's backstop, checked before it parks again. */
  get spent(): boolean {
    return this.fired;
  }

  /** Park with a deadline: the wait ends when `ms` passes with no frame. Re-arming restarts it. */
  arm(ms: number): void {
    this.open();
    this.timer = setTimeout(() => this.fire(), ms);
    // A turn waiting on nothing must not be the reason the process cannot exit.
    this.timer.unref?.();
  }

  /**
   * Park with no deadline — only `fire()` ends this wait.
   *
   * Opened on every held `result` even though a hold has no clock, because `fire()` can only reach a
   * loop that is already racing something: the channel has to exist BEFORE the keystroke does.
   */
  open(): void {
    this.clear();
    this.promise = new Promise<WaitEnded>((resolve) => {
      this.resolve = resolve;
    });
    if (this.fired) this.fire();
  }

  /** End the wait now. A no-op on the loop if nothing is open — `spent` is the backstop for that. */
  fire(): void {
    this.fired = true;
    this.resolve?.(WAIT_ENDED);
  }

  /**
   * The SESSION is in use again — not merely that a frame arrived. A held turn's stream is mostly the
   * delegate being waited for, and its frames must not stop a clock that is waiting on the model. See
   * `isSessionInUse` in `background-hold.ts` for which is which.
   */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.promise = undefined;
    this.resolve = undefined;
  }
}
