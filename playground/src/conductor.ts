import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { getGraphFor } from './chat.js';
import { gate, type GateDecision } from './gate.js';
import { type Job, listJobs, onJobUpdate } from './jobs.js';
import { extractAndRemember } from './memory/extract.js';
import { type Identity } from './memory/identity.js';
import { type Bot, botById, ROSTER } from './roster.js';
import { type ContextUsage, type RenderItem, toRenderItems } from './ui/messages.js';

/**
 * The single runtime that drives the #dev channel. ALL bot turns go through here, serialized one at a
 * time, so the shared transcript stays coherent. It owns:
 *  - the channel log (the canonical transcript),
 *  - the response gate routing (which bot speaks to each message),
 *  - the bot↔bot cascade and its loop breaker,
 *  - relaying finished background jobs through their owner bot.
 *
 * Each bot has its own chat graph + checkpoint (`${botId}:dev:root`); a message is delivered to every
 * bot exactly once (respond → invoke, ignore → updateState), so each bot's working memory stays
 * complete even when silent.
 */

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Cap on bot replies per processing burst — the loop breaker so bots can't ping-pong forever. */
const MAX_BOT_REPLIES = 3;

type ChannelMsg = { author: string; authorId: string; authorBotId?: string; text: string };

export interface ConductorState {
  history: RenderItem[];
  busy: boolean;
  ctx: ContextUsage;
  running: number;
  /** Who the CLI is currently speaking as (lowercased id). */
  speaker: string;
  /** The bot currently working, if any (for the spinner). */
  responder?: string;
}

class Conductor {
  private state: ConductorState = {
    history: [],
    busy: false,
    ctx: {},
    running: 0,
    speaker: 'dennis',
  };
  private subs = new Set<() => void>();
  private idleResolvers: (() => void)[] = [];
  private seq = 0;

  // The channel's members — everyone who's spoken (recall pulls facts about all of them).
  private members = new Set<string>(['dennis']);
  // Canonical channel transcript; every bot is delivered each entry exactly once.
  private channelLog: ChannelMsg[] = [];
  private deliveredUpTo = new Map<string, number>();
  // Pending job-completion relays to run through their owner bot.
  private relayQueue: Job[] = [];
  private draining = false;

