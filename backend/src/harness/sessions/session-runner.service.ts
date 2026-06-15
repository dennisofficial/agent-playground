import { EnvService } from '@core/config/env/env.service';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ChatTracePointer, traceSessionTurn } from '@workspace/langfuse';
import { EngineRegistry } from '../engines/engine.registry';
import { withActiveRoot } from '../engines/guard';
import {
  EWorkerEngineName,
  WorkerEvent,
  WorkerMode,
} from '../engines/worker-engine.port';
import { toGenerationUsage } from '../llm/usage-format';
import { engineSpecForMode } from '../employees/engine-for-mode';
import { EmployeeRegistry } from '../employees/employee.registry';
import { PersonaService } from '../employees/persona.service';
import { LifecycleRunner } from '../lifecycle/lifecycle.runner';
import { LifecycleEvent } from '../lifecycle/lifecycle.types';
import { CredentialContext } from '../llm-keys/credential-context';
import { TenantCredentialService } from '../llm-keys/tenant-credential.service';
import { BoardStore } from '../memory/board-store';
import { PlanStore } from '../memory/plan-store';
import { TeamSettingsStore } from '../memory/team-settings-store';
import { WorklogStore } from '../memory/worklog-store';
import { MetricsEventsService } from '../metrics/metrics-events.service';
import { WorktreeService } from '../worktrees/worktree.service';
import { coherenceNote, echoesOwnName } from './coherence-check';
import { renderQaAppendix, renderQuestionsReport } from './question-report';
import {
  SESSION_REGISTRY,
  type Session,
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
    private readonly lifecycle: LifecycleRunner,
    private readonly worklog: WorklogStore,
    private readonly worktrees: WorktreeService,
    private readonly creds: TenantCredentialService,
    private readonly credCtx: CredentialContext,
    private readonly metrics: MetricsEventsService,
    private readonly board: BoardStore,
    private readonly env: EnvService,
    private readonly plans: PlanStore,
    private readonly settings: TeamSettingsStore,
  ) {}

  /**
   * Refresh a worktree against its base branch when execution starts, and return a PREAMBLE to
   * prepend to the turn's opening message. Empty string on a clean refresh (or a benign "no base to
   * track" — unregistered local dev); otherwise a one-line heads-up so the bot knows it may be on a
   * stale base. A merge conflict gets the strongest preamble (resolve it first); a dirty tree / fetch
   * miss / contention / error each get an actionable note pointing at `refresh_worktree`. Never
   * throws — staleness must not block the turn.
   */
  private async baseRefreshPreamble(
    sessionId: string,
    worktree: { id: string },
  ): Promise<string> {
    const end = '\n\n';
    const otherLive = (
      await this.sessions.list({ worktreeId: worktree.id })
    ).some((s) => s.id !== sessionId && s.status === 'running');
    if (otherLive) {
      this.logger.warn(
        `${sessionId}: another session is mid-turn in ${worktree.id} — skipping base refresh`,
      );
      return `Heads up: this worktree wasn't updated against the base branch because another session is mid-turn in it — your base may be behind. Run \`refresh_worktree\` once it's free if you need the latest.${end}`;
    }
    try {
      const r = await this.worktrees.refreshFromBase(worktree.id);
      const base = r.baseBranch ?? 'the base branch';
      if (r.conflicted) {
        this.logger.log(
          `${sessionId}: base refresh hit conflicts (${r.baseBranch}) — handing them to the turn`,
        );
        return `Before anything else: a merge of the base branch \`${base}\` into this worktree is IN PROGRESS with conflicts in: ${(r.files ?? []).join(', ') || '(unknown files)'}. Resolve the conflicts, commit the merge, then continue.${end}`;
      }
      if (r.refreshed) {
        this.logger.log(
          `${sessionId}: refreshed ${worktree.id} from ${r.baseBranch}`,
        );
        return '';
      }
      if (r.dirty) {
        this.logger.warn(
          `${sessionId}: base refresh skipped (${worktree.id}) — dirty working tree`,
        );
        return `Heads up: this worktree wasn't updated against \`${base}\` because it has uncommitted changes — your base may be behind. Commit your work, then run \`refresh_worktree\` before relying on it.${end}`;
      }
      if (r.baseBranch) {
        // Has a base to track but it didn't land (e.g. fetch miss) — actionable staleness.
        this.logger.warn(
          `${sessionId}: base refresh did not land (${worktree.id}) — ${r.detail ?? 'unknown reason'}`,
        );
        return `Heads up: this worktree wasn't updated against \`${base}\` (${r.detail ?? 'the refresh did not land'}) — your base may be behind. Run \`refresh_worktree\` to retry when ready.${end}`;
      }
      // No base branch to track at all (unregistered / guard) — working on local state is expected;
      // a heads-up would be noise (and `refresh_worktree` would no-op too).
      this.logger.log(`${sessionId}: base refresh no-op — ${r.detail}`);
      return '';
    } catch (err) {
      this.logger.warn(
        `${sessionId}: base refresh failed (${worktree.id}), proceeding on local state: ${err}`,
      );
      return `Heads up: this worktree couldn't be updated against the base branch (an error occurred) — your base may be behind. Run \`refresh_worktree\` to retry; if it keeps failing, flag it to Dennis.${end}`;
    }
  }

  /**
   * Run one session turn to its report. `message` is the opening task on the first turn, or the
   * owner's reply on later ones. Fire-and-forget — errors are caught here so there's never an
   * unhandled rejection.
   */
  async runSessionTurn(
    sessionId: string,
    message: string,
    parentChatTrace?: ChatTracePointer,
    enteringExecute = false,
  ): Promise<void> {
    // Everything — including the registry read — runs inside the try: callers fire-and-forget
    // (`void runSessionTurn(...)`), so a rejection escaping this method would vanish and leave the
    // session stuck in 'running' forever with no failure relay.
    const ac = new AbortController();
    const startedAt = Date.now();
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
      // Entering execute (a fresh execute session, or a plan→execute flip): bring the worktree up
      // to date with the base branch before the engine runs. A worktree cut during stand-up is
      // stale by now (base moved while it sat idle / between sequential tickets). Skip if ANOTHER
      // session is mid-turn in the same checkout (a merge would mutate files under it) — this
      // session is already 'running', so it's excluded. The base merge never blocks the turn: a
      // CONFLICT is handed to the engine to resolve as its first act, and every OTHER non-clean
      // outcome (dirty tree, fetch miss, contention, error) is surfaced to the bot as a heads-up so
      // it knows it may be on a stale base and can `refresh_worktree` after committing.
      if (enteringExecute) {
        message = (await this.baseRefreshPreamble(sessionId, worktree)) + message;
      }
      // Per-turn spec from the employee, by mode: 'plan' → plan recipe, 'investigate' → investigate
      // recipe (execute's engine on a top-tier model), else the execute recipe (model/effort/
      // systemPrompt). Byte-stable across turns; `mode` also drives the engine's read-only posture at
      // the seam. `session.engine` (fixed at create) is the source of truth for WHICH engine — an
      // engine-changing mode flip is refused at replySession, so the resolved spec's engine always
      // matches it (investigate keeps execute's engine, so the flip into it is never engine-changing).
      const ctx = this.persona.context();
      const spec = engineSpecForMode(bot, ctx, session.mode);
      const { model, effort, systemPrompt } = spec;

      this.logger.log(
        `${sessionId} turn ${session.turns + 1} — ${session.mode} on ${model ?? `${session.engine} default`}${effort ? ` (effort:${effort})` : ''} (${bot.name}, ${worktree.id})`,
      );
      // Resolve THIS workspace's keys: passed into the claude/codex subprocess env (apiKey) AND
      // stashed in the credential context for the in-process langgraph engine's model builder.
      const keys = await this.creds.resolve(session.team);
      const engineKey =
        session.engine === EWorkerEngineName.CODEX
          ? keys.openai
          : keys.anthropic;
      // Jail the in-process langgraph tools to the worktree for the turn (claude/codex also get
      // `cwd` for their own subprocess sandbox).
      // The single engine run for this turn, parametrized by message / model / resume-id.
      // `systemPrompt`/`effort`/`mode` are constant for the turn.
      const runEngineTurn = (
        turnMessage: string,
        turnModel: string | undefined,
        resumeId: string | undefined,
      ) =>
        withActiveRoot(worktree.path, () =>
          this.credCtx.run({ teamId: session.team, keys }, () =>
            this.engines.get(session.engine).run({
              task: turnMessage,
              cwd: worktree.path,
              systemPrompt,
              agentId: bot.id,
              sessionId: resumeId,
              model: turnModel,
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
      // Langfuse: ONE observation per engine run (its own trace, grouped by the harness session
      // id) — the engine work (system prompt, the real opening/reply message, the report) is
      // otherwise invisible (subprocess engines emit no spans; this turn is ALS-detached from the
      // chat stream). `parentChatTrace` links it back to the spawning chat turn. No-op when tracing
      // is off. NOTE: pass NO LangChain callbacks into the engine — that would re-bleed tokens into
      // the chat stream the detach exists to prevent.
      const runTraced = (
        turnMessage: string,
        turnModel: string | undefined,
        resumeId: string | undefined,
      ) =>
        traceSessionTurn(
          () => runEngineTurn(turnMessage, turnModel, resumeId),
          {
            name: `session.turn:${session.engine}:${session.mode}`,
            asType: 'generation',
            sessionId,
            input: turnMessage,
            metadata: {
              model: turnModel,
              effort,
              mode: session.mode,
              engine: session.engine,
              boardTaskId: session.boardTaskId,
              agentId: bot.id,
              worktree: worktree.id,
              turn: session.turns + 1,
              parentChatTrace,
            },
            usage: (r) => toGenerationUsage(r.usage),
          },
        );

      const first = await runTraced(message, model, session.engineSessionId);
      const result = first.result;
      const engineSessionId = first.sessionId;
      const { questions, planText } = first;

      // Closed while we were finishing up: discard the result, don't go idle or relay. The abort
      // flag alone isn't enough — closeSession writes 'closed' BEFORE calling abort(), so an engine
      // that resolves inside that window would see aborted=false and overwrite the close with
      // 'idle' (and relay a result the owner explicitly discarded). Re-reading the live status
      // closes that race: only a still-'running' session may be finalized here.
      if (ac.signal.aborted) return;
      const live = await this.sessions.get(sessionId);
      if (!live || live.status !== 'running') return;

      // A turn that ASKED is a questions-report — even if a (partial) plan was captured too: a
      // plan with unanswered questions isn't approvable. A finished plan carries its planning Q&A
      // appendix so every decision made along the way is visible at approval. `lastReportKind` is
      // written on EVERY turn-end (undefined clears it) so a stale kind never survives.
      // Engine-neutral plan artifact: only ClaudeEngine has a native plan-capture signal (its
      // ExitPlanMode capture, surfaced as `planText` and folded into `result`). Engines WITHOUT one
      // (Codex/LangGraph) would otherwise never classify a plan, so for a BOARD-LINKED plan turn that
      // finished without questions, their report IS the plan — they attach and self-review too.
      // Claude keeps its precise signal: a plan-mode status update that captured no plan must not
      // clobber the attached plan.
      const engineCapturesPlan = session.engine === EWorkerEngineName.CLAUDE;
      const isBoardLinkedPlanTurn =
        !engineCapturesPlan &&
        session.mode === 'plan' &&
        session.boardTaskId !== undefined &&
        !questions?.length;
      const planBody = planText ?? result; // result == the plan for Claude; the report otherwise
      const kind = questions?.length
        ? ('questions' as const)
        : planText || isBoardLinkedPlanTurn
          ? ('plan' as const)
          : undefined;
      const qa = live.qa ?? [];

      // PLAN.FINISHED lifecycle hooks: for a board-linked plan turn, fire the engine-agnostic
      // lifecycle runner. Employees that declare a blocking `plan.finished` hook (the self-review
      // capability — engineers, not Sam) transform the plan here: a different engine critiques it and
      // the planning engine revises once. The runner is best-effort (it isolates failures/aborts and
      // keeps the prior payload) and may replace only planBody + engineSessionId (the transform
      // contract). Sam's plans declare no hook → the runner returns the payload unchanged.
      let finalPlanBody = planBody;
      let attachEngineSessionId = engineSessionId;
      if (
        kind === 'plan' &&
        session.boardTaskId !== undefined &&
        !ac.signal.aborted
      ) {
        const reviewed = await this.lifecycle.run(LifecycleEvent.PlanFinished, {
          employee: bot,
          session,
          planBody,
          engineSessionId,
          worktreePath: worktree.path,
          keys,
          signal: ac.signal,
          onProgress: (e) =>
            void this.sessions
              .appendProgress(sessionId, e)
              .catch(() => undefined),
        });
        finalPlanBody = reviewed.planBody;
        attachEngineSessionId = reviewed.engineSessionId;
      }
      // Closed (and thus aborted) while a hook ran: don't finalize over the close.
      if (ac.signal.aborted) return;

      const lastReport =
        kind === 'questions'
          ? renderQuestionsReport(questions!, planText)
          : kind === 'plan'
            ? qa.length
              ? `${finalPlanBody}\n\n${renderQaAppendix(qa)}`
              : finalPlanBody
            : result || '(no report)';
      // NO auto-attach. A finished plan RELAYS to the owning employee (the relay prompt tells it to
      // review and submit_plan); the employee's explicit submit_plan is what attaches it to the
      // ticket. This is the employee gating its own engine's plan, like a person reviewing their
      // Claude Code's plan before pushing it.
      //
      // Coherence canary: prose-report turns only (kind === undefined) — plan/questions artifacts
      // are never flagged (their format differs intentionally). When the worker drops its name
      // prefix the note rides along in lastReport, reaching the owner via the relay prompt,
      // check_session, and the close-time worklog — no new plumbing required.
      const degraded =
        kind === undefined &&
        result.trim() !== '' &&
        !echoesOwnName(result, bot.name);
      await this.sessions.update(sessionId, {
        status: 'idle',
        engineSessionId: attachEngineSessionId,
        lastReport: degraded
          ? lastReport + coherenceNote(bot.name)
          : lastReport,
        lastReportKind: kind,
        turns: session.turns + 1,
      });
      if (session.mode === 'execute') {
        await this.metrics
          .recordExecutionCompleted({
            teamId: session.team,
            agentId: session.ownerBot,
            projectId: session.project,
            sessionId,
            durationMs: Date.now() - startedAt,
          })
          .catch((metricsErr) =>
            this.logger.warn(
              `recordExecutionCompleted(${sessionId}) failed: ${metricsErr}`,
            ),
          );
      }
    } catch (err) {
      // An abort surfaces here as a thrown error — that's a close, not a failure; closeSession
      // already finalized the status. The updates are themselves guarded (a registry rejection here
      // must not escape the fire-and-forget caller) and never overwrite a status closeSession wrote.
      try {
        const live = await this.sessions.get(sessionId);
        if (!ac.signal.aborted && live?.status === 'running') {
          await this.sessions.update(sessionId, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          if (live.mode === 'execute') {
            await this.metrics
              .recordExecutionBlocked({
                teamId: live.team,
                agentId: live.ownerBot,
                projectId: live.project,
                sessionId,
                durationMs: Date.now() - startedAt,
                reason: err instanceof Error ? err.message : String(err),
              })
              .catch((metricsErr) =>
                this.logger.warn(
                  `recordExecutionBlocked(${sessionId}) failed: ${metricsErr}`,
                ),
              );
          }
        }
      } catch (updateErr) {
        this.logger.error(
          `Failed to record session ${sessionId} failure: ${String(updateErr)}`,
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
    parentChatTrace?: ChatTracePointer,
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
    // Engine guard (constraint #4): a session is pinned to its create-time engine for its life. A
    // mode flip that would need a DIFFERENT engine than the session runs on is refused — open a fresh
    // session in that mode instead. (For every current employee plan/execute share an engine, so this
    // only bites a future divergent config; it prevents silent wrong-engine execution.)
    if (mode && mode !== session.mode) {
      const bot =
        this.employees.byId(session.ownerBot) ?? this.employees.fallbackOwner();
      const ctx = this.persona.context();
      const targetEngine = engineSpecForMode(bot, ctx, mode).engine;
      if (targetEngine !== session.engine) {
        return {
          ok: false,
          reason: `${sessionId} runs on ${session.engine}; switching to '${mode}' needs the ${targetEngine} engine. Open a fresh ${mode} session instead.`,
        };
      }
    }
    // The approval gate, BEFORE any mutation — a refused flip must not record Q&A or change status.
    if (mode === 'execute') {
      const refusal = await this.executeRefusal(
        session.team,
        session.boardTaskId,
      );
      if (refusal) return { ok: false, reason: refusal };
    }
    // An answer to a questions-report goes on the Q&A ledger — the only way to continue an asking
    // session is through here, so every answer (Dennis-sourced or self-answered) gets recorded.
    const qaPatch =
      session.lastReportKind === 'questions' && session.lastReport
        ? { qa: [...(session.qa ?? []), { q: session.lastReport, a: message }] }
        : {};
    // A real transition INTO execute (plan→execute flip) starts execution for this work — refresh
    // the worktree against base. `session.mode` is still the pre-update value here.
    const enteringExecute = mode === 'execute' && session.mode !== 'execute';
    await this.sessions.update(sessionId, {
      status: 'running',
      ...(mode ? { mode } : {}),
      ...qaPatch,
    });
    void this.runSessionTurn(
      sessionId,
      message,
      parentChatTrace,
      enteringExecute,
    );
    return { ok: true };
  }

  /**
   * Why an execute turn on this work is not allowed yet — or null when it is. Gates, all skipped on
   * dial 'off': (1) a ticket already 'in_review' (its PR is up, Dennis is looking) bypasses every
   * gate — addressing review feedback is NOT "starting new work", the original approval covers it;
   * (2) an OPEN STANDUP pauses every other execute flip team-wide (approved or not — approval at the
   * sitting isn't GO; the lead's close_standup is); (3) the EXECUTION_APPROVAL_MODE dial: 'all' =
   * every execute turn needs a linked board task in 'approved' (or 'done'/'in_review'); 'linked' =
   * only board-linked sessions are gated. Unknown dial values fail closed to 'all'. Also used by
   * create_session for execute-mode opens, so a fresh session can't bypass the gate.
   */
  async executeRefusal(
    team: string,
    boardTaskId: number | undefined,
  ): Promise<string | null> {
    const dial = this.env.get('EXECUTION_APPROVAL_MODE');
    if (dial === 'off') return null;
    const task =
      boardTaskId !== undefined
        ? await this.board.get(team, boardTaskId)
        : undefined;
    if (boardTaskId !== undefined && !task)
      return `linked board task #${boardTaskId} no longer exists — fix the link before executing.`;
    // Review-feedback loop: a ticket in review stays executable through every round, standup or not.
    if (task?.status === 'in_review') return null;
    if (await this.settings.isStandupOpen(team)) {
      return `the standup is still OPEN — approved or not, nothing starts executing until the team lead closes it (close_standup). Keep planning or wait for the all-clear in the channel.`;
    }
    if (boardTaskId === undefined) {
      return dial === 'linked'
        ? null
        : `execution currently requires an APPROVED board task and this session isn't linked to one. Board the work (add_board_task), open the session with board_task_id, and plan first — your plan attaches to the ticket, Sam reviews it and proposes it, and Dennis approves. Then execute.`;
    }
    // 'approved' (first execute session — the approved→executing CAS in CreateSessionTool flips it),
    // 'executing' (work in flight — continuing turns and additional owners), and 'done' all execute.
    // 'self_review' is HERE too: after the integration self-review hands the owner the ship-or-fix
    // decision, a legitimate fix pass runs in their execute session (reply_session, or a fresh execute
    // session for the closed-session fallback) while the ticket sits in self_review.
    if (
      task!.status === 'approved' ||
      task!.status === 'executing' ||
      task!.status === 'self_review' ||
      task!.status === 'done'
    )
      return null;
    return `board task #${boardTaskId} is '${task!.status}' — work executes only AFTER Dennis approves it. Your finished plan is attached to the ticket; @Sam reviews it, proposes the ticket to Dennis (propose_plan), and Dennis's approval + the standup closing unlock execution.`;
  }

  /**
   * Resume a session for ONE awaited turn, HARNESS-INITIATED — deliberately bypasses executeRefusal
   * (that gate guards a bot's own tool calls, not the harness's review pipeline). The review
   * pipeline's bounded fix loop and conflict-resolution call this; the bot never reaches a
   * 'self_review' session through a tool. Sets the session running in `mode`, awaits the turn, and
   * returns the resulting session ('idle' with lastReport, or 'failed'). A timeout aborts the turn.
   * `enteringExecute` is false — the work already lives in the worktree; an internal fix/resolve turn
   * must NOT trigger a base refresh that could clobber an in-progress merge.
   */
  async resumeInternal(
    sessionId: string,
    prompt: string,
    opts: { mode?: WorkerMode; timeoutMs?: number } = {},
  ): Promise<Session | undefined> {
    const mode: WorkerMode = opts.mode ?? 'execute';
    const session = await this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.status === 'closed') return session;
    if (session.status === 'running')
      throw new Error(
        `session ${sessionId} is mid-turn — cannot resume it internally`,
      );
    await this.sessions.update(sessionId, { status: 'running', mode });
    const turn = this.runSessionTurn(sessionId, prompt, undefined, false);
    if (opts.timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.controllers.get(sessionId)?.abort();
          resolve();
        }, opts.timeoutMs);
      });
      await Promise.race([turn, timeout]);
      if (timer) clearTimeout(timer);
    } else {
      await turn;
    }
    return this.sessions.get(sessionId);
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
