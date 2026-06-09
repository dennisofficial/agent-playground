import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
import { executeApprovedPlan, stripStatusLine } from './approval.js';
import { getBoard } from './board/index.js';
import { type BotStateDelta, getBotGraph } from './bot-graph.js';
import { channel } from './channel.js';
import { type ConductorEvent, type ContextUsage, type MessageUsage } from './conductor-events.js';
import { type Employee, ROSTER, botById } from './employees/index.js';
import { type Job, getJob, listJobs, onJobUpdate } from './jobs.js';
import { DEFAULT_PROJECT, DEFAULT_TEAM, type Identity } from './memory/identity.js';
import { ticketStatusAfterExecute } from './ticket-completion.js';
import { type ActionResult, continueWork } from './worker.js';

/**
 * The dispatcher: a thin event loop around the shared `channel`. You append to the channel and move on
 * (never blocked); bots are independent reactive agents that run CONCURRENTLY. Each bot consumes the
 * channel exactly once via a per-bot cursor (`deliveredUpTo`), gated for respond/acknowledge/ignore, and
 * emits its own messages back as they're produced so teammates see them. This is the Slack model; the
 * `channel` + this dispatcher are the seam a Slack adapter replaces.
 *
 * Each turn runs on the bot's LangGraph turn-graph ([bot-graph.ts](bot-graph.ts)): gate → fetch → llm ⇄
 * tools → reconcile (or the ack/ignore drain). The graph is the bot's BRAIN — it owns the gate, the
 * mid-step channel re-read, the deterministic memory fetch/reconcile, and the checkpoint. The conductor
 * is just the event loop: scheduling, the cursor's coordinate space, and channel writes. It is UI-agnostic
 * — it emits a stream of domain `ConductorEvent`s (see [conductor-events.ts](conductor-events.ts)) that a
 * presentation surface (the terminal UI today, a Slack adapter or logger later) subscribes to and renders.
 */

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Flatten message content (string | content blocks) to a plain string — how we read what a bot said. */
const messageText = (content: BaseMessage['content']): string =>
  typeof content === 'string'
    ? content
    : content
        .map((c) =>
          typeof c === 'string' ? c : 'text' in c && typeof c.text === 'string' ? c.text : '',
        )
        .join('');

interface ToolCall {
  id?: string;
  name: string;
}

/** A short HH:MM:SS stamp for the transcript — handy for eyeballing the async/parallel flow. */
const clock = (): string =>
  new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

// ── Autonomy loop caps — TEMPORARILY UNCAPPED (2026-06-09, Dennis) ──────────────────────────────────
// Running the team fully unthrottled while we develop/observe it attended. The old caps reset on a HUMAN
// message, which throttles legitimate collaboration once no human is in the loop to reset them. Safety
// right now is the human watching the channel and killing the process. When unattended operation needs a
// real backstop, these get REPLACED (not lowered) by a progress-gated breaker — reset on work/triggers,
// trip on talk-without-work — and a token/$ cost ceiling. See memory `agent-playground-autonomy-endgoal`.
// To restore the prior guards: MAX_BOT_BURST = 50, MAX_TURN_STEPS = 200.

/** Bot RESPONSE turns between human messages before bot↔bot traffic is force-ignored. `Infinity` = no cap
 * (the `botBurst >= MAX_BOT_BURST` check is never true), so bots collaborate without a turn limit. */
const MAX_BOT_BURST = Number.POSITIVE_INFINITY;

/** Max LangGraph super-steps in a SINGLE bot turn (`llm ⇄ tools`). Effectively uncapped — finite only
 * because LangGraph's `recursionLimit` requires a real number; at ~2 steps/tool-call this is a "never" in
 * practice. It still pauses GRACEFULLY if somehow reached (see `handleStepCap`), so it's a harmless
 * last-resort guard on a single turn's tool loop, not an autonomy throttle. */
const MAX_TURN_STEPS = 1_000_000;

// ── Crash safety (NOT an autonomy throttle — kept on purpose) ───────────────────────────────────────
/** Attempts before the conductor gives up on a turn that keeps ERRORING without progress (drops + logs).
 * This only ever fires on a crashing turn; removing it wouldn't free autonomy, it would let a broken turn
 * re-bill forever. So it stays even while the autonomy caps above are off. */
const MAX_TURN_RETRIES = 3;

