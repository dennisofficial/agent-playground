import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { channel, type ChannelMsg } from './channel.js';
import { getGraphFor } from './chat.js';
import { gate, type GateDecision } from './gate.js';
import { type Job, listJobs, onJobUpdate } from './jobs.js';
import { extractAndRemember } from './memory/extract.js';
import { type Identity } from './memory/identity.js';
import { type Bot, botById, ROSTER } from './roster.js';
import { type ContextUsage, type RenderItem, toRenderItems } from './ui/messages.js';

/**
 * The dispatcher: a thin event loop around the shared `channel`. You append to the channel and move on
 * (never blocked); bots are independent reactive agents that run CONCURRENTLY. Each bot consumes the
 * channel exactly once via a per-bot cursor (`deliveredUpTo`), gated for respond/acknowledge/ignore, and
 * emits its own messages back as they're produced so teammates see them. This is the Slack model; the
 * `channel` + this dispatcher are the seam a Slack adapter replaces.
 *
 * (Phase 1: turns still run on the per-bot createAgent graph, streamed at the message level. Phase 2
 * swaps that for a custom LangGraph turn-graph with mid-step channel re-read.)
 */

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Max bot RESPONSE turns between human messages — the loop breaker so bots can't ping-pong forever. */
const MAX_BOT_BURST = 4;

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
    this.pushHistory({ id: msg.id, kind: 'user', text, speaker: who });
    // channel.subscribe → schedule() already fired; nothing to await.
  }

  /** Switch who's talking in the channel (the CLI's "/as <name>"), adding them to the members set. */
  setSpeaker(name: string): void {
    const id = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id) return;
    this.members.add(id);
    this.patch({ speaker: id });
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
      if (!this.nextFor(bot)) continue; // also advances the cursor past leading own messages
      this.claim(bot.id, () => this.processBot(bot));
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

  /** Peek the next non-own undelivered message for a bot, advancing the cursor past leading own ones. */
  private nextFor(bot: Bot): ChannelMsg | undefined {
    const undelivered = channel.since(this.deliveredUpTo.get(bot.id) ?? 0);
    let i = 0;
    while (i < undelivered.length && undelivered[i].authorBotId === bot.id) i++;
    if (i > 0) this.deliveredUpTo.set(bot.id, undelivered[i - 1].seq + 1); // consume own (no work)
    return undelivered[i];
  }

  /** Gate + act on a bot's whole undelivered batch, consuming it exactly once. */
  private async processBot(bot: Bot): Promise<void> {
    const cursor = this.deliveredUpTo.get(bot.id) ?? 0;
    const upto = channel.length; // consume up to here; messages arriving later stay undelivered
    const batch = channel.since(cursor).filter((m) => m.seq < upto && m.authorBotId !== bot.id);
    if (batch.length === 0) {
      this.deliveredUpTo.set(bot.id, upto);
      return;
    }
    const latest = batch[batch.length - 1];
    const capped = !!latest.authorBotId && this.botBurst >= MAX_BOT_BURST;
    try {
      const decision: GateDecision = capped
        ? { action: 'ignore' }
        : await gate(bot, latest.text, {
            authorBotId: latest.authorBotId,
            recentContext: this.recentContext(),
          });
      if (decision.action === 'respond') {
        this.botBurst++;
        await this.runBotTurn(bot, batch.map(asInput));
      } else if (decision.action === 'acknowledge') {
        await this.recordSeen(bot, batch);
        this.react(bot, decision.emoji ?? '👍');
      } else {
        await this.recordSeen(bot, batch);
      }
    } catch (err) {
      this.pushError(err);
    } finally {
      this.deliveredUpTo.set(bot.id, upto); // consumed exactly once, whatever the branch
      for (const m of batch) this.learnFrom(bot, m);
    }
  }

  // ── Turn execution ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run one bot turn on its createAgent graph, streamed at the message level. Each completed assistant
   * message is emitted to the CHANNEL as it's produced (so teammates see it mid-turn) and to history;
   * the first tool-only step fires a 👀.
   */
  private async runBotTurn(bot: Bot, inputs: HumanMessage[], surface?: string): Promise<void> {
    const thread = `${bot.id}:dev:root`;
    const identity = this.identityFor(bot.id, surface ?? thread);
    let firstAi = true;

    const commit = (msg: BaseMessage) => {
      const usage = (msg as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
        .usage_metadata;
      const rows = toRenderItems([msg], bot.name).map((r) => ({ ...r, id: `${bot.id}:${this.emitSeq++}` }));
      if (firstAi && msg.getType() === 'ai') {
        firstAi = false;
        const hasText = rows.some((r) => r.kind === 'assistant' && r.text);
        const hasTool = rows.some((r) => r.kind === 'tool');
        if (hasTool && !hasText) this.react(bot, '👀'); // seen, working
      }
      for (const r of rows) {
        if (r.kind === 'assistant' && r.text) {
          channel.append({ id: r.id, author: bot.name, authorId: bot.id, authorBotId: bot.id, text: r.text });
        }
      }
      if (rows.length || usage) {
        this.patch({
          ...(usage ? { ctx: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
          ...(rows.length ? { history: [...this.state.history, ...rows] } : {}),
        });
      }
    };

    try {
      const stream = await getGraphFor(bot.id).stream(
        { messages: inputs },
        { configurable: { thread_id: thread, identity }, streamMode: 'updates', recursionLimit: 50 },
      );
      for await (const update of stream as AsyncIterable<
        Record<string, { messages?: BaseMessage[] }>
      >) {
        for (const payload of Object.values(update)) {
          for (const msg of payload?.messages ?? []) commit(msg);
        }
      }
    } catch (err) {
      this.pushError(err);
    }
  }

  /** Relay a finished job through its owner bot (gate-bypassed); its reply enters the channel. */
  private async runJobRelay(job: Job): Promise<void> {
    if (job.status !== 'done' && job.status !== 'awaiting' && job.status !== 'failed') return;
    const bot = botById(job.ownerBot) ?? ROSTER[0];
    const prompt =
      job.status === 'failed'
        ? `[Background task] ${job.id} ("${job.task}") failed: ${job.error ?? '(unknown)'}. Let the team know in your own words — briefly, first person.`
        : job.status === 'awaiting'
          ? `[Background task] ${job.id} ("${job.task}") needs your input:\n${job.lastReport ?? '(no report)'}\n\nThis is your own background work. Relay what it needs (first person); when answered, continue_work("${job.id}", <answer>) to resume it.`
          : `[Background task] ${job.id} ("${job.task}") finished:\n${job.lastReport ?? '(no report)'}\n\nThis is your own work — relay the outcome to the team in the first person, briefly. The task is done; don't check it again.`;
    await this.runBotTurn(bot, [new HumanMessage(prompt)], job.notifyThread);
  }

  /** Record messages in a bot's checkpoint without a model call (the silent/ack path). Awaited → exactly-once. */
  private async recordSeen(bot: Bot, batch: ChannelMsg[]): Promise<void> {
    try {
      await getGraphFor(bot.id).updateState(
        { configurable: { thread_id: `${bot.id}:dev:root` } },
        { messages: batch.map(asInput) },
      );
    } catch {
      /* best-effort — a failure must never break the channel */
    }
  }

  /** Surface a reaction from a bot (the gate's ack, or the "seen, working" 👀). Slack seam: reactions.add. */
  private react(bot: Bot, emoji: string): void {
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

  /** Memory gate: learn a durable fact from a human message (fire-and-forget). Bot messages skipped. */
  private learnFrom(bot: Bot, m: ChannelMsg): void {
    if (m.authorBotId) return;
    const identity: Identity = {
      selfAgent: bot.id,
      company: 'local',
      participants: [...this.members],
      speaker: m.authorId,
      surface: `${bot.id}:dev:root`,
      isChannel: true,
    };
    void extractAndRemember({ bot, author: m.author, text: m.text, identity });
  }

  private recentContext(n = 6): string {
    return channel
      .since(Math.max(0, channel.length - n))
      .map((m) => `${m.author}: ${m.text}`)
      .join('\n');
  }

  private pushError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.pushHistory({ id: `e-${this.emitSeq++}`, kind: 'error', text: message });
  }

  // ── Quiescence ───────────────────────────────────────────────────────────────────────────────────

  private anyUndelivered(): boolean {
    return ROSTER.some((b) =>
      channel.since(this.deliveredUpTo.get(b.id) ?? 0).some((m) => m.authorBotId !== b.id),
    );
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

const asInput = (m: ChannelMsg): HumanMessage => new HumanMessage(`${m.author}: ${m.text}`);

export const conductor = new Conductor();
