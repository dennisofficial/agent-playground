/**
 * prompt-kit / jit — the JIT-context rule TYPE (Pillar 4, decisions d1/d4/d5).
 *
 * A JIT-context rule co-locates EVERYTHING about one on-demand injection — its trigger, its threshold/throttle,
 * its delivery channel, its enabled flag, and its payload text — in a single declarative object, mirroring how
 * `@Fragment` co-locates `usedBy`/`order`/`condition` with the fragment prose. The catalog (`rules.ts`) is the
 * one readable source of truth; TWO thin executors consume it (an engine-local one for tool/token/timer
 * triggers, a host-side one for lifecycle/operator triggers). This file is the shared vocabulary they agree on.
 *
 * "JIT context" is the canonical name (d1): ONE mechanism regardless of payload size — a one-line nudge and a
 * full on-demand instruction are the same primitive (condition → payload → channel → throttle). "Prompt
 * injection" stays reserved for the security-attack meaning.
 */
import type { AgentMessage } from '../message';

/**
 * What makes a rule fire. A tagged union so each trigger carries exactly its own matching data (d5):
 *  - `tool-match` — a tool result whose input matches `match` (returns a label for a hit, null to skip).
 *  - `token-threshold` — live context occupancy crosses `softTokens`, then each further +`reminderDeltaTokens`.
 *  - `hold-timer` — a background-task hold outlives `holdMs`.
 *  - `lifecycle` — a job-lifecycle event (operator tap / approval); driven by the host-side executor.
 *  - `operator-message` — fires while composing an operator turn (the Thread-5 turn-prefix prepend rail, d18).
 */
export type JitTrigger =
  | { kind: 'tool-match'; tool: 'Bash'; match: (command: string) => string | null }
  | { kind: 'token-threshold'; softTokens: number; reminderDeltaTokens: number }
  | { kind: 'hold-timer'; holdMs: number }
  | { kind: 'lifecycle'; event: 'preview-requested' | 'plan-approved' }
  | { kind: 'operator-message' };

/**
 * How the payload reaches the live session:
 *  - `postToolUse-additionalContext` — attached to a tool result via the SDK `PostToolUse` hook.
 *  - `steer-now` — a mid-turn `priority:'now'` steer into the open streaming input.
 *  - `host-seed-notice` — a `seedSystemNotification` seed turn from the host (the preview rail).
 *  - `turn-prefix` — a `system_reminder` chunk prepended to the composed operator turn (Thread 5's
 *    `composeTurn` consumes it; the reserved `reminderKind:'memory'` slot, d18).
 */
export type JitDelivery =
  | 'postToolUse-additionalContext'
  | 'steer-now'
  | 'host-seed-notice'
  | 'turn-prefix';

/**
 * The runtime context a firing rule's `render`/`seed` consumes. The SERVICE gathers this dynamic state and hands
 * it in (content/wiring split); each field is optional because different trigger kinds carry different data.
 */
export type JitFireCtx = {
  /** The Bash command that matched (tool-match rules). */
  command?: string;
  /** Which context-pressure band fired (token-threshold rules): `soft` on the first crossing, else `reminder`. */
  phase?: 'soft' | 'reminder';
  /** The job this fire targets (lifecycle rules — feeds the seed's dedup key). */
  jobId?: string;
};

/**
 * One JIT-context rule — trigger, threshold, delivery, enabled flag, and payload, co-located (d4). The former
 * env DEFAULTS (`SVC_NUDGE_DELTA_TOKENS`, `ROTATION_*`, `BG_TASK_MAX_HOLD_MS`) live here now as declared field
 * values; `enabled` replaces the `SVC_NUDGE_DISABLED` kill-switch.
 */
export type JitRule = {
  /** Stable unique id (also the catalog dedup key + spec anchor). */
  id: string;
  /** Off = never fires. Replaces the per-feature env kill-switches. */
  enabled: boolean;
  trigger: JitTrigger;
  delivery: JitDelivery;
  /** Fire at most once per this many tokens of context growth (was `SVC_NUDGE_DELTA_TOKENS`). */
  throttle?: { deltaTokens: number };
  /** The payload. Typed-function templating (d11): pure `(ctx) => AgentMessage`. */
  render: (ctx: JitFireCtx) => AgentMessage;
  /**
   * `host-seed-notice` delivery only: the SAME seed-row opts the shipped call site passes, so the visible
   * transcript row + insert-once key stay byte-identical (NOT the generic fallback pill).
   */
  seed?: { label?: string; chunkKey: (ctx: JitFireCtx) => string };
};

/**
 * Boot-validate the catalog in the `validateFragments` spirit: ids are unique and non-empty, every declared
 * numeric threshold/throttle is finite and positive, and `host-seed-notice` rules carry a `seed`. Throws loud on
 * the first violation so a malformed rule can never ship silently.
 */
export function validateJitRules(rules: readonly JitRule[]): void {
  const seen = new Set<string>();
  const positive = (label: string, n: number): void => {
    if (!Number.isFinite(n) || n <= 0) throw new Error(`JIT rule ${label} must be a finite positive number, got ${n}`);
  };
  for (const rule of rules) {
    if (!rule.id) throw new Error('JIT rule has an empty id');
    if (seen.has(rule.id)) throw new Error(`Duplicate JIT rule id: ${rule.id}`);
    seen.add(rule.id);
    const t = rule.trigger;
    if (t.kind === 'token-threshold') {
      positive(`${rule.id}.trigger.softTokens`, t.softTokens);
      positive(`${rule.id}.trigger.reminderDeltaTokens`, t.reminderDeltaTokens);
    } else if (t.kind === 'hold-timer') {
      positive(`${rule.id}.trigger.holdMs`, t.holdMs);
    }
    if (rule.throttle) positive(`${rule.id}.throttle.deltaTokens`, rule.throttle.deltaTokens);
    if (rule.delivery === 'host-seed-notice' && !rule.seed) {
      throw new Error(`JIT rule ${rule.id} uses host-seed-notice delivery but declares no seed`);
    }
  }
}
