import { describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { Repository } from 'typeorm';
import type { AtlasChannel, AtlasThread } from '../persistence/entities';
import type { ChatSurface, InboundChatMessage } from '../surface';
import { ChatStimulusBridge } from './chat-stimulus.bridge';
import type { StimulusIntake } from './stimulus-intake.service';
import type { ChatStimulus } from '../domain';

function fakeChannels(rows: AtlasChannel[]): Repository<AtlasChannel> {
  return {
    findOne: async (opts: { where: { team_id: string; surface_channel_ref: string } }) =>
      rows.find(
        (c) =>
          c.team_id === opts.where.team_id &&
          c.surface_channel_ref === opts.where.surface_channel_ref,
      ) ?? null,
  } as unknown as Repository<AtlasChannel>;
}

function fakeThreads(initial: AtlasThread[]): {
  repo: Repository<AtlasThread>;
  rows: AtlasThread[];
} {
  const rows = [...initial];
  let seq = initial.length;
  const repo = {
    findOne: async (opts: {
      where: { team_id: string; project_id: string; surface_thread_ref: string };
    }) =>
      rows.find(
        (t) =>
          t.team_id === opts.where.team_id &&
          t.project_id === opts.where.project_id &&
          t.surface_thread_ref === opts.where.surface_thread_ref,
      ) ?? null,
    create: (data: Partial<AtlasThread>) => ({ ...data }) as AtlasThread,
    save: async (t: AtlasThread) => {
      const saved = { ...t, id: `thread-${++seq}` } as AtlasThread;
      rows.push(saved);
      return saved;
    },
  } as unknown as Repository<AtlasThread>;
  return { repo, rows };
}

const channel = (over: Partial<AtlasChannel> = {}): AtlasChannel =>
  ({
    id: 'c1',
    team_id: 'T1',
    project_id: 'web',
    surface_channel_ref: 'C042',
    display_name: 'web',
    ...over,
  }) as AtlasChannel;

function makeBridge(opts: {
  channels: AtlasChannel[];
  threads: AtlasThread[];
}): {
  bridge: ChatStimulusBridge;
  intaken: ChatStimulus[];
  surface: ChatSurface;
  inbound$: Subject<InboundChatMessage>;
  threadRows: AtlasThread[];
} {
  const intaken: ChatStimulus[] = [];
  const intake = {
    intakeChat: vi.fn(async (s: ChatStimulus) => void intaken.push(s)),
  } as unknown as StimulusIntake;
  const inbound$ = new Subject<InboundChatMessage>();
  const surface = {
    name: 'slack',
    inbound$: inbound$.asObservable(),
    post: vi.fn(),
    react: vi.fn(),
    unreact: vi.fn(),
  } as unknown as ChatSurface;
  const { repo: threadRepo, rows: threadRows } = fakeThreads(opts.threads);
  const bridge = new ChatStimulusBridge(surface, intake, fakeChannels(opts.channels), threadRepo);
  return { bridge, intaken, surface, inbound$, threadRows };
}

const msg = (over: Partial<InboundChatMessage> = {}): InboundChatMessage => ({
  id: '100.1',
  authorId: 'U1',
  authorName: 'Dennis',
  text: 'hey atlas',
  teamId: 'T1',
  channel: 'C042',
  ts: new Date(),
  ...over,
});

describe('ChatStimulusBridge → ChatStimulus', () => {
  it('ignores a message in an unregistered channel', async () => {
    const { bridge, intaken } = makeBridge({ channels: [channel()], threads: [] });
    await bridge.onInbound(msg({ channel: 'CXXX' }));
    expect(intaken).toHaveLength(0);
  });

  it('a top-level message OPENS a chat-origin thread keyed by its own ts', async () => {
    const { bridge, intaken, threadRows } = makeBridge({ channels: [channel()], threads: [] });
    await bridge.onInbound(msg({ id: '100.1' })); // no threadTs
    expect(threadRows).toHaveLength(1);
    expect(threadRows[0]).toMatchObject({ origin: 'chat', surface_thread_ref: '100.1', project_id: 'web' });
    expect(intaken[0]).toMatchObject({
      kind: 'chat',
      trust: 'trusted',
      projectId: 'web',
      author: { id: 'U1', displayName: 'Dennis' },
    });
    expect(intaken[0].replyRoute).toEqual({ surfaceId: 'slack', threadRef: '100.1' });
  });

  it('a reply CONTINUES the existing thread (matched by surface_thread_ref) — no new thread', async () => {
    const existing = {
      id: 'thread-7',
      team_id: 'T1',
      project_id: 'web',
      origin: 'event',
      surface_thread_ref: '50.0',
      title: 'CI failure',
    } as AtlasThread;
    const { bridge, intaken, threadRows } = makeBridge({ channels: [channel()], threads: [existing] });

    await bridge.onInbound(msg({ id: '60.1', threadTs: '50.0', text: "I'm on it" }));
    expect(threadRows).toHaveLength(1); // no new thread created
    expect(intaken[0]).toMatchObject({ threadId: 'thread-7', body: "I'm on it" });
    expect(intaken[0].replyRoute.threadRef).toBe('50.0');
  });
});
