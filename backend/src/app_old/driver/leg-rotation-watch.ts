import { ROTATION_REMINDER_DELTA_TOKENS, ROTATION_SOFT_TOKENS } from '../../_shared/prompt-kit/jit';

export type LegRotationSignalPhase = 'soft' | 'reminder';

export interface LegRotationThresholds {
  softTokens: number;
  reminderDeltaTokens: number;
}

export const DEFAULT_ROTATION_SOFT_TOKENS = ROTATION_SOFT_TOKENS;
export const DEFAULT_ROTATION_REMINDER_DELTA_TOKENS = ROTATION_REMINDER_DELTA_TOKENS;

export interface LegRotationSignal {
  phase: LegRotationSignalPhase;
  reminderIndex: number;
  contextTokens: number;
  contextLimit: number | null;
}

export interface OccupancyEvent {
  contextTokens?: number | null;
  contextLimit?: number | null;
  parentToolUseId?: string;
}

export interface LegRotationRunState {
  handoff: string | null;
  softReached: boolean;
  peakTokens: number | null;
}

export function freshLegRotationState(): LegRotationRunState {
  return { handoff: null, softReached: false, peakTokens: null };
}

export function resolveRotationThresholds(): LegRotationThresholds {
  return {
    softTokens: DEFAULT_ROTATION_SOFT_TOKENS,
    reminderDeltaTokens: DEFAULT_ROTATION_REMINDER_DELTA_TOKENS,
  };
}

export class LegRotationWatch {
  private firedLevel = -1;

  constructor(
    private readonly thresholds: LegRotationThresholds,
    private readonly onSignal: (signal: LegRotationSignal) => void,
  ) {}

  get softReached(): boolean {
    return this.firedLevel >= 0;
  }

  observe(evt: OccupancyEvent): void {
    if (evt.parentToolUseId != null) return; // subagent's own window — a separate context that can't be rotated
    const tokens = evt.contextTokens;
    if (tokens == null) return; // positive-signal only — never nudge a Codex/unknown-occupancy turn
    if (tokens < this.thresholds.softTokens) return; // below soft — nothing to do yet
    const contextLimit = evt.contextLimit ?? null;
    const level = Math.floor(
      (tokens - this.thresholds.softTokens) / this.thresholds.reminderDeltaTokens,
    );
    if (level <= this.firedLevel) return; // already at/above this level — nothing new
    const isFirst = this.firedLevel < 0;
    this.firedLevel = level;
    this.onSignal({
      phase: isFirst ? 'soft' : 'reminder',
      reminderIndex: isFirst ? 0 : level,
      contextTokens: tokens,
      contextLimit,
    });
  }
}
