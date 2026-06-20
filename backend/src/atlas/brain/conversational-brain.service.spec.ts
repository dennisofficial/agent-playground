import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AtlasMemoryStore } from '../memory';
import type { ChatStimulus, Job } from '../domain';
import type {
  ChatSurface,
  InboundChatMessage,
  PostOptions,
} from '../surface';
import type { BrainLlm, GrillInput } from './brain-llm';
import type { GrillAction, TranscriptLine } from './brain.types';
import type { BrainStoreService, PersistedPlan, ThreadRoute } from './brain-store.service';
import { ConversationalBrainService } from './conversational-brain.service';
import { DecisionApprovalService } from './decision-approval.service';
import type { JobDispatcher } from './job-dispatcher';
import type {
  ScopingInvestigateInput,
  ScopingInvestigatorService,
} from './scoping-investigator.service';

/** A fake duplex surface: records posts. */
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
}

function fakeLlm(action: GrillAction | undefined): BrainLlm & { lastGrill?: GrillInput } {
  return {
    async triage() {
      return undefined;
    },
    async grill(input: GrillInput) {
      (this as { lastGrill?: GrillInput }).lastGrill = input;
      return action;
    },
  };
}

function fakeMemory(): AtlasMemoryStore {
  return { async recall() { return []; } } as unknown as AtlasMemoryStore;
}

function fakeInvestigator(
  digestText = '',
  answerText = 'This repo is a NestJS service.',
): ScopingInvestigatorService & {
  calls: ScopingInvestigateInput[];
  forgotten: string[];
  answers: Array<{ question: string }>;
} {
  const calls: ScopingInvestigateInput[] = [];
  const forgotten: string[] = [];
  const answers: Array<{ question: string }> = [];
  return {
    calls,
    forgotten,
    answers,
    async digest(input: ScopingInvestigateInput) {
      calls.push(input);
      return digestText;
    },
    async answer(input: { question: string }) {
      answers.push({ question: input.question });
      return answerText;
    },
    forget(threadId: string) {
      forgotten.push(threadId);
    },
  } as unknown as ScopingInvestigatorService & {
    calls: ScopingInvestigateInput[];
    forgotten: string[];
    answers: Array<{ question: string }>;
  };
}

function fakeStore(): BrainStoreService & {
  persisted?: PersistedPlan;
  appended: string[];
  reopened: string[];
  cancelled: string[];
  approvedWith?: { jobId: string; recordId: string; by: string };
} {
  const transcript: TranscriptLine[] = [{ author: 'Dennis', isAtlas: false, text: 'build me X' }];
  const ctx = {
    persisted: undefined as PersistedPlan | undefined,
    appended: [] as string[],
    reopened: [] as string[],
    cancelled: [] as string[],
    approvedWith: undefined as { jobId: string; recordId: string; by: string } | undefined,
    async transcript() {
      return transcript;
    },
    async appendAtlasMessage(_threadId: string, text: string) {
      ctx.appended.push(text);
    },
    async route(): Promise<ThreadRoute> {
      return { channel: 'C-proj', threadTs: 'root-1' };
    },
    async openJobOnThread() {
      return null;
    },
    async openJob() {
      return 'job-7';
    },
    async persistPlan() {
      const plan: PersistedPlan = {
        job: { id: 'job-7', decisionRecordId: 'dr-7', status: 'awaiting_approval' } as Job,
        decisionRecordId: 'dr-7',
      };
      ctx.persisted = plan;
      return plan;
    },
    async approve(jobId: string, recordId: string, by: string) {
      ctx.approvedWith = { jobId, recordId, by };
      return { id: jobId, status: 'running', kind: 'feature' } as Job;
    },
    async reopenScoping(jobId: string) {
      ctx.reopened.push(jobId);
    },
    async cancel(jobId: string) {
      ctx.cancelled.push(jobId);
    },
  };
  return ctx as unknown as BrainStoreService & typeof ctx;
}

function fakeDispatcher(): JobDispatcher & { jobs: Job[] } {
  const jobs: Job[] = [];
  return {
    jobs,
    async dispatch(job: Job) {
      jobs.push(job);
    },
  };
}

const PROPOSAL: GrillAction = {
  verb: 'propose_plan',
  title: 'CSV export',
  kind: 'feature',
  overview: 'Add CSV export to the dashboard.',
  decisions: [{ decisionClass: 'data_model', title: 'No schema change', ruling: 'Read-only export.' }],
  sectionBriefs: ['Backend: export endpoint', 'Frontend: download button'],
};

function chat(): ChatStimulus {
  return {
    id: 's1',
    teamId: 'T1',
    projectId: 'proj',
    kind: 'chat',
    trust: 'trusted',
    body: 'build me X',
    threadId: 'thr-1',
    author: { id: 'U-dennis', displayName: 'Dennis' },
    replyRoute: { surfaceId: 'slack', threadRef: 'root-1' },
    receivedAt: new Date(),
  };
}

