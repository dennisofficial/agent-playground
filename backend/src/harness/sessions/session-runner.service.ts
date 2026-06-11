import { Inject, Injectable, Logger } from '@nestjs/common';
import { EngineRegistry } from '../engines/engine.registry';
import { withActiveRoot } from '../engines/guard';
import type { WorkerEvent, WorkerMode } from '../engines/worker-engine.port';
import { EmployeeRegistry } from '../employees/employee.registry';
import { PersonaService } from '../employees/persona.service';
import { CredentialContext } from '../llm-keys/credential-context';
import { TenantCredentialService } from '../llm-keys/tenant-credential.service';
import { WorklogStore } from '../memory/worklog-store';
import { WorktreeService } from '../worktrees/worktree.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from './session-registry.port';

/**
 * Runs the employees' background sessions, one turn at a time. A turn is one engine run inside the
 * session's worktree: the engine loops internally until it has a report, the report lands as
 * `lastReport`, and the session goes 'idle' — OPEN, waiting for its owner to reply into it
 * (replySession), relay the outcome, or close it (closeSession). Every turn-end is the wake signal
 * the conductor relays through the owner bot; there is no STATUS-line protocol and no turn cap —
 * the owner drives the conversation, like an engineer driving Claude Code.
 */

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

/** One transcript event rendered as a single narratable line. */
function renderEvent(e: WorkerEvent): string {
  if (e.kind === 'text') return `thinking: ${e.text.slice(0, 300)}`;
  if (e.kind === 'tool')
    return `→ called ${e.name}${e.detail ? ` (${e.detail.slice(0, 200)})` : ''}`;
  return `report: ${e.text.slice(0, 300).replace(/\s+/g, ' ')}`;
}

const TRANSCRIPT_PAGE_SIZE = 40;
const TRANSCRIPT_MAX_MATCHES = 30;

@Injectable()
export class SessionRunnerService {
  private readonly logger = new Logger(SessionRunnerService.name);

  // Live AbortControllers for in-flight turns, keyed by session id — the handle closeSession
  // aborts. (In-process for now; when workers move to containers this becomes a remote stop signal.)
  private controllers = new Map<string, AbortController>();

  constructor(
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly engines: EngineRegistry,
    private readonly employees: EmployeeRegistry,
    private readonly persona: PersonaService,
    private readonly worklog: WorklogStore,
    private readonly worktrees: WorktreeService,
    private readonly creds: TenantCredentialService,
    private readonly credCtx: CredentialContext,
  ) {}

