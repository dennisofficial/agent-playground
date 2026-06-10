import { EnvService } from '@core/config/env/env.service';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ChannelService } from '../channel/channel.service';
import { CursorStore } from '../channel/cursor.store';
import type { ConductorEvent, MessageUsage } from '../domain/conductor-events';
import { DEFAULT_PROJECT, DEFAULT_TEAM, type Identity } from '../domain/identity';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { JOB_REGISTRY, type Job, type JobRegistry } from '../jobs/job-registry.port';
import { WorkerService } from '../jobs/worker.service';
import { type BotStateDelta, BotGraphFactory } from './bot-graph.factory';
import { ConductorEventsBus } from './conductor-events.bus';

/**
 * The dispatcher: a thin event loop around the shared channel. The human appends to the channel and
 * moves on (never blocked); bots are independent reactive agents that run CONCURRENTLY. Each bot
 * consumes the channel exactly once via a durable per-bot cursor, gated for respond/acknowledge/
 * ignore, and emits its own messages back as they're produced so teammates see them. This is the
 * Slack model; the ChatSurface port + this conductor are the seam a Slack adapter fills.
 *
 * Each turn runs on the bot's LangGraph turn-graph (BotGraphFactory) — the bot's BRAIN: it owns the
 * gate, the mid-step channel re-read, the deterministic memory fetch/reconcile, and the checkpoint.
 * The conductor is just the event loop: scheduling, the cursor's coordinate space, and channel
 * writes. It is UI-agnostic — it emits domain ConductorEvents on the events bus that presentation
 * surfaces (TUI, the future Slack adapter) subscribe to and render.
 * (Ported from playground/src/conductor.ts; board/approval paths are not in this pass.)
 */

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Flatten message content (string | content blocks) to a plain string. */
const messageText = (content: BaseMessage['content']): string =>
  typeof content === 'string'
    ? content
    : content.map((c) => (typeof c === 'string' ? c : 'text' in c && typeof c.text === 'string' ? c.text : '')).join('');

interface ToolCall {
  id?: string;
  name: string;
}

/** A short HH:MM:SS stamp for the transcript — handy for eyeballing the async/parallel flow. */
const clock = (): string =>
  new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ── Autonomy loop caps — UNCAPPED per Dennis (2026-06-09) ───────────────────────────────────────────
// Running the team unthrottled while it's developed/observed attended. When unattended operation needs
// a real backstop, these get REPLACED by a progress-gated breaker + a cost ceiling.
// To restore the prior guards: MAX_BOT_BURST = 50, MAX_TURN_STEPS = 200.

/** Bot RESPONSE turns between human messages before bot↔bot traffic is force-ignored. */
const MAX_BOT_BURST = Number.POSITIVE_INFINITY;

/** Max LangGraph super-steps in a SINGLE bot turn (`llm ⇄ tools`). Effectively uncapped — finite only
 * because LangGraph's `recursionLimit` requires a real number. Still pauses GRACEFULLY if reached. */
const MAX_TURN_STEPS = 1_000_000;

// ── Crash safety (NOT an autonomy throttle — kept on purpose) ───────────────────────────────────────
/** Attempts before the conductor gives up on a turn that keeps ERRORING without progress. Removing it
 * wouldn't free autonomy, it would let a broken turn re-bill forever. */
const MAX_TURN_RETRIES = 3;

/** How long shutdown waits for in-flight turns before giving up (ms). */
const SHUTDOWN_IDLE_TIMEOUT_MS = 10_000;

