import { describe, expect, it, vi } from 'vitest';
import { AgentChatSurface } from '../agent-surface';
import type { AtlasChannel, AtlasThread } from '../persistence/entities';
import { SurfaceOrchestration } from './surface-orchestration.service';

type Repo<T> = {
  findOne: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} & Record<string, unknown>;

function repos(opts: {
  channelRef?: string | null;
  threadRef?: string | null;
}): {
  channels: Repo<AtlasChannel>;
  threads: Repo<AtlasThread>;
} {
  const channels = {
    findOne: vi.fn(async () =>
      opts.channelRef === undefined
        ? null
        : ({ surface_channel_ref: opts.channelRef } as unknown as AtlasChannel),
    ),
    update: vi.fn(),
  } as unknown as Repo<AtlasChannel>;
  const threads = {
    findOne: vi.fn(async () => ({ surface_thread_ref: opts.threadRef ?? null }) as unknown as AtlasThread),
    update: vi.fn(async () => undefined),
  } as unknown as Repo<AtlasThread>;
  return { channels, threads };
}

const INPUT = {
  orgId: 'T1',
  repoId: 'web',
  threadId: 'thread-1',
  source: 'github',
  severity: 'critical' as const,
  title: 'CI failed on main',
};

describe('SurfaceOrchestration.announceEvent (W6 announce-in-timeline)', () => {
  it('posts the headline TOP-LEVEL and backfills surface_thread_ref with its ts', async () => {
    const surface = new AgentChatSurface();
    const { channels, threads } = repos({ channelRef: 'C-PROJ', threadRef: null });
    const svc = new SurfaceOrchestration(surface, channels as never, threads as never);

    const ts = await svc.announceEvent(INPUT);

    expect(ts).toBeTypeOf('string');
    // The announcement landed in the timeline (no threadTs → top-level).
    expect(surface.outbox).toHaveLength(1);
    expect(surface.outbox[0].channel).toBe('C-PROJ');
    expect(surface.outbox[0].threadTs).toBeUndefined();
    expect(surface.outbox[0].text).toContain('CI failed on main');
    expect(surface.outbox[0].text).toContain('github');
    // The thread's ref was backfilled with the announcement ts → downstream posts thread off it.
    expect(threads.update).toHaveBeenCalledWith({ id: 'thread-1' }, { surface_thread_ref: ts });
  });

  it('is idempotent: an already-announced thread is not re-posted', async () => {
    const surface = new AgentChatSurface();
    const { channels, threads } = repos({ channelRef: 'C-PROJ', threadRef: 'existing.ts' });
    const svc = new SurfaceOrchestration(surface, channels as never, threads as never);

    const ts = await svc.announceEvent(INPUT);

    expect(ts).toBe('existing.ts');
    expect(surface.outbox).toHaveLength(0);
    expect(threads.update).not.toHaveBeenCalled();
  });

  it('no bound channel → no announcement, ref left null (downstream falls back to top-level)', async () => {
    const surface = new AgentChatSurface();
    const { channels, threads } = repos({ channelRef: null, threadRef: null });
    const svc = new SurfaceOrchestration(surface, channels as never, threads as never);

    const ts = await svc.announceEvent(INPUT);

    expect(ts).toBeUndefined();
    expect(surface.outbox).toHaveLength(0);
    expect(threads.update).not.toHaveBeenCalled();
  });
});
