import { describe, expect, it } from 'vitest';
import type { JobEntity } from '../../persistence/entities';
import { AgentChatSurface } from '../../agent-surface/agent-chat-surface';
import { SurfaceOrchestration } from '../surface-orchestration.service';

function threadsRepo(thread: Partial<JobEntity> | null) {
  return {
    findOne: async () => (thread ? (thread as JobEntity) : null),
  } as never;
}

const INPUT = {
  orgId: 'T1',
  repoId: 'web',
  jobId: 'thread-1',
  source: 'github',
  severity: 'critical' as const,
  title: 'CI failed on main',
};

describe('SurfaceOrchestration.announceEvent (repo-addressed, real thread id)', () => {
  it('posts the headline into the thread and returns the thread id', async () => {
    const surface = new AgentChatSurface();
    const svc = new SurfaceOrchestration(surface, threadsRepo({ id: 'thread-1', repo_id: 'web' }));

    const ts = await svc.announceEvent(INPUT);

    expect(ts).toBe('thread-1');
    expect(surface.outbox).toHaveLength(1);
    expect(surface.outbox[0].channel).toBe('web'); // channel param carries repo_id
    expect(surface.outbox[0].threadTs).toBe('thread-1'); // threadTs param carries the real thread id
    expect(surface.outbox[0].text).toContain('CI failed on main');
    expect(surface.outbox[0].text).toContain('github');
  });

  it('missing thread → no announcement, returns undefined', async () => {
    const surface = new AgentChatSurface();
    const svc = new SurfaceOrchestration(surface, threadsRepo(null));

    const ts = await svc.announceEvent(INPUT);

    expect(ts).toBeUndefined();
    expect(surface.outbox).toHaveLength(0);
  });
});
