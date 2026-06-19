/**
 * Engine-stubbed pipeline SIMULATOR (NOT a test file — no `.spec`/`.test` suffix, so vitest never
 * collects it). The companion to `pipeline-runner.test-fakes.ts`, but one level up: where the
 * section-driver spec fakes the session runner, this wires the REAL PipelineRunnerService +
 * SessionRunnerService + InMemorySessionRegistry + ReviewPipelineService and stubs ONLY the AI engine
 * (the single seam: `turnExecutor.run(ctx, name, args) → engine.run(args)`). That exercises the bits
 * the FSM spec structurally can't reach: the detached turn, the `onUpdate→onSessionUpdate` relay,
 * fire-and-forget error handling, orphaned-session cleanup, the prompt-build → report-parse round trip,
 * and the real PR-gate review/ship interaction — all without a DB or an LLM.
 *
 * Scenarios script the engine per turn (keyed by mode/role), drive human gates via the real
 * BoardEventsBus + direct methods, and assert on the resulting durable state. `settle()` drives the
 * whole async cascade to quiescence deterministically (no sleeps).
 */
import {
  EWorkerEngineName,
  type EngineRunResult,
  type RunWorkerArgs,
  type WorkerEngine,
  type WorkerQuestion,
} from '../engines/worker-engine.port';
import { makeEmployee } from '../employees/employee.testing';
import { BoardEventsBus, type BoardEvent } from '../memory/board-events.bus';
import { InMemorySessionRegistry } from './in-memory-session.registry';
import { ReviewPipelineService } from './review-pipeline.service';
import { PipelineRunnerService, type SectionInput } from './pipeline-runner.service';
import { SessionRunnerService } from './session-runner.service';
import type { Session } from './session-registry.port';
import {
  FakeCodingStore,
  FakeNoteStore,
  FakePhaseStore,
  FakeReviewStore,
  FakeRunStore,
  FakeSectionStore,
} from './pipeline-runner.test-fakes';

// ── ScriptedEngine ────────────────────────────────────────────────────────────

/** What one scripted turn produces. The renderers round-trip the REAL parsers. */
export type ScriptedTurn =
  | { kind: 'report'; result: string }
  | {
      kind: 'plan';
      /** The `phases` JSON. Omit / pass `noPhasesBlock` to exercise the single-phase fallback. */
      phases?: Array<{ id: number; title?: string; group?: number }>;
      noPhasesBlock?: boolean;
      body?: string;
    }
  | { kind: 'execute'; handoff?: string; findings?: string; body?: string }
  | {
      /** A review turn. `blocker` drives the pipeline GROUP review (fenced ```verdict``` JSON);
       * `fullImpl` drives the ReviewPipelineService full-impl / lens review (the `VERDICT:` LINE). A
       * turn aimed at either consumer emits BOTH markers (each parser keys on its own), so the default
       * is a clean pass for both. */
      kind: 'review';
      blocker?: boolean;
      summary?: string;
      fullImpl?: 'pass' | 'changes';
    }
  | { kind: 'questions'; questions?: WorkerQuestion[]; planText?: string }
  | { kind: 'throw'; message?: string };

type Key = string; // `${mode}` or `${mode}:${role}`
export interface Script {
  default?: ScriptedTurn;
  /** Keyed by `${mode}` or `${mode}:${role}`; an array is consumed once per matching call (saturating). */
  byKey?: Record<Key, ScriptedTurn | ScriptedTurn[]>;
  /** Keyed by 0-based GLOBAL call index — highest priority. */
  byIndex?: Record<number, ScriptedTurn>;
}

export interface TurnLogEntry {
  mode: string;
  role: string;
  task: string;
  n: number;
}

const DEFAULT_QUESTION: WorkerQuestion = {
  question: 'Which datastore should I use?',
  header: 'datastore',
  options: [{ label: 'Postgres' }, { label: 'Redis' }],
};

function defaultFor(mode: string): ScriptedTurn {
  if (mode === 'plan') return { kind: 'plan' };
  if (mode === 'execute') return { kind: 'execute' };
  return { kind: 'review' }; // investigate → passing verdict (both grammars)
}

/**
 * A real `WorkerEngine` that produces deterministic, parser-valid reports from a programmable script.
 * The ONLY fake in the simulator. `turns` is the ordered log every scenario asserts against.
 */