describe('ConversationalBrainService (grill)', () => {
  let surface: FakeSurface;
  let approvals: DecisionApprovalService;
  let dispatcher: ReturnType<typeof fakeDispatcher>;

  beforeEach(() => {
    surface = new FakeSurface();
    approvals = new DecisionApprovalService(surface);
    dispatcher = fakeDispatcher();
  });

  function make(
    action: GrillAction | undefined,
    store = fakeStore(),
    investigator = fakeInvestigator(),
  ) {
    const llm = fakeLlm(action);
    return {
      svc: new ConversationalBrainService(
        llm,
        store as unknown as BrainStoreService,
        fakeMemory(),
        approvals,
        investigator,
        dispatcher,
        surface,
      ),
      store,
      llm,
      investigator,
    };
  }

  it('asks a clarifying question in-thread and records it to the transcript', async () => {
    const { svc, store } = make({ verb: 'ask_question', question: 'Which export format?' });
    await svc.handleChatTurn(chat());
    const posted = surface.posts.find((p) => p.text === 'Which export format?');
    expect(posted).toBeDefined();
    expect(posted?.opts?.threadTs).toBe('root-1');
    expect(store.appended).toContain('Which export format?');
    expect(dispatcher.jobs).toHaveLength(0);
  });

  it('grounds the grill in the repo digest (issue #1: investigate, do not interrogate)', async () => {
    const { svc, llm, investigator } = make(
      { verb: 'ask_question', question: 'Which export format?' },
      fakeStore(),
      fakeInvestigator('Repo digest: NestJS + pnpm; the dashboard module owns export.'),
    );
    await svc.handleChatTurn(chat());
    // The investigator was consulted for THIS thread/project, and its digest reached the grill turn.
    expect(investigator.calls).toHaveLength(1);
    expect(investigator.calls[0]).toMatchObject({
      teamId: 'T1',
      projectId: 'proj',
      threadId: 'thr-1',
    });
    expect(llm.lastGrill?.repoDigest).toContain('NestJS');
  });

  it('proposes a plan → persists it → posts the approval card', async () => {
    const { svc, store } = make(PROPOSAL);
    // handleChatTurn blocks on the verdict; check the persist + card post, then resolve to let it finish.
    const turn = svc.handleChatTurn(chat());
    await waitFor(() => approvals.pendingCount === 1);
    expect(store.persisted?.decisionRecordId).toBe('dr-7');
    const card = surface.posts.find((p) => Array.isArray(p.opts?.blocks));
    expect(card).toBeDefined();
    expect(card?.opts?.threadTs).toBe('root-1');
    approvals.resolve('job-7', 'approve', 'U-dennis'); // unblock the turn
    await turn;
  });

  it('on APPROVE → marks approved + dispatches the job + forgets the scoping digest', async () => {
    const { svc, store, investigator } = make(PROPOSAL);
    const turn = svc.handleChatTurn(chat());
    // Let the card post + the verdict promise register, then approve.
    await waitFor(() => approvals.pendingCount === 1);
    expect(approvals.resolve('job-7', 'approve', 'U-dennis')).toBe(true);
    await turn;
    expect(store.approvedWith).toEqual({ jobId: 'job-7', recordId: 'dr-7', by: 'U-dennis' });
    expect(dispatcher.jobs).toHaveLength(1);
    expect(dispatcher.jobs[0]?.status).toBe('running');
    expect(investigator.forgotten).toContain('thr-1');
  });

  it('on REQUEST_CHANGES → no dispatch, job returns to scoping', async () => {
    const { svc, store } = make(PROPOSAL);
    const turn = svc.handleChatTurn(chat());
    await waitFor(() => approvals.pendingCount === 1);
    approvals.resolve('job-7', 'request_changes', 'U-dennis', 'use streaming');
    await turn;
    expect(dispatcher.jobs).toHaveLength(0);
    expect(store.reopened).toContain('job-7');
  });

  it('on DENY → no dispatch, job cancelled', async () => {
    const { svc, store } = make(PROPOSAL);
    const turn = svc.handleChatTurn(chat());
    await waitFor(() => approvals.pendingCount === 1);
    approvals.resolve('job-7', 'deny', 'U-dennis');
    await turn;
    expect(dispatcher.jobs).toHaveLength(0);
    expect(store.cancelled).toContain('job-7');
  });

  it('answerQuestion posts a repo-grounded answer in-thread without opening a job (issue #6)', async () => {
    const { svc, store, investigator } = make(undefined, fakeStore(), fakeInvestigator('', 'It is a NestJS orchestrator.'));
    await svc.answerQuestion(chat());
    expect(investigator.answers).toHaveLength(1);
    const posted = surface.posts.find((p) => p.text === 'It is a NestJS orchestrator.');
    expect(posted).toBeDefined();
    expect(posted?.opts?.threadTs).toBe('root-1');
    expect(store.appended).toContain('It is a NestJS orchestrator.');
    expect(dispatcher.jobs).toHaveLength(0);
  });

  it('no LLM verdict → asks a generic clarifier (never guesses a plan)', async () => {
    const { svc, store } = make(undefined);
    await svc.handleChatTurn(chat());
    expect(surface.posts).toHaveLength(1);
    expect(store.persisted).toBeUndefined();
    expect(dispatcher.jobs).toHaveLength(0);
  });
});

/** Poll until a predicate holds (the verdict promise registers asynchronously after the card posts). */
async function waitFor(pred: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('waitFor timed out');
}