  /**
   * Run one session turn to its report. `message` is the opening task on the first turn, or the
   * owner's reply on later ones. Fire-and-forget — errors are caught here so there's never an
   * unhandled rejection.
   */
  async runSessionTurn(sessionId: string, message: string): Promise<void> {
    // Everything — including the registry read — runs inside the try: callers fire-and-forget
    // (`void runSessionTurn(...)`), so a rejection escaping this method would vanish and leave the
    // session stuck in 'running' forever with no failure relay.
    const ac = new AbortController();
    this.controllers.set(sessionId, ac);
    try {
      const session = await this.sessions.get(sessionId);
      if (!session) return;
      const bot =
        this.employees.byId(session.ownerBot) ?? this.employees.fallbackOwner();
      const worktree = this.worktrees.get(session.worktreeId);
      if (!worktree) {
        throw new Error(
          `Worktree "${session.worktreeId}" no longer exists — the session has nowhere to run.`,
        );
      }
      // Per-turn model tiering: a 'plan' turn runs on a high-reasoning model + max effort, an
      // 'execute' turn on the cheaper everyday model. `mode` also drives the engine's read-only
      // posture at the seam.
      const { model, effort } = this.employees.resolveWorkerModel(
        bot,
        session.mode,
      );

      this.logger.log(
        `${sessionId} turn ${session.turns + 1} — ${session.mode} on ${model ?? `${session.engine} default`}${effort ? ` (effort:${effort})` : ''} (${bot.name}, ${worktree.id})`,
      );
      // Resolve THIS workspace's keys: passed into the claude/codex subprocess env (apiKey) AND
      // stashed in the credential context for the in-process langgraph engine's model builder.
      const keys = await this.creds.resolve(session.team);
      const engineKey =
        session.engine === 'codex' ? keys.openai : keys.anthropic;
      // Jail the in-process langgraph tools to the worktree for the turn (claude/codex also get
      // `cwd` for their own subprocess sandbox).
      const { result, sessionId: engineSessionId } = await withActiveRoot(
        worktree.path,
        () =>
          this.credCtx.run({ teamId: session.team, keys }, () =>
            this.engines.get(session.engine).run({
              task: message,
              cwd: worktree.path,
              systemPrompt: this.persona.workerPromptFor(bot),
              sessionId: session.engineSessionId,
              model,
              effort,
              mode: session.mode,
              apiKey: engineKey,
              onEvent: (e) =>
                void this.sessions
                  .appendProgress(sessionId, e)
                  .catch((err) =>
                    this.logger.warn(
                      `appendProgress(${sessionId}) failed: ${err}`,
                    ),
                  ),
              signal: ac.signal,
            }),
          ),
      );
      // Closed while we were finishing up: discard the result, don't go idle or relay. The abort
      // flag alone isn't enough — closeSession writes 'closed' BEFORE calling abort(), so an engine
      // that resolves inside that window would see aborted=false and overwrite the close with
      // 'idle' (and relay a result the owner explicitly discarded). Re-reading the live status
      // closes that race: only a still-'running' session may be finalized here.
      if (ac.signal.aborted) return;
      const live = await this.sessions.get(sessionId);
      if (!live || live.status !== 'running') return;

      await this.sessions.update(sessionId, {
        status: 'idle',
        engineSessionId,
        lastReport: result || '(no report)',
        turns: session.turns + 1,
      });
    } catch (err) {
      // An abort surfaces here as a thrown error — that's a close, not a failure; closeSession
      // already finalized the status. The updates are themselves guarded (a registry rejection here
      // must not escape the fire-and-forget caller) and never overwrite a status closeSession wrote.
      try {
        if (
          !ac.signal.aborted &&
          (await this.sessions.get(sessionId))?.status === 'running'
        ) {
          await this.sessions.update(sessionId, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (updateErr) {
        this.logger.error(
          `Failed to record session ${sessionId} failure: ${updateErr}`,
        );
      }
    } finally {
      this.controllers.delete(sessionId);
    }
  }

  /**
   * Send the owner's next message into an open session — the conversation continues with full
   * engine context. Valid on 'idle' (the normal case) and 'failed' (a reply retries on the same
   * engine session). An optional `mode` switches the session for this and subsequent turns — this
   * is the plan-approval lever: replying with mode 'execute' lets a planned change be built.
   */
  async replySession(
    sessionId: string,
    message: string,
    mode?: WorkerMode,
  ): Promise<ActionResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: `No session "${sessionId}".` };
    if (session.status === 'running') {
      return {
        ok: false,
        reason: `${sessionId} is mid-turn — wait for it to report back (or close it).`,
      };
    }
    if (session.status === 'closed') {
      return {
        ok: false,
        reason: `${sessionId} is closed — open a new session for new work.`,
      };
    }
    await this.sessions.update(sessionId, {
      status: 'running',
      ...(mode ? { mode } : {}),
    });
    void this.runSessionTurn(sessionId, message);
    return { ok: true };
  }

  /**
   * Close a session its owner is done with. Mid-turn ('running') the in-flight run is aborted and
   * its result discarded; 'idle'/'failed' sessions just close. Closing is when completed work is
   * logged (a close with a report = a finished thread of work) — the worktree stays.
   */
  async closeSession(sessionId: string): Promise<ActionResult> {
    const session = await this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: `No session "${sessionId}".` };
    if (session.status === 'closed') {
      return { ok: false, reason: `${sessionId} is already closed.` };
    }
    const controller = this.controllers.get(sessionId);
    await this.sessions.update(sessionId, { status: 'closed' }); // mark first so the turn race re-read sees it
    controller?.abort();
    if (session.lastReport) {
      // Durable record so standups / "what did you do" have a real answer.
      await this.worklog
        .logWork({
          team: session.team,
          ownerBot: session.ownerBot,
          project: session.project,
          task: session.task,
          summary: session.lastReport.slice(0, 600),
        })
        .catch(() => {});
    }
    return { ok: true };
  }

  /** Render a session's recent steps as a compact, narratable string for `check_session`. */
  async getSessionActivity(sessionId: string): Promise<string> {
    const events = await this.sessions.progress(sessionId);
    if (events.length === 0) return 'No activity yet — just getting started.';
    return events.slice(-12).map(renderEvent).join('\n') || 'Working…';
  }

  /**
   * Look through a session's FULL transcript — every thinking step, tool call, and report across
   * all its turns — the way an engineer scrolls back through a Claude Code transcript. With a
   * `query`: matching lines (case-insensitive), each tagged with its line number. Without: one page
   * of lines, `page` 1 = the most recent page, 2 = the one before, …
   */
  async searchTranscript(
    sessionId: string,
    opts: { query?: string; page?: number } = {},
  ): Promise<string> {
    const events = await this.sessions.progress(sessionId);
    if (events.length === 0) return 'No activity yet — nothing to search.';
    const lines = events.map((e, i) => `[${i + 1}] ${renderEvent(e)}`);

    if (opts.query) {
      const q = opts.query.toLowerCase();
      const matches = lines.filter((l) => l.toLowerCase().includes(q));
      if (matches.length === 0)
        return `No transcript lines match "${opts.query}" (${lines.length} lines total).`;
      const shown = matches.slice(0, TRANSCRIPT_MAX_MATCHES);
      const more =
        matches.length > shown.length
          ? `\n…and ${matches.length - shown.length} more matches — narrow the query.`
          : '';
      return `${matches.length} of ${lines.length} transcript lines match "${opts.query}":\n${shown.join('\n')}${more}`;
    }

    const pages = Math.max(1, Math.ceil(lines.length / TRANSCRIPT_PAGE_SIZE));
    const page = Math.min(Math.max(opts.page ?? 1, 1), pages);
    // page 1 = the END of the transcript (most recent), counting backward.
    const end = lines.length - (page - 1) * TRANSCRIPT_PAGE_SIZE;
    const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
    return `Transcript lines ${start + 1}–${end} of ${lines.length} (page ${page}/${pages}, 1 = latest):\n${lines.slice(start, end).join('\n')}`;
  }

  /** Abort every in-flight turn (graceful shutdown). */
  abortAll(): void {
    for (const [sessionId, controller] of this.controllers) {
      this.logger.log(`Aborting in-flight session ${sessionId} (shutdown)`);
      controller.abort();
    }
  }
}
