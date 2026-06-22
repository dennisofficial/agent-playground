import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ChatSurface, InboundChatMessage, PostOptions } from './chat-surface.port';
import { CompositeChatSurface } from './composite-chat-surface';

/** A minimal in-memory `ChatSurface` that records its outbound calls — the composite's dispatch target. */
class FakeSurface implements ChatSurface {
  readonly inboundSubject = new Subject<InboundChatMessage>();
  readonly posts: Array<{ channel: string; text: string; opts: PostOptions }> = [];
  readonly reactions: Array<{ kind: 'add' | 'remove'; emoji: string }> = [];
  connectCalls = 0;
  private seq = 0;

  constructor(
    readonly name: string,
    private readonly connectable = false,
  ) {
    if (connectable) {
      (this as unknown as { connect: () => Promise<void> }).connect = async () => {
        this.connectCalls += 1;
      };
    }
  }

  get inbound$() {
    return this.inboundSubject.asObservable();
  }

  async post(channel: string, text: string, opts: PostOptions = {}): Promise<string | undefined> {
    this.posts.push({ channel, text, opts });
    this.seq += 1;
    return `${this.name}-ts-${this.seq}`;
  }

  async react(_channel: string, _ts: string, emoji: string): Promise<void> {
    this.reactions.push({ kind: 'add', emoji });
  }

  async unreact(_channel: string, _ts: string, emoji: string): Promise<void> {
    this.reactions.push({ kind: 'remove', emoji });
  }
}

function inbound(surface: string, text: string): InboundChatMessage {
  return {
    id: `${surface}-1`,
    authorId: 'U1',
    authorName: 'U1',
    text,
    teamId: 'T1',
    channel: 'C1',
    surface,
    ts: new Date(),
  };
}

describe('CompositeChatSurface', () => {
  it('throws when constructed with no adapters', () => {
    expect(() => new CompositeChatSurface([])).toThrow();
  });

  it('dispatches a post to the adapter named by opts.surfaceId', async () => {
    const slack = new FakeSurface('slack');
    const web = new FakeSurface('web');
    const composite = new CompositeChatSurface([slack, web]);

    const wts = await composite.post('C1', 'to web', { surfaceId: 'web' });
    const sts = await composite.post('C1', 'to slack', { surfaceId: 'slack' });

    expect(web.posts).toHaveLength(1);
    expect(web.posts[0].text).toBe('to web');
    expect(wts).toBe('web-ts-1');
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0].text).toBe('to slack');
    expect(sts).toBe('slack-ts-1');
  });

  it('falls back to the first enabled adapter when surfaceId is unset', async () => {
    const slack = new FakeSurface('slack');
    const web = new FakeSurface('web');
    const composite = new CompositeChatSurface([slack, web]);

    await composite.post('C1', 'no surface');

    expect(slack.posts).toHaveLength(1); // slack is first → the default
    expect(web.posts).toHaveLength(0);
  });

  it('falls back to the default adapter when surfaceId matches no enabled adapter', async () => {
    const slack = new FakeSurface('slack');
    const web = new FakeSurface('web');
    const composite = new CompositeChatSurface([slack, web]);

    await composite.post('C1', 'legacy row', { surfaceId: 'gone' });

    expect(slack.posts).toHaveLength(1);
    expect(web.posts).toHaveLength(0);
  });

  it('routes to the sole adapter regardless of surfaceId (single-surface boot)', async () => {
    const agent = new FakeSurface('agent');
    const composite = new CompositeChatSurface([agent]);

    await composite.post('C1', 'a', { surfaceId: 'slack' }); // surface not enabled → sole adapter
    await composite.post('C1', 'b');

    expect(agent.posts.map((p) => p.text)).toEqual(['a', 'b']);
  });

  it('merges inbound from every enabled adapter (each carrying its surface tag)', () => {
    const slack = new FakeSurface('slack');
    const web = new FakeSurface('web');
    const composite = new CompositeChatSurface([slack, web]);

    const seen: Array<{ surface: string | undefined; text: string }> = [];
    composite.inbound$.subscribe((m) => seen.push({ surface: m.surface, text: m.text }));

    slack.inboundSubject.next(inbound('slack', 'hi from slack'));
    web.inboundSubject.next(inbound('web', 'hi from web'));

    expect(seen).toEqual([
      { surface: 'slack', text: 'hi from slack' },
      { surface: 'web', text: 'hi from web' },
    ]);
  });

  it('connect() fans out to adapters that expose connect()', async () => {
    const slack = new FakeSurface('slack', true);
    const web = new FakeSurface('web', false); // no connect()
    const composite = new CompositeChatSurface([slack, web]);

    await composite.connect();

    expect(slack.connectCalls).toBe(1);
  });

  it('exposes the enabled adapter names in order via surfaceNames', () => {
    const composite = new CompositeChatSurface([
      new FakeSurface('slack'),
      new FakeSurface('web'),
    ]);
    expect(composite.surfaceNames).toEqual(['slack', 'web']);
    expect(composite.name).toBe('composite');
  });

  it('react/unreact route to the default adapter (no surface-aware callers today)', async () => {
    const slack = new FakeSurface('slack');
    const web = new FakeSurface('web');
    const composite = new CompositeChatSurface([slack, web]);

    await composite.react('C1', 'ts1', '👍');
    await composite.unreact('C1', 'ts1', '👍');

    expect(slack.reactions).toEqual([
      { kind: 'add', emoji: '👍' },
      { kind: 'remove', emoji: '👍' },
    ]);
    expect(web.reactions).toHaveLength(0);
  });

  it('update() dispatches to the default adapter when it supports update', () => {
    const slack = new FakeSurface('slack');
    const update = vi.fn();
    (slack as unknown as { update: typeof update }).update = update;
    const composite = new CompositeChatSurface([slack]);

    composite.update('C1', 'ts1', { text: 'edited' });

    expect(update).toHaveBeenCalledWith('C1', 'ts1', { text: 'edited' }, undefined);
  });
});
