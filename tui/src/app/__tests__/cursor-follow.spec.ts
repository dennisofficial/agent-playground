import { describe, expect, it } from 'bun:test';
import { syncCursor, type ConversationDeps, type OpenConversation } from '../conversation-open.js';
import { EThreadRole, EThreadStatus } from '../../generated/prisma/enums.js';
import type { Job, Thread } from '../../generated/prisma/client.js';

/**
 * What the renderer asks between turns: has the cursor moved off the thread on screen, and is what
 * is on screen still true?
 *
 * The second question is the bug this closes. `OpenConversation.closed` is a SNAPSHOT taken when the
 * conversation opened, and a thread that advances itself closes MID-TURN — so the composer stayed
 * writable in a thread that had already ended, until the human navigated away and back.
 */

const JOB = { id: 'job-1', activeThreadId: 'thread-1' } as unknown as Job;

function thread(args: { id: string; closed?: boolean }): Thread {
  return {
    id: args.id,
    phaseId: 'phase-1',
    role: EThreadRole.generic,
    status: args.closed ? EThreadStatus.closed : EThreadStatus.active,
    openedByThreadId: null,
    activeSessionId: 'session-1',
  } as unknown as Thread;
}

function world(args: { cursor: string; threads: Thread[] }) {
  const loaded: string[] = [];
  const deps = {
    jobRepository: {
      async findById(): Promise<Job> {
        return { ...JOB, activeThreadId: args.cursor };
      },
    },
    threadRepository: {
      async findById(id: string): Promise<Thread | null> {
        return args.threads.find((row) => row.id === id) ?? null;
      },
    },
    // Only reached on a REFRESH, which is the point of counting it: a sync that re-read the whole
    // conversation every time would re-hydrate a working thread's store on every turn boundary.
    sessionRepository: {
      async findById() {
        return { id: 'session-1', accountId: 'account-1', contextPercent: 10 };
      },
      async refsForThread() {
        loaded.push('sessions');
        return [];
      },
    },
    messageRepository: { async listForThread() { return []; } },
    turnRepository: { async lastForThread() { return null; } },
    sessionManagerService: {
      async currentSession() {
        return { id: 'session-1', accountId: 'account-1', contextPercent: 10 };
      },
    },
    turnRunnerService: { busy: () => false },
    contextFolderService: { ensure: () => '/context' },
    accountUsageService: { kick: () => undefined },
    phaseBriefService: {
      async forPhase() {
        return { instructions: 'i', opening: 'o' };
      },
    },
    threadSeamService: { async toolsFor() { return []; } },
    stores: {
      hydrate: () => ({ setContextPercent: () => undefined }),
    },
  } as unknown as ConversationDeps;

  return { deps, loaded };
}

function open(args: { thread: Thread; closed: boolean }): OpenConversation {
  return {
    job: JOB,
    thread: args.thread,
    cwd: '/repo',
    closed: args.closed,
  } as unknown as OpenConversation;
}

describe('syncCursor', () => {
  it('follows the cursor when it moves OFF the thread on screen', async () => {
    const here = thread({ id: 'thread-1' });
    const { deps } = world({ cursor: 'thread-2', threads: [here, thread({ id: 'thread-2' })] });

    const sync = await syncCursor(deps, {
      open: open({ thread: here, closed: false }),
      // The last reading had it here — which is what makes this a move rather than a difference.
      lastCursorThreadId: 'thread-1',
    });

    expect(sync?.moved?.id).toBe('thread-2');
    expect(sync?.cursorThreadId).toBe('thread-2');
  });

  it('does NOT follow a cursor that was already elsewhere — browsing is deliberate', async () => {
    const here = thread({ id: 'thread-1' });
    const { deps } = world({ cursor: 'thread-2', threads: [here, thread({ id: 'thread-2' })] });

    // The human opened this thread from the list while the frontier was somewhere else. Following
    // would take the page away from him the instant anything anywhere finished a turn.
    const sync = await syncCursor(deps, {
      open: open({ thread: here, closed: false }),
      lastCursorThreadId: 'thread-2',
    });

    expect(sync?.moved).toBeNull();
    expect(sync?.refreshed).toBeNull();
  });

  it('never follows on the FIRST reading, when there is nothing to compare against', async () => {
    const here = thread({ id: 'thread-1' });
    const { deps } = world({ cursor: 'thread-2', threads: [here, thread({ id: 'thread-2' })] });

    const sync = await syncCursor(deps, {
      open: open({ thread: here, closed: false }),
      lastCursorThreadId: null,
    });

    expect(sync?.moved).toBeNull();
    // It still reports where the cursor is, so the reading AFTER this one can tell a move.
    expect(sync?.cursorThreadId).toBe('thread-2');
  });

  it('re-opens the conversation when the thread on screen closed under it', async () => {
    const closed = thread({ id: 'thread-1', closed: true });
    const { deps, loaded } = world({ cursor: 'thread-1', threads: [closed] });

    const sync = await syncCursor(deps, {
      // What the page is holding: opened while the thread was live, and now stale.
      open: open({ thread: closed, closed: false }),
      lastCursorThreadId: 'thread-1',
    });

    expect(sync?.refreshed?.closed).toBe(true);
    // Closing also ends the session and takes the tools away — re-reading is what gets all three.
    expect(sync?.refreshed?.tools).toEqual([]);
    expect(loaded).toEqual(['sessions']);
  });

  it('does nothing at all when neither the cursor nor the thread moved', async () => {
    const here = thread({ id: 'thread-1' });
    const { deps, loaded } = world({ cursor: 'thread-1', threads: [here] });

    const sync = await syncCursor(deps, {
      open: open({ thread: here, closed: false }),
      lastCursorThreadId: 'thread-1',
    });

    expect(sync).toEqual({ cursorThreadId: 'thread-1', moved: null, refreshed: null });
    expect(loaded).toEqual([]);
  });
});