export class ScriptedEngine implements WorkerEngine {
  readonly name = EWorkerEngineName.CLAUDE; // matches makeEmployee's default engine ⇒ engineCapturesPlan
  readonly turns: TurnLogEntry[] = [];
  private cursors = new Map<Key, number>();
  private n = 0;

  constructor(private script: Script = {}) {}

  /** Re-arm the script mid-scenario (e.g. after an approve, to change a later turn's outcome). */
  setScript(s: Script): void {
    this.script = s;
  }

  async run(args: RunWorkerArgs): Promise<EngineRunResult> {
    const role = args.agentId;
    const mode = args.mode;
    const idx = this.n++;
    this.turns.push({ mode, role, task: args.task, n: idx });
    const turn = this.pick(mode, role, idx);
    if (turn.kind === 'throw')
      throw new Error(turn.message ?? 'scripted engine failure');
    return this.render(turn, args);
  }

  private pick(mode: string, role: string, idx: number): ScriptedTurn {
    if (this.script.byIndex?.[idx]) return this.script.byIndex[idx];
    for (const key of [`${mode}:${role}`, mode]) {
      const hit = this.script.byKey?.[key];
      if (!hit) continue;
      if (Array.isArray(hit)) {
        const c = this.cursors.get(key) ?? 0;
        this.cursors.set(key, c + 1);
        return hit[Math.min(c, hit.length - 1)];
      }
      return hit;
    }
    return this.script.default ?? defaultFor(mode);
  }

  private render(
    t: Exclude<ScriptedTurn, { kind: 'throw' }>,
    args: RunWorkerArgs,
  ): EngineRunResult {
    args.onEvent({ kind: 'text', text: `scripted ${t.kind}` });
    switch (t.kind) {
      case 'report':
        return { result: t.result, sessionId: 'eng' };
      case 'questions':
        return {
          result: 'asking',
          sessionId: 'eng',
          questions: t.questions ?? [DEFAULT_QUESTION],
          ...(t.planText ? { planText: t.planText } : {}),
        };
      case 'plan': {
        let body = t.body ?? '# Plan';
        if (!t.noPhasesBlock) {
          const phases = t.phases ?? [{ id: 1, title: 'only phase' }];
          body += '\n\n```phases\n' + JSON.stringify(phases) + '\n```';
        }
        // planText set so the turn classifies as kind='plan' regardless of engine.
        return { result: body, sessionId: 'eng', planText: body };
      }
      case 'execute': {
        let body = t.body ?? 'Built it.';
        if (t.handoff) body += '\n\n```handoff\n' + t.handoff + '\n```';
        if (t.findings) body += '\n\n```findings\n' + t.findings + '\n```';
        return { result: body, sessionId: 'eng' };
      }
      case 'review': {
        const v = { blocker: t.blocker ?? false, summary: t.summary ?? 'looks ok' };
        const line = `VERDICT: ${t.fullImpl === 'changes' ? 'CHANGES' : 'PASS'}`;
        const result =
          'Reviewed.\n\n```verdict\n' + JSON.stringify(v) + '\n```\n\n' + line;
        return { result, sessionId: 'eng' };
      }
    }
  }
}

// ── doubles shared across the real services ────────────────────────────────────

interface BoardTask {
  id: number;
  status: string;
  title?: string;
  description?: string;
  project?: string;
  assignee?: string;
}

class FakeBoard {
  tasks = new Map<number, BoardTask>();
  updates: Array<{ taskId: number; patch: Partial<BoardTask> }> = [];
  seed(taskId: number, data: Partial<BoardTask>): void {
    this.tasks.set(taskId, { id: taskId, status: 'open', ...data });
  }
  async get(_team: string, id: number): Promise<BoardTask | undefined> {
    return this.tasks.get(id);
  }
  async update(
    _team: string,
    id: number,
    patch: Partial<BoardTask>,
  ): Promise<BoardTask | undefined> {
    this.updates.push({ taskId: id, patch });
    const t = this.tasks.get(id) ?? { id, status: 'open' };
    Object.assign(t, patch);
    this.tasks.set(id, t);
    return t;
  }
  async transition(
    _team: string,
    id: number,
    _from: string,
    patch: Partial<BoardTask>,
  ): Promise<BoardTask | undefined> {
    return this.update(_team, id, patch);
  }
  async list(): Promise<BoardTask[]> {
    return [...this.tasks.values()];
  }
}

