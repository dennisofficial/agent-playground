import { describe, expect, it } from 'bun:test';
import { EAttentionCourt, EAttentionVerb } from '../../domain/attention.js';
import { EThreadStatus } from '../../generated/prisma/enums.js';
import type { Job } from '../../generated/prisma/client.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ThreadRepository, ThreadRow } from '../../store/thread.repository.js';
import type { TransitionRepository, TransitionRow } from '../../store/transition.repository.js';
import { AttentionService } from '../attention.service.js';

/**
 * Where a job stands the instant one of its turns ends — the read a desktop notification is decided
 * from.
 *
 * The property worth protecting here is the de-duplication one, and it is structural rather than
 * enforced: `runningThreadIds` is the CALLER'S local lane set. The engine runs in-process, so a turn
 * belongs to exactly one Atlas instance, and passing the lanes in is what makes "should I notify"
 * answerable only by the instance that ran the agent. Reading a global notion of "is anything
 * running" would put every open terminal back in the business of announcing every job.
 */

function service(args: {
  job?: Job | null;
  threads?: { id: string; closed?: boolean }[];
  pending?: TransitionRow[];
}): AttentionService {
  const job =
    args.job === undefined
      ? ({ id: 'job-1', title: 'Password policy', prNumber: null } as unknown as Job)
      : args.job;

  const jobRepository = {
    async findByThreadId(): Promise<Job | null> {
      return job;
    },
  } as unknown as JobRepository;

  const threadRepository = {
    async listForJob(): Promise<ThreadRow[]> {
      return (args.threads ?? [{ id: 'thread-1' }]).map(
        (thread) =>
          ({
            id: thread.id,
            status: thread.closed ? EThreadStatus.closed : EThreadStatus.active,
          }) as unknown as ThreadRow,
      );
    },
  } as unknown as ThreadRepository;

  const transitionRepository = {
    async pendingForJob(): Promise<TransitionRow[]> {
      return args.pending ?? [];
    },
  } as unknown as TransitionRepository;

  return new AttentionService(threadRepository, jobRepository, transitionRepository);
}

describe('jobAttentionAfterTurn', () => {
  it('leaves the ball with the human when the job has nothing else running', async () => {
    const state = await service({}).jobAttentionAfterTurn({
      threadId: 'thread-1',
      runningThreadIds: [],
    });

    expect(state?.jobTitle).toBe('Password policy');
    expect(state?.attention.verb).toBe(EAttentionVerb.reply);
    expect(state?.attention.court).toBe(EAttentionCourt.yours);
  });

  it('keeps the ball with the agent while a sibling thread is still running HERE', async () => {
    const state = await service({
      threads: [{ id: 'thread-1' }, { id: 'thread-2' }],
    }).jobAttentionAfterTurn({
      threadId: 'thread-1',
      // Our own lane set, so this is a turn this process is still running.
      runningThreadIds: ['thread-2'],
    });

    expect(state?.attention.court).toBe(EAttentionCourt.agent);
  });

  /**
   * The multi-instance case, stated as the behaviour rather than as the mechanism. A thread another
   * terminal is running is absent from OUR lanes and is therefore counted idle — which is the point:
   * that terminal holds the turn and will announce it when it ends. Counting it as running here
   * would mean neither instance ever notified, each waiting on work the other owns.
   *
   * In practice this barely arises, because the claim file already keeps one terminal driving a job;
   * it is asserted so that a later "fix" reaching for a global running set has to argue with a test.
   */
  it('treats a thread ANOTHER instance is running as idle, because that instance will speak', async () => {
    const state = await service({
      threads: [{ id: 'thread-1' }, { id: 'thread-2' }],
    }).jobAttentionAfterTurn({
      threadId: 'thread-1',
      runningThreadIds: [],
    });

    expect(state?.attention.court).toBe(EAttentionCourt.yours);
  });

  it('reports a pending proposal, which outranks anything still working', async () => {
    const state = await service({
      threads: [{ id: 'thread-1' }, { id: 'thread-2' }],
      pending: [{ id: 'transition-1' } as unknown as TransitionRow],
    }).jobAttentionAfterTurn({
      threadId: 'thread-1',
      runningThreadIds: ['thread-2'],
    });

    expect(state?.attention.verb).toBe(EAttentionVerb.confirm);
    expect(state?.attention.court).toBe(EAttentionCourt.yours);
  });

  it('sends a job whose last thread closed to the phase prompt, not to silence', async () => {
    const state = await service({
      threads: [{ id: 'thread-1', closed: true }],
    }).jobAttentionAfterTurn({ threadId: 'thread-1', runningThreadIds: [] });

    expect(state?.attention.verb).toBe(EAttentionVerb.nothingOpen);
    expect(state?.attention.court).toBe(EAttentionCourt.yours);
  });

  /**
   * Several terminals share one database, so a job can be deleted out from under a turn that had
   * already finished. Null rather than a throw — there is nobody to tell, and the caller's whole
   * failure mode is "no banner".
   */
  it('answers null for a job that is gone', async () => {
    const state = await service({ job: null }).jobAttentionAfterTurn({
      threadId: 'thread-1',
      runningThreadIds: [],
    });
    expect(state).toBeNull();
  });
});