  constructor() {
    onJobUpdate((job) => {
      this.patch({ running: listJobs().filter((j) => j.status === 'running').length });
      // A finished/blocked job wakes its owner bot to relay it (gate-bypassed — the owner always relays).
      if (job.status === 'done' || job.status === 'awaiting' || job.status === 'failed') {
        this.relayQueue.push(job);
        void this.drain();
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

  /** Resolves once the channel is quiescent (no turn streaming, nothing pending). For tests. */
  whenIdle(): Promise<void> {
    if (!this.draining) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  submitUser(text: string): void {
    const who = titleCase(this.state.speaker);
    this.members.add(this.state.speaker);
    this.channelLog.push({ author: who, authorId: this.state.speaker, text });
    this.patch({
      history: [...this.state.history, { id: `u-${this.seq++}`, kind: 'user', text, speaker: who }],
    });
    void this.drain();
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

  /** Build the run identity for a bot's turn: who's present + who's speaking + this bot as self. */
  private identityFor(botId: string, surface: string): Identity {
    return {
      selfAgent: botId,
      company: 'local',
      participants: [...this.members],
      speaker: this.state.speaker,
      surface,
      isChannel: true, // #dev is a shared channel — 1:1 facts never surface here
    };
  }

  /** Memory gate: learn a durable fact from a human message (fire-and-forget). Bot messages skipped. */
  private learnFrom(bot: Bot, m: ChannelMsg): void {
    if (m.authorBotId) return; // only learn from human messages
    const identity: Identity = {
      selfAgent: bot.id,
      company: 'local',
      participants: [...this.members],
      speaker: m.authorId, // the actual author, not the mutable current speaker
      surface: `${bot.id}:dev:root`,
      isChannel: true,
    };
    void extractAndRemember({ bot, author: m.author, text: m.text, identity });
  }

  private recentContext(n = 6): string {
    return this.channelLog
      .slice(-n)
      .map((m) => `${m.author}: ${m.text}`)
      .join('\n');
  }

  // Single serialized loop: drain job relays, then deliver the channel to all bots, until quiescent.
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.patch({ busy: true });
    try {
      do {
        while (this.relayQueue.length) await this.runJobRelay(this.relayQueue.shift()!);
        await this.pump();
      } while (this.relayQueue.length || this.hasUndelivered());
    } finally {
      this.draining = false;
      this.patch({ busy: false, responder: undefined });
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const r of resolvers) r();
    }
  }

  private hasUndelivered(): boolean {
    return ROSTER.some((b) => (this.deliveredUpTo.get(b.id) ?? 0) < this.channelLog.length);
  }

  /**
   * Deliver pending channel messages to every bot, gating each. Idempotent — each (bot, message) is
   * processed exactly once (the pointer advances before any await), so a bot can't double-run; bot↔bot
   * cascades emerge from pointers reaching replies that land in the log. Capped by MAX_BOT_REPLIES.
   */
  private async pump(): Promise<void> {
    let replies = 0;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const bot of ROSTER) {
        const ptr = this.deliveredUpTo.get(bot.id) ?? 0;
        if (ptr >= this.channelLog.length) continue;
        const m = this.channelLog[ptr];
        this.deliveredUpTo.set(bot.id, ptr + 1); // advance first → never re-taken
        progressed = true;
        if (m.authorBotId === bot.id) break; // own message: already in this bot's thread; skip

        const decision: GateDecision =
          replies < MAX_BOT_REPLIES
            ? await gate(bot, m.text, {
                authorBotId: m.authorBotId,
                recentContext: this.recentContext(),
              })
            : { action: 'ignore' }; // past the cap: record but don't reply
        if (decision.action === 'respond') {
          await this.runBotTurn(bot, new HumanMessage(`${m.author}: ${m.text}`));
          replies++;
        } else if (decision.action === 'acknowledge') {
          await this.acknowledge(bot, m, decision.emoji ?? '👍'); // react, no full reply
        } else {
          await this.recordSeen(bot, m);
        }
        this.learnFrom(bot, m); // memory gate: learn from it whether we replied, reacted, or ignored
        break; // re-scan from the top — a reply may have appended new messages
      }
    }
  }

  /** Record a message in a bot's checkpoint without a model call (the silent/ack path). Best-effort. */
  private async recordSeen(bot: Bot, m: ChannelMsg): Promise<void> {
    try {
      getGraphFor(bot.id).updateState(
        { configurable: { thread_id: `${bot.id}:dev:root` } },
        { messages: [new HumanMessage(`${m.author}: ${m.text}`)] },
      );
    } catch {
      /* recording is best-effort — a failure must never break the channel */
    }
  }

  /**
   * The gate's middle tier: acknowledge a message with a reaction instead of a full reply. The bot
   * still "sees" it (recorded in its checkpoint) — it just signals receipt without noise. In the TUI
   * this surfaces a reaction line; a Slack adapter would call `reactions.add` on the message here.
   */
  private async acknowledge(bot: Bot, m: ChannelMsg, emoji: string): Promise<void> {
    await this.recordSeen(bot, m);
    this.react(bot, emoji);
  }

  /** Surface a reaction from a bot (the gate's ack, or the "seen, working" 👀). Slack seam: reactions.add. */
  private react(bot: Bot, emoji: string): void {
    this.patch({
      history: [
        ...this.state.history,
        { id: `r-${this.seq++}`, kind: 'reaction', emoji, by: bot.name },
      ],
    });
  }

  /** Relay a finished job through its owner bot (gate-bypassed); its reply enters the channel. */
  private async runJobRelay(job: Job): Promise<void> {
    if (job.status !== 'done' && job.status !== 'awaiting' && job.status !== 'failed') return; // stale
    const bot = botById(job.ownerBot) ?? ROSTER[0];
    const prompt =
      job.status === 'failed'
        ? `[Background task] ${job.id} ("${job.task}") failed: ${job.error ?? '(unknown)'}. Let the team know in your own words — briefly, first person.`
        : job.status === 'awaiting'
          ? `[Background task] ${job.id} ("${job.task}") needs your input:\n${job.lastReport ?? '(no report)'}\n\nThis is your own background work. Relay what it needs (first person); when answered, continue_work("${job.id}", <answer>) to resume it.`
          : `[Background task] ${job.id} ("${job.task}") finished:\n${job.lastReport ?? '(no report)'}\n\nThis is your own work — relay the outcome to the team in the first person, briefly. The task is done; don't check it again.`;
    await this.runBotTurn(bot, new HumanMessage(prompt), job.notifyThread);
  }

  /**
   * Run one bot's turn. Streams the graph at the MESSAGE level (streamMode 'updates'): each completed
   * message — a chunk of text, or a step's tool calls — lands in the transcript as soon as that step
   * finishes, not token-by-token and without waiting for the whole agentic turn. The spoken text is
   * also appended to the channel log so teammates can react to it.
   */
  private async runBotTurn(bot: Bot, input: HumanMessage, surface?: string): Promise<void> {
    const thread = `${bot.id}:dev:root`;
    const identity = this.identityFor(bot.id, surface ?? thread);
    this.patch({ responder: bot.name });

    let spoken = '';
    let firstAi = true;
    // Append one completed message to the transcript and accumulate its spoken text for the channel log.
    const commit = (msg: BaseMessage) => {
      const usage = (msg as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
        .usage_metadata;
      const rows = toRenderItems([msg], bot.name);
      // "Seen, working" signal: if the bot's FIRST action is a tool call (no text yet), react 👀 — like
      // a typing indicator that lasts while it grinds through tools (maps to Slack reactions.add).
      if (firstAi && msg.getType() === 'ai') {
        firstAi = false;
        const hasText = rows.some((r) => r.kind === 'assistant' && r.text);
        const hasTool = rows.some((r) => r.kind === 'tool');
        if (hasTool && !hasText) this.react(bot, '👀');
      }
      for (const r of rows) if (r.kind === 'assistant' && r.text) spoken += `${r.text}\n`;
      if (rows.length || usage) {
        this.patch({
          ...(usage ? { ctx: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
          ...(rows.length ? { history: [...this.state.history, ...rows] } : {}),
        });
      }
    };

    try {
      const stream = await getGraphFor(bot.id).stream(
        { messages: [input] },
        { configurable: { thread_id: thread, identity }, streamMode: 'updates', recursionLimit: 50 },
      );
      // Each update is { <nodeName>: { messages: [...] } } — complete messages from that step.
      for await (const update of stream as AsyncIterable<
        Record<string, { messages?: BaseMessage[] }>
      >) {
        for (const payload of Object.values(update)) {
          for (const msg of payload?.messages ?? []) commit(msg);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch({
        history: [...this.state.history, { id: `e-${this.seq++}`, kind: 'error', text: message }],
      });
    }

    const reply = spoken.trim();
    if (reply)
      this.channelLog.push({
        author: bot.name,
        authorId: bot.id,
        authorBotId: bot.id,
        text: reply,
      });
  }
}

export const conductor = new Conductor();
