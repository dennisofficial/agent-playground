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

function world(args: {
  cursor: string;
  threads: Thread[];
  workspacePath?: string | null;
  /** Threads whose lane is held — the turn runner's answer, which the follow rule now consults. */
  busy?: readonly string[];
}) {
  const loaded: string[] = [];
  const deps = {
    jobRepository: {
      async findById(): Promise<Job> {
        return {
          ...JOB,
          activeThreadId: args.cursor,
          workspacePath: args.workspacePath ?? null,
        };
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
        return { id: 'session-1', accountId: 'account-1', contextTokens: null, contextLimit: null };
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
        return { id: 'session-1', accountId: 'account-1', contextTokens: null, contextLimit: null };
      },
    },
    turnRunnerService: {
      busy: (id: string) => (args.busy ?? []).includes(id),
    },
    contextFolderService: { ensure: () => '/context' },
    accountUsageService: { kick: () => undefined },
    phaseBriefService: {
      async forPhase() {
        return { instructions: 'i', opening: 'o' };
      },
    },
    threadSeamService: { async toolsFor() { return []; } },
    stores: {
      // `setNoAccount` is only reached when the refreshed thread is OPEN — the closed-thread case
      // skips it, which is why a fake without it survived until a live thread had to be re-opened.
      hydrate: () => ({
        setContextReading: () => undefined,
        setNoAccount: () => undefined,
      }),
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

  /**
   * `advance_thread` moves the cursor from inside a tool call and THEN lets the caller write its
   * sign-off — the one sentence that says in plain words where the work went. Following the instant
   * the successor's lane opens costs the human that sentence, and leaves the thread they were
   * watching permanently unread, because `lastSeenAt` only writes through while they are on it.
   */
  describe('a thread that is still talking', () => {
    it('holds the move until the turn on screen has ended', async () => {
      const here = thread({ id: 'thread-1', closed: true });
      const { deps } = world({
        cursor: 'thread-2',
        threads: [here, thread({ id: 'thread-2' })],
        busy: ['thread-1'],
      });

      const sync = await syncCursor(deps, {
        open: open({ thread: here, closed: false }),
        lastCursorThreadId: 'thread-1',
      });

      expect(sync?.moved).toBeNull();
      // The close is still reported — the composer must lock the moment the thread ends, whether or
      // not the page is about to move.
      expect(sync?.refreshed?.closed).toBe(true);
      // And the memory does NOT advance, which is what keeps the move readable next time.
      expect(sync?.cursorThreadId).toBe('thread-1');
    });

    it('follows on the next reading, once the lane is free', async () => {
      const here = thread({ id: 'thread-1', closed: true });
      const { deps } = world({
        cursor: 'thread-2',
        threads: [here, thread({ id: 'thread-2' })],
      });

      // Exactly what the held reading above handed back: the page is now holding a closed thread,
      // and its memory of the cursor is still itself.
      const sync = await syncCursor(deps, {
        open: open({ thread: here, closed: true }),
        lastCursorThreadId: 'thread-1',
      });

      expect(sync?.moved?.id).toBe('thread-2');
      expect(sync?.cursorThreadId).toBe('thread-2');
    });
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

  /**
   * The other snapshot that can go stale under an open conversation: WHERE ITS TURNS RUN.
   *
   * `enter_worktree` writes `Job.workspacePath` from inside a tool call, and the conversation is
   * holding the directory it opened with. Without this the tool would create the worktree and every
   * later turn would keep running in the project tree — which is the bug the tool was built to fix,
   * moved one layer up and made harder to see.
   */
  describe('a worktree taken mid-turn', () => {
    it('re-opens the conversation against the new directory', async () => {
      const here = thread({ id: 'thread-1' });
      const { deps, loaded } = world({
        cursor: 'thread-1',
        threads: [here],
        workspacePath: '/repo/.worktrees/drain-a1b2c3d4',
      });

      const sync = await syncCursor(deps, {
        // Opened before the tool call, so it still points at the project tree.
        open: open({ thread: here, closed: false }),
        lastCursorThreadId: 'thread-1',
      });

      expect(sync?.refreshed?.cwd).toBe('/repo/.worktrees/drain-a1b2c3d4');
      // The tool context is rebuilt with it, which is what makes `ship_pr` reach the right tree.
      expect(loaded).toEqual(['sessions']);
    });

    /**
     * The refreshed conversation must carry the NEW job row. Holding the old one would leave
     * `workspacePath` disagreeing with `cwd` for ever, and this comparison would re-open the
     * conversation at every turn boundary from then on.
     */
    it('settles — the refreshed conversation does not refresh again', async () => {
      const here = thread({ id: 'thread-1' });
      const world1 = world({
        cursor: 'thread-1',
        threads: [here],
        workspacePath: '/repo/.worktrees/drain-a1b2c3d4',
      });
      const first = await syncCursor(world1.deps, {
        open: open({ thread: here, closed: false }),
        lastCursorThreadId: 'thread-1',
      });
      if (!first?.refreshed) throw new Error('the first sync did not refresh');

      const world2 = world({
        cursor: 'thread-1',
        threads: [here],
        workspacePath: '/repo/.worktrees/drain-a1b2c3d4',
      });
      const second = await syncCursor(world2.deps, {
        open: first.refreshed,
        lastCursorThreadId: 'thread-1',
      });

      expect(second?.refreshed).toBeNull();
      expect(world2.loaded).toEqual([]);
    });

    /**
     * A job that never took a worktree records null, and null is not a relocation back to the
     * project path — it is the ordinary state of most jobs, whose cwd is already the project path.
     */
    it('leaves a job with no worktree exactly where it is', async () => {
      const here = thread({ id: 'thread-1' });
      const { deps, loaded } = world({ cursor: 'thread-1', threads: [here], workspacePath: null });

      const sync = await syncCursor(deps, {
        open: open({ thread: here, closed: false }),
        lastCursorThreadId: 'thread-1',
      });

      expect(sync?.refreshed).toBeNull();
      expect(loaded).toEqual([]);
    });
  });
});
