/**
 * prompt-kit / jit — the JIT-context rule CATALOG (Pillar 4, decisions d1/d4/d5/d7).
 *
 * The single readable source of truth for every on-demand injection: each rule co-locates its trigger, its
 * threshold/throttle, its delivery channel, its `enabled` flag, and its payload. Two thin executors consume this
 * one catalog (engine-local for tool/token/timer triggers; host-side for lifecycle triggers) — the catalog owns
 * WHAT to say; the executors own WHEN/HOW to deliver (content/wiring split).
 *
 * The former env knobs are gone (d4): their DEFAULTS are the declared field values below, so runtime behavior at
 * default settings is byte-identical. `enabled` replaces the per-feature kill-switches.
 */
import { agentMessage } from '../message';
import { ROTATION_REMINDER_NUDGE, ROTATION_SOFT_NUDGE } from '../messages/build-handoff';
import { composePreviewPrepSeed } from '../system/fragments';
import { chunkKey } from '../harness/chunk-keys';
import { detectLongRunningCommand, renderSvcNudge } from './svc-nudge';
import { detectGithubHtmlUrl, renderGithubFetchNudge, FETCH_TOOL_MATCHER } from './github-fetch-guard';
import { detectInstallCommand } from './install-awareness';
import { BG_TASK_CAP_NOTICE } from './bg-task-cap';
import { planApprovedRule } from './plan-approved';
import { type JitRule, validateJitRules } from './rule';
import { assertEnforcementSeamConfigured } from '../message';

/** Was `DEFAULT_SVC_NUDGE_DELTA_TOKENS` (env `SVC_NUDGE_DELTA_TOKENS`). */
export const SVC_NUDGE_DELTA_TOKENS = 40_000;
/** Was `DEFAULT_ROTATION_SOFT_TOKENS` (env `ROTATION_SOFT_TOKENS`). */
export const ROTATION_SOFT_TOKENS = 150_000;
/** Was `DEFAULT_ROTATION_REMINDER_DELTA_TOKENS` (env `ROTATION_REMINDER_DELTA_TOKENS`). */
export const ROTATION_REMINDER_DELTA_TOKENS = 25_000;
/** Was the `HOLD_CAP_MS` default (env `BG_TASK_MAX_HOLD_MS`). */
export const BG_TASK_HOLD_CAP_MS = 600_000;

/**
 * atlas-svc nudge — when Atlas runs a Bash command that smells long-running, append a reminder pointing it at
 * the `atlas-svc` supervisor. Engine-local `PostToolUse` hook; throttled by context-token growth.
 */
export const svcNudgeRule: JitRule = {
  id: 'svc-nudge',
  enabled: true,
  trigger: { kind: 'tool-match', tool: 'Bash', match: detectLongRunningCommand },
  delivery: 'postToolUse-additionalContext',
  throttle: { deltaTokens: SVC_NUDGE_DELTA_TOKENS },
  render: (ctx) => agentMessage(renderSvcNudge(ctx.command ?? '')),
};

/**
 * GitHub-fetch guard — when Atlas fetches a github.com/gist.github.com HTML page (native `WebFetch` or a `fetch`
 * MCP tool), append a reminder that GitHub's web UI is client-rendered so the fetch returns chrome, not content,
 * and point it at the authenticated `gh api`/`git`/`raw.githubusercontent.com` tooling instead. Engine-local
 * `PostToolUse` hook on the fetch-tool matcher. NO throttle: each github fetch is a distinct mis-step worth
 * correcting (mirrors install-awareness), and the correction itself is what stops a repeat.
 */
export const githubFetchGuardRule: JitRule = {
  id: 'github-fetch-guard',
  enabled: true,
  trigger: { kind: 'url-match', toolMatcher: FETCH_TOOL_MATCHER, match: detectGithubHtmlUrl },
  delivery: 'postToolUse-additionalContext',
  render: (ctx) => agentMessage(renderGithubFetchNudge(ctx.url ?? '')),
};

/**
 * Install-awareness nudge — when Atlas runs a Bash command that installs/removes profile-relevant tooling,
 * the engine-local hook makes a host round-trip (`ProfileAwarenessService`, thread 1) that dedups against the
 * per-repo `profile_seen_tooling` ledger and returns a deterministic checklist; the hook injects it via
 * `ctx.installAwarenessText`. NO throttle: the ledger transition itself is the dedup, so distinct new tools
 * installed in quick succession must each nudge — a token-throttle would wrongly swallow them.
 */
export const installAwarenessRule: JitRule = {
  id: 'install-awareness',
  enabled: true,
  trigger: { kind: 'tool-match', tool: 'Bash', match: (c) => detectInstallCommand(c)?.label ?? null },
  delivery: 'postToolUse-additionalContext',
  render: (ctx) => agentMessage(ctx.installAwarenessText ?? ''),
};

