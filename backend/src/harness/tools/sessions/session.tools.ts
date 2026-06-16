import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Inject } from '@nestjs/common';
import type { ChatTracePointer } from '@workspace/langfuse';
import { z } from 'zod';
import type { Identity } from '../../domain/identity';
import {
  DEFAULT_EXECUTE_PROMPT,
  DEFAULT_PLAN_PROMPT,
} from '../../engines/engine.prompts';
import {
  EWorkerEngineName,
  type WorkerMode,
} from '../../engines/worker-engine.port';
import { engineSpecForMode } from '../../employees/engine-for-mode';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { BoardStore } from '../../memory/board-store';
import { PlanStore } from '../../memory/plan-store';
import { TicketNoteStore } from '../../memory/ticket-note-store';
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

const reviewNoteField = z
  .number()
  .int()
  .optional()
  .describe(
    "A self-review findings note (#X from the self-review heads-up) to load into this session — the harness inlines the full findings so you don't retype them. Use it when addressing self-review feedback.",
  );

/** The findings block the harness inlines when a tool is handed a review note id. */
function reviewFindingsBlock(noteId: number, body: string): string {
  return `SELF-REVIEW FINDINGS TO ADDRESS (note #${noteId}):\n${body}`;
}

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
  review_note_id: reviewNoteField,
});

@HarnessTool()
export class CreateSessionTool implements IHarnessTool<
  typeof createSessionSchema
> {
  readonly name = 'create_session';
  readonly description =
    "Open a background session — a long-lived Claude Code-style worker — in a worktree and give it its first turn. Returns a session id; you're notified when the turn reports back, and the session STAYS OPEN for follow-ups (reply_session). Put any brief first-person heads-up in THIS message's text; once it's running you don't need to keep replying — just wait for the report-back, don't poll or babysit it.";
  readonly schema = createSessionSchema;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
    private readonly worktrees: WorktreeService,
    private readonly employees: EmployeeRegistry,
    private readonly board: BoardStore,
    private readonly plans: PlanStore,
    private readonly notes: TicketNoteStore,
  ) {}

  async execute(
    {
      worktreeId,
      task,
      mode,
      board_task_id,
      review_note_id,
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
      const refusal = await this.runner.executeRefusal(
        id.team,
        board_task_id,
        worktreeId,
      );
      if (refusal) return `Can't open an execute session: ${refusal}`;
      // Drift guard: the ticket's slug is the single source of truth for its shared branch. If this
      // worktree already sits on a DIFFERENT shared branch (e.g. a manual create_worktree(shared:)),
      // refuse — otherwise ensureShared keeps the stale branch and the sibling grouping diverges.
      if (board_task_id !== undefined && boardTask && worktree.sharedBranch) {
        const want = this.worktrees.sharedBranchName(
          boardTask.sharedSlug ?? `ticket-${board_task_id}`,
        );
        if (worktree.sharedBranch !== want)
          return `Can't open an execute session: ${worktreeId} is on ${worktree.sharedBranch}, but ticket #${board_task_id} lands on ${want}. Use a fresh worktree for this ticket.`;
      }
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
      const plan = await this.plans.get(id.team, board_task_id);
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
    // Inline self-review findings by id so the owner doesn't retype them (the closed-session fallback;
    // the recommended path is reply_session into the still-open execute session).
    if (review_note_id !== undefined && board_task_id !== undefined) {
      const note = await this.notes
        .get(id.team, board_task_id, review_note_id)
        .catch(() => undefined);
      if (note) openingTask += `\n\n${reviewFindingsBlock(note.id, note.body)}`;
    }
    const { sessionId } = await this.openSession({
      identity: id,
      worktreeId,
      task,
      openingTask,
      mode,
      engine: engineName,
      boardTaskId: board_task_id,
      parentChatTrace: ctx.parentChatTrace,
    });
    // The board task starts EXECUTING once an execute session is live. CAS approved→executing AFTER
    // the session registered (a failed create can't strand the task), idempotent across owners (only
    // the first owner's start flips it; later owners find it already 'executing'). Stamp the execute
    // worktree + shared branch on this owner's plan row so the integration barrier finds them later.
    // Both best-effort — they must never fail the session that's already running.
    if (mode === 'execute' && board_task_id !== undefined && boardTask) {
      // Ensure the worktree is on the shared branch the TICKET names: its `shared_slug` (a feature
      // group landing on one PR), or `ticket-${id}` for standalone work. The drift guard above already
      // rejected a worktree sitting on a conflicting shared branch, so this is a no-op or a clean cut.
      const sharedBranch = await this.worktrees
        .ensureShared(
          worktreeId,
          boardTask.sharedSlug ?? `ticket-${board_task_id}`,
        )
        .catch(() => worktree.sharedBranch);
      await this.board
        .transition(id.team, board_task_id, 'approved', { status: 'executing' })
        .catch(() => undefined);
      await this.plans
        .setExecuteContext(id.team, board_task_id, {
          executeWorktreeId: worktreeId,
          sharedBranch: sharedBranch ?? worktree.sharedBranch,
        })
        .catch(() => undefined);
    }
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
    /** Best-effort link back to the spawning chat turn's trace (for Langfuse session linkage). */
    parentChatTrace?: ChatTracePointer;
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
      // A fresh execute session starts execution for this work — refresh the worktree against base.
      void this.runner.runSessionTurn(
        session.id,
        opts.openingTask,
        opts.parentChatTrace,
        opts.mode === 'execute',
      );
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
  review_note_id: reviewNoteField,
});

@HarnessTool()
export class ReplySessionTool implements IHarnessTool<
  typeof replySessionSchema
> {
  readonly name = 'reply_session';
  readonly description =
    "Send the next message into one of your open sessions — it keeps its full context, so follow-ups go here instead of a new session. This is how you feed review/revision notes back into a still-open planning or execute session. You're notified when the turn reports back; no need to keep chatting in the meantime.";
  readonly schema = replySessionSchema;

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
    private readonly notes: TicketNoteStore,
  ) {}

  async execute(
    {
      sessionId,
      message,
      mode,
      review_note_id,
    }: z.infer<typeof replySessionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.ownerBot !== ctx.identity.selfAgent)
      throw new Error(`Couldn't reply to ${sessionId}: not your session.`);
    // Inline self-review findings by id (the recommended fix path: feed the notes into this still-open
    // execute session). The harness loads the full note so the owner only writes how to proceed.
    let outgoing = message;
    if (review_note_id !== undefined && session.boardTaskId !== undefined) {
      const note = await this.notes
        .get(session.team, session.boardTaskId, review_note_id)
        .catch(() => undefined);
      if (note)
        outgoing = `${reviewFindingsBlock(note.id, note.body)}\n\n${message}`;
    }
    // The reply fires fire-and-forget and must run in a clean store so a LangGraph run's callbacks
    // don't bleed into the chat stream.
    let res: ActionResult = { ok: false };
    await AsyncLocalStorageProviderSingleton.getInstance().run(
      undefined,
      async () => {
        res = await this.runner.replySession(
          sessionId,
          outgoing,
          mode,
          ctx.parentChatTrace,
        );
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
    const { model, effort } = engineSpecForMode(bot, specCtx, session.mode);
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
