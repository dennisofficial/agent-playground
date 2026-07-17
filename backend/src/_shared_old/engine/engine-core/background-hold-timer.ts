import type { EngineLocalHooks } from '@workspace/agent-engine';
import { bgTaskCapRule } from '../../prompt-kit/jit';
import type { RunEngineArgs } from '../engine.types';

export interface BackgroundHoldTimerParams {
  holdCapMs: number;
  streaming: boolean;
  isTurnEnded: () => boolean;
  cancelEnd: () => void;
  onEvent?: RunEngineArgs['onEvent'];
  steer?: EngineLocalHooks['steer'];
}

export class BackgroundHoldTimer {
  private readonly liveBgTasks = new Set<string>();
  private readonly liveSubagentTasks = new Set<string>();
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private cappingFlag = false;

  constructor(private readonly p: BackgroundHoldTimerParams) {}

  get capping(): boolean {
    return this.cappingFlag;
  }

  get hasLiveBgTasks(): boolean {
    return this.liveBgTasks.size > 0;
  }

  get hasLiveSubagentTasks(): boolean {
    return this.liveSubagentTasks.size > 0;
  }

  trackTaskStarted(taskId: string, isSubagent: boolean): void {
    this.liveBgTasks.add(taskId);
    if (isSubagent) this.liveSubagentTasks.add(taskId);
  }

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
    if (this.liveBgTasks.size > 0 && this.liveSubagentTasks.size === 0) this.armHoldTimer();
    else this.clearHold();
  }

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
  }
}