/** Ephemeral, overwrite-style status that drives the spinner/footer — a pull snapshot (`getStatus`),
 * distinct from the append-only `ConductorEvent` stream. A presentation surface that doesn't need a
 * spinner (e.g. a Slack adapter) simply never reads this. */
export interface ConductorStatus {
  /** True while any bot is working (drives the spinner; input stays live regardless). */
  busy: boolean;
  ctx: ContextUsage;
  /** Count of running background JOBS (footer). */
  running: number;
  /** Who the CLI is currently speaking as (lowercased id). */
  speaker: string;
  /** Display names of bots currently working a turn. */
  thinking: string[];
}

class Conductor {
  private state: ConductorStatus = {
    busy: false,
    ctx: {},
    running: 0,
    speaker: 'dennis',
    thinking: [],
  };
  /** Status-change subscribers (spinner/footer). The append-only event stream is `eventSubs`. */
  private subs = new Set<() => void>();
  /** Domain-event subscribers — the presentation seam (TUI renders; a logger/Slack adapter could too). */
  private eventSubs = new Set<(e: ConductorEvent) => void>();
  private idleResolvers: (() => void)[] = [];
  private emitSeq = 0; // unique id per emitted message/row

  private members = new Set<string>(['dennis']);
  /** Per-bot cursor: seq up to which this bot has consumed the channel (exactly once each). */
  private deliveredUpTo = new Map<string, number>();
  /** Bots currently processing (covers gate → consume, so a re-poke can't double-schedule). */
  private runningBots = new Set<string>();
  /** Bot response-turns since the last human message (loop breaker). */
  private botBurst = 0;
  private relayQueue: Job[] = [];
  /** Per-bot consecutive no-progress failures at a stuck cursor — the error retry-cap loop breaker. */
  private failures = new Map<string, { cursor: number; count: number }>();

