import { firstValueFrom } from 'rxjs';
import { take, toArray } from 'rxjs/operators';
import { describe, expect, it, vi } from 'vitest';
import { AtlasSlackSurface } from './atlas-slack-surface';
import type { SlackWebClientLike } from './slack.tokens';

function fakeWeb(): { client: SlackWebClientLike; posts: Array<Record<string, unknown>>; reacts: unknown[] } {
  const posts: Array<Record<string, unknown>> = [];
  const reacts: unknown[] = [];
  const client: SlackWebClientLike = {
    chat: {
      postMessage: vi.fn(async (args) => {
        posts.push(args as Record<string, unknown>);
        return { ts: `ts-${posts.length}`, ok: true };
      }),
    },
    reactions: {
      add: vi.fn(async (args) => {
        reacts.push({ kind: 'add', ...args });
      }),
      remove: vi.fn(async (args) => {
        reacts.push({ kind: 'remove', ...args });
      }),
    },
    auth: { test: vi.fn(async () => ({ user_id: 'UBOT', team_id: 'T1' })) },
  };
  return { client, posts, reacts };
}

describe('AtlasSlackSurface — thread-aware (vs v1 top-level-only)', () => {
  it('post() threads via thread_ts and returns the posted ts', async () => {
    const { client, posts } = fakeWeb();
    const surface = new AtlasSlackSurface(client, undefined);

    const rootTs = await surface.post('C1', 'announce');
    expect(rootTs).toBe('ts-1');
    expect(posts[0]).toEqual({ channel: 'C1', text: 'announce' }); // top-level: NO thread_ts

    const replyTs = await surface.post('C1', 'in thread', { threadTs: rootTs });
    expect(replyTs).toBe('ts-2');
    expect(posts[1]).toEqual({ channel: 'C1', text: 'in thread', thread_ts: 'ts-1' });
  });

  it('post() returns undefined when no Web client is bound', async () => {
    const surface = new AtlasSlackSurface(undefined, undefined);
    expect(await surface.post('C1', 'x')).toBeUndefined();
    expect(surface.available).toBe(false);
  });

  it('inbound KEEPS thread replies and carries threadTs (the v1 fix)', async () => {
    const surface = new AtlasSlackSurface(undefined, undefined);
    const collected = firstValueFrom(surface.inbound$.pipe(take(2), toArray()));

    // A top-level message: thread_ts absent → threadTs undefined.
    surface.emitInbound(
      { type: 'message', user: 'U1', channel: 'C1', ts: '100.1', text: 'top level' },
      'T1',
    );
    // A thread reply: thread_ts !== ts → threadTs carried (v1 would DROP this).
    surface.emitInbound(
      { type: 'message', user: 'U1', channel: 'C1', ts: '101.2', thread_ts: '100.1', text: 'reply' },
      'T1',
    );

    const msgs = await collected;
    expect(msgs[0].threadTs).toBeUndefined();
    expect(msgs[0].text).toBe('top level');
    expect(msgs[1].threadTs).toBe('100.1');
    expect(msgs[1].text).toBe('reply');
    expect(msgs[1].channel).toBe('C1');
  });

  it('inbound drops own/bot/subtype/empty messages (echo-loop guard)', async () => {
    const { client } = fakeWeb();
    const surface = new AtlasSlackSurface(client, undefined);
    await surface.connect(); // resolves selfUserId = UBOT (no socket → inert inbound)

    const emitted: string[] = [];
    surface.inbound$.subscribe((m) => emitted.push(m.id));

    surface.emitInbound({ type: 'message', user: 'UBOT', channel: 'C', ts: '1', text: 'self' }, 'T1');
    surface.emitInbound({ type: 'message', bot_id: 'B1', channel: 'C', ts: '2', text: 'bot' }, 'T1');
    surface.emitInbound({ type: 'message', subtype: 'channel_join', user: 'U', channel: 'C', ts: '3' }, 'T1');
    surface.emitInbound({ type: 'message', user: 'U2', channel: 'C', ts: '4', text: '   ' }, 'T1');
    surface.emitInbound({ type: 'message', user: 'U2', channel: 'C', ts: '5', text: 'real' }, 'T1');

    expect(emitted).toEqual(['5']);
  });

  it('react() maps unicode → shortcode and swallows already_reacted', async () => {
    const { client, reacts } = fakeWeb();
    const surface = new AtlasSlackSurface(client, undefined);
    await surface.react('C1', 'ts-1', '🚀');
    expect(reacts[0]).toEqual({ kind: 'add', channel: 'C1', timestamp: 'ts-1', name: 'rocket' });

    (client.reactions.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      data: { error: 'already_reacted' },
    });
    await expect(surface.react('C1', 'ts-1', '🚀')).resolves.toBeUndefined();
  });
});
