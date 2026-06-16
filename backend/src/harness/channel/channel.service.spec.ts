import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { ChannelMessage } from '@workspace/shared/schemas';
import type { EnvService } from '@core/config/env/env.service';
import { ChannelService } from './channel.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ChannelService with a stubbed repo (no Postgres) for pure in-memory tests. */
function buildService(opts: { surfaceId?: string } = {}): ChannelService {
  const repo = {
    query: vi.fn().mockResolvedValue([]), // onModuleInit hydration no-ops
    upsert: vi.fn().mockResolvedValue(undefined),
  } as unknown as Repository<ChannelMessage>;
  const env = {
    get: (key: string) => {
      if (key === 'HARNESS_SURFACE_ID') return opts.surfaceId ?? 'tui:main';
      return undefined;
    },
  } as unknown as EnvService;
  const svc = new ChannelService(repo, env);
  // Skip the real onModuleInit (would hit the mocked DB; fine but noisy).
  return svc;
}

function appendMsg(
  svc: ChannelService,
  text: string,
  channelId?: string,
): ReturnType<ChannelService['append']> {
  return svc.append({
    id: `msg-${Math.random().toString(36).slice(2)}`,
    author: 'dennis',
    authorId: 'dennis',
    text,
    ...(channelId ? { channelId } : {}),
  });
}

// ---------------------------------------------------------------------------
// since() monotonicity
// ---------------------------------------------------------------------------

describe('ChannelService.since() — cursor monotonicity', () => {
  it('returns only messages with seq >= cursor', () => {
    const svc = buildService();
    const m0 = appendMsg(svc, 'hello');   // seq 0
    const m1 = appendMsg(svc, 'world');   // seq 1
    const m2 = appendMsg(svc, 'third');   // seq 2

    // cursor at 1 → only m1 and m2
    const result = svc.since(1);
    expect(result.map((m) => m.seq)).toEqual([m1.seq, m2.seq]);
    expect(result.every((m) => m.seq >= 1)).toBe(true);

    // cursor at 0 → all three
    expect(svc.since(0)).toHaveLength(3);

    // cursor at nextSeq → nothing
    expect(svc.since(m2.seq + 1)).toHaveLength(0);

    // seq is exact: since(2) includes m2
    expect(svc.since(2).map((m) => m.seq)).toEqual([m2.seq]);

    // double-check assignments are monotonically increasing
    expect(m0.seq).toBe(0);
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
  });

  it('cursor at 0 always returns all messages (no false exclusions)', () => {
    const svc = buildService();
    appendMsg(svc, 'a');
    appendMsg(svc, 'b');
    appendMsg(svc, 'c');
    expect(svc.since(0)).toHaveLength(3);
  });

  it('each room maintains its own independent seq space', () => {
    const svc = buildService();
    // room-a gets two messages; room-b gets one
    const a0 = appendMsg(svc, 'a-first',  'room-a');
    const a1 = appendMsg(svc, 'a-second', 'room-a');
    const b0 = appendMsg(svc, 'b-first',  'room-b');

    // room-a seqs start at 0
    expect(a0.seq).toBe(0);
    expect(a1.seq).toBe(1);
    // room-b seqs ALSO start at 0 (independent space)
    expect(b0.seq).toBe(0);

    // since() is scoped per room
    expect(svc.since(1, 'room-a').map((m) => m.seq)).toEqual([1]);
    expect(svc.since(0, 'room-b')).toHaveLength(1);
    expect(svc.since(1, 'room-b')).toHaveLength(0);
  });

  it('seq is strictly monotonically increasing — each append increments nextSeq', () => {
    const svc = buildService();
    const seqs = [0, 1, 2, 3, 4].map((i) => appendMsg(svc, `msg-${i}`).seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    // nextSeq (via lengthOf) always equals the next seq to be assigned
    expect(svc.lengthOf()).toBe(5);
  });

  it('a re-emitted (streaming-update) message preserves its original seq — no rewind', () => {
    const svc = buildService();
    const original = svc.append({
      id: 'stream-1',
      author: 'alex',
      authorId: 'alex',
      authorBotId: 'alex',
      text: 'partial output',
    });
    const seqBefore = original.seq;

    // Re-emit the same id with updated text (streaming edit)
    const updated = svc.append({
      id: 'stream-1',
      author: 'alex',
      authorId: 'alex',
      authorBotId: 'alex',
      text: 'complete output',
    });

    // seq must not change — the update is in-place, not a new slot
    expect(updated.seq).toBe(seqBefore);
    // nextSeq must not advance past 1 (one message was ever created)
    expect(svc.lengthOf()).toBe(1);

    // since(0) still returns exactly one message
    const msgs = svc.since(0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('complete output');
    expect(msgs[0].seq).toBe(seqBefore);
  });
});
