import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import type { Identity } from '../../domain/identity';
import {
  DEFAULT_EXECUTE_PROMPT,
  DEFAULT_PLAN_PROMPT,
} from '../../engines/role-prompts';
import {
  EWorkerEngineName,
  type WorkerMode,
} from '../../engines/worker-engine.port';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { BoardStore } from '../../memory/board-store';
import { PlanStore } from '../../memory/plan-store';
import {
  SESSION_REGISTRY,
  type Session,
  type SessionRegistry,
} from '../../sessions/session-registry.port';
import {
  SessionRunnerService,
  type ActionResult,
} from '../../sessions/session-runner.service';
import { WorktreeService } from '../../worktrees/worktree.service';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * A bot's session tools. The chat surface has NO filesystem/shell access at all — not even reads.
 * The chat-you is a PERSON: it plans, coordinates, and remembers, but its hands are background
 * SESSIONS — long-lived Claude Code-style workers it drives like an engineer. Every touch of a
 * codebase goes through a session running in a worktree; sessions stay open across turns (follow-ups
 * go into existing context) and the bot closes them when a thread of work is done. Each tool reads
 * the calling bot's identity from the tool context (set by the conductor) so sessions are scoped
 * per bot.
 */

const modeField = z
  .enum(['plan', 'execute'])
  .describe(
    "'plan' = read-only (the engine's native planning posture — investigation, review, planning a change); 'execute' = can change the worktree.",
  );

const createSessionSchema = z.object({
  worktreeId: z.string().describe('The worktree this session runs in.'),
  task: z
    .string()
    .describe('A clear, self-contained opening message for the session.'),
  mode: modeField,
  board_task_id: z
    .number()
    .int()
    .optional()
    .describe(
      'The team-board task (#N from list_board) this session works. Link it for ANY board work: the plan→approval flow runs through the board, and an execute turn is refused until the task is approved.',
    ),
});

@HarnessTool()
export class CreateSessionTool implements IHarnessTool<
  typeof createSessionSchema
> {
  readonly name = 'create_session';
  readonly description =
    "Open a background session — a long-lived Claude Code-style worker — in a worktree and give it its first turn. Returns a session id; you're notified when the turn reports back, and the session STAYS OPEN for follow-ups (reply_session). Calling this ENDS YOUR TURN, so put any brief first-person heads-up in THIS message's text.";
  readonly schema = createSessionSchema;
  readonly terminal = true;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
    private readonly worktrees: WorktreeService,
    private readonly employees: EmployeeRegistry,
    private readonly board: BoardStore,
    private readonly plans: PlanStore,
  ) {}

  async execute(
    {
      worktreeId,
      task,
      mode,
      board_task_id,
    }: z.infer<typeof createSessionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree)
      throw new Error(
        `No worktree "${worktreeId}" — create one first (create_worktree) or check list_worktrees.`,
      );
    const boardTask =
      board_task_id !== undefined
        ? await this.board.get(id.team, board_task_id)
        : undefined;
    if (board_task_id !== undefined && !boardTask)
      return `No board task #${board_task_id} — check list_board, or omit board_task_id.`;
    // The same approval gate reply_session applies — a fresh execute-mode session can't bypass it.
    if (mode === 'execute') {
      const refusal = await this.runner.executeRefusal(id.team, board_task_id);
      if (refusal) return `Can't open an execute session: ${refusal}`;
    }
    // The engine is the employee's spec for THIS session's role (plan/execute) — so a plan session
    // and an execute session on the same employee can run different engines (Option B). Fixed at
    // create; a session never swaps engines mid-life (replySession refuses an engine-changing flip).
    const bot =
      this.employees.byId(id.selfAgent) ?? this.employees.fallbackOwner();
    const engCtx = this.employees.context();
    const engineName = (
      mode === 'plan' ? bot.planEngine(engCtx) : bot.executeEngine(engCtx)
    ).engine;
    // OPTION B handoff: a fresh execute session is seeded from the APPROVED PLAN (the durable ticket
    // artifact), not the planning session's investigation noise. When this is an execute session on a
    // board task with the owner's attached plan, the engine's first message IS the enriched plan
    // (rendered through the employee's `execute` template); the chat-self's brief `task` rides along
    // as a note. The stored session.task stays the brief (for list_sessions); the engine gets the full
    // handoff. Falls back to the plain task when there's no attached plan (e.g. a non-plan execute).
    let openingTask = task;
    // Engines WITHOUT a native plan ceremony (everything but Claude, whose SDK plan mode enforces
    // read-only + ExitPlanMode for us) need the plan posture in the PROMPT: a Codex/LangGraph plan
    // turn is only read-only at the sandbox, so without this framing it would try to IMPLEMENT rather
    // than draft. This mirrors the Codex CLI's own plan mode — investigate read-only, emit a structured
    // plan, then stop for approval. Claude keeps the raw task: its native plan mode + ExitPlanMode
    // capture already do this, and wrapping the task would muddy that capture.
    if (mode === 'plan' && engineName !== EWorkerEngineName.CLAUDE) {
      openingTask = DEFAULT_PLAN_PROMPT({ ticket: task });
    }
    if (mode === 'execute' && board_task_id !== undefined && boardTask) {
      const plan = await this.plans.get(id.team, board_task_id, id.selfAgent);
      if (plan) {
        const ticketText =
          `${boardTask.title}\n\n${boardTask.description}`.trim();
        openingTask = DEFAULT_EXECUTE_PROMPT({
          ticket: ticketText,
          plan: plan.planMd,
        });
        if (task.trim()) openingTask += `\n\nTASK:\n${task.trim()}`;
      }
    }
    const { sessionId } = await this.openSession({
      identity: id,
      worktreeId,
      task,
      openingTask,
      mode,
      engine: engineName,
      boardTaskId: board_task_id,
    });
    return `Opened ${sessionId} (${engineName}, ${mode}${board_task_id !== undefined ? `, board #${board_task_id}` : ''}) in ${worktreeId}: "${task}". You're notified when it reports back; it stays open for follow-ups until you close_session it.`;
  }

  /**
   * The canonical create-session-and-fire-first-turn path, reused by `create_session` AND by
   * engine-tool capabilities (`EngineToolFactory`) so they don't invent a parallel worker path. The
   * engine is fixed at create. The first turn is fire-and-forget, detached from the conductor's
   * streaming callback context (AsyncLocalStorage `run(undefined, …)`) — without that, a LangGraph
   * turn's invoke() inherits the chat stream's message handler and its tokens bleed into the chat.
   */
  async openSession(opts: {
    identity: Identity;
    worktreeId: string;
    /** Stored brief (titles list_sessions + the close-time worklog). */
    task: string;
    /** The actual first-turn message (may be enriched, e.g. the Option-B plan handoff). */
    openingTask: string;
    mode: WorkerMode;
    engine: EWorkerEngineName;
    boardTaskId?: number;
  }): Promise<{ sessionId: string }> {
    const session = await this.sessions.create({
      task: opts.task,
      worktreeId: opts.worktreeId,
      notifyThread: opts.identity.surface,
      engine: opts.engine,
      ownerBot: opts.identity.selfAgent,
      team: opts.identity.team,
      project: opts.identity.project,
      mode: opts.mode,
      ...(opts.boardTaskId !== undefined
        ? { boardTaskId: opts.boardTaskId }
        : {}),
    });
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      void this.runner.runSessionTurn(session.id, opts.openingTask);
    });
    return { sessionId: session.id };
  }
}

