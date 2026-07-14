import { describe, expect, it, vi } from 'vitest';
import type { EngineCapability, EngineLocalHooks } from '../port.js';
import { buildEngineLocalHooks, guardHooksAgainstCapabilities } from './engine-local.js';

describe('buildEngineLocalHooks', () => {
  it('svc-nudge fires on the first match then respects the token-delta throttle', () => {
    const render = vi.fn((command: string) => `nudge: ${command}`);
    const hooks = buildEngineLocalHooks({
      svcNudge: { tool: 'Bash', match: (cmd) => (cmd.includes('serve') ? 'serve' : null), deltaTokens: 100, render },
    });

    expect(hooks.postToolUseContext?.('Bash', { command: 'pnpm serve' }, 10)).toBe('nudge: pnpm serve');
    // Same tokens (no growth) — throttled.
    expect(hooks.postToolUseContext?.('Bash', { command: 'pnpm serve' }, 50)).toBeNull();
    // Grew past the delta — fires again.
    expect(hooks.postToolUseContext?.('Bash', { command: 'pnpm serve' }, 111)).toBe('nudge: pnpm serve');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('returns null for a non-matching command or a non-watched tool', () => {
    const hooks = buildEngineLocalHooks({
      svcNudge: { tool: 'Bash', match: (cmd) => (cmd.includes('serve') ? 'serve' : null), deltaTokens: 100, render: (c) => c },
    });
    expect(hooks.postToolUseContext?.('Bash', { command: 'pnpm test' }, 10)).toBeNull();
    expect(hooks.postToolUseContext?.('Write', { command: 'pnpm serve' }, 10)).toBeNull();
  });

  it('writeGuard delegates to evaluateWriteGuard', () => {
    const hooks = buildEngineLocalHooks({ writeGuard: { readOnly: true, roots: [] } });
    expect(hooks.writeGuard?.('Write', { file_path: '/a.txt' })).toEqual({
      allow: false,
      reason: 'This is a read-only turn — no file writes.',
    });
  });

  it('passes rotation through verbatim', () => {
    const rotation = { softTokens: 1000, reminderDeltaTokens: 500, softText: 'soft', reminderText: 'reminder' };
    const hooks = buildEngineLocalHooks({ rotation });
    expect(hooks.rotation).toEqual(rotation);
  });

  it('produces unset hook fields for unset specs', () => {
    const hooks = buildEngineLocalHooks({});
    expect(hooks.postToolUseContext).toBeUndefined();
    expect(hooks.writeGuard).toBeUndefined();
    expect(hooks.rotation).toBeUndefined();
    expect(hooks.steer).toBeUndefined();
    expect(hooks.holdCapMs).toBeUndefined();
  });
});

describe('guardHooksAgainstCapabilities', () => {
  it('drops a hook field whose capability is missing, calling onDropped', () => {
    const hooks: EngineLocalHooks = { holdCapMs: 5000 };
    const onDropped = vi.fn();
    const guarded = guardHooksAgainstCapabilities(hooks, new Set<EngineCapability>(['writeGuard']), onDropped);
    expect(guarded.holdCapMs).toBeUndefined();
    expect(onDropped).toHaveBeenCalledWith('holdCapMs', 'holdTimer');
  });

  it('keeps a hook field whose capability is present', () => {
    const hooks: EngineLocalHooks = { holdCapMs: 5000 };
    const guarded = guardHooksAgainstCapabilities(hooks, new Set<EngineCapability>(['holdTimer']));
    expect(guarded.holdCapMs).toBe(5000);
  });

  it('does not mutate the input hooks object', () => {
    const hooks: EngineLocalHooks = { holdCapMs: 5000 };
    guardHooksAgainstCapabilities(hooks, new Set<EngineCapability>([]));
    expect(hooks).toEqual({ holdCapMs: 5000 });
  });
});
