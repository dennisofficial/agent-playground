/**
 * prompt-kit / jit — parity tests for the JIT-context rule catalog (Pillar 4, d1/d4/d5). Each rule's trigger,
 * throttle, and payload must reproduce the ENGINE'S pre-migration behavior byte-for-byte at defaults — these
 * specs are the guardrail for that parity, alongside the driver/engine specs that consume the same catalog.
 */
import { describe, expect, it } from 'vitest';
import { ROTATION_REMINDER_NUDGE, ROTATION_SOFT_NUDGE } from '../messages/build-handoff';
import { BG_TASK_CAP_NOTICE } from './bg-task-cap';
import { detectGithubHtmlUrl, renderGithubFetchNudge } from './github-fetch-guard';
import { detectInstallCommand } from './install-awareness';
import { planApprovedRule } from './plan-approved';
import { validateJitRules } from './rule';
import {
  JIT_RULES,
  bgTaskCapRule,
  findLifecycleRule,
  githubFetchGuardRule,
  installAwarenessRule,
  legRotationRule,
  memoryPrependRule,
  operatorMessageRules,
  svcNudgeRule,
} from './rules';
import { renderSvcNudge, svcNudgeShouldFire } from './svc-nudge';

describe('svcNudgeRule', () => {
  it.each([
    'pnpm dev',
    'pnpm --filter backend dev',
    'docker compose up',
    'nohup ./run.sh',
    'node server.js &',
    'uvicorn app:app --reload',
  ])('trigger.match fires on %j (parity with detectLongRunningCommand)', (cmd) => {
    if (svcNudgeRule.trigger.kind !== 'tool-match') throw new Error('expected tool-match trigger');
    expect(svcNudgeRule.trigger.match(cmd)).not.toBeNull();
  });

  it.each(['pnpm test', 'pnpm build', 'git status', 'atlas-svc run --name web -- pnpm dev'])(
    'trigger.match does NOT fire on %j',
    (cmd) => {
      if (svcNudgeRule.trigger.kind !== 'tool-match')
        throw new Error('expected tool-match trigger');
      expect(svcNudgeRule.trigger.match(cmd)).toBeNull();
    },
  );

  it('render is byte-identical to renderSvcNudge', () => {
    expect(svcNudgeRule.render({ command: 'vite' })).toBe(renderSvcNudge('vite'));
  });

  it('throttle mirrors svcNudgeShouldFire at the declared delta', () => {
    expect(svcNudgeRule.throttle?.deltaTokens).toBe(40_000);
    expect(svcNudgeShouldFire(null, 0, 40_000)).toBe(true);
    expect(svcNudgeShouldFire(0, 39_999, 40_000)).toBe(false);
    expect(svcNudgeShouldFire(0, 40_000, 40_000)).toBe(true);
  });
});

describe('githubFetchGuardRule', () => {
  it.each([
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/issues/1',
    'https://gist.github.com/someone/abc',
  ])('trigger.match fires on %j (parity with detectGithubHtmlUrl)', (url) => {
    if (githubFetchGuardRule.trigger.kind !== 'url-match')
      throw new Error('expected url-match trigger');
    expect(githubFetchGuardRule.trigger.match(url)).toBe(detectGithubHtmlUrl(url));
    expect(githubFetchGuardRule.trigger.match(url)).not.toBeNull();
  });

  it.each([
    'https://raw.githubusercontent.com/o/r/main/f',
    'https://api.github.com/repos/o/r',
    'not a url',
  ])('trigger.match does NOT fire on %j', (url) => {
    if (githubFetchGuardRule.trigger.kind !== 'url-match')
      throw new Error('expected url-match trigger');
    expect(githubFetchGuardRule.trigger.match(url)).toBeNull();
  });

  it('watches the fetch tools and delivers as PostToolUse additionalContext', () => {
    if (githubFetchGuardRule.trigger.kind !== 'url-match')
      throw new Error('expected url-match trigger');
    expect(githubFetchGuardRule.trigger.toolMatcher).toBe('WebFetch|mcp__fetch__.*');
    expect(githubFetchGuardRule.delivery).toBe('postToolUse-additionalContext');
  });

  it('render is byte-identical to renderGithubFetchNudge, empty when absent', () => {
    const url = 'https://github.com/owner/repo/tree/main';
    expect(githubFetchGuardRule.render({ url })).toBe(renderGithubFetchNudge(url));
    expect(githubFetchGuardRule.render({})).toBe(renderGithubFetchNudge(''));
  });

  it('declares no throttle (each github fetch is a distinct mis-step worth correcting)', () => {
    expect(githubFetchGuardRule.throttle).toBeUndefined();
  });
});