@Injectable()
export class ConductorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ConductorService.name);

  private members = new Set<string>(['dennis']);
  /** Bots currently processing (covers gate → consume, so a re-poke can't double-schedule). */
  private runningBots = new Set<string>();
  /** Bot response-turns since the last human message (loop breaker; uncapped today). */
  private botBurst = 0;
  private relayQueue: Job[] = [];
  /** Per-bot consecutive no-progress failures at a stuck cursor — the error retry-cap loop breaker. */
  private failures = new Map<string, { cursor: number; count: number }>();
  private idleResolvers: (() => void)[] = [];
  private emitSeq = 0; // unique id per emitted message/row
  private stopping = false;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly channel: ChannelService,
    private readonly cursors: CursorStore,
    private readonly employees: EmployeeRegistry,
    private readonly graphs: BotGraphFactory,
    @Inject(JOB_REGISTRY) private readonly jobs: JobRegistry,
    private readonly worker: WorkerService,
    private readonly bus: ConductorEventsBus,
    private readonly env: EnvService,
  ) {}

  /** Constructor stays pure; subscriptions + the first schedule happen here (after channel/cursor
   * hydration, which runs in onModuleInit — module init completes before any bootstrap hook). */
  onApplicationBootstrap(): void {
    this.unsubscribers.push(this.channel.subscribe(() => this.schedule()));
    this.unsubscribers.push(
      this.jobs.onUpdate((job) => {
        void this.jobs.list({ status: 'running' }).then((running) => this.bus.patchStatus({ running: running.length }));
        if (job.status === 'done' || job.status === 'awaiting' || job.status === 'failed') {
          this.relayQueue.push(job);
          this.schedule();
        }
      }),
    );
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.worker.abortAll();
    await Promise.race([this.whenIdle(), new Promise((r) => setTimeout(r, SHUTDOWN_IDLE_TIMEOUT_MS))]);
    for (const unsub of this.unsubscribers) unsub();
    await this.channel.flush().catch(() => {});
    await this.cursors.flush().catch(() => {});
  }

  /** Resolves once nothing is running and nothing is left to deliver. For tests + shutdown. */
  whenIdle(): Promise<void> {
    if (this.isQuiescent()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Append the current speaker's message to the channel and return immediately — NEVER waits on a
   * bot. (The TUI's input path; the SurfaceBridge uses `submitFrom` with the surface's author.) */
  submitUser(text: string): void {
    this.submitFrom(this.bus.status.speaker, titleCase(this.bus.status.speaker), text);
  }

  /** Append a human message from a known author (the ChatSurface inbound path). */
  submitFrom(authorId: string, authorName: string, text: string): void {
    this.members.add(authorId);
    this.botBurst = 0; // a human spoke → reset the bot-cascade budget
    const id = `u-${this.emitSeq++}`;
    this.channel.append({ id, author: authorName, authorId, text });
    // Surface the human's own message through the SAME event stream, keyed by the channel id — so
    // the UI renders it from one uniform path and a bot's reaction can fold onto it.
    this.emit({ id, kind: 'message', authorId, authorName, fromHuman: true, text, ts: clock() });
    // channel.subscribe → schedule() already fired; nothing to await.
  }

  /** Switch who's talking in the channel (the TUI's "/as <name>"), adding them to the members set. */
  setSpeaker(name: string): void {
    const id = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id) return;
    this.members.add(id);
    this.bus.patchStatus({ speaker: id });
  }

  private emit(event: ConductorEvent): void {
    this.bus.emit(event);
  }

  private refreshThinking(): void {
    const names = [...this.runningBots].map((id) => this.employees.byId(id)?.name ?? id);
    this.bus.patchStatus({ thinking: names, busy: this.runningBots.size > 0 });
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Synchronous: claims idle bots and starts their work WITHOUT awaiting (so bots run in parallel
   * and input never blocks). Re-entrant-safe — it only kicks off `void` work. Re-called on channel
   * growth and on each turn's completion.
   */
  private schedule(): void {
    if (this.stopping) {
      this.maybeResolveIdle();
      return;
    }
    // Job relays first (gate-bypassed, run through the owner bot when it's free).
    for (let i = 0; i < this.relayQueue.length; ) {
      const job = this.relayQueue[i];
      const owner = this.employees.byId(job.ownerBot)?.id ?? this.employees.fallbackOwner().id;
      if (this.runningBots.has(owner)) {
        i++;
        continue;
      }
      this.relayQueue.splice(i, 1);
      this.claim(owner, () => this.runJobRelay(job));
    }
    // Channel deliveries: each idle bot with undelivered non-own work.
    for (const bot of this.employees.list()) {
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

  /** True if the channel holds a non-own message this bot hasn't consumed yet. */
  private hasWork(bot: EmployeeDefinition): boolean {
    return this.channel
      .since(this.cursors.get(bot.id, this.channel.surfaceId))
      .some((m) => m.authorBotId !== bot.id);
  }

  // ── Turn execution ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run one bot turn on its LangGraph turn-graph. The graph gates, consumes the channel (mid-step),
   * and checkpoints; the conductor interprets its streamed node deltas — writing each assistant
   * message back to the CHANNEL (so teammates see it mid-turn) and emitting domain ConductorEvents.
   * After the turn it reads the authoritative cursor back from the checkpoint and persists it.
   *
   * `seed` forces a gate-bypassed respond on a synthetic message (job relays); `surface` overrides
   * the identity surface (a job's notify thread).
   */
  private async runBotGraph(bot: EmployeeDefinition, opts: { seed?: string; surface?: string } = {}): Promise<void> {
    // Scope the LangGraph thread by project so a project's durable conversation history never
    // replays into another project. Matches the planned {botId}:{channelId}:{thread_ts} convention.
    const project = this.projectForSurface(opts.surface);
    const thread = `${bot.id}:${project}:root`;
    const identity = this.identityFor(bot.id, opts.surface ?? thread, project);
    const surfaceId = this.channel.surfaceId;
    const cursorBefore = this.cursors.get(bot.id, surfaceId);
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
      // Footer ctx tracks EVERY billed step — including tool-only ones, which carry usage but no
      // text and so emit no `message` event.
      if (usage) this.bus.patchStatus({ ctx: { input: usage.input, output: usage.output } });

      const text = messageText(msg.content).trim();
      if (text) {
        // The reply goes back onto the shared channel so teammates + job relays see it, and the
        // `message` event carries the SAME id so the channel message and its render row line up.
        const id = `${bot.id}:${this.emitSeq++}`;
        this.channel.append({ id, author: bot.name, authorId: bot.id, authorBotId: bot.id, text });
        this.emit({ id, kind: 'message', authorId: bot.id, authorName: bot.name, fromHuman: false, text, usage, ts: clock() });
      }
      const calls = (msg as { tool_calls?: ToolCall[] }).tool_calls ?? [];
      for (const c of calls) {
        this.emit({ id: `${bot.id}:${this.emitSeq++}`, kind: 'tool', botId: bot.id, botName: bot.name, toolName: c.name });
      }
    };

    // Input overwrites the persisted cursor with the durable per-bot cursor — the conductor owns the
    // cursor's coordinate space; the graph only borrows it for within-run threading.
    const input: Record<string, unknown> = { cursor: cursorBefore, forced: !!opts.seed };
    if (opts.seed) input.messages = [new HumanMessage(opts.seed)];

    let failed = false;
    try {
      const stream = await this.graphs.getBotGraph(bot).stream(input, {
        configurable: { thread_id: thread, identity, capped },
        streamMode: 'updates',
        recursionLimit: MAX_TURN_STEPS,
      });
      for await (const update of stream as AsyncIterable<Record<string, BotStateDelta>>) {
        for (const delta of Object.values(update)) {
          // Observability: the soft gate's verdict + rationale, emitted BEFORE the reply/reaction it
          // explains. The only trace of an `ignore`, which otherwise leaves no mark.
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
          // Surface whatever reactions the graph decided — the conductor only renders; the brain decides.
          if (delta.reaction) this.react(bot, delta.reaction, delta.reactionTargetId);
          if (delta.decision === 'acknowledge') this.react(bot, delta.ackEmoji ?? '👍', delta.reactionTargetId);
          // Observability: the fetch node's pre-LLM recall — what the bot walked in knowing this turn.
          if (delta.recalled) {
            this.emit({ id: `m-${this.emitSeq++}`, kind: 'recall', botId: bot.id, botName: bot.name, text: delta.recalled });
          }
          for (const msg of delta.messages ?? []) {
            if (msg.getType() === 'ai') commit(msg); // skip injected Human messages (already in channel/UI)
          }
        }
      }
    } catch (err) {
      // The per-turn step cap is an expected ceiling on a long reactive loop, not a crash — turn it
      // into a clean first-person "pausing" message instead of a raw error, and end here.
      if (err instanceof GraphRecursionError) {
        this.handleStepCap(bot, { seed: !!opts.seed });
        return;
      }
      this.emitError(err);
      failed = true;
    }

    // The checkpoint is the cursor's source of truth; read it back, then persist it.
    let cursorAfter = cursorBefore;
    try {
      const final = await this.graphs.getBotGraph(bot).getState({ configurable: { thread_id: thread } });
      cursorAfter = (final.values.cursor as number) ?? cursorBefore;
    } catch {
      /* keep cursorBefore — a getState failure must not advance the cursor past unconsumed messages */
    }

    // Retry cap (the loop breaker for errors). A turn that threw WITHOUT advancing the cursor would
    // be re-scheduled forever — hasWork stays true, so gate + fetch re-bill every lap. For such
    // no-progress failures on a normal channel turn, count consecutive attempts at this cursor;
    // after MAX_TURN_RETRIES, drop the wedged batch and surface it, so one poison message can't
    // loop a bot. Seed turns (job relays) are excluded: they're spliced from the queue before
    // running, so a failure isn't re-scheduled and can't loop.
    if (failed && cursorAfter <= cursorBefore && !opts.seed) {
      const prior = this.failures.get(bot.id);
      const attempts = prior?.cursor === cursorBefore ? prior.count + 1 : 1;
      if (attempts >= MAX_TURN_RETRIES) {
        const dropTo = this.channel.length;
        this.failures.delete(bot.id);
        this.cursors.set(bot.id, surfaceId, dropTo);
        this.emitError(
          `${bot.name}: gave up after ${attempts} failed attempts; skipped ${dropTo - cursorBefore} unread message(s) to break the loop (see the error above).`,
        );
        return;
      }
      this.failures.set(bot.id, { cursor: cursorBefore, count: attempts });
      // Leave the cursor unadvanced so the next schedule retries the batch.
      return;
    } else if (cursorAfter > cursorBefore) {
      this.failures.delete(bot.id); // real forward progress resets the streak
    }
    this.cursors.set(bot.id, surfaceId, cursorAfter);
    // Memory + tasks are reconciled INSIDE the graph (the bot's brain), not here — the conductor is
    // just the event loop: schedule, stream, emit, advance the cursor.
  }

  /** Relay a finished job through its owner bot (gate-bypassed seed); its reply enters the channel. */
  private async runJobRelay(job: Job): Promise<void> {
    if (job.status !== 'done' && job.status !== 'awaiting' && job.status !== 'failed') return;
    const bot = this.employees.byId(job.ownerBot) ?? this.employees.fallbackOwner();

    const prompt =
      job.status === 'failed'
        ? `[Background task] ${job.id} ("${job.task}") failed: ${job.error ?? '(unknown)'}. Let the team know in your own words — briefly, first person.`
        : job.status === 'awaiting'
          ? job.mode === 'plan'
            ? `[Background planning] ${job.id} ("${job.task}") came back with a PLAN + open questions:\n${job.lastReport ?? '(no report)'}\n\nThis is your own planning work. Relay the plan and its questions to the team (first person). Triage each question: anything about WHAT to build or WHY is Dennis's call — surface it to him; anything technical/reversible, answer yourself or @mention the right teammate. To refine the plan with an answer, continue_work("${job.id}", <answer>). You do NOT approve or start the build yourself — Dennis signs off himself, so hand the plan to him for review; don't promise to build it.`
            : `[Background task] ${job.id} ("${job.task}") needs your input:\n${job.lastReport ?? '(no report)'}\n\nThis is your own background work. Relay what it needs (first person); when answered, continue_work("${job.id}", <answer>) to resume it.`
          : `[Background task] ${job.id} ("${job.task}") finished:\n${job.lastReport ?? '(no report)'}\n\nThis is your own work — relay the outcome to the team in the first person, briefly. The task is done; don't check it again.`;
    await this.runBotGraph(bot, { seed: prompt, surface: job.notifyThread });
  }

  /** Emit a reaction from a bot ON a target message, so the surface folds it into that message. */
  private react(bot: EmployeeDefinition, emoji: string, targetId?: string): void {
    this.emit({ id: `r-${this.emitSeq++}`, kind: 'reaction', botId: bot.id, botName: bot.name, emoji, targetId: targetId ?? '' });
  }

  /**
   * A reactive loop hit the per-turn step cap. End it gracefully: the bot tells the team — first
   * person, in the channel — that it's pausing, instead of the turn dying with a raw error. For a
   * normal channel turn we also advance the cursor to the high-water mark so the bot doesn't
   * immediately re-fire and re-hit the cap; seed turns aren't re-scheduled, so theirs stays put.
   */
  private handleStepCap(bot: EmployeeDefinition, opts: { seed?: boolean }): void {
    const id = `${bot.id}:${this.emitSeq++}`;
    const text =
      `Oh — I hit my per-turn step cap, so I've gotta pause this loop here. ` +
      `Ping me and I'll pick it right back up.`;
    this.channel.append({ id, author: bot.name, authorId: bot.id, authorBotId: bot.id, text });
    this.emit({ id, kind: 'message', authorId: bot.id, authorName: bot.name, fromHuman: false, text, ts: clock() });
    if (!opts.seed) this.cursors.set(bot.id, this.channel.surfaceId, this.channel.length);
    this.failures.delete(bot.id); // a step cap isn't a failure — don't count it toward the retry streak
  }

  // ── Memory + identity ────────────────────────────────────────────────────────────────────────────

  private identityFor(botId: string, surface: string, project: string): Identity {
    return {
      selfAgent: botId,
      team: this.env.get('HARNESS_TEAM_ID') ?? DEFAULT_TEAM,
      project,
      participants: [...this.members],
      speaker: this.bus.status.speaker,
      surface,
      isChannel: true,
    };
  }

  /**
   * The active project for a turn — the seam the future Slack adapter fills with a
   * channelId→project lookup (callers never change). v0: one conversation → one project.
   * `ZERO_PROJECT` overrides it as a manual cross-project test affordance.
   */
  private projectForSurface(_surface?: string): string {
    return this.env.get('ZERO_PROJECT') ?? DEFAULT_PROJECT;
  }

  private emitError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(message);
    this.emit({ id: `e-${this.emitSeq++}`, kind: 'error', message });
  }

  // ── Quiescence ───────────────────────────────────────────────────────────────────────────────────

  private anyUndelivered(): boolean {
    return this.employees.list().some((b) => this.hasWork(b));
  }

  private isQuiescent(): boolean {
    return this.runningBots.size === 0 && this.relayQueue.length === 0 && (this.stopping || !this.anyUndelivered());
  }

  private maybeResolveIdle(): void {
    if (!this.isQuiescent()) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }
}
