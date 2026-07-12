import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { ChatSurface, InboundChatMessage } from '../surface/chat-surface.port';
import { PREVIEW_PREP_SEED_BODY } from '../prompt-kit';
import { JitHostExecutor } from './jit-host-executor';

/** Captures the exact args a `seedSystemNotification` call receives — the parity proof. */
class FakeSurface implements ChatSurface {
  readonly name = 'fake';
  readonly inbound$ = new Subject<InboundChatMessage>();
  calls: Array<Parameters<Required<ChatSurface>['seedSystemNotification']>> = [];

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
  it('fires the preview-prep rule byte-identical to the shipped hand-rolled seed call', () => {
    const surface = new FakeSurface();
    const executor = new JitHostExecutor(surface);

    const ts = executor.fireLifecycle('preview-requested', { repoId: 'R', jobId: 'J', orgId: 'O' });

    expect(ts).toBe('seeded-ts');
    expect(surface.calls).toHaveLength(1);
    const [channel, jobId, body, opts] = surface.calls[0];
    expect(channel).toBe('R');
    expect(jobId).toBe('J');
    expect(body).toBe(PREVIEW_PREP_SEED_BODY);
    expect(opts?.orgId).toBe('O');
    expect(opts?.seedRow).toEqual({ label: 'Spin up preview requested', chunkKey: 'seed:preview:J' });
  });

  it('returns "" when the surface cannot seed (no seedSystemNotification bound)', () => {
    const surface: ChatSurface = {
      name: 'fake',
      inbound$: new Subject<InboundChatMessage>(),
      post: async () => undefined,
    };
    const executor = new JitHostExecutor(surface);

    expect(executor.fireLifecycle('preview-requested', { repoId: 'R', jobId: 'J' })).toBe('');
  });

  it('returns "" for a lifecycle event with no matching enabled rule', () => {
    const surface = new FakeSurface();
    const executor = new JitHostExecutor(surface);

    expect(executor.fireLifecycle('plan-approved', { repoId: 'R', jobId: 'J' })).toBe('');
    expect(surface.calls).toHaveLength(0);
  });

  it('seeds onto ctx.surface instead of the ambiently-injected one, when given', () => {
    const injected = new FakeSurface();
    const override = new FakeSurface();
    const executor = new JitHostExecutor(injected);

    executor.fireLifecycle('preview-requested', { repoId: 'R', jobId: 'J', surface: override });

    expect(injected.calls).toHaveLength(0);
    expect(override.calls).toHaveLength(1);
  });
});
