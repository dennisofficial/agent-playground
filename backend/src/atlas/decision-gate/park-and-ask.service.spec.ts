import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatSurface,
  InboundChatMessage,
  PostOptions,
} from '../surface';
import { ParkAndAskService } from './park-and-ask.service';

/** A fake duplex surface: records posts, lets the test push inbound thread replies. */
class FakeSurface implements ChatSurface {
  readonly name = 'fake';
  readonly inbound$ = new Subject<InboundChatMessage>();
  readonly posts: Array<{ channel: string; text: string; opts?: PostOptions }> = [];
  private seq = 0;

  async post(channel: string, text: string, opts?: PostOptions): Promise<string | undefined> {
    this.posts.push({ channel, text, ...(opts ? { opts } : {}) });
    return `ts-${++this.seq}`;
  }
  async react(): Promise<void> {}
  async unreact(): Promise<void> {}

  /** Helper: simulate a human thread reply. */
  reply(channel: string, threadTs: string, text: string, authorId = 'U-human'): void {
    this.inbound$.next({
      id: `ts-reply-${++this.seq}`,
      authorId,
      authorName: 'Human',
      text,
      orgId: 'T1',
      channel,
      threadTs,
      ts: new Date(),
    });
  }
}

describe('ParkAndAskService', () => {
  let surface: FakeSurface;
  let svc: ParkAndAskService;

  beforeEach(() => {
    surface = new FakeSurface();
    svc = new ParkAndAskService(surface);
  });

  afterEach(() => {
    svc.onModuleDestroy();
  });

  it('posts the question into the provided thread and resolves on a human reply', async () => {
    const handle = await svc.ask(
      { channel: 'C1', threadTs: 'root-1' },
      'Should the cache be Redis or in-memory?',
    );

    // The question was posted into the thread.
    expect(surface.posts).toHaveLength(1);
    expect(surface.posts[0]?.channel).toBe('C1');
    expect(surface.posts[0]?.opts?.threadTs).toBe('root-1');
    expect(handle.threadTs).toBe('root-1');
    expect(handle.resolved).toBe(false);
    expect(svc.pending).toBe(1);

    // Human replies in the thread → the handle resolves with the reply.
    surface.reply('C1', 'root-1', 'Use Redis.');
    const resolution = await handle.answer;
    expect(resolution.text).toBe('Use Redis.');
    expect(resolution.authorId).toBe('U-human');
    expect(resolution.parkId).toBe(handle.id);
    expect(handle.resolved).toBe(true);
    expect(handle.resolution?.text).toBe('Use Redis.');
    expect(svc.pending).toBe(0);
  });

  it('seeds a NEW thread when no threadTs is given and binds to the seeded root', async () => {
    const handle = await svc.ask({ channel: 'C9' }, 'Which base branch?');
    // Top-level post (no threadTs opt); the returned ts becomes the thread root.
    expect(surface.posts[0]?.opts?.threadTs).toBeUndefined();
    expect(handle.questionTs).toBe('ts-1');
    expect(handle.threadTs).toBe('ts-1');

    surface.reply('C9', 'ts-1', 'main');
    await expect(handle.answer).resolves.toMatchObject({ text: 'main' });
  });

  it('ignores top-level messages and replies in OTHER threads', async () => {
    const handle = await svc.ask({ channel: 'C1', threadTs: 'root-1' }, 'q?');

    // A top-level message (no threadTs) is not an answer.
    surface.inbound$.next({
      id: 'x',
      authorId: 'U',
      authorName: 'n',
      text: 'unrelated',
      orgId: 'T1',
      channel: 'C1',
      ts: new Date(),
    });
    // A reply in a DIFFERENT thread is not an answer.
    surface.reply('C1', 'root-OTHER', 'nope');
    // A reply in a different CHANNEL is not an answer.
    surface.reply('C-other', 'root-1', 'nope');

    expect(handle.resolved).toBe(false);
    expect(svc.pending).toBe(1);

    // The correct thread reply resolves it.
    surface.reply('C1', 'root-1', 'yes');
    await expect(handle.answer).resolves.toMatchObject({ text: 'yes' });
  });

  it('routes concurrent parks on different threads independently', async () => {
    const a = await svc.ask({ channel: 'C1', threadTs: 'tA' }, 'A?');
    const b = await svc.ask({ channel: 'C1', threadTs: 'tB' }, 'B?');
    expect(svc.pending).toBe(2);

    surface.reply('C1', 'tB', 'answer-B');
    await expect(b.answer).resolves.toMatchObject({ text: 'answer-B' });
    expect(a.resolved).toBe(false);
    expect(svc.pending).toBe(1);

    surface.reply('C1', 'tA', 'answer-A');
    await expect(a.answer).resolves.toMatchObject({ text: 'answer-A' });
    expect(svc.pending).toBe(0);
  });

  it('cancel rejects a pending park', async () => {
    const handle = await svc.ask({ channel: 'C1', threadTs: 't' }, 'q?');
    svc.cancel(handle.id, 'section aborted');
    await expect(handle.answer).rejects.toThrow('section aborted');
    expect(svc.pending).toBe(0);
  });

  it('onModuleDestroy rejects still-parked questions (no hung awaits)', async () => {
    const handle = await svc.ask({ channel: 'C1', threadTs: 't' }, 'q?');
    svc.onModuleDestroy();
    await expect(handle.answer).rejects.toThrow(/shutting down/);
  });
});
