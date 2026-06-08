import { AIMessageChunk, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { getGraph } from './chat.js';
import { CLI_THREAD_ID, type Job, listJobs, onJobUpdate } from './jobs.js';
import type { ContextUsage, RenderItem } from './ui/messages.js';
import { toRenderItems } from './ui/messages.js';

/**
 * The single runtime that drives Zero. ALL invocations of the chat graph go through here,
 * serialized one turn at a time — both user input and background-job completions. This is what
 * lets a finished job flow *through* Zero (he composes the relay) instead of the UI rendering a
 * side-channel notice, and it prevents concurrent invocation of the chat thread.
 *
 * v0 is single-surface (one CLI chat). The conductor is the seam a Slack adapter plugs into;
 * per-surface state/queues are v1. Jobs already carry `notifyThread` so completions route to a
 * recorded surface rather than a hardcoded constant.
 */
type Turn = { kind: 'user'; text: string } | { kind: 'job'; job: Job };

// Narrowed render items for the live region: the in-flight message's tool rows and its streaming
// text are tracked separately so they render as distinct, stable groups (text doesn't bleed into
// the ⚙ tool indicators). The `tool` variant has no `text` field, hence the split.
type AssistantItem = Extract<RenderItem, { kind: 'assistant' }>;
type ToolItem = Extract<RenderItem, { kind: 'tool' }>;

export interface ConductorState {
  history: RenderItem[];
  liveTools: ToolItem[];
  liveText: AssistantItem[];
  busy: boolean;
  ctx: ContextUsage;
  running: number;
}

class Conductor {
  private state: ConductorState = {
    history: [],
    liveTools: [],
    liveText: [],
    busy: false,
    ctx: {},
    running: 0,
  };
  private queue: Turn[] = [];
  private processing = false;
  private subs = new Set<() => void>();
  private idleResolvers: (() => void)[] = [];
  private seq = 0;

  constructor() {
    // The chat layer — not the UI — is the subscriber to job lifecycle now.
    onJobUpdate((job) => {
      this.patch({ running: listJobs().filter((j) => j.status === 'running').length });
      // A background task wakes the chat-self once it's reached a terminal/blocking state: 'done'
      // (relay it), 'failed' (relay the error), or 'awaiting' (it needs human input). 'running' just
      // refreshes the footer count — it never wakes the chat, so a task runs silently to completion.
      if (job.status === 'done' || job.status === 'awaiting' || job.status === 'failed') {
        this.enqueue({ kind: 'job', job });
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

  /** Resolves once the queue is drained and no turn is processing. For deterministic tests. */
  whenIdle(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  submitUser(text: string): void {
    this.enqueue({ kind: 'user', text });
  }

  private patch(p: Partial<ConductorState>): void {
    this.state = { ...this.state, ...p };
    for (const cb of this.subs) cb();
  }

  private enqueue(turn: Turn): void {
    this.queue.push(turn);
    if (!this.processing) void this.drain();
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length) {
      await this.runTurn(this.queue.shift()!);
    }
    this.processing = false;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }

  private async runTurn(turn: Turn): Promise<void> {
    let thread: string;
    let input: HumanMessage;
    if (turn.kind === 'user') {
      thread = CLI_THREAD_ID;
      input = new HumanMessage(turn.text);
      this.patch({
        history: [...this.state.history, { id: `u-${this.seq++}`, kind: 'user', text: turn.text }],
        busy: true,
        liveTools: [],
        liveText: [],
      });
    } else {
      const j = turn.job;
      // Stale guard: by the time this turn is processed the job may have moved on (e.g. resumed).
      if (j.status !== 'done' && j.status !== 'awaiting' && j.status !== 'failed') return;
      thread = j.notifyThread;
      input =
        j.status === 'failed'
          ? new HumanMessage(
              `[Background task] ${j.id} ("${j.task}") failed: ${j.error ?? '(unknown)'}. Let the user know in your own words — briefly, first person.`,
            )
          : j.status === 'awaiting'
            ? new HumanMessage(
                `[Background task] ${j.id} ("${j.task}") needs your input:\n${j.lastReport ?? '(no report)'}\n\n` +
                  `This is your own background work. Relay what it needs to the user (first person); when they answer, ` +
                  `continue_work("${j.id}", <their answer>) to resume it to completion.`,
              )
            : new HumanMessage(
                `[Background task] ${j.id} ("${j.task}") finished:\n${j.lastReport ?? '(no report)'}\n\n` +
                  `This is your own work — relay the outcome to the user in the first person, briefly. The task is ` +
                  `done; don't check it again.`,
              );
      this.patch({ busy: true, liveTools: [], liveText: [] });
    }

    // Finalize a streamed message into the static history (and refresh the token gauge).
    const commit = (msg: BaseMessage | undefined) => {
      if (!msg) return;
      const usage = (msg as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
        .usage_metadata;
      const rows = toRenderItems([msg]);
      // Clear the live lists in the same patch that appends to history, so a finished message's
      // rows never appear in both <Static> and the live region during a message-id transition.
      // The next streaming chunk repopulates live immediately.
      this.patch({
        ...(usage ? { ctx: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
        ...(rows.length ? { history: [...this.state.history, ...rows] } : {}),
        liveTools: [],
        liveText: [],
      });
    };

    // Accumulate streamed chunks into real message objects; the in-flight one renders live, and
    // each completed message moves to history as the next begins.
    let curId: string | undefined;
    let cur: BaseMessage | undefined;
    try {
      const stream = await getGraph().stream(
        { messages: [input] },
        { configurable: { thread_id: thread }, streamMode: 'messages', recursionLimit: 50 },
      );
      for await (const [chunk] of stream) {
        const id = chunk.id ?? curId ?? '_0';
        if (cur && id !== curId) {
          commit(cur);
          cur = chunk;
          curId = id;
        } else if (cur && cur instanceof AIMessageChunk && chunk instanceof AIMessageChunk) {
          cur = cur.concat(chunk);
        } else {
          cur = chunk;
          curId = id;
        }
        const items = toRenderItems([cur]);
        this.patch({
          liveText: items.filter((i): i is AssistantItem => i.kind === 'assistant'),
          liveTools: items.filter((i): i is ToolItem => i.kind === 'tool'),
        });
      }
      commit(cur);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch({
        history: [...this.state.history, { id: `e-${this.seq++}`, kind: 'error', text: message }],
      });
    } finally {
      this.patch({ liveTools: [], liveText: [], busy: false });
    }
  }
}

export const conductor = new Conductor();