/**
 * Leg-rotation nudge — as this turn's own main-agent occupancy fills, latch SOFT the first time it crosses
 * `softTokens`, then a REMINDER on each further +`reminderDeltaTokens`. Engine-local mid-turn steer. The
 * per-turn enablement + thresholds are still seeded via `RunEngineArgs.rotationNudge` (the driver sources them
 * from these declared values); this rule is the catalog source of both the threshold config and the payload.
 */
export const legRotationRule: JitRule = {
  id: 'leg-rotation',
  enabled: true,
  trigger: {
    kind: 'token-threshold',
    softTokens: ROTATION_SOFT_TOKENS,
    reminderDeltaTokens: ROTATION_REMINDER_DELTA_TOKENS,
  },
  delivery: 'steer-now',
  render: (ctx) => agentMessage(ctx.phase === 'reminder' ? ROTATION_REMINDER_NUDGE : ROTATION_SOFT_NUDGE),
};

/**
 * Background-task cap — when a `run_in_background` Bash task keeps the turn held past `holdMs`, steer the agent
 * with the cap notice before the engine ends the session. Engine-local hold-timer.
 */
export const bgTaskCapRule: JitRule = {
  id: 'bg-task-cap',
  enabled: true,
  trigger: { kind: 'hold-timer', holdMs: BG_TASK_HOLD_CAP_MS },
  delivery: 'steer-now',
  render: () => agentMessage(BG_TASK_CAP_NOTICE),
};

/**
 * Preview flagship (d7) — the exemplar lifecycle rule. When the operator taps "Spin up preview" at the ship
 * gate, seed the full demo-ready preview procedure as a host system-notice turn. The payload + gating already
 * shipped upstream (removed from the always-on prompt); this rule is the migration that routes it through the
 * registry. Byte-identical to the hand-rolled `spinUpPreview` seed — same body, same label + chunkKey.
 */
export const previewPrepRule: JitRule = {
  id: 'preview-prep',
  enabled: true,
  trigger: { kind: 'lifecycle', event: 'preview-requested' },
  delivery: 'host-seed-notice',
  render: (ctx) => agentMessage(composePreviewPrepSeed(ctx.previewInstructions ?? null)),
  seed: { label: 'Spin up preview requested', chunkKey: (ctx) => chunkKey.preview(ctx.jobId ?? '') },
};

/**
 * Memory turn-prefix rail (d18) — the exemplar `operator-message` rule. While the host composes an operator turn,
 * this rule may prepend a `system_reminder source="memory"` chunk BEFORE the `<user>` bubble. It is the general
 * prepend RAIL this job ships; its payload comes from `ctx.prependText`, which is EMPTY until the dependent
 * memory-auto-retrieval follow-up job wires `MemoryStore.recall` into it — so an operator turn with no memory
 * content renders no prefix chunk and stays byte-identical. `enabled` keeps the rail live so the wiring is
 * exercised end-to-end; the no-op render is what preserves default behavior.
 */
export const memoryPrependRule: JitRule = {
  id: 'memory-prepend',
  enabled: true,
  trigger: { kind: 'operator-message' },
  delivery: 'turn-prefix',
  reminderKind: 'memory',
  render: (ctx) => agentMessage(ctx.prependText ?? ''),
};

/** The declarative catalog every executor reads. */
export const JIT_RULES: JitRule[] = [
  svcNudgeRule,
  githubFetchGuardRule,
  installAwarenessRule,
  legRotationRule,
  bgTaskCapRule,
  previewPrepRule,
  planApprovedRule,
  memoryPrependRule,
];

// Boot-validate on import (validateFragments spirit): a malformed rule fails loud, never ships silently.
validateJitRules(JIT_RULES);
// Same boot-loud parity for the enforcement seam config the structural lint depends on (d10): a disarmed
// guard would let CI go quietly green, so fail at import if the sealed inventory / seam globs are degenerate.
assertEnforcementSeamConfigured();

/**
 * Find the single enabled rule whose lifecycle trigger matches `event`, or undefined. The host-side executor's
 * lookup; kept here so the catalog stays the one place rules are enumerated.
 */
export function findLifecycleRule(event: 'preview-requested' | 'plan-approved'): JitRule | undefined {
  return JIT_RULES.find(
    (r) => r.enabled && r.trigger.kind === 'lifecycle' && r.trigger.event === event,
  );
}

/**
 * Every enabled `operator-message` turn-prefix rule, in catalog order — the host-side executor's lookup for the
 * turn-prefix prepend rail (d18). Kept here so the catalog stays the one place rules are enumerated.
 */
export function operatorMessageRules(): JitRule[] {
  return JIT_RULES.filter((r) => r.enabled && r.trigger.kind === 'operator-message');
}
