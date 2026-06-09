import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { type BotStateDelta, getBotGraph } from './bot-graph.js';
import { channel } from './channel.js';
import { type Employee, botById, ROSTER } from './employees/index.js';
import { type Job, listJobs, onJobUpdate } from './jobs.js';
import { type Identity } from './memory/identity.js';
import { listTasks } from './memory/tasks.js';
import { gateCostUsd } from './model.js';
import {
  type ContextUsage,
  type MessageUsage,
  type RenderItem,
  toRenderItems,
} from './ui/messages.js';

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
 * is just the event loop: scheduling, the cursor's coordinate space, and channel/UI emission. The graph's
 * streamed deltas drive what the dispatcher renders and emits.
 */

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** A short HH:MM:SS stamp for the transcript — handy for eyeballing the async/parallel flow. */
const clock = (): string =>
  new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** Max bot RESPONSE turns between human messages — the loop breaker so bots can't ping-pong forever. */
const MAX_BOT_BURST = 4;

/** Attempts before the conductor gives up on a turn that keeps erroring without progress (drops + logs). */
const MAX_TURN_RETRIES = 3;

export interface ConductorState {
  history: RenderItem[];
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
  private state: ConductorState = {
    history: [],
    busy: false,
    ctx: {},
    running: 0,
    speaker: 'dennis',
    thinking: [],
  };
  private subs = new Set<() => void>();
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
    onJobUpdate((job) => {
      this.patch({ running: listJobs().filter((j) => j.status === 'running').length });
      if (job.status === 'done' || job.status === 'awaiting' || job.status === 'failed') {
        this.relayQueue.push(job);
        this.schedule();
      }
    });
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  getState(): ConductorState {
    return this.state;
  }

