import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptMessageEntity } from '../persistence/entities';
import { parseSessionTranscriptTurns } from './session-transcript';
import { backfillThreadFromTurns } from './turn-backfill';

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
type Row = Partial<TranscriptMessageEntity>;

/** A turn: prompt → text → a PAIRED tool → an UNPAIRED (interrupted) tool. `T*` timestamps let us assert
 *  created_at ordering. No end_turn — back-fill doesn't gate on it (the caller decides which turns to pass). */
const TURN = [
  line({
    type: 'user',
    uuid: 'p1',
    sessionId: 's',
    message: { role: 'user', content: 'go' },
  }),
  line({
    type: 'assistant',
    uuid: 'b-text',
    sessionId: 's',
    timestamp: '2026-06-30T12:00:01.000Z',
    message: { content: [{ type: 'text', text: 'hi there' }] },
  }),
  line({
    type: 'assistant',
    uuid: 'b-read',
    sessionId: 's',
    timestamp: '2026-06-30T12:00:02.000Z',
    message: {
      content: [{ type: 'tool_use', id: 'tr', name: 'Read', input: {} }],
    },
  }),
  line({
    type: 'user',
    uuid: 'b-res',
    sessionId: 's',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tr',
          content: 'ok',
          is_error: false,
        },
      ],
    },
  }),
  line({
    type: 'assistant',
    uuid: 'b-ask',
    sessionId: 's',
    timestamp: '2026-06-30T12:00:03.000Z',
    message: {
      content: [{ type: 'tool_use', id: 'ta', name: 'ask_question', input: {} }],
    },
  }),
].join('\n');

const turnsOf = (jsonl = TURN) => parseSessionTranscriptTurns(jsonl).turns;

/** A messages-repo mock: `save` accumulates; `getCount` answers the final-reply-present query; `getRawMany`
 *  answers persistedSdkUuids (alias `u`) or persistedToolIds (alias `id`, kind='tool') by the select alias. */
function makeMessages(seed: Row[] = []) {
  const saved: Row[] = [...seed];
  const repo = {
    create: (r: Row) => r,
    save: vi.fn(async (r: Row) => {
      saved.push(r);
      return r;
    }),
    createQueryBuilder: () => {
      const params: Record<string, unknown> = {};
      let alias = '';
      const qb: Record<string, unknown> = {};
      qb.select = (_expr: string, a: string) => {
        alias = a;
        return qb;
      };
      qb.where = (_c: unknown, p?: Record<string, unknown>) => {
        if (p) Object.assign(params, p);
        return qb;
      };
      qb.andWhere = (_c: unknown, p?: Record<string, unknown>) => {
        if (p) Object.assign(params, p);
        return qb;
      };
      qb.getCount = async () => {
        const needle = String(params.needle ?? '');
        return saved.filter(
          (r) =>
            r.author_id === 'atlas' &&
            typeof r.text === 'string' &&
            needle &&
            r.text.includes(needle),
        ).length;
      };
      qb.getRawMany = async () => {
        if (alias === 'id')
          return saved
            .filter((r) => r.kind === 'tool' && (r.meta as { id?: string })?.id)
            .map((r) => ({ id: (r.meta as { id: string }).id }));
        return saved
          .filter((r) => (r.meta as { sdkUuid?: string })?.sdkUuid)
          .map((r) => ({ u: (r.meta as { sdkUuid: string }).sdkUuid }));
      };
      return qb;
    },
  } as unknown as Repository<TranscriptMessageEntity>;
  return { repo, saved };
}

