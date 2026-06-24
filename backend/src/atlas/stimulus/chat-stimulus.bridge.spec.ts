import { describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { Repository } from 'typeorm';
import type { AtlasThread } from '../persistence/entities';
import type { ChatSurface, InboundChatMessage } from '../surface';
import { ChatStimulusBridge } from './chat-stimulus.bridge';
import type { StimulusIntake } from './stimulus-intake.service';
import type { ChatStimulus } from '../domain';

function fakeThreads(initial: AtlasThread[]): {
  repo: Repository<AtlasThread>;
  rows: AtlasThread[];
} {
  const rows = [...initial];
  let seq = initial.length;
  const repo = {
    findOne: async (opts: { where: { id: string } }) =>
      rows.find((t) => t.id === opts.where.id) ?? null,
    create: (data: Partial<AtlasThread>) => ({ ...data }) as AtlasThread,
    save: async (t: AtlasThread) => {
      const saved = { ...t, id: t.id ?? `thread-${++seq}` } as AtlasThread;
      rows.push(saved);
      return saved;
    },
  } as unknown as Repository<AtlasThread>;
  return { repo, rows };
}

function makeBridge(threads: AtlasThread[]): {
  bridge: ChatStimulusBridge;
  intaken: ChatStimulus[];
  threadRows: AtlasThread[];
} {
  const intaken: ChatStimulus[] = [];
  const intake = {
    intakeChat: vi.fn(async (s: ChatStimulus) => void intaken.push(s)),
  } as unknown as StimulusIntake;
  const inbound$ = new Subject<InboundChatMessage>();
  const surface = {
    name: 'web',
    inbound$: inbound$.asObservable(),
    post: vi.fn(),
  } as unknown as ChatSurface;
  const { repo, rows } = fakeThreads(threads);
  const bridge = new ChatStimulusBridge(surface, intake, repo);
  return { bridge, intaken, threadRows: rows };
}

const msg = (over: Partial<InboundChatMessage> = {}): InboundChatMessage => ({
  id: '100.1',
  authorId: 'U1',
  authorName: 'Dennis',
  text: 'hey atlas',
  orgId: 'T1',
  channel: 'web', // channel carries repo_id
  ts: new Date(),
  ...over,
});

describe('ChatStimulusBridge → ChatStimulus', () => {
  it('ignores a message with no org/repo coordinate', async () => {
    const { bridge, intaken } = makeBridge([]);
    await bridge.onInbound(msg({ orgId: '', channel: '' }));
    expect(intaken).toHaveLength(0);
  });

  it('an unaddressed message OPENS a chat-origin thread on the repo', async () => {
    const { bridge, intaken, threadRows } = makeBridge([]);
    await bridge.onInbound(msg({})); // no threadTs
    expect(threadRows).toHaveLength(1);
    expect(threadRows[0]).toMatchObject({ origin: 'chat', repo_id: 'web' });
    expect(intaken[0]).toMatchObject({
      kind: 'chat',
      trust: 'trusted',
      repoId: 'web',
      author: { id: 'U1', displayName: 'Dennis' },
    });
    expect(intaken[0].replyRoute).toEqual({ surfaceId: 'web', threadRef: threadRows[0].id });
  });

  it('a message addressing an existing thread CONTINUES it (no new thread)', async () => {
    const existing = {
      id: 'thread-7',
      org_id: 'T1',
      repo_id: 'web',
      origin: 'control',
      surface_thread_ref: null,
      title: null,
    } as AtlasThread;
    const { bridge, intaken, threadRows } = makeBridge([existing]);

    await bridge.onInbound(msg({ threadTs: 'thread-7', text: "I'm on it" }));
    expect(threadRows).toHaveLength(1); // no new thread created
    expect(intaken[0]).toMatchObject({ threadId: 'thread-7', body: "I'm on it" });
    expect(intaken[0].replyRoute.threadRef).toBe('thread-7');
  });
});