class FakePlans {
  attached: unknown[] = [];
  approved: Array<{ taskId: number; role: string }> = [];
  prUrls = new Map<number, string>();
  async attach(p: unknown): Promise<unknown> {
    this.attached.push(p);
    return p;
  }
  async approve(_team: string, taskId: number, role: string): Promise<void> {
    this.approved.push({ taskId, role });
  }
  async setPrUrl(_team: string, taskId: number, url: string): Promise<void> {
    this.prUrls.set(taskId, url);
  }
  async listForTask(): Promise<unknown[]> {
    return [];
  }
  async setExecuteContext(): Promise<void> {}
  async setOwnerStatus(): Promise<void> {}
}

function makeEmployees(leadId = 'atlas') {
  const cache = new Map<string, ReturnType<typeof makeEmployee>>();
  const lead = makeEmployee({ id: leadId, name: 'Atlas', role: 'team lead', teamLead: true });
  cache.set(leadId, lead);
  const get = (id: string) => {
    if (!cache.has(id)) cache.set(id, makeEmployee({ id, name: id, role: id }));
    return cache.get(id)!;
  };
  return {
    byId: (id: string) => (id ? get(id) : undefined),
    teamLead: () => lead,
    fallbackOwner: () => lead,
    context: () => ({ team: 'T1', roster: 'roster' }),
  };
}

export interface SimulatorOpts {
  /** EXECUTION_APPROVAL_MODE dial for the session runner (default 'off' = un-gated). */
  approvalMode?: 'all' | 'linked' | 'off';
  /** INTEGRATION_REVIEW_MODE for the review service. */
  integrationReviewMode?: 'advisory' | 'gated';
  /** The daemon `reviewRange` file list. Default [] ⇒ full-impl + lens reviews short-circuit to a
   * clean pass WITHOUT running an engine turn (keeps happy-path cascades minimal). Set non-empty to
   * exercise the real full-impl review turn (e.g. the changes-at-PR-gate scenario). */
  reviewFiles?: string[];
  /** Make the daemon `openPr` throw ⇒ shipTask fails ⇒ the run fails loudly. */
  shipFails?: boolean;
  /** Make the daemon `publish` return a non-integrated (conflict) result ⇒ shipTask fails. */
  publishConflict?: boolean;
}

function makeDaemonAndGit(opts: SimulatorOpts) {
  const calls = { publish: 0, openPr: 0, markReady: 0, commentPr: 0, attachDesign: 0 };
  const daemon = {
    reviewRange: async () => ({
      range: 'base...head',
      files: opts.reviewFiles ?? [],
      baseBranch: 'main',
    }),
    publish: async (_id: string) => {
      calls.publish++;
      return opts.publishConflict
        ? {
            integrated: false as const,
            sharedBranch: 'feature/x',
            files: ['a.ts'] as string[],
            remote: undefined as { pushed: boolean; detail?: string } | undefined,
          }
        : { integrated: true as const, sharedBranch: 'feature/x' };
    },
    openPr: async (_args: { title: string; body?: string; draft?: boolean }) => {
      calls.openPr++;
      if (opts.shipFails) throw new Error('openPr blew up');
      return { url: 'https://github.com/o/r/pull/9', number: 9, existing: false };
    },
    markReady: async (_n: number) => {
      calls.markReady++;
      return { isDraft: false };
    },
    commentPr: async (_n: number, _t: string) => {
      calls.commentPr++;
      return undefined;
    },
    attachDesign: async (_b64: string) => {
      calls.attachDesign++;
      return { ok: true as const, message: 'attached' };
    },
  };
  // The `resolve()` port: base-refresh (session runner) + publish/projectRecordFor (peer path, unused here).
  const port = {
    refreshFromBase: async () => ({ refreshed: true, baseBranch: 'main' }),
    mergeState: async () => ({ inProgress: false, files: [] as string[] }),
    publish: daemon.publish,
    projectRecordFor: async () => {
      throw new Error('projectRecordFor must not be called on the workstation path');
    },
  };
  const workspaceGit = {
    isContainerized: () => true,
    daemonFor: () => daemon,
    resolve: () => port,
    resolveReferenceTarget: () => undefined,
  };
  return { daemon, workspaceGit, calls };
}

// ── buildPipelineSimulator ─────────────────────────────────────────────────────

