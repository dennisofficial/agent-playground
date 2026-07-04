import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import type { DataSource, Repository } from 'typeorm';
import {
  MessageEntity,
  StimulusEntity,
  JobEntity,
} from '../persistence/entities';
import {
  DuplicateStimulusError,
  StimulusStoreService,
} from './stimulus-store.service';

/** A minimal repo fake that mints ids on save + threads create/save/delete. */
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

/**
 * A fake `DataSource.transaction` with real ROLLBACK-on-throw semantics: writes are BUFFERED and only
 * flushed to the backing fake repos when the callback resolves. A throw inside the callback flushes
 * nothing — mirroring a Postgres transaction that never commits. `rowsFor` maps an entity class to the
 * fake repo's `rows` array so committed rows land where the behavioral assertions look for them.
 */
function fakeDataSource(
  rowsFor: (Entity: unknown) => { id?: string }[],
  opts: { failOn?: unknown } = {},
) {
  let seq = 0;
  const transaction = vi.fn(async (cb: (m: unknown) => Promise<unknown>) => {
    const staged: Array<{ Entity: unknown; saved: { id?: string } }> = [];
    const manager = {
      create: (Entity: unknown, data: Record<string, unknown>) => ({ ...data, __entity: Entity }),
      save: async (e: Record<string, unknown>) => {
        const { __entity, ...rest } = e as { __entity: unknown };
        // Inject a write failure INSIDE the callback (like a real failed INSERT) so the callback throws
        // and the flush below never runs → nothing commits.
        if (opts.failOn !== undefined && __entity === opts.failOn) throw new Error('stimulus write failed');
        const saved = { ...rest, id: `tx-${++seq}`, created_at: new Date() } as { id?: string };
        staged.push({ Entity: __entity, saved });
        return saved;
      },
    };
    const result = await cb(manager); // a throw inside cb skips the flush below → rollback
    for (const { Entity, saved } of staged) rowsFor(Entity).push(saved);
    return result;
  });
  return { transaction } as unknown as DataSource;
}

describe('StimulusStoreService — notification-seeds-a-thread', () => {
  it('seedEventThread opens a thread (origin event), persists message + event stimulus', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<MessageEntity>('msg');
    const stimuli = fakeRepo<StimulusEntity>('stim');
    const ds = fakeDataSource(() => []);
    const store = new StimulusStoreService(threads.repo, messages.repo, stimuli.repo, ds);

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
    expect(seeded.message).toMatchObject({ job_id: seeded.thread.id, text: 'CI failed', author: 'github' });
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
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<MessageEntity>('msg');
    const stimuli = fakeRepo<StimulusEntity>('stim');
    // The stimulus insert hits the partial-unique index.
    const uniqueErr = new QueryFailedError('insert', [], new Error('dup')) as QueryFailedError & {
      code?: string;
    };
    uniqueErr.code = '23505';
    (stimuli.repo.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(uniqueErr);

    const ds = fakeDataSource(() => []);
    const store = new StimulusStoreService(threads.repo, messages.repo, stimuli.repo, ds);
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
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<MessageEntity>('msg');
    const stimuli = fakeRepo<StimulusEntity>('stim');
    const ds = fakeDataSource((Entity) =>
      Entity === MessageEntity ? messages.rows : stimuli.rows,
    );
    const store = new StimulusStoreService(threads.repo, messages.repo, stimuli.repo, ds);

    const chat = await store.recordChatStimulus({
      orgId: 'T1',
      repoId: 'web',
      jobId: 'thread-9',
      author: { id: 'U1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'slack', jobRef: '100.1' },
      body: 'hey',
    });

    expect(threads.repo.save).not.toHaveBeenCalled(); // chat does NOT open a thread
    expect((ds.transaction as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1); // both writes in ONE tx
    expect(messages.rows[0]).toMatchObject({ job_id: 'thread-9', author: 'Dennis', text: 'hey' });
    expect(stimuli.rows[0]).toMatchObject({ kind: 'chat', job_id: 'thread-9', body: 'hey' });
    expect(chat).toMatchObject({
      kind: 'chat',
      trust: 'trusted',
      jobId: 'thread-9',
      author: { id: 'U1', displayName: 'Dennis' },
    });
    expect(chat.replyRoute).toEqual({ surfaceId: 'slack', jobRef: '100.1' });
  });

  it('recordChatStimulus is ATOMIC — a failed stimulus write leaves NO orphan message bubble', async () => {
    // The exact torn-write bug: a crash/failure between the message save and the stimulus save must not
    // leave a transcript bubble with no stimulus behind it (which renders but never drives a brain turn).
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<MessageEntity>('msg');
    const stimuli = fakeRepo<StimulusEntity>('stim');
    // The stimulus save (the SECOND write in the transaction) fails.
    const ds = fakeDataSource(
      (Entity) => (Entity === MessageEntity ? messages.rows : stimuli.rows),
      { failOn: StimulusEntity },
    );
    const store = new StimulusStoreService(threads.repo, messages.repo, stimuli.repo, ds);

    await expect(
      store.recordChatStimulus({
        orgId: 'T1',
        repoId: 'web',
        jobId: 'thread-9',
        author: { id: 'U1', displayName: 'Dennis' },
        replyRoute: { surfaceId: 'slack', jobRef: '100.1' },
        body: 'hey',
      }),
    ).rejects.toThrow('stimulus write failed');

    // Neither row committed — the message was rolled back with the stimulus.
    expect(messages.rows).toHaveLength(0);
    expect(stimuli.rows).toHaveLength(0);
  });
});