const replySessionSchema = z.object({
  sessionId: z.string().describe('The session to continue.'),
  message: z
    .string()
    .describe(
      "Your next message into the session — an answer, follow-up, course correction, or approval. First person; it's your own work.",
    ),
  mode: modeField
    .optional()
    .describe(
      "Switch the session's mode from this turn on (e.g. a plan session into execution for quick non-board work). BOARD work does NOT switch here — approved tickets execute in a fresh execute session opened from the plan.",
    ),
});

@HarnessTool()
export class ReplySessionTool implements IHarnessTool<
  typeof replySessionSchema
> {
  readonly name = 'reply_session';
  readonly description =
    "Send the next message into one of your open sessions — it keeps its full context, so follow-ups go here instead of a new session. This is how you feed review/revision notes back into a still-open planning or execute session. Calling this ENDS YOUR TURN; you're notified when the turn reports back.";
  readonly schema = replySessionSchema;
  readonly terminal = true;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
  ) {}

  async execute(
    { sessionId, message, mode }: z.infer<typeof replySessionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.ownerBot !== ctx.identity.selfAgent)
      throw new Error(`Couldn't reply to ${sessionId}: not your session.`);
    // The reply fires fire-and-forget and must run in a clean store so a LangGraph run's callbacks
    // don't bleed into the chat stream.
    let res: ActionResult = { ok: false };
    await AsyncLocalStorageProviderSingleton.getInstance().run(
      undefined,
      async () => {
        res = await this.runner.replySession(sessionId, message, mode);
      },
    );
    if (!res.ok)
      throw new Error(`Couldn't reply to ${sessionId}: ${res.reason}`);
    return `Sent to ${sessionId}${mode ? ` (mode → ${mode})` : ''}; it's working and will report back.`;
  }
}

const closeSessionSchema = z.object({
  sessionId: z.string().describe('The session to close.'),
});

@HarnessTool()
export class CloseSessionTool implements IHarnessTool<
  typeof closeSessionSchema