export function buildPipelineSimulator(script: Script = {}, opts: SimulatorOpts = {}) {
  const engine = new ScriptedEngine(script);
  const sessions = new InMemorySessionRegistry();
  const turnExecutor = {
    run: (_ctx: unknown, _name: unknown, args: RunWorkerArgs) => engine.run(args),
  };

  // FSM store fakes (reused from pipeline-runner.test-fakes.ts).
  const runs = new FakeRunStore();
  const sectionStore = new FakeSectionStore();
  const phaseStore = new FakePhaseStore();
  const codingStore = new FakeCodingStore();
  const reviewStore = new FakeReviewStore();
  const notes = new FakeNoteStore();

  const board = new FakeBoard();
  const plans = new FakePlans();
  const employees = makeEmployees();
  const boardEvents = new BoardEventsBus();
  const proposalCalls: unknown[] = [];
  const proposals = {
    propose: async (p: unknown) => {
      proposalCalls.push(p);
      return { ok: true as const };
    },
  };

  const { daemon, workspaceGit, calls } = makeDaemonAndGit(opts);

  const persona = { context: () => employees.context() };
  const lifecycle = {
    run: async (_e: unknown, payload: unknown) => payload, // no self-review transform
  };
  const worklog = { logWork: async () => undefined };
  const creds = {
    resolve: async () => ({}),
    engineAuth: async () => ({ mode: 'api_key' as const, apiKey: undefined }),
  };
  const credCtx = { run: (_c: unknown, fn: () => unknown) => fn() };
  const metrics = {
    recordExecutionCompleted: async () => undefined,
    recordExecutionBlocked: async () => undefined,
  };
  const env = {
    get: (key: string) =>
      key === 'INTEGRATION_REVIEW_MODE'
        ? (opts.integrationReviewMode ?? 'advisory')
        : (opts.approvalMode ?? 'off'),
  };
  const settings = { isStandupOpen: async () => false };
  const reader = { get: () => undefined }; // benign: called before the containerized guard
  const tokens = { resolve: async () => undefined };
  const github = {
    openPullRequest: () => {
      throw new Error('host github must not be called on the containerized path');
    },
  };

  const runner = new SessionRunnerService(
    sessions,
    turnExecutor as never,
    employees as never,
    persona as never,
    lifecycle as never,
    worklog as never,
    workspaceGit as never,
    creds as never,
    credCtx as never,
    metrics as never,
    board as never,
    env as never,
    plans as never,
    settings as never,
  );

  const review = new ReviewPipelineService(
    turnExecutor as never,
    employees as never,
    credCtx as never,
    creds as never,
    reader as never,
    workspaceGit as never,
    tokens as never,
    github as never,
    board as never,
    plans as never,
    notes as never,
    boardEvents as never,
    runner as never,
    env as never,
    sessions as never,
  );

  const pipeline = new PipelineRunnerService(
    runs as never,
    sectionStore as never,
    runner as never,
    sessions as never,
    board as never,
    employees as never,
    plans as never,
    proposals as never,
    review as never,
    boardEvents as never,
    phaseStore as never,
    codingStore as never,
    reviewStore as never,
    notes as never,
    workspaceGit as never,
  );

  // ── settle() plumbing: track the two fire-and-forget relay layers ───────────
  const inflight = new Set<Promise<unknown>>();
  const errors: unknown[] = [];
  const track = (p: Promise<unknown>): void => {
    const w = Promise.resolve(p).then(
      () => undefined,
      (err) => void errors.push(err),
    );
    inflight.add(w);
    void w.finally(() => inflight.delete(w));
  };
  // Capture board events for assertions (raw subscription — not part of the relay graph).
  const events: BoardEvent[] = [];
  boardEvents.onEvent((e) => events.push(e));

  // Wire the pipeline's two subscriptions OURSELVES (instead of onApplicationBootstrap) so we hold the
  // ACTUAL onSessionUpdate / onBoardEvent promises — the pipeline's own cb returns void, which would
  // hide the async work from settle().
  const onSession = (s: Session) =>
    (pipeline as unknown as { onSessionUpdate: (s: Session) => Promise<void> }).onSessionUpdate(s);
  const onBoard = (e: BoardEvent) =>
    (pipeline as unknown as { onBoardEvent: (e: BoardEvent) => Promise<void> }).onBoardEvent(e);
  sessions.onUpdate((s) => track(onSession(s)));
  boardEvents.onEvent((e) => track(onBoard(e)));

  const tick = () => new Promise((r) => setImmediate(r));

  /** Drive the whole async cascade (detached engine turns + relays) to a stable state — terminal
   * (done/failed), a human gate (paused), or a questions park — with NO sleeps. Throws on timeout so an
   * accidental infinite cascade fails fast instead of hanging. */
  async function settle({ timeoutMs = 5000 } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline)
        throw new Error('settle() timed out — cascade did not quiesce');
      if (inflight.size > 0) {
        await Promise.race([...inflight, tick()]);
        continue;
      }
      if (runner.inFlightCount() > 0) {
        await tick();
        continue;
      }
      // Both empty: confirm stable across one macrotask (a relay may have just scheduled a turn that
      // registers its controller a tick late).
      await tick();
      if (inflight.size === 0 && runner.inFlightCount() === 0) return;
    }
  }

  return {
    pipeline,
    runner,
    review,
    engine,
    sessions,
    runs,
    sectionStore,
    phaseStore,
    codingStore,
    reviewStore,
    notes,
    board,
    plans,
    boardEvents,
    daemon,
    daemonCalls: calls,
    events,
    errors,
    proposalCalls,
    settle,
  };
}

