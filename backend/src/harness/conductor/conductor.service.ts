import { EnvService } from '@core/config/env/env.service';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  ChannelRegistryService,
  type ChannelInfo,
} from '../channel/channel-registry.service';
import { ChannelService } from '../channel/channel.service';
import { CursorStore } from '../channel/cursor.store';
import type { ConductorEvent, MessageUsage } from '../domain/conductor-events';
import {
  DEFAULT_PROJECT,
  DEFAULT_TEAM,
  type Identity,
} from '../domain/identity';
import { flattenContent, titleCase } from '../domain/text';
import { EmployeeRegistry } from '../employees/employee.registry';
import type { EmployeeDefinition } from '../employees/employee.types';
import { CredentialContext } from '../llm-keys/credential-context';
import { LlmReadinessService } from '../llm-keys/llm-readiness.service';
import { TenantCredentialService } from '../llm-keys/tenant-credential.service';
import {
  SESSION_REGISTRY,
  type Session,
  type SessionRegistry,
} from '../sessions/session-registry.port';
import { SessionRunnerService } from '../sessions/session-runner.service';
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
export class ConductorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ConductorService.name);

  /** Bots currently processing (covers gate → consume, so a re-poke can't double-schedule), keyed
   * `${teamId}|${botId}` (see botKey): one "person" works ONE turn at a time across all its rooms
   * WITHIN a workspace, but the same employee in another workspace runs concurrently. */
  private runningBots = new Set<string>();
  /** Bot response-turns since the last human message, PER ROOM (loop breaker; uncapped today) —
   * one room's bot cascade must not throttle another's. */
  private botBurst = new Map<string, number>();
  private relayQueue: Session[] = [];
  /** Consecutive no-progress failures at a stuck cursor, keyed `${botId}|${channelId}` — the error
   * retry-cap loop breaker, scoped so one room's poison message can't skip another room's batch. */
  private failures = new Map<string, { cursor: number; count: number }>();
  private idleResolvers: (() => void)[] = [];
  private emitSeq = 0; // unique id per emitted message/row
  /** Per-boot tag baked into MINTED channel-message ids. Ids persist now, and `emitSeq` restarts at
   * 0 every boot — an untagged `u-0`/`alex:0` would collide with a hydrated row from the previous
   * run and silently update it in place instead of appending. */
  private readonly mintTag = Date.now().toString(36);
  private stopping = false;
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly channel: ChannelService,
    private readonly registry: ChannelRegistryService,
    private readonly cursors: CursorStore,
    private readonly employees: EmployeeRegistry,
    private readonly graphs: BotGraphFactory,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly runner: SessionRunnerService,
    private readonly bus: ConductorEventsBus,
    private readonly env: EnvService,
    private readonly readiness: LlmReadinessService,
    private readonly creds: TenantCredentialService,
    private readonly credCtx: CredentialContext,
  ) {}

  /** runningBots is keyed per (tenant, bot): a bot works ONE turn at a time within a workspace, but
   * the SAME employee in another workspace runs concurrently (tenants don't head-of-line-block). */
  private botKey(teamId: string, botId: string): string {
    return `${teamId}|${botId}`;
  }

  /** Constructor stays pure; subscriptions + the first schedule happen here (after channel/cursor
   * hydration, which runs in onModuleInit — module init completes before any bootstrap hook). */
  async onApplicationBootstrap(): Promise<void> {
    // The process's default room registers itself (full roster + the default human). Rooms whose
    // logs survived a restart but whose registry rows are missing re-register with channel defaults
    // — a noisy default beats a silently dead room.
    this.registry.ensure({
      channelId: this.channel.surfaceId,
      teamId: this.env.get('HARNESS_TEAM_ID') ?? DEFAULT_TEAM,
      kind: 'channel',
      project: this.env.get('ZERO_PROJECT') ?? DEFAULT_PROJECT,
      members: [...this.employees.list().map((b) => b.id), 'dennis'],
      displayName: this.channel.surfaceId,
    });
    for (const channelId of this.channel.channelIds()) {
      this.registry.ensure({
        channelId,
        members: [...this.employees.list().map((b) => b.id), 'dennis'],
      });
    }

    // Reconcile durable cursors with each room's hydration window BEFORE any scheduling. A room
    // hydrates only a tail; a bot whose cursor sits below the window would otherwise have the gap
    // silently skipped by `since()`. A bot with NO stored cursor (brand-new teammate, or a bot just
    // added to a room) starts from the window floor — it joins the conversation at the present
    // instead of replaying (and re-billing) the entire archived history.
    for (const info of this.registry.list()) {
      const known: number[] = [];
      for (const bot of this.botsIn(info)) {
        if (this.cursors.has(bot.id, info.channelId))
          known.push(this.cursors.get(bot.id, info.channelId));
        else
          this.cursors.set(
            bot.id,
            info.channelId,
            this.channel.floorSeqOf(info.channelId),
          );
      }
      if (known.length)
        await this.channel.backfillTo(Math.min(...known), info.channelId);
    }

    this.unsubscribers.push(this.channel.subscribe(() => this.schedule()));
    // Pending-keys mode: when provider keys land at runtime, release the gate and deliver
    // whatever accumulated while keyless.
    const readySub = this.readiness.ready$.subscribe(() => this.schedule());
    this.unsubscribers.push(() => readySub.unsubscribe());
    this.unsubscribers.push(
      this.sessions.onUpdate((session) => {
        void this.sessions
          .list({ status: 'running' })
          .then((running) => this.bus.patchStatus({ running: running.length }))
          .catch((err) =>
            this.logger.warn(`running-sessions count refresh failed: ${err}`),
          );
        // Every turn-end relays to the owner ('idle' = reported back, 'failed' = the turn errored).
        // 'running' (a turn started) and 'closed' (the owner already decided) never relay.
        if (session.status === 'idle' || session.status === 'failed') {
          this.relayQueue.push(session);
          this.schedule();
        }
      }),
    );
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.runner.abortAll();
    await Promise.race([
      this.whenIdle(),
      new Promise((r) => setTimeout(r, SHUTDOWN_IDLE_TIMEOUT_MS)),
    ]);
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
    this.submitFrom(
      this.bus.status.speaker,
      titleCase(this.bus.status.speaker),
      text,
    );
  }

  /** Append a human message from a known author (the ChatSurface inbound path). `opts.id` is the
   * surface-native message id (a Slack ts) — kept so reactions/edits target the surface's own
   * coordinate; minted only when the caller has none. */
  submitFrom(
    authorId: string,
    authorName: string,
    text: string,
    opts: { id?: string; channelId?: string; teamId?: string } = {},
  ): void {
    const channelId = opts.channelId ?? this.channel.surfaceId;
    // Lazy room registration (the Slack-DM pattern: first message creates the room) + the speaker
    // joins the room they spoke in. teamId stamps the room's tenant on first registration.
    this.registry.ensure({
      channelId,
      ...(opts.teamId ? { teamId: opts.teamId } : {}),
      members: [...this.employees.list().map((b) => b.id), authorId],
    });
    this.registry.addMembers(channelId, [authorId]);
    this.botBurst.set(channelId, 0); // a human spoke → reset this room's bot-cascade budget
    const id = opts.id ?? `u-${this.mintTag}-${this.emitSeq++}`;
    this.channel.append({ id, channelId, author: authorName, authorId, text });
    // Surface the human's own message through the SAME event stream, keyed by the channel id — so
    // the UI renders it from one uniform path and a bot's reaction can fold onto it.
    this.emit({
      id,
      kind: 'message',
      channelId,
      authorId,
      authorName,
      fromHuman: true,
      text,
      ts: clock(),
    });
    // channel.subscribe → schedule() already fired; nothing to await.
  }

  /** Switch who's talking (the TUI's "/as <name>"). They join each room on their first message. */
  setSpeaker(name: string): void {
    const id = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id) return;
    this.bus.patchStatus({ speaker: id });
  }

  /** The human currently speaking (the TUI's `/as` identity) — e.g. for addressing their DMs. */
  get speaker(): string {
    return this.bus.status.speaker;
  }

  private emit(event: ConductorEvent): void {
    this.bus.emit(event);
  }

  private refreshThinking(): void {
    // runningBots keys are `${teamId}|${botId}` — render the bot's display name (deduped across
    // workspaces; the status line is a single presence indicator, not per-tenant).
    const names = [
      ...new Set(
        [...this.runningBots].map((key) => {
          const botId = key.slice(key.indexOf('|') + 1);
          return this.employees.byId(botId)?.name ?? botId;
        }),
      ),
    ];
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
    // Pending-keys gate is now PER WORKSPACE: a room/relay only starts when its tenant's keys are
    // ready (getBotGraph builds the Anthropic model from the turn's CredentialContext, so a keyless
    // tenant would throw). `ensureChecked` kicks an async readiness probe; ready$ → schedule()
    // releases that workspace's backlog. Other workspaces keep running meanwhile.
    // Session relays first (gate-bypassed, run through the owner bot when it's free).
    for (let i = 0; i < this.relayQueue.length; ) {
      const session = this.relayQueue[i];
      const team = this.registry.teamIdOf(session.notifyThread);
      if (!this.readiness.isReady(team)) {
        this.readiness.ensureChecked(team);
        i++;
        continue;
      }
      const owner =
        this.employees.byId(session.ownerBot)?.id ??
        this.employees.fallbackOwner().id;
      if (this.runningBots.has(this.botKey(team, owner))) {
        i++;
        continue;
      }
      this.relayQueue.splice(i, 1);
      this.claim(this.botKey(team, owner), () => this.runSessionRelay(session));
    }
    // Room deliveries: each idle member bot with undelivered non-own work, per room.
    for (const info of this.registry.list()) {
      if (!this.readiness.isReady(info.teamId)) {
        this.readiness.ensureChecked(info.teamId);
        continue;
      }
      for (const bot of this.botsIn(info)) {
        const key = this.botKey(info.teamId, bot.id);
        if (this.runningBots.has(key)) continue;
        if (!this.hasWork(bot, info.channelId)) continue;
        this.claim(key, () =>
          this.runBotGraph(bot, { channelId: info.channelId }),
        );
      }
    }
    this.maybeResolveIdle();
  }

  /** Mark a bot busy (before any async work), run `task`, then release + re-schedule. `key` is the
   * per-(tenant,bot) botKey. */
  private claim(key: string, task: () => Promise<void>): void {
    this.runningBots.add(key);
    this.refreshThinking();
    void task().finally(() => {
      this.runningBots.delete(key);
      this.refreshThinking();
      this.schedule();
    });
  }

  /** True if a room holds a non-own message this bot hasn't consumed yet. */
  private hasWork(bot: EmployeeDefinition, channelId: string): boolean {
    return this.channel
      .since(this.cursors.get(bot.id, channelId), channelId)
      .some((m) => m.authorBotId !== bot.id);
  }

  /** The roster members of a room (its bots — humans in `members` are identity participants). */
  private botsIn(info: ChannelInfo): EmployeeDefinition[] {
    return this.employees.list().filter((b) => info.members.includes(b.id));
  }

  // ── Turn execution ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run one bot turn on its LangGraph turn-graph. The graph gates, consumes the channel (mid-step),
   * and checkpoints; the conductor interprets its streamed node deltas — writing each assistant
   * message back to the CHANNEL (so teammates see it mid-turn) and emitting domain ConductorEvents.
   * After the turn it reads the authoritative cursor back from the checkpoint and persists it.
   *
   * `seed` forces a gate-bypassed respond on a synthetic message (session relays); `channelId` is the
   * room the turn runs in (defaults to the process's default room).
   */
  private async runBotGraph(
    bot: EmployeeDefinition,
    opts: { seed?: string; channelId?: string } = {},
  ): Promise<void> {
    // Scope the LangGraph thread by ROOM so one room's durable conversation history never replays
    // into another — the {botId}:{channelId}:{thread_ts ?? 'root'} convention from ARCHITECTURE.md.
    const channelId = opts.channelId ?? this.channel.surfaceId;
    const info = this.registry.ensure({ channelId });
    // Resolve this workspace's LLM keys and run the WHOLE turn inside the credential context, so the
    // model/embedding builders (gate, llm node, reconcile) all pick up the right tenant's key.
    const keys = await this.creds.resolve(info.teamId);
    return this.credCtx.run({ teamId: info.teamId, keys }, () =>
      this.runBotGraphInner(bot, info, channelId, opts),
    );
  }

  private async runBotGraphInner(
    bot: EmployeeDefinition,
    info: ChannelInfo,
    channelId: string,
    opts: { seed?: string; channelId?: string },
  ): Promise<void> {
    const thread = `${bot.id}:${channelId}:root`;
    const identity = this.identityFor(bot.id, info);
    const cursorBefore = this.cursors.get(bot.id, channelId);
    const capped = (this.botBurst.get(channelId) ?? 0) >= MAX_BOT_BURST;
    let responded = false;

    const commit = (msg: BaseMessage) => {
      const um = (
        msg as {
          usage_metadata?: {
            input_tokens?: number;
            output_tokens?: number;
            input_token_details?: {
              cache_read?: number;
              cache_creation?: number;
            };
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
      if (usage)
        this.bus.patchStatus({
          ctx: { input: usage.input, output: usage.output },
        });

      const text = flattenContent(msg.content).trim();
      if (text) {
        // The reply goes back onto the room's shared log so teammates + session relays see it, and the
        // `message` event carries the SAME id so the channel message and its render row line up.
        const id = `${bot.id}:${this.mintTag}:${this.emitSeq++}`;
        this.channel.append({
          id,
          channelId,
          author: bot.name,
          authorId: bot.id,
          authorBotId: bot.id,
          text,
        });
        this.emit({
          id,
          kind: 'message',
          channelId,
          authorId: bot.id,
          authorName: bot.name,
          fromHuman: false,
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

    // Input overwrites the persisted cursor with the durable per-bot cursor — the conductor owns the
    // cursor's coordinate space; the graph only borrows it for within-run threading.
    const input: Record<string, unknown> = {
      cursor: cursorBefore,
      forced: !!opts.seed,
    };
    if (opts.seed) input.messages = [new HumanMessage(opts.seed)];

    let failed = false;
    try {
      const stream = await this.graphs.getBotGraph(bot).stream(input, {
        configurable: { thread_id: thread, identity, capped, channelId },
        streamMode: 'updates',
        recursionLimit: MAX_TURN_STEPS,
      });
      for await (const update of stream as AsyncIterable<
        Record<string, BotStateDelta>
      >) {
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
            this.botBurst.set(
              channelId,
              (this.botBurst.get(channelId) ?? 0) + 1,
            ); // a real reply counts toward this room's loop breaker
          }
          // Surface whatever reactions the graph decided — the conductor only renders; the brain decides.
          if (delta.reaction)
            this.react(bot, channelId, delta.reaction, delta.reactionTargetId);
          if (delta.decision === 'acknowledge')
            this.react(
              bot,
              channelId,
              delta.ackEmoji ?? '👍',
              delta.reactionTargetId,
            );
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
      // The per-turn step cap is an expected ceiling on a long reactive loop, not a crash — turn it
      // into a clean first-person "pausing" message instead of a raw error, and end here.
      if (err instanceof GraphRecursionError) {
        this.handleStepCap(bot, channelId, { seed: !!opts.seed });
        return;
      }
      this.emitError(err);
      failed = true;
    }

    // The checkpoint is the cursor's source of truth; read it back, then persist it. MONOTONIC on
    // purpose: a checkpoint can legitimately report a cursor BELOW ours — a brand-new thread id
    // (e.g. ZERO_PROJECT changed) whose first committed node left the annotation default 0 while
    // the durable per-bot cursor is far ahead. `Math.max` keeps such states from rewinding the
    // durable cursor to 0 and re-gating the whole hydrated history. (Also covers the `0 ?? x`
    // falsy-zero trap the old `??` fallback had.)
    let cursorAfter = cursorBefore;
    try {
      const final = await this.graphs
        .getBotGraph(bot)
        .getState({ configurable: { thread_id: thread } });
      const committed = final.values.cursor as number | undefined;
      cursorAfter = Math.max(
        cursorBefore,
        typeof committed === 'number' ? committed : cursorBefore,
      );
    } catch {
      /* keep cursorBefore — a getState failure must not advance the cursor past unconsumed messages */
    }

    // Retry cap (the loop breaker for errors). A turn that threw WITHOUT advancing the cursor would
    // be re-scheduled forever — hasWork stays true, so gate + fetch re-bill every lap. For such
    // no-progress failures on a normal channel turn, count consecutive attempts at this cursor;
    // after MAX_TURN_RETRIES, drop the wedged batch and surface it, so one poison message can't
    // loop a bot. Seed turns (session relays) are excluded: they're spliced from the queue before
    // running, so a failure isn't re-scheduled and can't loop.
    // NOTE: unlike the playground (in-memory cursors reset on restart, giving skipped messages a
    // second chance), this skip is DURABLE — the dropped batch stays dropped across restarts. The
    // error event above is the only record of it; that's a conscious trade for durable cursors.
    if (failed && cursorAfter <= cursorBefore && !opts.seed) {
      const failKey = `${bot.id}|${channelId}`;
      const prior = this.failures.get(failKey);
      const attempts = prior?.cursor === cursorBefore ? prior.count + 1 : 1;
      if (attempts >= MAX_TURN_RETRIES) {
        const dropTo = this.channel.lengthOf(channelId);
        this.failures.delete(failKey);
        this.cursors.set(bot.id, channelId, dropTo);
        this.emitError(
          `${bot.name}: gave up after ${attempts} failed attempts; skipped ${dropTo - cursorBefore} unread message(s) to break the loop (see the error above).`,
        );
        return;
      }
      this.failures.set(failKey, { cursor: cursorBefore, count: attempts });
      // Leave the cursor unadvanced so the next schedule retries the batch.
      return;
    } else if (cursorAfter > cursorBefore) {
      this.failures.delete(`${bot.id}|${channelId}`); // real forward progress resets the streak
    }
    this.cursors.set(bot.id, channelId, cursorAfter);
    // Memory + tasks are reconciled INSIDE the graph (the bot's brain), not here — the conductor is
    // just the event loop: schedule, stream, emit, advance the cursor.
  }

  /** Relay a session's turn-end through its owner bot (gate-bypassed seed); its reply enters the
   * room the session was opened from — `session.notifyThread` carries that channel coordinate (it's
   * set from `identity.surface` at creation). An unknown coordinate falls back to the default room. */
  private async runSessionRelay(session: Session): Promise<void> {
    if (session.status !== 'idle' && session.status !== 'failed') return;
    const bot =
      this.employees.byId(session.ownerBot) ?? this.employees.fallbackOwner();

    const prompt =
      session.status === 'failed'
        ? `[Session ${session.id} — "${session.task}"] this turn FAILED: ${session.error ?? '(unknown)'}. The session is still open. Let the team know briefly, first person; reply_session("${session.id}", <message>) to retry or redirect it, or close_session("${session.id}") to drop it.`
        : `[Session ${session.id} — "${session.task}"] reported back:\n${session.lastReport ?? '(no report)'}\n\nThis is your own background session — it's still open with full context. Decide what's next:\n- reply_session("${session.id}", <message>) to continue it — answer its question, ask a follow-up, or approve its plan into execution (mode: "execute").\n- Relay the outcome to the team in the first person when it's worth sharing.\n- close_session("${session.id}") when this thread of work is finished.\nAnything about WHAT to build or WHY is Dennis's call — surface it to him; technical HOW is yours (answer it, or @mention the teammate whose area it is).`;
    const channelId = this.registry.get(session.notifyThread)
      ? session.notifyThread
      : this.channel.surfaceId;
    await this.runBotGraph(bot, { seed: prompt, channelId });
  }

  /** Emit a reaction from a bot ON a target message, so the surface folds it into that message. */
  private react(
    bot: EmployeeDefinition,
    channelId: string,
    emoji: string,
    targetId?: string,
  ): void {
    this.emit({
      id: `r-${this.emitSeq++}`,
      kind: 'reaction',
      channelId,
      botId: bot.id,
      botName: bot.name,
      emoji,
      targetId: targetId ?? '',
    });
  }

  /**
   * A reactive loop hit the per-turn step cap. End it gracefully: the bot tells the team — first
   * person, in the channel — that it's pausing, instead of the turn dying with a raw error. For a
   * normal channel turn we also advance the cursor to the high-water mark so the bot doesn't
   * immediately re-fire and re-hit the cap; seed turns aren't re-scheduled, so theirs stays put.
   */
  private handleStepCap(
    bot: EmployeeDefinition,
    channelId: string,
    opts: { seed?: boolean },
  ): void {
    const id = `${bot.id}:${this.mintTag}:${this.emitSeq++}`;
    const text =
      `Oh — I hit my per-turn step cap, so I've gotta pause this loop here. ` +
      `Ping me and I'll pick it right back up.`;
    this.channel.append({
      id,
      channelId,
      author: bot.name,
      authorId: bot.id,
      authorBotId: bot.id,
      text,
    });
    this.emit({
      id,
      kind: 'message',
      channelId,
      authorId: bot.id,
      authorName: bot.name,
      fromHuman: false,
      text,
      ts: clock(),
    });
    if (!opts.seed)
      this.cursors.set(bot.id, channelId, this.channel.lengthOf(channelId));
    this.failures.delete(`${bot.id}|${channelId}`); // a step cap isn't a failure — don't count it toward the retry streak
  }

  // ── Memory + identity ────────────────────────────────────────────────────────────────────────────

  /** A turn's identity comes from the room: its project (memory scope), its human members (the
   * participants — pair scopes in a DM), and its kind (isChannel guards 1:1 fact recall).
   *
   * A DM is WORKSPACE-level, not project-bound: it recalls every project the bot shares with the
   * present humans (real rooms both are in), `project` falls back to the default (only the
   * reminders home — project WRITES from a DM must name their project), and the DM row's own
   * `project` column is ignored. */
  private identityFor(botId: string, info: ChannelInfo): Identity {
    const botIds = new Set(this.employees.list().map((b) => b.id));
    const humans = info.members.filter((m) => !botIds.has(m));
    const isDm = info.kind === 'dm';
    return {
      selfAgent: botId,
      team: info.teamId,
      project: isDm ? DEFAULT_PROJECT : info.project,
      projects: isDm
        ? this.registry.projectsShared([botId, ...humans])
        : [info.project],
      participants: humans,
      speaker: this.bus.status.speaker,
      surface: info.channelId,
      isChannel: !isDm,
    };
  }

  private emitError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(message);
    this.emit({ id: `e-${this.emitSeq++}`, kind: 'error', message });
  }

  // ── Quiescence ───────────────────────────────────────────────────────────────────────────────────

  private anyUndelivered(): boolean {
    return this.registry
      .list()
      .some((info) =>
        this.botsIn(info).some((b) => this.hasWork(b, info.channelId)),
      );
  }

  private isQuiescent(): boolean {
    return (
      this.runningBots.size === 0 &&
      this.relayQueue.length === 0 &&
      (this.stopping || !this.anyUndelivered())
    );
  }

  private maybeResolveIdle(): void {
    if (!this.isQuiescent()) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }
}