describe('backfillThreadFromTurns', () => {
  it("inserts a turn's blocks, dropping the interrupted (unpaired) tool call", async () => {
    const { repo, saved } = makeMessages();
    const inserted = await backfillThreadFromTurns(repo, 'th', 'thread-1', turnsOf());
    expect(inserted).toBe(2);
    expect(saved.map((r) => (r.meta as { sdkUuid: string }).sdkUuid)).toEqual(['b-text', 'b-read']);
    expect(saved.map((r) => r.kind)).toEqual(['chat', 'tool']);
    expect(saved.every((r) => r.author_id === 'atlas')).toBe(true);
  });

  it('assigns strictly-increasing created_at seeded from the SDK timestamps', async () => {
    const { repo, saved } = makeMessages();
    await backfillThreadFromTurns(repo, 'th', 'thread-1', turnsOf());
    const times = saved.map((r) => (r.created_at as Date).getTime());
    expect(times).toEqual([
      Date.parse('2026-06-30T12:00:01.000Z'),
      Date.parse('2026-06-30T12:00:02.000Z'),
    ]);
    expect(times[1]).toBeGreaterThan(times[0]);
  });

  it('skips a whole turn whose final reply is already persisted', async () => {
    const { repo, saved } = makeMessages([{ author_id: 'atlas', text: 'hi there', kind: 'chat' }]);
    const inserted = await backfillThreadFromTurns(repo, 'th', 'thread-1', turnsOf());
    expect(inserted).toBe(0);
    expect(saved).toHaveLength(1); // only the seed
  });

  it('dedupes an individual block already present by sdkUuid (turn not skipped wholesale)', async () => {
    // Final reply 'done reading' is NOT seeded, so the turn is processed; the Read (sdkUuid 'b-read') is
    // already present, so only the text block lands.
    const jsonl = [
      line({
        type: 'user',
        uuid: 'p1',
        sessionId: 's',
        message: { role: 'user', content: 'go' },
      }),
      line({
        type: 'assistant',
        uuid: 'b-read',
        sessionId: 's',
        timestamp: '2026-06-30T12:00:01.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'tr', name: 'Read', input: {} }],
        },
      }),
      line({
        type: 'user',
        uuid: 'b-res',
        sessionId: 's',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tr', content: 'ok' }],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'b-text',
        sessionId: 's',
        timestamp: '2026-06-30T12:00:02.000Z',
        message: { content: [{ type: 'text', text: 'done reading' }] },
      }),
    ].join('\n');
    const { repo, saved } = makeMessages([
      {
        author_id: 'atlas',
        text: 'earlier',
        kind: 'tool',
        meta: { sdkUuid: 'b-read', id: 'tr' },
      },
    ]);
    const inserted = await backfillThreadFromTurns(
      repo,
      'th',
      'thread-1',
      parseSessionTranscriptTurns(jsonl).turns,
    );
    expect(inserted).toBe(1);
    expect(saved.slice(1).map((r) => (r.meta as { sdkUuid: string }).sdkUuid)).toEqual(['b-text']);
  });

  it('dedupes a tool block already persisted by SDK tool_use id (meta.id)', async () => {
    // Final reply differs from any seed so the turn is NOT skipped wholesale; the paired Read (id 'tr') is
    // already persisted, so only the text block is inserted.
    const jsonl = [
      line({
        type: 'user',
        uuid: 'p1',
        sessionId: 's',
        message: { role: 'user', content: 'go' },
      }),
      line({
        type: 'assistant',
        uuid: 'b-read',
        sessionId: 's',
        timestamp: '2026-06-30T12:00:01.000Z',
        message: {
          content: [{ type: 'tool_use', id: 'tr', name: 'Read', input: {} }],
        },
      }),
      line({
        type: 'user',
        uuid: 'b-res',
        sessionId: 's',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tr', content: 'ok' }],
        },
      }),
      line({
        type: 'assistant',
        uuid: 'b-text',
        sessionId: 's',
        timestamp: '2026-06-30T12:00:02.000Z',
        message: { content: [{ type: 'text', text: 'done reading' }] },
      }),
    ].join('\n');
    const { repo, saved } = makeMessages([
      { author_id: 'atlas', text: 'earlier', kind: 'tool', meta: { id: 'tr' } },
    ]);
    const inserted = await backfillThreadFromTurns(
      repo,
      'th',
      'thread-1',
      parseSessionTranscriptTurns(jsonl).turns,
    );
    expect(inserted).toBe(1);
    expect(saved.slice(1).map((r) => (r.meta as { sdkUuid: string }).sdkUuid)).toEqual(['b-text']);
  });

  it('is idempotent — a second run inserts nothing', async () => {
    const { repo, saved } = makeMessages();
    expect(await backfillThreadFromTurns(repo, 'th', 'thread-1', turnsOf())).toBe(2);
    const afterFirst = saved.length;
    expect(await backfillThreadFromTurns(repo, 'th', 'thread-1', turnsOf())).toBe(0);
    expect(saved.length).toBe(afterFirst);
  });
});