export type Simulator = ReturnType<typeof buildPipelineSimulator>;

// ── makeDriver ─────────────────────────────────────────────────────────────────

export function makeDriver(sim: Simulator, team = 'T1', taskId = 7) {
  const { pipeline, engine, runs, sectionStore, board, boardEvents, daemonCalls, events, settle } = sim;
  // Seed the board task (shipTask + reviews read title/description/assignee/project).
  board.seed(taskId, {
    status: 'planning',
    title: 'Test task',
    description: 'desc',
    project: 'proj',
  });

  const run = () => runs.getByTask(team, taskId);
  const sections = async () =>
    sectionStore.listForRun(((await run())!.id as string) ?? '');

  return {
    sim,
    team,
    taskId,
    async dispatchFeature(
      sectionsInput: SectionInput[],
      over: { overview?: string } = {},
    ) {
      await pipeline.start({
        team,
        project: 'proj',
        taskId,
        workspaceId: `ws-${taskId}`,
        notifyThread: 'thread',
        kind: 'feature',
        sections: sectionsInput,
        ...(over.overview ? { overview: over.overview } : {}),
      });
      await settle();
    },
    async dispatchBugfix(role = 'phase_backend') {
      await pipeline.start({
        team,
        project: 'proj',
        taskId,
        workspaceId: `ws-${taskId}`,
        notifyThread: 'thread',
        kind: 'bugfix',
        role,
      });
      await settle();
    },
    async approve() {
      boardEvents.emit({ kind: 'ticket-approved', team, taskId });
      await settle();
    },
    async requestChanges(feedback?: string) {
      if (feedback)
        await sim.notes.add(
          team,
          taskId,
          'atlas',
          `Requested changes on the proposal #${taskId}: ${feedback}`,
        );
      boardEvents.emit({ kind: 'ticket-changes-requested', team, taskId });
      await settle();
    },
    async deny() {
      boardEvents.emit({ kind: 'ticket-denied', team, taskId });
      await settle();
    },
    async attachDesign(zipPath: string) {
      const r = await pipeline.attachDesign(team, taskId, zipPath);
      await settle();
      return r;
    },
    async skipDesign() {
      const r = await pipeline.skipDesign(team, taskId);
      await settle();
      return r;
    },
    async dispatchFixup(guidance?: string) {
      const r = await pipeline.dispatchFixup(team, taskId, guidance);
      await settle();
      return r;
    },
    async reopenSection(name: string, defect: string) {
      const r = await pipeline.reopenSection(team, taskId, name, defect);
      await settle();
      return r;
    },
    async answerQuestions(answers: string) {
      const r = await pipeline.answerSectionQuestions(team, taskId, answers);
      await settle();
      return r;
    },
    /** Simulate a process restart: abort in-flight turns, optionally reconcile the live session's
     * status (a durable registry flips it to 'failed' on boot), then resume from durable rows. */
    async restart(reconcile?: (s: Session) => void) {
      sim.runner.abortAll();
      if (reconcile) {
        const r = await run();
        if (r?.sessionId) {
          const s = await sim.sessions.get(r.sessionId as string);
          if (s) reconcile(s);
        }
      }
      await pipeline.resumePipelines();
      await settle();
    },
    arm: (s: Script) => engine.setScript(s),
    run,
    sections,
    /** The ordered {mode, role} of every engine turn. */
    turns: () => engine.turns.map((t) => ({ mode: t.mode, role: t.role })),
    events: () => events,
    /** Ship count = daemon markReady invocations (the real ship path; pr-ready is also emitted). */
    shipCalls: () => daemonCalls.markReady,
    prReadyEvents: () => events.filter((e) => e.kind === 'pr-ready'),
  };
}
