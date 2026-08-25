import type { AgentMessage } from '../message';

export type JitTrigger =
  | {
      kind: 'tool-match';
      tool: 'Bash';
      match: (command: string) => string | null;
    }
  | {
      kind: 'url-match';
      toolMatcher: string;
      match: (url: string) => string | null;
    }
  | { kind: 'token-threshold'; softTokens: number; reminderDeltaTokens: number }
  | { kind: 'hold-timer'; holdMs: number }
  | { kind: 'lifecycle'; event: 'plan-approved' }
  | { kind: 'operator-message' };

export type JitDelivery =
  | 'postToolUse-additionalContext'
  | 'steer-now'
  | 'host-seed-notice'
  | 'turn-prefix';

export type JitFireCtx = {
  command?: string;
  url?: string;
  installAwarenessText?: string;
  phase?: 'soft' | 'reminder';
  jobId?: string;
  prependText?: string;
  buildPath?: 'direct' | 'plan';
  baseBranch?: string;
  decisionRecordId?: string;
};

export type JitRule = {
  id: string;
  enabled: boolean;
  trigger: JitTrigger;
  delivery: JitDelivery;
  throttle?: { deltaTokens: number };
  render: (ctx: JitFireCtx) => AgentMessage;
  seed?: { label?: string; chunkKey: (ctx: JitFireCtx) => string };
  reminderKind?: string;
};

export function validateJitRules(rules: readonly JitRule[]): void {
  const seen = new Set<string>();
  const positive = (label: string, n: number): void => {
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`JIT rule ${label} must be a finite positive number, got ${n}`);
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
    } else if (t.kind === 'url-match' && !t.toolMatcher) {
      throw new Error(
        `JIT rule ${rule.id} uses a url-match trigger but declares an empty toolMatcher`,
      );
    }
    if (rule.throttle) positive(`${rule.id}.throttle.deltaTokens`, rule.throttle.deltaTokens);
    if (rule.delivery === 'host-seed-notice' && !rule.seed) {
      throw new Error(`JIT rule ${rule.id} uses host-seed-notice delivery but declares no seed`);
    }
  }
}
