import type { SeedRow } from '@shared/domain';
import type { DataSource, Repository } from 'typeorm';
import { QueryFailedError } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import {
  InboundMessageEntity,
  JobEntity,
  TranscriptMessageEntity,
} from '../../persistence/entities';
import { SYSTEM_SEED_AUTHOR } from '../../surface/chat-surface.port';
import type { JobBootstrapService } from '../job-bootstrap';
import { DuplicateStimulusError, StimulusStoreService } from '../stimulus-store.service';

function makeBootstrap() {
  return {
    planningThreadId: vi.fn(async () => 'thread-planning'),
    ensurePlanningThreadGroup: vi.fn(async () => undefined),
    ciThreadId: vi.fn(async () => null),
  } as unknown as JobBootstrapService;
}

function fakeRepo<T extends { id?: string }>(prefix: string) {
  const rows: T[] = [];
  let seq = 0;
  const deleted: string[] = [];
  const repo = {
    create: (data: Partial<T>) => ({ ...data }) as T,
    save: vi.fn(async (e: T) => {
      const saved = {
        ...e,
        id: e.id ?? `${prefix}-${++seq}`,
        created_at: new Date(),
      } as T;
      rows.push(saved);
      return saved;
    }),
    delete: vi.fn(async (where: { id: string }) => void deleted.push(where.id)),
  } as unknown as Repository<T>;
  return { repo, rows, deleted };
}

function fakeDataSource(
  rowsFor: (Entity: unknown) => { id?: string }[],
  opts: { failOn?: unknown; failWith?: unknown } = {},
) {
  let seq = 0;
  const transaction = vi.fn(async (cb: (m: unknown) => Promise<unknown>) => {
    const staged: Array<{ Entity: unknown; saved: { id?: string } }> = [];
    const manager = {
      create: (Entity: unknown, data: Record<string, unknown>) => ({
        ...data,
        __entity: Entity,
      }),
      save: async (e: Record<string, unknown>) => {
        const { __entity, ...rest } = e as { __entity: unknown };
        if (opts.failOn !== undefined && __entity === opts.failOn)
          throw opts.failWith ?? new Error('stimulus write failed');
        const saved = {
          ...rest,
          id: `tx-${++seq}`,
          created_at: new Date(),
        } as { id?: string };
        staged.push({ Entity: __entity, saved });
        return saved;
      },
      update: async (Entity: unknown, id: string, patch: Record<string, unknown>) => {
        const target = staged.find((s) => s.Entity === Entity && s.saved.id === id);
        if (target) Object.assign(target.saved, patch);
        return { affected: target ? 1 : 0 };
      },
    };
    const result = await cb(manager); // a throw inside cb skips the flush below → rollback
    for (const { Entity, saved } of staged) rowsFor(Entity).push(saved);
    return result;
  });
  return { transaction } as unknown as DataSource;
}

