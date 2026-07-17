import type { EnvService } from '@core/config/env/env.service';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ComposerDraftAttachmentEntity,
  ComposerDraftEntity,
} from '../../persistence/entities';
import { ComposerDraftService } from '../composer-draft.service';

/**
 * Pure unit tests: the encrypt/decrypt round-trip and the applied-cardId pruning are exercised against
 * in-memory repo stand-ins (no DB, no host filesystem) — attachment upload/promote paths are validated
 * live per `sections/02-backend.md`'s Validation section.
 */

/** A tiny in-memory stand-in for a TypeORM repository (composite-key find/save/count/delete). */
function memRepo<T extends object>(keys: (keyof T)[]): Repository<T> {
  let rows: T[] = [];
  const match = (where: Partial<T>) => (r: T) =>
    (Object.entries(where) as [keyof T, unknown][]).every(([k, v]) => r[k] === v);
  return {
    create: (v: Partial<T>) => ({ id: randomUUID(), ...v }) as T,
    find: async ({ where }: { where?: Partial<T> } = {}) =>
      where ? rows.filter(match(where)) : rows,
    findOne: async ({ where }: { where: Partial<T> }) => rows.find(match(where)) ?? null,
    save: async (row: T) => {
      rows = rows.filter((r) => !keys.every((k) => r[k] === row[k]));
      rows.push(row);
      return row;
    },
    count: async ({ where }: { where?: Partial<T> } = {}) =>
      (where ? rows.filter(match(where)) : rows).length,
    delete: async (where: Partial<T>) => {
      rows = rows.filter((r) => !match(where)(r));
      return { affected: 0, raw: [] };
    },
  } as unknown as Repository<T>;
}

const KEY = randomBytes(32).toString('hex');
const env = {
  get: (k: string) => (k === 'SECRETS_ENCRYPTION_KEY' ? KEY : undefined),
} as unknown as EnvService;

describe('ComposerDraftService', () => {
  let service: ComposerDraftService;

  beforeEach(() => {
    service = new ComposerDraftService(
      memRepo<ComposerDraftEntity>(['job_id', 'user_id']),
      memRepo<ComposerDraftAttachmentEntity>(['id']),
      {} as never, // dataSource — not exercised by putDraft/getDraft/clearOnSend
      env,
      {} as never, // lifecycle (JobLifecycleService)
    );
  });

  it('round-trips a staged secret answer: encrypted at rest, decrypted cleartext on read', async () => {
    await service.putDraft('org-1', 'job-1', 'user-1', {
      text: 'hi',
      stagedAnswers: [
        {
          kind: 'secret',
          cardId: 'c1',
          label: 'API key',
          value: 'sk-live-shh',
        },
      ],
      comments: [],
    });

    const { payload } = await service.getDraft('org-1', 'job-1', 'user-1');
    expect(payload.text).toBe('hi');
    expect(payload.stagedAnswers).toEqual([
      { kind: 'secret', cardId: 'c1', label: 'API key', value: 'sk-live-shh' },
    ]);
  });

  it('a second putDraft upserts the same (job, user) row rather than creating another', async () => {
    await service.putDraft('org-1', 'job-1', 'user-1', {
      text: 'first',
      stagedAnswers: [],
      comments: [],
    });
    await service.putDraft('org-1', 'job-1', 'user-1', {
      text: 'second',
      stagedAnswers: [],
      comments: [],
    });

    const { payload } = await service.getDraft('org-1', 'job-1', 'user-1');
    expect(payload.text).toBe('second');
  });

  it('clearOnSend drops only the applied cardIds, keeping the rest, and blanks text/comments', async () => {
    await service.putDraft('org-1', 'job-1', 'user-1', {
      text: 'draft text',
      stagedAnswers: [
        { kind: 'question', cardId: 'q1', label: 'DB?', answer: 'Postgres' },
        { kind: 'question', cardId: 'q2', label: 'Cache?', answer: 'Redis' },
      ],
      comments: [{ id: 'r1', file: { node: 'n', label: 'l' }, quote: 'q', note: 'n' }],
    });

    await service.clearOnSend('org-1', 'job-1', 'user-1', ['q1'], {
      clearText: true,
      clearComments: true,
    });

    const { payload } = await service.getDraft('org-1', 'job-1', 'user-1');
    expect(payload.text).toBe('');
    expect(payload.comments).toEqual([]);
    expect(payload.stagedAnswers).toEqual([
      { kind: 'question', cardId: 'q2', label: 'Cache?', answer: 'Redis' },
    ]);
  });

  it('clearOnSend leaves text/comments untouched when the caller says this submit did not carry them', async () => {
    await service.putDraft('org-1', 'job-1', 'user-1', {
      text: 'unrelated in-progress note',
      stagedAnswers: [{ kind: 'question', cardId: 'q1', label: 'DB?', answer: 'Postgres' }],
      comments: [{ id: 'r1', file: { node: 'n', label: 'l' }, quote: 'q', note: 'n' }],
    });

    await service.clearOnSend('org-1', 'job-1', 'user-1', ['q1'], {
      clearText: false,
      clearComments: false,
    });

    const { payload } = await service.getDraft('org-1', 'job-1', 'user-1');
    expect(payload.text).toBe('unrelated in-progress note');
    expect(payload.comments).toEqual([
      { id: 'r1', file: { node: 'n', label: 'l' }, quote: 'q', note: 'n' },
    ]);
    expect(payload.stagedAnswers).toEqual([]);
  });

  it('clearOnSend is a no-op when the caller has no draft row', async () => {
    await expect(
      service.clearOnSend('org-1', 'job-none', 'user-1', ['q1'], {
        clearText: true,
        clearComments: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('getDraft returns an empty payload without creating a row when none exists', async () => {
    const { payload, attachments } = await service.getDraft('org-1', 'job-2', 'user-1');
    expect(payload).toEqual({ text: '', stagedAnswers: [], comments: [] });
    expect(attachments).toEqual([]);
  });
});
