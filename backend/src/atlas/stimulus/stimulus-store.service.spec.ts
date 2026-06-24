import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import type { Repository } from 'typeorm';
import type {
  AtlasMessage,
  AtlasStimulus,
  AtlasThread,
} from '../persistence/entities';
import {
  DuplicateStimulusError,
  StimulusStoreService,
} from './stimulus-store.service';

/** A minimal repo fake that mints ids on save + tracks create/save/delete. */
function fakeRepo<T extends { id?: string }>(prefix: string) {
  const rows: T[] = [];
  let seq = 0;
  const deleted: string[] = [];
  const repo = {
    create: (data: Partial<T>) => ({ ...data }) as T,
    save: vi.fn(async (e: T) => {
      const saved = { ...e, id: e.id ?? `${prefix}-${++seq}`, created_at: new Date() } as T;
      rows.push(saved);
      return saved;
    }),
    delete: vi.fn(async (where: { id: string }) => void deleted.push(where.id)),
  } as unknown as Repository<T>;
  return { repo, rows, deleted };
}

describe('StimulusStoreService — notification-seeds-a-thread', () => {
  it('seedEventThread opens a thread (origin event), persists message + event stimulus', async () => {
    const threads = fakeRepo<AtlasThread>('thread');
    const messages = fakeRepo<AtlasMessage>('msg');
    const stimuli = fakeRepo<AtlasStimulus>('stim');
    const store = new StimulusStoreService(threads.repo, messages.repo, stimuli.repo);

    const seeded = await store.seedEventThread({
      orgId: 'T1',
      repoId: 'web',
      source: 'github',
      dedupeKey: 'run:1',
      severity: 'critical',
      body: 'CI failed',
      title: '[github] CI failed',
    });

    expect(seeded.thread).toMatchObject({ origin: 'event', org_id: 'T1', repo_id: 'web', surface_thread_ref: null });
    expect(seeded.message).toMatchObject({ thread_id: seeded.thread.id, text: 'CI failed', author: 'github' });
    expect(seeded.stimulus).toMatchObject({
      kind: 'event',
      trust: 'untrusted',
      source: 'github',
      dedupeKey: 'run:1',
      severity: 'critical',
      orgId: 'T1',
      repoId: 'web',
    });
    expect(seeded.stimulus.id).toBeTruthy();
  });

  it('rolls back the thread + message and throws DuplicateStimulusError on a unique violation', async () => {
    const threads = fakeRepo<AtlasThread>('thread');
    const messages = fakeRepo<AtlasMessage>('msg');
    const stimuli = fakeRepo<AtlasStimulus>('stim');
    // The stimulus insert hits the partial-unique index.
    const uniqueErr = new QueryFailedError('insert', [], new Error('dup')) as QueryFailedError & {
      code?: string;
    };
    uniqueErr.code = '23505';
    (stimuli.repo.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(uniqueErr);

    const store = new StimulusStoreService(threads.repo, messages.repo, stimuli.repo);
    await expect(
      store.seedEventThread({
        orgId: 'T1',
        repoId: 'web',
        source: 'github',
        dedupeKey: 'run:1',
        severity: 'info',
        body: 'dup',
        title: 't',
      }),
    ).rejects.toBeInstanceOf(DuplicateStimulusError);

    // The orphaned thread + message were cleaned up.
    expect(threads.deleted).toHaveLength(1);
    expect(messages.deleted).toHaveLength(1);
  });

  it('recordChatStimulus persists a chat message + chat stimulus (no thread, no dedupe)', async () => {
    const threads = fakeRepo<AtlasThread>('thread');
    const messages = fakeRepo<AtlasMessage>('msg');
    const stimuli = fakeRepo<AtlasStimulus>('stim');
    const store = new StimulusStoreService(threads.repo, messages.repo, stimuli.repo);

    const chat = await store.recordChatStimulus({
      orgId: 'T1',
      repoId: 'web',
      threadId: 'thread-9',
      author: { id: 'U1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'slack', threadRef: '100.1' },
      body: 'hey',
    });

    expect(threads.repo.save).not.toHaveBeenCalled(); // chat does NOT open a thread
    expect(messages.rows[0]).toMatchObject({ thread_id: 'thread-9', author: 'Dennis', text: 'hey' });
    expect(chat).toMatchObject({
      kind: 'chat',
      trust: 'trusted',
      threadId: 'thread-9',
      author: { id: 'U1', displayName: 'Dennis' },
    });
    expect(chat.replyRoute).toEqual({ surfaceId: 'slack', threadRef: '100.1' });
  });
});