describe('StimulusStoreService — notification-seeds-a-thread', () => {
  it('attachEventToJob persists the system_event card + event stimulus atomically on an existing job', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const ds = fakeDataSource((Entity) =>
      Entity === TranscriptMessageEntity ? messages.rows : stimuli.rows,
    );
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

    const event = await store.attachEventToJob({
      jobId: 'job-7',
      orgId: 'T1',
      repoId: 'web',
      source: 'github',
      dedupeKey: 'ci:abc',
      severity: 'critical',
      eventKind: 'ci_failure',
      body: 'CI failed',
    });

    expect(threads.repo.save).not.toHaveBeenCalled(); // attach reuses the job — no new thread
    expect(ds.transaction as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1); // both writes in ONE tx
    expect(messages.rows[0]).toMatchObject({
      job_id: 'job-7',
      text: 'CI failed',
      meta: {
        source: 'system_event',
        eventSource: 'github',
        severity: 'critical',
        eventKind: 'ci_failure',
      },
    });
    expect(stimuli.rows[0]).toMatchObject({
      kind: 'event',
      trust: 'untrusted',
      job_id: 'job-7',
      dedupe_key: 'ci:abc',
    });
    expect(event).toMatchObject({
      type: 'event',
      trust: 'untrusted',
      jobId: 'job-7',
      source: 'github',
      severity: 'critical',
    });
  });

  it('attachEventToJob routes to the ci thread group thread once one exists (§CI-routing)', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const ds = fakeDataSource((Entity) =>
      Entity === TranscriptMessageEntity ? messages.rows : stimuli.rows,
    );
    const bootstrap = {
      planningThreadId: vi.fn(async () => 'thread-planning'),
      ensurePlanningThreadGroup: vi.fn(async () => undefined),
      ciThreadId: vi.fn(async () => 'thread-ci-1'),
    } as unknown as JobBootstrapService;
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuli.repo,
      ds,
      bootstrap,
    );

    const event = await store.attachEventToJob({
      jobId: 'job-7',
      orgId: 'T1',
      repoId: 'web',
      source: 'github',
      dedupeKey: 'ci:abc',
      severity: 'critical',
      eventKind: 'ci_failure',
      body: 'CI failed again',
    });

    expect(messages.rows[0]).toMatchObject({
      job_id: 'job-7',
      thread_id: 'thread-ci-1',
    });
    expect(stimuli.rows[0]).toMatchObject({ lane: 'thread:thread-ci-1' });
    expect(event.resumeThreadId).toBe('thread-ci-1');
  });

  it('attachEventToJob is ATOMIC — a failed stimulus write leaves NO orphan event card', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const ds = fakeDataSource(
      (Entity) => (Entity === TranscriptMessageEntity ? messages.rows : stimuli.rows),
      { failOn: InboundMessageEntity },
    );
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

    await expect(
      store.attachEventToJob({
        jobId: 'job-7',
        orgId: 'T1',
        repoId: 'web',
        source: 'github',
        dedupeKey: 'ci:abc',
        severity: 'critical',
        eventKind: 'ci_failure',
        body: 'CI failed',
      }),
    ).rejects.toThrow('stimulus write failed');

    expect(messages.rows).toHaveLength(0);
    expect(stimuli.rows).toHaveLength(0);
  });

  it('attachEventToJob throws DuplicateStimulusError on a unique violation, committing neither row', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const uniqueErr = new QueryFailedError('insert', [], new Error('dup')) as QueryFailedError & {
      code?: string;
    };
    uniqueErr.code = '23505';
    const ds = fakeDataSource(
      (Entity) => (Entity === TranscriptMessageEntity ? messages.rows : stimuli.rows),
      { failOn: InboundMessageEntity, failWith: uniqueErr },
    );
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

    await expect(
      store.attachEventToJob({
        jobId: 'job-7',
        orgId: 'T1',
        repoId: 'web',
        source: 'github',
        dedupeKey: 'ci:abc',
        severity: 'info',
        eventKind: 'ci_failure',
        body: 'dup',
      }),
    ).rejects.toBeInstanceOf(DuplicateStimulusError);

    expect(messages.rows).toHaveLength(0);
    expect(stimuli.rows).toHaveLength(0);
    expect(messages.deleted).toHaveLength(0);
  });

  it('recordChatStimulus persists a chat message + chat stimulus (no thread, no dedupe)', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const ds = fakeDataSource((Entity) =>
      Entity === TranscriptMessageEntity ? messages.rows : stimuli.rows,
    );
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

    const chat = await store.recordChatStimulus({
      orgId: 'T1',
      repoId: 'web',
      jobId: 'thread-9',
      author: { id: 'U1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'slack', jobRef: '100.1' },
      body: 'hey',
    });

    expect(threads.repo.save).not.toHaveBeenCalled(); // chat does NOT open a thread
    expect(ds.transaction as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1); // both writes in ONE tx
    expect(messages.rows[0]).toMatchObject({
      job_id: 'thread-9',
      author: 'Dennis',
      text: 'hey',
    });
    expect(stimuli.rows[0]).toMatchObject({
      kind: 'chat',
      job_id: 'thread-9',
      body: 'hey',
    });
    expect(chat).toMatchObject({
      jobId: 'thread-9',
      author: { id: 'U1', displayName: 'Dennis' },
      message: { type: 'user' },
    });
    expect(chat.replyRoute).toEqual({ surfaceId: 'slack', jobRef: '100.1' });
  });

  it('recordChatStimulus is ATOMIC — a failed stimulus write leaves NO orphan message bubble', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const ds = fakeDataSource(
      (Entity) => (Entity === TranscriptMessageEntity ? messages.rows : stimuli.rows),
      { failOn: InboundMessageEntity },
    );
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

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

    expect(messages.rows).toHaveLength(0);
    expect(stimuli.rows).toHaveLength(0);
  });
});

