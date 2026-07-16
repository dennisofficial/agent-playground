import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type {
  ChatSurface,
  InboundChatMessage,
} from '../surface/chat-surface.port';
import { memoryPrependRule, renderPlanApprovedSeed } from '@shared/prompt-kit/jit';
import { JitHostExecutor } from './jit-host-executor';

/** Captures the exact args a `seedSystemNotification` call receives — the parity proof. */
class FakeSurface implements ChatSurface {
  readonly name = 'fake';
  readonly inbound$ = new Subject<InboundChatMessage>();
  calls: Array<Parameters<Required<ChatSurface>['seedSystemNotification']>> =
    [];

  async post(): Promise<string | undefined> {
    return undefined;
  }

  seedSystemNotification(
    ...args: Parameters<Required<ChatSurface>['seedSystemNotification']>
  ): string {
    this.calls.push(args);
    return 'seeded-ts';
  }
}

describe('JitHostExecutor', () => {
  it('returns "" when the surface cannot seed (no seedSystemNotification bound)', () => {
    const surface: ChatSurface = {
      name: 'fake',
      inbound$: new Subject<InboundChatMessage>(),
      post: async () => undefined,
    };
    const executor = new JitHostExecutor(surface);

    expect(
      executor.fireLifecycle('plan-approved', { repoId: 'R', jobId: 'J' }),
    ).toBe('');
  });

  it('fires the plan-approved rule, threading buildPath/baseBranch/decisionRecordId through to render + chunkKey', () => {
    const surface = new FakeSurface();
    const executor = new JitHostExecutor(surface);

    const ts = executor.fireLifecycle('plan-approved', {
      repoId: 'R',
      jobId: 'J',
      orgId: 'O',
      buildPath: 'plan',
      baseBranch: 'main',
      decisionRecordId: 'dr-1',
    });

    expect(ts).toBe('seeded-ts');
    expect(surface.calls).toHaveLength(1);
    const [channel, jobId, body, opts] = surface.calls[0];
    expect(channel).toBe('R');
    expect(jobId).toBe('J');
    expect(body).toBe(
      renderPlanApprovedSeed({
        jobId: 'J',
        buildPath: 'plan',
        baseBranch: 'main',
        decisionRecordId: 'dr-1',
      }),
    );
    expect(opts?.seedRow).toEqual({
      label: 'Plan approved — checking the base branch before starting',
      chunkKey: 'seed:plan-approved:dr-1',
    });
  });

  it('seeds onto ctx.surface instead of the ambiently-injected one, when given', () => {
    const injected = new FakeSurface();
    const override = new FakeSurface();
    const executor = new JitHostExecutor(injected);

    executor.fireLifecycle('plan-approved', {
      repoId: 'R',
      jobId: 'J',
      surface: override,
    });

    expect(injected.calls).toHaveLength(0);
    expect(override.calls).toHaveLength(1);
  });

  describe('collectOperatorPrepends (d18 turn-prefix rail)', () => {
    it('returns [] with no prependText — the default memory rail renders empty (byte-identical)', () => {
      const executor = new JitHostExecutor(new FakeSurface());

      expect(executor.collectOperatorPrepends({ jobId: 'j' })).toEqual([]);
    });

    it('returns one memory system_reminder chunk once prependText is supplied', () => {
      const executor = new JitHostExecutor(new FakeSurface());

      expect(
        executor.collectOperatorPrepends({
          jobId: 'j',
          prependText: 'recalled memory',
        }),
      ).toEqual([
        {
          kind: 'system_reminder',
          body: 'recalled memory',
          attrs: { reminderKind: 'memory' },
        },
      ]);
    });

    it('reports when an enabled operator turn-prefix rule exists', () => {
      const executor = new JitHostExecutor(new FakeSurface());

      expect(executor.hasEnabledOperatorPrepends()).toBe(true);
    });

    it('reports false and renders no chunks when the declarative rule is disabled', () => {
      const executor = new JitHostExecutor(new FakeSurface());
      const prev = memoryPrependRule.enabled;
      memoryPrependRule.enabled = false;
      try {
        expect(executor.hasEnabledOperatorPrepends()).toBe(false);
        expect(
          executor.collectOperatorPrepends({
            jobId: 'j',
            prependText: 'recalled memory',
          }),
        ).toEqual([]);
      } finally {
        memoryPrependRule.enabled = prev;
      }
    });
  });
});