describe('installAwarenessRule', () => {
  it.each(['pnpm add eslint', 'apt-get install doctl', 'pnpm remove eslint'])(
    'trigger.match fires on %j (parity with detectInstallCommand)',
    (cmd) => {
      if (installAwarenessRule.trigger.kind !== 'tool-match')
        throw new Error('expected tool-match trigger');
      expect(installAwarenessRule.trigger.match(cmd)).toBe(
        detectInstallCommand(cmd)?.label ?? null,
      );
      expect(installAwarenessRule.trigger.match(cmd)).not.toBeNull();
    },
  );

  it.each(['pnpm install', 'npm ci', 'pnpm outdated', 'git status'])(
    'trigger.match does NOT fire on %j',
    (cmd) => {
      if (installAwarenessRule.trigger.kind !== 'tool-match')
        throw new Error('expected tool-match trigger');
      expect(installAwarenessRule.trigger.match(cmd)).toBeNull();
    },
  );

  it('renders the host-supplied text verbatim, and empty when absent', () => {
    expect(installAwarenessRule.render({ installAwarenessText: 'checklist text' })).toBe(
      'checklist text',
    );
    expect(installAwarenessRule.render({})).toBe('');
  });

  it('declares no throttle (the ledger transition is the dedup)', () => {
    expect(installAwarenessRule.throttle).toBeUndefined();
  });
});

describe('legRotationRule', () => {
  it('declares the operator-chosen thresholds', () => {
    if (legRotationRule.trigger.kind !== 'token-threshold')
      throw new Error('expected token-threshold trigger');
    expect(legRotationRule.trigger.softTokens).toBe(150_000);
    expect(legRotationRule.trigger.reminderDeltaTokens).toBe(25_000);
  });

  it('renders the SOFT nudge for phase "soft" and by default', () => {
    expect(legRotationRule.render({ phase: 'soft' })).toBe(ROTATION_SOFT_NUDGE);
    expect(legRotationRule.render({})).toBe(ROTATION_SOFT_NUDGE);
  });

  it('renders the REMINDER nudge for phase "reminder"', () => {
    expect(legRotationRule.render({ phase: 'reminder' })).toBe(ROTATION_REMINDER_NUDGE);
  });
});

describe('bgTaskCapRule', () => {
  it('declares the default hold cap and byte-identical notice', () => {
    if (bgTaskCapRule.trigger.kind !== 'hold-timer') throw new Error('expected hold-timer trigger');
    expect(bgTaskCapRule.trigger.holdMs).toBe(600_000);
    expect(bgTaskCapRule.render({})).toBe(BG_TASK_CAP_NOTICE);
  });
});

describe('memoryPrependRule (turn-prefix rail, d18)', () => {
  it('is an operator-message rule delivered as a turn-prefix in the reserved memory slot', () => {
    expect(memoryPrependRule.trigger).toEqual({ kind: 'operator-message' });
    expect(memoryPrependRule.delivery).toBe('turn-prefix');
    expect(memoryPrependRule.reminderKind).toBe('memory');
  });

  it('renders nothing without prepend content (byte-identical default: no prefix chunk)', () => {
    expect(memoryPrependRule.render({})).toBe('');
  });

  it('renders the supplied prepend text (the rail the follow-up recall job fills)', () => {
    expect(memoryPrependRule.render({ prependText: 'memory: prefers pnpm' })).toBe(
      'memory: prefers pnpm',
    );
  });

  it('operatorMessageRules() enumerates it', () => {
    expect(operatorMessageRules()).toContain(memoryPrependRule);
  });
});

describe('JIT_RULES catalog', () => {
  it('validates without throwing', () => {
    expect(() => validateJitRules(JIT_RULES)).not.toThrow();
  });

  it('has unique ids', () => {
    const ids = JIT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the github-fetch guard', () => {
    expect(JIT_RULES).toContain(githubFetchGuardRule);
  });

  it('findLifecycleRule resolves plan-approved to planApprovedRule (the only lifecycle rule left — Thread 4 retired preview-requested)', () => {
    expect(findLifecycleRule('plan-approved')).toBe(planApprovedRule);
  });
});
