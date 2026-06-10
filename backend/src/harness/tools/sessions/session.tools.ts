import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { EmployeeRegistry } from '../../employees/employee.registry';
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
});

@HarnessTool()
export class CreateSessionTool
  implements IHarnessTool<typeof createSessionSchema>
{
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
  ) {}

  async execute(
    { worktreeId, task, mode }: z.infer<typeof createSessionSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const id = ctx.identity;
    const worktree = this.worktrees.get(worktreeId);
    if (!worktree)
      return `No worktree "${worktreeId}" — create one first (create_worktree) or check list_worktrees.`;
    // The engine is the employee's locked engine — there is no per-session override.
    const engineName = (
      this.employees.byId(id.selfAgent) ?? this.employees.fallbackOwner()
    ).engine;
    const session = await this.sessions.create({
      task,
      worktreeId,
      notifyThread: id.surface,
      engine: engineName,
      ownerBot: id.selfAgent,
      project: id.project,
      mode,
    });
    // Fire-and-forget: the turn runs in the background, the chat turn returns immediately.
    //
    // Detach the background turn from the conductor's streaming callback context. create_session
    // runs inside the chat graph's `streamMode: 'messages'` run, and LangChain propagates that
    // run's callbacks to nested runnables via AsyncLocalStorage. Without clearing the store, a
    // LangGraph turn's invoke() inherits the chat stream's message handler and its tokens/
    // tool-calls bleed into the main chat. run(undefined, …) roots the turn in a clean store.
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => {
      void this.runner.runSessionTurn(session.id, task);
    });
    return `Opened ${session.id} (${engineName}, ${mode}) in ${worktreeId}: "${task}". You're notified when it reports back; it stays open for follow-ups until you close_session it.`;
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
      "Switch the session's mode from this turn on — approve a plan by replying with 'execute'.",
    ),
});

@HarnessTool()
export class ReplySessionTool
  implements IHarnessTool<typeof replySessionSchema>
{
  readonly name = 'reply_session';
  readonly description =
    "Send the next message into one of your open sessions — it keeps its full context, so follow-ups go here instead of a new session. Also how a plan gets approved: reply with mode 'execute'. Calling this ENDS YOUR TURN; you're notified when the turn reports back.";
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
      return `Couldn't reply to ${sessionId}: not your session.`;
    // The reply fires fire-and-forget and must run in a clean store so a LangGraph run's callbacks
    // don't bleed into the chat stream.
    let res: ActionResult = { ok: false };
    await AsyncLocalStorageProviderSingleton.getInstance().run(
      undefined,
      async () => {
        res = await this.runner.replySession(sessionId, message, mode);
      },
    );
    return res.ok
      ? `Sent to ${sessionId}${mode ? ` (mode → ${mode})` : ''}; it's working and will report back.`
      : `Couldn't reply to ${sessionId}: ${res.reason}`;
  }
}

const closeSessionSchema = z.object({
  sessionId: z.string().describe('The session to close.'),
});

@HarnessTool()
export class CloseSessionTool
  implements IHarnessTool<typeof closeSessionSchema>
{
  readonly name = 'close_session';
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
export class CheckSessionTool
  implements IHarnessTool<typeof checkSessionSchema>
{
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
    const { model, effort } = this.employees.resolveWorkerModel(
      bot,
      session.mode,
    );
    const tier = `${session.mode} on ${model ?? `${session.engine} default`}${effort ? `, effort ${effort}` : ''}`;
    const header = `${session.id} [${session.status}] (${tier}, ${session.worktreeId}, turn ${session.turns}): "${session.task}"`;
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
export class ListSessionsTool
  implements IHarnessTool<typeof listSessionsSchema>
{
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
          `- ${s.id} [${s.status}] (${s.mode}, ${s.worktreeId}, turn ${s.turns}): "${s.task}"`,
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
    .describe('Without a query: which page of the transcript; 1 (default) = the most recent.'),
});

@HarnessTool()
export class SearchSessionTool
  implements IHarnessTool<typeof searchSessionSchema>
{
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
