import { agentMessage, assertEnforcementSeamConfigured } from '../message';
import { ROTATION_REMINDER_NUDGE, ROTATION_SOFT_NUDGE } from '../messages/build-handoff';
import { BG_TASK_CAP_NOTICE } from './bg-task-cap';
import {
  detectGithubHtmlUrl,
  FETCH_TOOL_MATCHER,
  renderGithubFetchNudge,
} from './github-fetch-guard';
import { detectInstallCommand } from './install-awareness';
import { planApprovedRule } from './plan-approved';
import { type JitRule, validateJitRules } from './rule';
import { detectLongRunningCommand, renderSvcNudge } from './svc-nudge';

export const SVC_NUDGE_DELTA_TOKENS = 40_000;
export const ROTATION_SOFT_TOKENS = 150_000;
export const ROTATION_REMINDER_DELTA_TOKENS = 25_000;
export const BG_TASK_HOLD_CAP_MS = 600_000;

export const svcNudgeRule: JitRule = {
  id: 'svc-nudge',
  enabled: true,
  trigger: {
    kind: 'tool-match',
    tool: 'Bash',
    match: detectLongRunningCommand,
  },
  delivery: 'postToolUse-additionalContext',
  throttle: { deltaTokens: SVC_NUDGE_DELTA_TOKENS },
  render: (ctx) => agentMessage(renderSvcNudge(ctx.command ?? '')),
};

export const githubFetchGuardRule: JitRule = {
  id: 'github-fetch-guard',
  enabled: true,
  trigger: {
    kind: 'url-match',
    toolMatcher: FETCH_TOOL_MATCHER,
    match: detectGithubHtmlUrl,
  },
  delivery: 'postToolUse-additionalContext',
  render: (ctx) => agentMessage(renderGithubFetchNudge(ctx.url ?? '')),
};

export const installAwarenessRule: JitRule = {
  id: 'install-awareness',
  enabled: true,
  trigger: {
    kind: 'tool-match',
    tool: 'Bash',
    match: (c) => detectInstallCommand(c)?.label ?? null,
  },
  delivery: 'postToolUse-additionalContext',
  render: (ctx) => agentMessage(ctx.installAwarenessText ?? ''),
};

export const legRotationRule: JitRule = {
  id: 'leg-rotation',
  enabled: true,
  trigger: {
    kind: 'token-threshold',
    softTokens: ROTATION_SOFT_TOKENS,
    reminderDeltaTokens: ROTATION_REMINDER_DELTA_TOKENS,
  },
  delivery: 'steer-now',
  render: (ctx) =>
    agentMessage(ctx.phase === 'reminder' ? ROTATION_REMINDER_NUDGE : ROTATION_SOFT_NUDGE),
};

export const bgTaskCapRule: JitRule = {
  id: 'bg-task-cap',
  enabled: true,
  trigger: { kind: 'hold-timer', holdMs: BG_TASK_HOLD_CAP_MS },
  delivery: 'steer-now',
  render: () => agentMessage(BG_TASK_CAP_NOTICE),
};

export const memoryPrependRule: JitRule = {
  id: 'memory-prepend',
  enabled: true,
  trigger: { kind: 'operator-message' },
  delivery: 'turn-prefix',
  reminderKind: 'memory',
  render: (ctx) => agentMessage(ctx.prependText ?? ''),
};

export const JIT_RULES: JitRule[] = [
  svcNudgeRule,
  githubFetchGuardRule,
  installAwarenessRule,
  legRotationRule,
  bgTaskCapRule,
  planApprovedRule,
  memoryPrependRule,
];

validateJitRules(JIT_RULES);
assertEnforcementSeamConfigured();

export function findLifecycleRule(event: 'plan-approved'): JitRule | undefined {
  return JIT_RULES.find(
    (r) => r.enabled && r.trigger.kind === 'lifecycle' && r.trigger.event === event,
  );
}

export function operatorMessageRules(): JitRule[] {
  return JIT_RULES.filter((r) => r.enabled && r.trigger.kind === 'operator-message');
}