> {
  readonly name = 'close_session';
  readonly refreshesContext = ['work'] as const;
  readonly description =
    "Close a session you're done with (stops it if it's mid-turn and discards that turn's result). Its completed work is logged. The worktree stays until you remove_worktree it.";
  readonly schema = closeSessionSchema;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
  ) {}

  async execute(
    { sessionId }: z.infer<typeof closeSessionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.ownerBot !== ctx.identity.selfAgent)
      return `Couldn't close ${sessionId}: not your session.`;
    const res = await this.runner.closeSession(sessionId);
    return res.ok
      ? `Closed ${sessionId} ("${session.task}").`
      : `Couldn't close ${sessionId}: ${res.reason}`;
  }
}

const checkSessionSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('The session to check; omit for your latest.'),
});

@HarnessTool()
export class CheckSessionTool implements IHarnessTool<
  typeof checkSessionSchema
> {
  readonly name = 'check_session';
  readonly description =
    "Peek at one of your sessions — status, mode, and recent activity (or its last report once idle). Use it when someone asks how it's going; don't poll it in a loop.";
  readonly schema = checkSessionSchema;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
    private readonly employees: EmployeeRegistry,
  ) {}

  async execute(
    { sessionId }: z.infer<typeof checkSessionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const session = sessionId
      ? await this.sessions.get(sessionId)
      : await this.sessions.latest(id.selfAgent);
    if (!session || session.ownerBot !== id.selfAgent) {
      return sessionId
        ? `No session "${sessionId}" found.`
        : 'You have no sessions yet.';
    }
    const bot =
      this.employees.byId(session.ownerBot) ?? this.employees.fallbackOwner();
    const specCtx = this.employees.context();
    const { model, effort } =
      session.mode === 'plan'
        ? bot.planEngine(specCtx)
        : bot.executeEngine(specCtx);
    const tier = `${session.mode} on ${model ?? `${session.engine} default`}${effort ? `, effort ${effort}` : ''}`;
    const board =
      session.boardTaskId !== undefined
        ? `, board #${session.boardTaskId}`
        : '';
    const waiting =
      session.status === 'idle' && session.lastReportKind === 'questions'
        ? ' — waiting on answers'
        : '';
    const header = `${session.id} [${session.status}]${waiting} (${tier}, ${session.worktreeId}${board}, turn ${session.turns}): "${session.task}"`;
    if (session.status === 'idle')
      return `${header}\nLast report: ${session.lastReport ?? '(none)'}`;
    if (session.status === 'failed')
      return `${header}\nLast turn failed: ${session.error ?? '(unknown error)'} — reply_session retries it.`;
    if (session.status === 'closed')
      return `${header}\nClosed. Final report: ${session.lastReport ?? '(none)'}`;
    const progress = await this.runner.getSessionActivity(session.id);
    return `${header}\nProgress so far:\n${progress}`;
  }
}

const listSessionsSchema = z.object({});

@HarnessTool()
export class ListSessionsTool implements IHarnessTool<
  typeof listSessionsSchema
> {
  readonly name = 'list_sessions';
  readonly description =
    'Your sessions, open ones first: id, status, mode, worktree, and opening task. Check it when you pick work back up — an open session may already have the context you need.';
  readonly schema = listSessionsSchema;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
  ) {}

  async execute(
    _args: z.infer<typeof listSessionsSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const all = await this.sessions.list({ ownerBot: ctx.identity.selfAgent });
    if (all.length === 0) return 'You have no sessions.';
    const order: Record<Session['status'], number> = {
      running: 0,
      idle: 1,
      failed: 2,
      closed: 3,
    };
    return [...all]
      .sort((a, b) => order[a.status] - order[b.status])
      .map(
        (s) =>
          `- ${s.id} [${s.status}] (${s.mode}, ${s.worktreeId}${s.boardTaskId !== undefined ? `, board #${s.boardTaskId}` : ''}, turn ${s.turns}): "${s.task}"${s.status === 'idle' && s.lastReportKind === 'questions' ? ' — waiting on answers' : ''}`,
      )
      .join('\n');
  }
}

const searchSessionSchema = z.object({
  sessionId: z.string().describe('The session whose transcript to read.'),
  query: z
    .string()
    .optional()
    .describe('Find transcript lines containing this text (case-insensitive).'),
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Without a query: which page of the transcript; 1 (default) = the most recent.',
    ),
});

@HarnessTool()
export class SearchSessionTool implements IHarnessTool<
  typeof searchSessionSchema
> {
  readonly name = 'search_session';
  readonly description =
    "Look through one of your sessions' FULL transcript — every step and tool call across all its turns — like scrolling back through a Claude Code transcript. Search with `query`, or page through with `page`. For when the last report isn't enough and you need what actually happened.";
  readonly schema = searchSessionSchema;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
  ) {}

  async execute(
    { sessionId, query, page }: z.infer<typeof searchSessionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.ownerBot !== ctx.identity.selfAgent)
      return `No session "${sessionId}" of yours.`;
    return this.runner.searchTranscript(sessionId, { query, page });
  }
}