  constructor() {
    channel.subscribe(() => this.schedule());
    // Jobs are in-memory and vanish on restart, so any ticket left 'in_progress' from a prior session has
    // no live job to finish it — reset such orphans back to 'approved' (their frozen plan is intact).
    this.reconcileOrphanedTickets();
    onJobUpdate((job) => {
      this.patch({ running: listJobs().filter((j) => j.status === 'running').length });
      // Ticket lifecycle: an EXECUTE job tied to a ticket reaching a terminal state flips the ticket.
      if (
        job.mode === 'execute' &&
        job.ticketId &&
        (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')
      ) {
        this.syncTicketAfterExecute(job);
      }
      // An APPROVED plan job transitions to 'done' but must NOT relay — the bot already presented the
      // plan when it went 'awaiting', and the execute job it spawned is what reports the build. (A plan
      // job that NATURALLY finished — STATUS: DONE, no execution needed — has no `plan` set and relays.)
      if (job.status === 'done' && job.mode === 'plan' && job.plan) return;
      if (job.status === 'done' || job.status === 'awaiting' || job.status === 'failed') {
        this.relayQueue.push(job);
        this.schedule();
      }
    });
  }

  /** Reset tickets orphaned in 'in_progress' by a restart (no live job) back to 'approved'. Best-effort,
   * active project — see the in-memory job-registry limitation in jobs.ts. */
  private reconcileOrphanedTickets(): void {
    try {
      const project = this.projectForSurface();
      const board = getBoard();
      for (const t of board.listTickets({ project, status: 'in_progress' })) {
        board.setStatus(project, t.id, 'approved');
      }
    } catch {
      // A board hiccup at startup must not crash the conductor — orphan cleanup is best-effort.
    }
  }

  /** When an execute job for a ticket finishes, advance the ticket — but a ticket only goes `done` once
   * EVERY approved-plan discipline has an integrated (done) execute job, not merely when no sibling is
   * currently active. Otherwise a discipline that hasn't started its build yet gets locked out (a `done`
   * ticket is no longer executable). Never overrides a human/scrum decision (blocked/dropped). */
  private syncTicketAfterExecute(job: Job): void {
    if (!job.ticketId) return;
    const board = getBoard();
    const ticket = board.getTicket(job.project, job.ticketId);
    if (!ticket || ticket.status === 'blocked' || ticket.status === 'dropped') return;

    const ticketJobs = listJobs().filter(
      (j) => j.ticketId === job.ticketId && j.mode === 'execute',
    );
    const approvedOwners = board
      .listPlans(job.project, job.ticketId)
      .filter((p) => p.approvedMd.trim())
      .map((p) => p.ownerBot);
    // Pure decision (unit-tested in ticket-completion.test): done only when EVERY approved discipline has
    // an integrated job; a failed discipline blocks regardless of finish order; otherwise leave unchanged.
    const next = ticketStatusAfterExecute(job, ticketJobs, approvedOwners);
    if (next) board.setStatus(job.project, job.ticketId, next);
  }

  /** Subscribe to STATUS changes (busy/thinking/ctx/jobs-running) — re-read via `getStatus()`. */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** Subscribe to the append-only domain event stream (messages, tools, reactions, observability) — the
   * presentation seam. The TUI accumulates these into render rows; a logger/Slack adapter could consume
   * the same stream. Returns an unsubscribe. */
  onEvent(cb: (e: ConductorEvent) => void): () => void {
    this.eventSubs.add(cb);
    return () => this.eventSubs.delete(cb);
  }

  getStatus(): ConductorStatus {
    return this.state;
  }

  /** Resolves once nothing is running and nothing is left to deliver. For deterministic tests. */
  whenIdle(): Promise<void> {
    if (this.isQuiescent()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Append the user's message to the channel and return immediately — NEVER waits on a bot. The input
   * surface echoes the user's own message locally; the conductor only puts it on the channel. */
  submitUser(text: string): void {
    const who = titleCase(this.state.speaker);
    this.members.add(this.state.speaker);
    this.botBurst = 0; // a human spoke → reset the bot-cascade budget
    channel.append({
      id: `u-${this.emitSeq++}`,
      author: who,
      authorId: this.state.speaker,
      text,
    });
    // channel.subscribe → schedule() already fired; nothing to await.
  }

  /** Switch who's talking in the channel (the CLI's "/as <name>"), adding them to the members set. */
  setSpeaker(name: string): void {
    const id = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id) return;
    this.members.add(id);
    this.patch({ speaker: id });
  }

  /**
   * HUMAN-ONLY plan approval — the code-level human-in-the-loop gate. Triggered by the terminal
   * `/approve` command (and a future Slack "Approve" button), NEVER by a model tool. Validates the job
   * is a plan awaiting approval and spawns the execute build through the single chokepoint
   * (`executeApprovedPlan`); on success, emits an `approval` event so the transcript records who built what.
   */
  approvePlan(jobId: string, edits?: string): ActionResult {
    const res = executeApprovedPlan(jobId, edits, this.state.speaker);
    if (res.ok) {
      const job = getJob(jobId);
      this.emit({
        id: `a-${this.emitSeq++}`,
        kind: 'approval',
        jobId,
        decision: 'approved',
        by: this.state.speaker,
        note: `building ${res.execJobId}${job ? ` — "${job.task}"` : ''}`,
      });
    }
    return { ok: res.ok, reason: res.reason };
  }

  /**
   * HUMAN-ONLY plan rejection: bounce the reason back to the planner so it revises and re-surfaces
   * (reuses the awaiting → continue_work refine loop). Emits a `rejected` approval event.
   */
  rejectPlan(jobId: string, reason: string): ActionResult {
    const job = getJob(jobId);
    if (!job || job.mode !== 'plan' || job.status !== 'awaiting')
      return { ok: false, reason: `${jobId} isn't a plan awaiting approval.` };
    const res = continueWork(
      jobId,
      `${this.state.speaker} did NOT approve the plan: ${reason}\n\nRevise the plan to address this, then re-surface it (STATUS: QUESTION). Do not proceed as-is.`,
    );
    if (res.ok) {
      this.emit({
        id: `a-${this.emitSeq++}`,
        kind: 'approval',
        jobId,
        decision: 'rejected',
        by: this.state.speaker,
        note: reason,
      });
    }
    return res;
  }

  /**
   * HUMAN-ONLY ticket approval — the standup sign-off. Freezes every attached plan into its immutable
   * `approvedMd` snapshot (the contract) and moves the ticket to `approved`, after which an employee can
   * build their plan via `execute_ticket` with NO further per-build gate. Optional `edits` are folded into
   * each plan's draft before the snapshot. Triggered by the terminal `/approve-ticket`, never by a model.
   */
  approveTicket(ticketId: string, edits?: string): ActionResult {
    const project = this.projectForSurface();
    const board = getBoard();
    const ticket = board.getTicket(project, ticketId);
    if (!ticket) return { ok: false, reason: `No ticket "${ticketId}" on the board.` };
    if (ticket.status !== 'backlog')
      return {
        ok: false,
        reason: `${ticket.id} is ${ticket.status}, not an open backlog item to approve.`,
      };
    const plans = board.listPlans(project, ticketId);
    if (plans.length === 0)
      return {
        ok: false,
        reason: `${ticket.id} has no plans attached yet — let the team plan it first.`,
      };
    // Fold standup edits into each draft before the snapshot freezes it (attach is allowed while backlog).
    if (edits?.trim()) {
      for (const p of plans)
        board.attachPlan(
          project,
          ticketId,
          p.ownerBot,
          `${p.draftMd}\n\n## Adjustments from ${titleCase(this.state.speaker)} at standup\n${edits.trim()}`,
        );
    }
    const approved = board.approve(project, ticketId);
    if (!approved) return { ok: false, reason: `Couldn't approve ${ticketId}.` };
    this.emit({
      id: `a-${this.emitSeq++}`,
      kind: 'approval',
      jobId: ticket.id,
      decision: 'approved',
      by: this.state.speaker,
      note: `ticket ${ticket.id} approved — ${plans.length} plan(s) frozen, ready to build`,
    });
    return { ok: true };
  }

  /** Plan jobs currently awaiting the human's approval — drives the TUI's awaiting-approvals panel.
   * Ticket-linked plan jobs are EXCLUDED: they're approved at the ticket level (`/approve-ticket`), not
   * per-job, so they never show a `/approve <job>` prompt. */
  awaitingApprovals(): Job[] {
    return listJobs().filter((j) => j.status === 'awaiting' && j.mode === 'plan' && !j.ticketId);
  }

  private patch(p: Partial<ConductorStatus>): void {
    this.state = { ...this.state, ...p };
    for (const cb of this.subs) cb();
  }

  private emit(event: ConductorEvent): void {
    for (const cb of this.eventSubs) cb(event);
  }

  private refreshThinking(): void {
    const names = [...this.runningBots].map((id) => botById(id)?.name ?? id);
    this.patch({ thinking: names, busy: this.runningBots.size > 0 });
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Synchronous: claims idle bots and starts their work WITHOUT awaiting (so bots run in parallel and
   * input never blocks). Re-entrant-safe — it only kicks off `void` work. Re-called on channel growth
   * and on each turn's completion.
   */
  private schedule(): void {
    // Job relays first (gate-bypassed, run through the owner bot when it's free).
    for (let i = 0; i < this.relayQueue.length; ) {
      const job = this.relayQueue[i];
      const owner = botById(job.ownerBot)?.id ?? ROSTER[0].id;
      if (this.runningBots.has(owner)) {
        i++;
        continue;
      }
      this.relayQueue.splice(i, 1);
      this.claim(owner, () => this.runJobRelay(job));
    }
    // Channel deliveries: each idle bot with undelivered non-own work.
    for (const bot of ROSTER) {
      if (this.runningBots.has(bot.id)) continue;
      if (!this.hasWork(bot)) continue;
      this.claim(bot.id, () => this.runBotGraph(bot));
    }
    this.maybeResolveIdle();
  }

  /** Mark a bot busy (before any async work), run `task`, then release + re-schedule. */
  private claim(botId: string, task: () => Promise<void>): void {
    this.runningBots.add(botId);
    this.refreshThinking();
    void task().finally(() => {
      this.runningBots.delete(botId);
      this.refreshThinking();
      this.schedule();
    });
  }

  /** True if the channel holds a non-own message this bot hasn't consumed yet (its trailing own ones don't count). */
  private hasWork(bot: Employee): boolean {
    return channel.since(this.deliveredUpTo.get(bot.id) ?? 0).some((m) => m.authorBotId !== bot.id);
  }

  // ── Turn execution ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run one bot turn on its LangGraph turn-graph. The graph gates, consumes the channel (mid-step), and
   * checkpoints; the dispatcher interprets its streamed node deltas — writing each assistant message back
   * to the CHANNEL (so teammates see it mid-turn) and emitting domain `ConductorEvent`s (message, tool,
   * the reactions the graph decided — the "seen, working" 👀 and its ack — plus gate/recall observability)
   * for any presentation surface. After the turn it reads the authoritative cursor back from the checkpoint
   * and runs the reflect pass over what this bot consumed (facts to remember + open tasks to track).
   *
   * `seed` forces a gate-bypassed respond on a synthetic message (job relays); `surface` overrides the
   * identity surface (a job's notify thread).
   */
  private async runBotGraph(
    bot: Employee,
    opts: { seed?: string; surface?: string } = {},
  ): Promise<void> {
    // Scope the LangGraph thread by project so a project's durable conversation history (checkpoints.db)
    // never replays into another project. Matches the planned {botId}:{channelId}:{thread_ts} convention.
    const project = this.projectForSurface(opts.surface);
    const thread = `${bot.id}:${project}:root`;
    const identity = this.identityFor(bot.id, opts.surface ?? thread, project);
    const cursorBefore = this.deliveredUpTo.get(bot.id) ?? 0;
    const capped = this.botBurst >= MAX_BOT_BURST;
    let responded = false;

    const commit = (msg: BaseMessage) => {
      const um = (
        msg as {
          usage_metadata?: {
            input_tokens?: number;
            output_tokens?: number;
            input_token_details?: { cache_read?: number; cache_creation?: number };
          };
        }
      ).usage_metadata;
      const usage: MessageUsage | undefined = um
        ? {
            input: um.input_tokens ?? 0,
            output: um.output_tokens ?? 0,
            cacheRead: um.input_token_details?.cache_read || undefined,
            cacheWrite: um.input_token_details?.cache_creation || undefined,
          }
        : undefined;
      // Footer ctx tracks EVERY billed step — including tool-only ones, which carry usage but no text and
      // so emit no `message` event. Update it independently of whether there's text to show.
      if (usage) this.patch({ ctx: { input: usage.input, output: usage.output } });

      const text = messageText(msg.content).trim();
      if (text) {
        // The reply goes back onto the shared channel so teammates + job relays see it, and the `message`
        // event carries the SAME id so the channel message and its render row line up.
        const id = `${bot.id}:${this.emitSeq++}`;
        channel.append({ id, author: bot.name, authorId: bot.id, authorBotId: bot.id, text });
        this.emit({
          id,
          kind: 'message',
          botId: bot.id,
          botName: bot.name,
          text,
          usage,
          ts: clock(),
        });
      }
      const calls = (msg as { tool_calls?: ToolCall[] }).tool_calls ?? [];
      for (const c of calls) {
        this.emit({
          id: `${bot.id}:${this.emitSeq++}`,
          kind: 'tool',
          botId: bot.id,
          botName: bot.name,
          toolName: c.name,
        });
      }
    };

    // Input overwrites the (intentionally dead) persisted cursor with our in-memory one — see bot-graph.ts.
    const input: Record<string, unknown> = { cursor: cursorBefore, forced: !!opts.seed };
    if (opts.seed) input.messages = [new HumanMessage(opts.seed)];

    let failed = false;
    try {
      const stream = await getBotGraph(bot.id).stream(input, {
        configurable: { thread_id: thread, identity, capped },
        streamMode: 'updates',
        recursionLimit: MAX_TURN_STEPS,
      });
      for await (const update of stream as AsyncIterable<Record<string, BotStateDelta>>) {
        for (const delta of Object.values(update)) {
          // Observability: the soft gate's verdict + rationale, emitted BEFORE the reply/reaction it
          // explains. The only trace of an `ignore`, which otherwise leaves no mark. Raw usage rides the
          // event; the consumer formats cost (the TUI shows $). A logger/Slack adapter may drop it.
          if (delta.reasoning) {
            this.emit({
              id: `g-${this.emitSeq++}`,
              kind: 'gate',
              botId: bot.id,
              botName: bot.name,
              action: delta.decision ?? 'ignore',
              reasoning: delta.reasoning,
              usage: delta.gateUsage,
            });
          }
          if (delta.decision === 'respond' && !responded) {
            responded = true;
            this.botBurst++; // a real reply counts toward the loop breaker
          }
          // Surface whatever reactions the graph decided to emit — the gate's "seen, working" 👀 (fired the
          // moment it commits to responding) and its ack reaction. The conductor only renders; the brain decides.
          if (delta.reaction) this.react(bot, delta.reaction);
          if (delta.decision === 'acknowledge') this.react(bot, delta.ackEmoji ?? '👍');
          // Observability: the fetch node's pre-LLM recall — what the bot walked in knowing this turn.
          if (delta.recalled) {
            this.emit({
              id: `m-${this.emitSeq++}`,
              kind: 'recall',
              botId: bot.id,
              botName: bot.name,
              text: delta.recalled,
            });
          }
          for (const msg of delta.messages ?? []) {
            if (msg.getType() === 'ai') commit(msg); // skip injected Human messages (already in channel/UI)
          }
        }
      }
    } catch (err) {
      // The per-turn step cap (`recursionLimit`) is an expected ceiling on a long reactive loop, not a
      // crash — turn it into a clean first-person "pausing" message instead of a raw error, and end here.
      if (err instanceof GraphRecursionError) {
        this.handleStepCap(bot, { seed: !!opts.seed });
        return;
      }
      this.emitError(err);
      failed = true;
    }

    // The checkpoint is the cursor's source of truth; read it back, then learn from what we consumed.
    let cursorAfter = cursorBefore;
    try {
      const final = await getBotGraph(bot.id).getState({ configurable: { thread_id: thread } });
      cursorAfter = (final.values.cursor as number) ?? cursorBefore;
    } catch {
      /* keep cursorBefore — a getState failure must not advance the cursor past unconsumed messages */
    }

    // Retry cap (the loop breaker for errors). A turn that threw WITHOUT advancing the cursor would be
    // re-scheduled forever — hasWork stays true, so gate + fetch re-bill every lap (this is what turned a
    // single crash into a repeat-storm). For such no-progress failures on a normal channel turn, count
    // consecutive attempts at this cursor; after MAX_TURN_RETRIES, drop the wedged batch (advance to the
    // channel's high-water mark — the same "fully consumed" sentinel consume/llm use) and surface it, so
    // one poison message can't loop a bot. Seed turns (job relays) are excluded: they're spliced from the
    // queue before running, so a failure isn't re-scheduled and can't loop. Real forward progress (cursor
    // moved) always resets the streak.
    if (failed && cursorAfter <= cursorBefore && !opts.seed) {
      const prior = this.failures.get(bot.id);
      const attempts = prior?.cursor === cursorBefore ? prior.count + 1 : 1;
      if (attempts >= MAX_TURN_RETRIES) {
        const dropTo = channel.length;
        this.failures.delete(bot.id);
        this.deliveredUpTo.set(bot.id, dropTo);
        this.emitError(
          `${bot.name}: gave up after ${attempts} failed attempts; skipped ${dropTo - cursorBefore} unread message(s) to break the loop (see the error above).`,
        );
        return;
      }
      this.failures.set(bot.id, { cursor: cursorBefore, count: attempts });
      // Leave the cursor unadvanced (cursorAfter === cursorBefore) so the next schedule retries the batch.
    } else if (cursorAfter > cursorBefore) {
      this.failures.delete(bot.id); // real forward progress resets the streak
    }
    this.deliveredUpTo.set(bot.id, cursorAfter);
    // Memory + tasks are reconciled INSIDE the graph now (the bot's brain), not here — the conductor is
    // just the event loop: schedule, stream, emit, advance the cursor.
  }

  /** Relay a finished job through its owner bot (gate-bypassed seed); its reply enters the channel. */
  private async runJobRelay(job: Job): Promise<void> {
    if (job.status !== 'done' && job.status !== 'awaiting' && job.status !== 'failed') return;
    const bot = botById(job.ownerBot) ?? ROSTER[0];

    // Ticket-linked PLAN job back with a plan: store it onto the ticket (for standup approval) and relay
    // WITHOUT the per-job /approve ask — approval is ticket-level (/approve-ticket).
    if (job.status === 'awaiting' && job.mode === 'plan' && job.ticketId) {
      const board = getBoard();
      const ticket = board.getTicket(job.project, job.ticketId);
      const planMd = stripStatusLine(job.lastReport ?? '').trim() || (job.lastReport ?? '').trim();
      if (ticket && ticket.status === 'backlog' && planMd)
        board.attachPlan(job.project, job.ticketId, job.ownerBot, planMd);
      const seed = `[Background planning] ${job.id} finished planning ${job.ticketId}${ticket ? ` ("${ticket.title}")` : ''}. Your plan is attached to the ticket for standup review — Dennis approves the whole ticket there, so there is NOTHING to /approve per-job and you do NOT start the build yourself. Relay briefly (first person) that your plan for ${job.ticketId} is ready for standup; surface any genuine open questions about WHAT to build to Dennis.`;
      await this.runBotGraph(bot, { seed, surface: job.notifyThread });
      return;
    }

    const prompt =
      job.status === 'failed'
        ? `[Background task] ${job.id} ("${job.task}") failed: ${job.error ?? '(unknown)'}. Let the team know in your own words — briefly, first person.`
        : job.status === 'awaiting'
          ? job.mode === 'plan'
            ? `[Background planning] ${job.id} ("${job.task}") came back with a PLAN + open questions:\n${job.lastReport ?? '(no report)'}\n\nThis is your own planning work. Relay the plan and its questions to the team (first person). Triage each question: anything about WHAT to build or WHY is Dennis's call — surface it to him; anything technical/reversible, answer yourself or @mention the right teammate. To refine the plan with an answer, continue_work("${job.id}", <answer>). You do NOT approve or start the build yourself — once the plan is settled, Dennis signs off directly in the terminal (/approve ${job.id}) and the build kicks off on its own. Hand it to him for sign-off; don't promise to build it.`
            : `[Background task] ${job.id} ("${job.task}") needs your input:\n${job.lastReport ?? '(no report)'}\n\nThis is your own background work. Relay what it needs (first person); when answered, continue_work("${job.id}", <answer>) to resume it.`
          : `[Background task] ${job.id} ("${job.task}") finished:\n${job.lastReport ?? '(no report)'}\n\nThis is your own work — relay the outcome to the team in the first person, briefly. The task is done; don't check it again.`;
    await this.runBotGraph(bot, { seed: prompt, surface: job.notifyThread });
  }

  /** Emit a reaction from a bot (the gate's ack, or the "seen, working" 👀). Slack seam: reactions.add. */
  private react(bot: Employee, emoji: string): void {
    this.emit({
      id: `r-${this.emitSeq++}`,
      kind: 'reaction',
      botId: bot.id,
      botName: bot.name,
      emoji,
    });
  }

  /**
   * A reactive loop hit the per-turn step cap (`MAX_TURN_STEPS`). End it gracefully: the bot tells the team
   * — first person, in the channel, so it reads like it's aware — that it's pausing, instead of the turn
   * dying with a raw `GraphRecursionError`. The cap is PER TURN, so a fresh budget starts on the bot's next
   * turn; it picks back up when someone messages it again.
   *
   * For a normal channel turn we also advance the cursor to the high-water mark so the bot doesn't
   * immediately re-fire and re-hit the cap (the loop's instruction is still in its history) — anything
   * unread is "ping me to resume." Seed turns (job relays) aren't re-scheduled, so we leave their cursor
   * alone (advancing it would wrongly swallow pending channel work).
   */
  private handleStepCap(bot: Employee, opts: { seed?: boolean }): void {
    const id = `${bot.id}:${this.emitSeq++}`;
    const text =
      `Oh — I hit my per-turn step cap, so I've gotta pause this loop here. ` +
      `Ping me and I'll pick it right back up.`;
    channel.append({ id, author: bot.name, authorId: bot.id, authorBotId: bot.id, text });
    this.emit({ id, kind: 'message', botId: bot.id, botName: bot.name, text, ts: clock() });
    if (!opts.seed) this.deliveredUpTo.set(bot.id, channel.length);
    this.failures.delete(bot.id); // a step cap isn't a failure — don't count it toward the retry streak
  }

  // ── Memory + identity (unchanged) ────────────────────────────────────────────────────────────────

  private identityFor(botId: string, surface: string, project: string): Identity {
    return {
      selfAgent: botId,
      team: DEFAULT_TEAM,
      project,
      participants: [...this.members],
      speaker: this.state.speaker,
      surface,
      isChannel: true,
    };
  }

  /**
   * The active project for a turn — the seam the future Slack adapter fills with a channelId→project
   * lookup (callers never change). v0: one conversation → one project. `ZERO_PROJECT` overrides it as a
   * manual cross-project test affordance (see the plan's verification section), NOT a production source.
   */
  private projectForSurface(_surface?: string): string {
    return process.env.ZERO_PROJECT ?? DEFAULT_PROJECT;
  }

  private emitError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit({ id: `e-${this.emitSeq++}`, kind: 'error', message });
  }

  // ── Quiescence ───────────────────────────────────────────────────────────────────────────────────

  private anyUndelivered(): boolean {
    return ROSTER.some((b) => this.hasWork(b));
  }

  private isQuiescent(): boolean {
    return this.runningBots.size === 0 && this.relayQueue.length === 0 && !this.anyUndelivered();
  }

  private maybeResolveIdle(): void {
    if (!this.isQuiescent()) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }
}

export const conductor = new Conductor();
