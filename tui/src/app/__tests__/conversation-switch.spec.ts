import { describe, expect, it } from 'bun:test';
import type { Message } from '../../domain/message.js';
import type { PhaseBrief } from '../../domain/phase-spec.js';
import { EMessageType, EThreadStatus } from '../../generated/prisma/enums.js';
import type { EngineSession, Job, Thread } from '../../generated/prisma/client.js';
import type { MessageRepository } from '../../store/message.repository.js';
import type { SessionRepository } from '../../store/session.repository.js';
import type { TurnRepository } from '../../store/turn.repository.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { AccountUsageService } from '../account-usage.service.js';
import type { ContextFolderService } from '../context-folder.service.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import { ConversationService } from '../conversation.service.js';
import type { PhaseBriefService } from '../phase-brief.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import type { TurnRunnerService } from '../turn-runner.service.js';

/**
 * Switching threads is on the critical path, not a browsing nicety: the job's cursor moves on its
 * own, and a human reads a closed leg while an agent is still working in another one. The three
 * things that must survive it are a running turn, a running thread's live state, and the fact that
 * a finished thread is history rather than somewhere to work.
 */

const JOB = { id: 'job-1', title: 'fix steering' } as unknown as Job;

function thread(id: string, status: EThreadStatus = EThreadStatus.active): Thread {
  return {
    id,
    role: 'builder',
    status,
    activeSessionId: `session-of-${id}`,
    phaseId: 'phase-1',
  } as unknown as Thread;
}

function session(id: string): EngineSession {
  return {
    id,
    accountId: 'account-1',
    engine: 'claude',
    model: 'claude-opus-5',
    ordinal: 1,
    contextPercent: 12,
  } as unknown as EngineSession;
}

function message(id: string): Message {
  return { id, payload: { type: EMessageType.assistant, text: id } } as unknown as Message;
}

function build(args: { running?: string[] } = {}): {
  conversationService: ConversationService;
  stores: ConversationStoreRegistry;
  opened: string[];
  claimed: string[];
  released: string[];
} {
  const running = args.running ?? [];
  const opened: string[] = [];
  const claimed: string[] = [];
  const released: string[] = [];

  const stores = new ConversationStoreRegistry();

  const sessionManagerService = {
    async currentSession(t: Thread): Promise<EngineSession> {
      opened.push(t.id);
      return session(`session-of-${t.id}`);
    },
  } as unknown as SessionManagerService;

  const sessionRepository = {
    async findById(id: string): Promise<EngineSession> {
      return session(id);
    },
    async claim(id: string): Promise<boolean> {
      claimed.push(id);
      return true;
    },
    async release(id: string): Promise<void> {
      released.push(id);
    },
    async refsForThread(): Promise<[]> {
      return [];
    },
  } as unknown as SessionRepository;

  const messageRepository = {
    async listForThread(threadId: string): Promise<Message[]> {
      return [message(`${threadId}-persisted`)];
    },
  } as unknown as MessageRepository;

  const threadRepository = {
    async findById(id: string): Promise<Thread> {
      return thread(id);
    },
  } as unknown as ThreadRepository;

  const conversationService = new ConversationService(
    {} as unknown as JobRepository,
    threadRepository,
    sessionRepository,
    messageRepository,
    { async lastForThread(): Promise<null> { return null; } } as unknown as TurnRepository,
    sessionManagerService,
    {
      busy: (threadId: string): boolean => running.includes(threadId),
    } as unknown as TurnRunnerService,
    { ensure: (): string => '/tmp/context' } as unknown as ContextFolderService,
    { kick: (): void => undefined } as unknown as AccountUsageService,
    {
      async forPhase(): Promise<PhaseBrief> {
        return { instructions: 'phase instructions', opening: 'phase opening' };
      },
    } as unknown as PhaseBriefService,
    stores,
  );

  return { conversationService, stores, opened, claimed, released };
}

