import type { EngineLocalHooks } from '@workspace/agent-engine';
import { bgTaskCapRule } from '../../prompt-kit/jit';
import type { RunEngineArgs } from '../engine.types';

export interface BackgroundHoldTimerParams {
  /** Read LIVE from the JIT catalog each run (so a spec can mutate the rule) by the caller, then passed in. */
  holdCapMs: number;
  /** Whether this turn runs in streaming-input mode — the cap is advisory-only and never fires on a worker turn. */
  streaming: boolean;
  /** The turn has begun unwinding (its `finally`) — never cap after that. */
  isTurnEnded: () => boolean;
  /** Cancel a pending steer-idle close — the cap must not undo an active-work hold. Owned by the steer channel. */
  cancelEnd: () => void;
  onEvent?: RunEngineArgs['onEvent'];
  /** The capability-gated steer channel the cap notice is pushed onto (bg-task-cap → the model, in-turn). */
  steer?: EngineLocalHooks['steer'];
}

/**
 * BACKGROUND-TASK HOLD (SDK `run_in_background` Bash + backgrounded Task subagents): a tool-native background
 * task closes the turn's first `result` immediately (terminal_reason=completed), which would let the
 * STEER_IDLE_GRACE close the input while work is still in flight. Instead we hold the query() session open so
 * the task's `task_notification` AND the model's auto-continuation land in THIS turn.
 *
 * A background SUBAGENT runs UNCAPPED — held open with NO timer (it may run for hours; bounded only by the
 * outer PHASE_TIMEOUT / an operator Stop). A bare background Bash shell that exceeds `holdCapMs` gets an
 * ADVISORY nudge (the `bg-task-cap` rule's notice) and the model's NEXT natural result ends the turn — nothing
 * is ever killed, and the stream is NEVER severed by the cap. Closing stdin under a still-active turn makes
 * every subsequent host-tool call throw a bare "Stream closed" (prod incident b30616d2), so the cap never does
 * it.
 */
export class BackgroundHoldTimer {
  private readonly liveBgTasks = new Set<string>();
  // task_ids whose task_started carried subagent_type (a Task subagent, not a bare bg Bash)
  private readonly liveSubagentTasks = new Set<string>();
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private cappingFlag = false;

  constructor(private readonly p: BackgroundHoldTimerParams) {}

  /** `true` once the advisory cap has fired — the message loop must not cancel the model's next natural close. */
  get capping(): boolean {
    return this.cappingFlag;
  }

  get hasLiveBgTasks(): boolean {
    return this.liveBgTasks.size > 0;
  }

  get hasLiveSubagentTasks(): boolean {
    return this.liveSubagentTasks.size > 0;
  }

  /** An SDK run_in_background Bash task (or a backgrounded Task subagent) began — track it so the turn holds its
   *  input open until the task settles. A live subagent runs uncapped, so track it separately. */
  trackTaskStarted(taskId: string, isSubagent: boolean): void {
    this.liveBgTasks.add(taskId);
    if (isSubagent) this.liveSubagentTasks.add(taskId);
  }

  /** The task settled (completed/failed/stopped). Drop it from the live sets; a settlement + auto-continuation
   *  is imminent, so restart the hold window (or clear it if none remain). */
  trackTaskSettled(taskId?: string): void {
    if (taskId) {
      this.liveBgTasks.delete(taskId);
      this.liveSubagentTasks.delete(taskId);
    }
    this.resetHoldTimer();
  }

  armHoldTimer(): void {
    this.clearHold();
    this.holdTimer = setTimeout(() => this.onCap(), this.p.holdCapMs);
  }

  clearHold(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }
  }

  private resetHoldTimer(): void {
    if (this.liveBgTasks.size > 0 && this.liveSubagentTasks.size === 0)
      this.armHoldTimer();
    else this.clearHold();
  }

  // Cap fired (bare bg Bash only): warn the agent IN-TURN (mirrors the rotation nudge) and stop the loop from
  // cancelling closes (`capping`) so the model's next natural result ends the turn. Advisory-only — the stream
  // is never severed and no task is killed.
  private onCap(): void {
    if (!this.p.streaming || this.p.isTurnEnded() || this.cappingFlag) return;
    if (this.liveSubagentTasks.size > 0) return; // safety: never cap while a subagent is live
    this.cappingFlag = true; // the model's NEXT natural result ends the turn (no forced kill)
    this.p.onEvent?.({
      kind: 'bg_task',
      status: 'capped',
      detail: `background Bash task exceeded ${this.p.holdCapMs}ms (advisory; stream NOT closed)`,
    });
    this.p.cancelEnd();
    if (bgTaskCapRule.enabled) this.p.steer?.push(bgTaskCapRule.render({}));
    // NO capKillTimer / NO input.end() — the cap is purely advisory; stdin is never severed.
  }
}