describe('StimulusStoreService — seed-aware recordChatStimulus (durable chat/gate pump)', () => {
  function fakeMessageRepoWithQueryBuilder(rows: TranscriptMessageEntity[]) {
    return {
      create: (data: Partial<TranscriptMessageEntity>) => ({ ...data }) as TranscriptMessageEntity,
      save: vi.fn(async (e: TranscriptMessageEntity) => {
        const saved = {
          ...e,
          id: `msg-${rows.length + 1}`,
          created_at: new Date(),
        } as TranscriptMessageEntity;
        rows.push(saved);
        return saved;
      }),
      createQueryBuilder: () => {
        let jobId: string | undefined;
        let chunkKey: string | undefined;
        const qb = {
          where(_expr: string, params: Record<string, unknown>) {
            if (params.jobId !== undefined) jobId = params.jobId as string;
            return qb;
          },
          andWhere(_expr: string, params: Record<string, unknown>) {
            if (params.key !== undefined) {
              chunkKey = (JSON.parse(params.key as string) as { chunkKey?: string }).chunkKey;
            }
            return qb;
          },
          getCount: async () =>
            rows.filter(
              (r) =>
                r.job_id === jobId &&
                (r.meta as { chunkKey?: string } | null)?.chunkKey === chunkKey,
            ).length,
        };
        return qb;
      },
      // The pill-correlation write (`m.update(TranscriptMessageEntity, pillRow, { stimulus_id })`) patches
      // the saved row in place, mirroring a real UPDATE.
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
        return { affected: row ? 1 : 0 };
      }),
    } as unknown as Repository<TranscriptMessageEntity>;
  }

  function fakeDataSourceWithMessageRepo(messageRepo: Repository<TranscriptMessageEntity>) {
    let seq = 0;
    const transaction = vi.fn(async (cb: (m: unknown) => Promise<unknown>) => {
      const manager = {
        create: (Entity: unknown, data: Record<string, unknown>) => ({
          ...data,
          __entity: Entity,
        }),
        save: async (e: Record<string, unknown>) => {
          const { __entity, ...rest } = e as { __entity: unknown };
          return { ...rest, id: `tx-${++seq}`, created_at: new Date() };
        },
        getRepository: (Entity: unknown) => {
          if (Entity === TranscriptMessageEntity) return messageRepo;
          throw new Error(
            `fakeDataSourceWithMessageRepo: unexpected getRepository(${String(Entity)})`,
          );
        },
        // The pill-correlation write (see `recordChatStimulus`) delegates to the message repo's own
        // `update`, which patches the row in `messageRows` in place.
        update: async (
          Entity: unknown,
          id: string,
          patch: Record<string, unknown>,
        ) => {
          if (Entity === TranscriptMessageEntity) {
            return (
              messageRepo as unknown as {
                update: (
                  id: string,
                  patch: Record<string, unknown>,
                ) => Promise<unknown>;
              }
            ).update(id, patch);
          }
          throw new Error(
            `fakeDataSourceWithMessageRepo: unexpected update(${String(Entity)})`,
          );
        },
      };
      return cb(manager);
    });
    return { transaction } as unknown as DataSource;
  }

  it('with a systemChunk: writes the durable stimuli row + ONE curated pill via writeSystemChunk — NO raw operator bubble', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const messageRows: TranscriptMessageEntity[] = [];
    const messagesRepo = fakeMessageRepoWithQueryBuilder(messageRows);
    const ds = fakeDataSourceWithMessageRepo(messagesRepo);
    const store = new StimulusStoreService(
      threads.repo,
      messagesRepo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

    const chunkKey = 'seed:q:job-9:q1';
    const seedRow: SeedRow = { label: 'Question answered', chunkKey };
    const rawBody = '<system_notice>Question answered: 42</system_notice>';

    const chat = await store.recordChatStimulus({
      orgId: 'T1',
      repoId: 'web',
      jobId: 'job-9',
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: 'job-9' },
      body: rawBody,
      systemChunk: seedRow,
      seedQuestionId: 'q1',
    });

    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]).toMatchObject({
      job_id: 'job-9',
      kind: 'chat',
      author_id: 'U-SYSTEM',
      meta: expect.objectContaining({ source: 'system_notice', chunkKey }),
    });
    expect(messageRows[0].text).toBe(seedRow.label);
    expect(messageRows[0].card).toBeUndefined();

    expect(chat).toMatchObject({
      jobId: 'job-9',
      deliveredQuestionIds: ['q1'],
    });
    expect(chat.message.type).toBe('seed');
  });

  it("with systemChunk 'skip': writes the durable stimuli row but NO transcript pill (the silent re-drive contract)", async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const messageRows: TranscriptMessageEntity[] = [];
    const messagesRepo = fakeMessageRepoWithQueryBuilder(messageRows);
    const ds = fakeDataSourceWithMessageRepo(messagesRepo);
    const store = new StimulusStoreService(
      threads.repo,
      messagesRepo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

    const chat = await store.recordChatStimulus({
      orgId: 'T1',
      repoId: 'web',
      jobId: 'job-9',
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: 'job-9' },
      body: '<system_notice>Please continue with the current task: "X".</system_notice>',
      systemChunk: 'skip',
    });

    expect(messageRows).toHaveLength(0);
    expect(chat.message.type).toBe('seed');
    expect(chat).toMatchObject({ jobId: 'job-9' });
  });

  it('the curated pill is DEDUPED on chunkKey — a second seed with the same key writes NO additional message row', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const stimuli = fakeRepo<InboundMessageEntity>('stim');
    const messageRows: TranscriptMessageEntity[] = [];
    const messagesRepo = fakeMessageRepoWithQueryBuilder(messageRows);
    const ds = fakeDataSourceWithMessageRepo(messagesRepo);
    const store = new StimulusStoreService(
      threads.repo,
      messagesRepo,
      stimuli.repo,
      ds,
      makeBootstrap(),
    );

    const chunkKey = 'seed:q:job-9:q1';
    const seedRow: SeedRow = { label: 'Question answered', chunkKey };
    const input = {
      orgId: 'T1',
      repoId: 'web',
      jobId: 'job-9',
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: 'job-9' },
      body: '<system_notice>Question answered: 42</system_notice>',
      systemChunk: seedRow,
      seedQuestionId: 'q1',
    };

    const first = await store.recordChatStimulus(input);
    const second = await store.recordChatStimulus(input);

    expect(first.id).not.toBe(second.id);
    expect(messageRows).toHaveLength(1);
  });

  it('rowToChatStimulus (via findChatStimulusById) round-trips seedQuestionId/seedSecretId/seedFileId/seed through reply_route', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const row = {
      id: 'stim-42',
      org_id: 'T1',
      repo_id: 'web',
      job_id: 'thread-9',
      kind: 'chat',
      trust: 'trusted',
      body: '<system_notice>answered</system_notice>',
      author_id: SYSTEM_SEED_AUTHOR.id,
      author_name: SYSTEM_SEED_AUTHOR.name,
      reply_route: {
        surfaceId: 'web',
        jobRef: 'thread-9',
        seedQuestionId: 'q1',
        seedSecretId: 's1',
        seedFileId: 'f1',
      },
      created_at: new Date(),
    } as unknown as InboundMessageEntity;
    const stimuliRepo = {
      findOne: vi.fn().mockResolvedValue(row),
    } as unknown as Repository<InboundMessageEntity>;
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuliRepo,
      {} as unknown as DataSource,
      makeBootstrap(),
    );

    const chat = await store.findChatStimulusById('stim-42');

    expect(chat).toMatchObject({
      id: 'stim-42',
      jobId: 'thread-9',
      deliveredQuestionIds: ['q1'],
      deliveredSecretIds: ['s1'],
      deliveredFileIds: ['f1'],
    });
  });

  it('rowToChatStimulus: an operator row (author_id != U-SYSTEM) round-trips NO seed metadata and seed:undefined', async () => {
    const threads = fakeRepo<JobEntity>('thread');
    const messages = fakeRepo<TranscriptMessageEntity>('msg');
    const row = {
      id: 'stim-43',
      org_id: 'T1',
      repo_id: 'web',
      job_id: 'thread-9',
      kind: 'chat',
      trust: 'trusted',
      body: 'a plain operator message',
      author_id: 'U1',
      author_name: 'Dennis',
      reply_route: { surfaceId: 'web', jobRef: 'thread-9' },
      created_at: new Date(),
    } as unknown as InboundMessageEntity;
    const stimuliRepo = {
      findOne: vi.fn().mockResolvedValue(row),
    } as unknown as Repository<InboundMessageEntity>;
    const store = new StimulusStoreService(
      threads.repo,
      messages.repo,
      stimuliRepo,
      {} as unknown as DataSource,
      makeBootstrap(),
    );

    const chat = await store.findChatStimulusById('stim-43');

    expect(chat?.deliveredQuestionIds).toBeUndefined();
    expect(chat?.deliveredSecretIds).toBeUndefined();
    expect(chat?.deliveredFileIds).toBeUndefined();
    expect(chat?.message.type).toBe('user');
  });
});
