import type { EngineCapability, EngineLocalHooks } from '../port.js';
import { evaluateWriteGuard, type WriteGuardCtx } from '../write-guard.js';

export interface SvcNudgeSpec {
  /** The tool name this rule watches (today always 'Bash'). */
  tool: string;
  /** Returns a match label, or null when the command doesn't match. */
  match: (command: string) => string | null;
  /** Fire on first match, then again only once context has grown this many tokens since the last fire. */
  deltaTokens: number;
  /** Render the nudge text for a matched command. */
  render: (command: string) => string;
}

export interface RotationSpec {
  softTokens: number;
  reminderDeltaTokens: number;
  softText: string;
  reminderText: string;
}

export interface EngineLocalHooksSpec {
  /** Undefined ⇒ the svc-nudge rule is disabled/not applicable this turn. */
  svcNudge?: SvcNudgeSpec;
  /** Undefined ⇒ no write-guard predicate for this turn (e.g. nothing to enforce). */
  writeGuard?: WriteGuardCtx;
  /** Undefined ⇒ no rotation steer for this turn (Claude's OWN rotation path is driven by a separate
   *  pre-existing mechanism and does NOT use this — this field exists for engines whose adapter wires
   *  rotation through the generic hook, i.e. Codex). */
  rotation?: RotationSpec;
}

/**
 * Throttle predicate for a per-tool nudge: fire on the FIRST match (`last === null`), then only once the
 * context has grown by at least `delta` tokens since the last nudge. Mirrors the backend's
 * `svcNudgeShouldFire`.
 */
export function shouldFireOnDelta(last: number | null, now: number, delta: number): boolean {
  return last === null || now - last >= delta;
}

/**
 * The engine-agnostic JIT-hook BUILDER: assembles an {@link EngineLocalHooks} from plain descriptor data.
 * Call once PER TURN — the svc-nudge throttle state is closed over the returned hooks and must not leak
 * across turns.
 */
export function buildEngineLocalHooks(spec: EngineLocalHooksSpec): EngineLocalHooks {
  const hooks: EngineLocalHooks = {};

  if (spec.svcNudge) {
    const svcNudge = spec.svcNudge;
    let lastTokens: number | null = null;
    hooks.postToolUseContext = (toolName, input, tokens) => {
      if (toolName !== svcNudge.tool) return null;
      const command = typeof (input as { command?: unknown })?.command === 'string'
        ? ((input as { command?: string }).command as string)
        : '';
      const match = svcNudge.match(command);
      if (!match) return null;
      if (!shouldFireOnDelta(lastTokens, tokens, svcNudge.deltaTokens)) return null;
      lastTokens = tokens;
      return svcNudge.render(command);
    };
  }

  if (spec.writeGuard) {
    const writeGuardCtx = spec.writeGuard;
    hooks.writeGuard = (toolName, input) => evaluateWriteGuard(toolName, input, writeGuardCtx);
  }

  if (spec.rotation) {
    hooks.rotation = { ...spec.rotation };
  }

  return hooks;
}

/**
 * Degrade-never-crash safety net: drops any hook field set on `hooks` whose paired capability is absent
 * from `capabilities`, calling `onDropped` for each drop. Never mutates the input object.
 */
export function guardHooksAgainstCapabilities(
  hooks: EngineLocalHooks,
  capabilities: ReadonlySet<EngineCapability>,
  onDropped?: (field: string, capability: EngineCapability) => void,
): EngineLocalHooks {
  const pairs: Array<[keyof EngineLocalHooks, EngineCapability]> = [
    ['postToolUseContext', 'postToolUseContext'],
    ['writeGuard', 'writeGuard'],
    ['steer', 'midTurnSteer'],
    ['rotation', 'midTurnSteer'],
    ['holdCapMs', 'holdTimer'],
  ];

  const result: EngineLocalHooks = { ...hooks };
  for (const [field, capability] of pairs) {
    if (result[field] !== undefined && !capabilities.has(capability)) {
      onDropped?.(field, capability);
      delete result[field];
    }
  }
  return result;
}