  /** Resolves once nothing is running and nothing is left to deliver. For deterministic tests. */
  whenIdle(): Promise<void> {
    if (this.isQuiescent()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Append the user's message to the channel and return immediately — NEVER waits on a bot. */
  submitUser(text: string): void {
    const who = titleCase(this.state.speaker);
    this.members.add(this.state.speaker);
    this.botBurst = 0; // a human spoke → reset the bot-cascade budget
    const msg = channel.append({
      id: `u-${this.emitSeq++}`,
      author: who,
      authorId: this.state.speaker,
      text,
    });
    this.pushHistory({ id: msg.id, kind: 'user', text, speaker: who, ts: clock() });
    // channel.subscribe → schedule() already fired; nothing to await.
  }

  /** Switch who's talking in the channel (the CLI's "/as <name>"), adding them to the members set. */
  setSpeaker(name: string): void {
    const id = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id) return;
    this.members.add(id);
    this.patch({ speaker: id });
  }

  /** CLI "/tasks": dump the open task board into the transcript so you can glance at what reflect captured. */
  showTasks(): void {
    const tasks = listTasks({ company: 'local', status: 'open' });
    const text = tasks.length
      ? `Open tasks (${tasks.length}):\n` +
        tasks
          .map(
            (t) =>
              `  #${t.id}  ${t.assignee ? `[${t.assignee}]` : '[unassigned]'}  ${t.description}`,
          )
          .join('\n')
      : 'No open tasks yet.';
    this.pushHistory({ id: `note-${this.emitSeq++}`, kind: 'note', text });
  }

  private patch(p: Partial<ConductorState>): void {
    this.state = { ...this.state, ...p };
    for (const cb of this.subs) cb();
  }

  private pushHistory(...items: RenderItem[]): void {
    this.patch({ history: [...this.state.history, ...items] });
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
   * checkpoints; the dispatcher interprets its streamed node deltas — emitting each assistant message to
   * the CHANNEL (so teammates see it mid-turn) + history, firing 👀 on the first tool-only step, and
   * surfacing the ack reaction. After the turn it reads the authoritative cursor back from the checkpoint
   * and runs the reflect pass over what this bot consumed (facts to remember + open tasks to track).
   *
   * `seed` forces a gate-bypassed respond on a synthetic message (job relays); `surface` overrides the
   * identity surface (a job's notify thread).
   */
  private async runBotGraph(
    bot: Employee,
    opts: { seed?: string; surface?: string } = {},
  ): Promise<void> {
    const thread = `${bot.id}:dev:root`;
    const identity = this.identityFor(bot.id, opts.surface ?? thread);
    const cursorBefore = this.deliveredUpTo.get(bot.id) ?? 0;
    const capped = this.botBurst >= MAX_BOT_BURST;
    let firstAi = true;
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
      const stamp = clock();
      // Attach usage to the assistant text row — "the end of the message" the user sees. Tool-only steps
      // (no text) don't carry a usage line; their cost still rolls into the footer ctx below.
      const rows = toRenderItems([msg], bot.name).map((r) => ({
        ...r,
        id: `${bot.id}:${this.emitSeq++}`,
        ...(r.kind === 'assistant' ? { ts: stamp, usage } : {}),
      }));
      if (firstAi) {
        firstAi = false;
        const hasText = rows.some((r) => r.kind === 'assistant' && r.text);
        const hasTool = rows.some((r) => r.kind === 'tool');
        if (hasTool && !hasText) this.react(bot, '👀'); // seen, working
      }
      for (const r of rows) {
        if (r.kind === 'assistant' && r.text) {
          channel.append({
            id: r.id,
            author: bot.name,
            authorId: bot.id,
            authorBotId: bot.id,
            text: r.text,
          });
        }
      }
      if (rows.length || usage) {
        this.patch({
          ...(usage ? { ctx: { input: usage.input, output: usage.output } } : {}),
          ...(rows.length ? { history: [...this.state.history, ...rows] } : {}),
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
        recursionLimit: 50,
      });
      for await (const update of stream as AsyncIterable<Record<string, BotStateDelta>>) {
        for (const delta of Object.values(update)) {
          // Debug only: surface the soft gate's verdict + rationale inline, BEFORE the reply/reaction it
          // explains. This is the only UI trace of an `ignore`, which otherwise leaves no mark.
          if (delta.reasoning) {
            const u = delta.gateUsage;
            const cost = u
              ? `  ·  ${u.input} in · ${u.output} out · $${gateCostUsd(u.input, u.output).toFixed(6)}`
              : '';
            this.pushHistory({
              id: `g-${this.emitSeq++}`,
              kind: 'gate',
              by: bot.name,
              action: delta.decision ?? 'ignore',
              reasoning: `${delta.reasoning}${cost}`,
            });
          }
          if (delta.decision === 'respond' && !responded) {
            responded = true;
            this.botBurst++; // a real reply counts toward the loop breaker
          }
          if (delta.decision === 'acknowledge') this.react(bot, delta.ackEmoji ?? '👍');
          // The fetch node's pre-LLM recall — surface what the bot walked in knowing (debug, dim).
          if (delta.recalled) {
            this.pushHistory({
              id: `m-${this.emitSeq++}`,
              kind: 'recall',
              by: bot.name,
              text: delta.recalled,
            });
          }
          for (const msg of delta.messages ?? []) {
            if (msg.getType() === 'ai') commit(msg); // skip injected Human messages (already in channel/UI)
          }
        }
      }
    } catch (err) {
      this.pushError(err);
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
        this.pushError(
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
    const prompt =
      job.status === 'failed'
        ? `[Background task] ${job.id} ("${job.task}") failed: ${job.error ?? '(unknown)'}. Let the team know in your own words — briefly, first person.`
        : job.status === 'awaiting'
          ? `[Background task] ${job.id} ("${job.task}") needs your input:\n${job.lastReport ?? '(no report)'}\n\nThis is your own background work. Relay what it needs (first person); when answered, continue_work("${job.id}", <answer>) to resume it.`
          : `[Background task] ${job.id} ("${job.task}") finished:\n${job.lastReport ?? '(no report)'}\n\nThis is your own work — relay the outcome to the team in the first person, briefly. The task is done; don't check it again.`;
    await this.runBotGraph(bot, { seed: prompt, surface: job.notifyThread });
  }

  /** Surface a reaction from a bot (the gate's ack, or the "seen, working" 👀). Slack seam: reactions.add. */
  private react(bot: Employee, emoji: string): void {
    this.pushHistory({ id: `r-${this.emitSeq++}`, kind: 'reaction', emoji, by: bot.name });
  }

  // ── Memory + identity (unchanged) ────────────────────────────────────────────────────────────────

  private identityFor(botId: string, surface: string): Identity {
    return {
      selfAgent: botId,
      company: 'local',
      participants: [...this.members],
      speaker: this.state.speaker,
      surface,
      isChannel: true,
    };
  }

  private pushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.pushHistory({ id: `e-${this.emitSeq++}`, kind: 'error', text: message });
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
