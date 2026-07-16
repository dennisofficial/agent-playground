import { describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { Repository } from 'typeorm';
import type { JobEntity } from '../persistence/entities';
import type {
  ChatSurface,
  InboundChatMessage,
} from '../surface/chat-surface.port';
import { ChatStimulusBridge } from './chat-stimulus.bridge';
import type { StimulusIntake } from './stimulus-intake.service';
import type { EventMessage, Message, SeedRow } from '../domain';

type IntakeCall = {
  message: Exclude<Message, EventMessage>;
  transport: {
    author: { id: string; displayName: string };
    replyRoute: { surfaceId: string; jobRef: string };
  };
};

type LegacySeedCall = {
  input: {
    orgId: string;
    repoId: string;
    jobId: string;
    body: string;
    seedRow?: SeedRow;
    seedQuestionId?: string;
    seedFileId?: string;
    seedSecretId?: string;
    seedQuestionIds?: string[];
    seedFileIds?: string[];
    seedSecretIds?: string[];
    priority?: 'now' | 'queue' | 'later';
    card?: Record<string, unknown>;
  };
  transport: {
    author: { id: string; displayName: string };
    replyRoute: { surfaceId: string; jobRef: string };
  };
};

function fakeThreads(initial: JobEntity[]): {
  repo: Repository<JobEntity>;
  rows: JobEntity[];
} {
  const rows = [...initial];
  let seq = initial.length;
  const repo = {
    findOne: async (opts: { where: { id: string } }) =>
      rows.find((t) => t.id === opts.where.id) ?? null,
    create: (data: Partial<JobEntity>) => ({ ...data }) as JobEntity,
    save: async (t: JobEntity) => {
      const saved = { ...t, id: t.id ?? `thread-${++seq}` } as JobEntity;
      rows.push(saved);
      return saved;
    },
  } as unknown as Repository<JobEntity>;
  return { repo, rows };
}

function makeBridge(threads: JobEntity[]): {
  bridge: ChatStimulusBridge;
  calls: IntakeCall[];
  legacySeedCalls: LegacySeedCall[];
  threadRows: JobEntity[];
} {
  const calls: IntakeCall[] = [];
  const legacySeedCalls: LegacySeedCall[] = [];
  const intake = {
    intakeChat: vi.fn(
      async (
        message: IntakeCall['message'],
        transport: IntakeCall['transport'],
      ) => void calls.push({ message, transport }),
    ),
    intakeLegacySeed: vi.fn(
      async (
        input: LegacySeedCall['input'],
        transport: LegacySeedCall['transport'],
      ) => void legacySeedCalls.push({ input, transport }),
    ),
  } as unknown as StimulusIntake;
  const inbound$ = new Subject<InboundChatMessage>();
  const surface = {
    name: 'web',
    inbound$: inbound$.asObservable(),
    post: vi.fn(),
  } as unknown as ChatSurface;
  const { repo, rows } = fakeThreads(threads);
  const bridge = new ChatStimulusBridge(surface, intake, repo);
  return { bridge, calls, legacySeedCalls, threadRows: rows };
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

describe('ChatStimulusBridge → Message', () => {
  it('ignores a message with no org/repo coordinate', async () => {
    const { bridge, calls } = makeBridge([]);
    await bridge.onInbound(msg({ orgId: '', channel: '' }));
    expect(calls).toHaveLength(0);
  });

  it('an unaddressed message OPENS a chat-origin thread on the repo', async () => {
    const { bridge, calls, threadRows } = makeBridge([]);
    await bridge.onInbound(msg({})); // no threadTs
    expect(threadRows).toHaveLength(1);
    expect(threadRows[0]).toMatchObject({ origin: 'chat', repo_id: 'web' });
    expect(calls[0].message).toMatchObject({
      type: 'user',
      trust: 'trusted',
      repoId: 'web',
      author: { id: 'U1', displayName: 'Dennis' },
    });
    expect(calls[0].transport.replyRoute).toEqual({
      surfaceId: 'web',
      jobRef: threadRows[0].id,
    });
  });

  it('a message addressing an existing thread CONTINUES it (no new thread)', async () => {
    const existing = {
      id: 'thread-7',
      org_id: 'T1',
      repo_id: 'web',
      origin: 'control',
      surface_thread_ref: null,
      title: null,
    } as JobEntity;
    const { bridge, calls, threadRows } = makeBridge([existing]);

    await bridge.onInbound(msg({ threadTs: 'thread-7', text: "I'm on it" }));
    expect(threadRows).toHaveLength(1); // no new thread created
    expect(calls[0].message).toMatchObject({
      type: 'user',
      jobId: 'thread-7',
      body: "I'm on it",
    });
    expect(calls[0].transport.replyRoute.jobRef).toBe('thread-7');
  });

  it('a seed inbound routes through the legacy generic-seed intake path', async () => {
    const existing = {
      id: 'thread-7',
      org_id: 'T1',
      repo_id: 'web',
      origin: 'event',
      surface_thread_ref: null,
      title: null,
    } as JobEntity;
    const { bridge, calls, legacySeedCalls } = makeBridge([existing]);

    const seedRow = {
      label: 'Question answered',
      chunkKey: 'seed:q:thread-7:q1',
    };
    await bridge.onInbound(
      msg({
        threadTs: 'thread-7',
        text: 'answer',
        seed: true,
        seedQuestionId: 'q1',
        seedRow,
      }),
    );
    expect(calls).toHaveLength(0); // seed inbound bypasses intakeChat entirely
    expect(legacySeedCalls[0].input).toMatchObject({
      jobId: 'thread-7',
      body: 'answer',
      seedRow,
      seedQuestionId: 'q1',
    });
    expect(legacySeedCalls[0].transport.replyRoute).toEqual({
      surfaceId: 'web',
      jobRef: 'thread-7',
    });
  });
});