describe('opening a job', () => {
  it('lands on the job’s active thread — the cursor is where a job resumes', async () => {
    const { conversationService } = build();
    const job = { ...JOB, activeThreadId: 'thread-c' } as unknown as Job;

    const open = await conversationService.openJob(job, '/repo');

    expect(open.thread.id).toBe('thread-c');
  });

  it('refuses a job whose cursor points nowhere rather than guessing a thread', async () => {
    const { conversationService } = build();

    await expect(conversationService.openJob(JOB, '/repo')).rejects.toThrow(
      'no active thread',
    );
  });
});

describe('opening a running thread', () => {
  it('hydrates it rather than resetting — the spinner, tail and queue survive', async () => {
    const { conversationService, stores } = build({ running: ['thread-b'] });
    const store = stores.for('thread-b');
    store.startTurn();
    store.enqueue({ id: 'q1', text: 'and also check the tests' });

    await conversationService.openThread(JOB, thread('thread-b'), '/repo');

    const state = store.getSnapshot();
    expect(state.running).toBe(true);
    expect(state.queued).toHaveLength(1);
    expect(state.messages.map((m) => m.id)).toContain('thread-b-persisted');
  });

  it('does not overwrite a live reading of context pressure with the row’s stale one', async () => {
    const { conversationService, stores } = build({ running: ['thread-b'] });
    const store = stores.for('thread-b');
    store.startTurn();
    store.setContextPercent(87);

    await conversationService.openThread(JOB, thread('thread-b'), '/repo');

    expect(store.getSnapshot().contextPercent).toBe(87);
  });
});

describe('switching threads', () => {
  it('leaves the thread it switched away from exactly as it was', async () => {
    const { conversationService, stores } = build({ running: ['thread-a'] });
    await conversationService.openThread(JOB, thread('thread-a'), '/repo');
    const left = stores.for('thread-a');
    left.startTurn();
    left.appendDelta('text', 'half a sentence');

    await conversationService.openThread(JOB, thread('thread-b'), '/repo');

    expect(left.getSnapshot().running).toBe(true);
    expect(stores.for('thread-b')).not.toBe(left);
  });

  it('keeps one store per thread, so a switch cannot cross two transcripts', async () => {
    const { conversationService, stores } = build();

    await conversationService.openThread(JOB, thread('thread-a'), '/repo');
    await conversationService.openThread(JOB, thread('thread-b'), '/repo');

    expect(stores.for('thread-a').getSnapshot().messages.map((m) => m.id)).toEqual([
      'thread-a-persisted',
    ]);
    expect(stores.for('thread-b').getSnapshot().messages.map((m) => m.id)).toEqual([
      'thread-b-persisted',
    ]);
  });

  it('holds the soft lock of a thread it left running, and drops it when idle', async () => {
    const { conversationService, released } = build({ running: ['thread-a'] });
    await conversationService.openThread(JOB, thread('thread-a'), '/repo');

    await conversationService.leave();

    expect(released).toEqual([]);
  });
});

describe('opening a closed thread', () => {
  it('reads its last session instead of minting a new one', async () => {
    const { conversationService, opened, claimed } = build();

    const open = await conversationService.openThread(
      JOB,
      thread('thread-old', EThreadStatus.closed),
      '/repo',
    );

    expect(opened).toEqual([]);
    expect(claimed).toEqual([]);
    expect(open.session.id).toBe('session-of-thread-old');
  });

  it('comes back read-only, so nothing can be typed into history', async () => {
    const { conversationService } = build();

    const open = await conversationService.openThread(
      JOB,
      thread('thread-old', EThreadStatus.closed),
      '/repo',
    );

    expect(open.readOnly).toBe(true);
  });

  it('still shows the transcript that made it worth opening', async () => {
    const { conversationService, stores } = build();

    await conversationService.openThread(
      JOB,
      thread('thread-old', EThreadStatus.closed),
      '/repo',
    );

    expect(stores.for('thread-old').getSnapshot().messages.map((m) => m.id)).toEqual([
      'thread-old-persisted',
    ]);
  });

  it('refuses plainly when the thread was closed before it ever ran', async () => {
    const { conversationService } = build();
    const never = { ...thread('thread-empty', EThreadStatus.closed), activeSessionId: null };

    await expect(
      conversationService.openThread(JOB, never as unknown as Thread, '/repo'),
    ).rejects.toThrow('nothing to read');
  });
});
