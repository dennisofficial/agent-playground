import { EnvService } from '@core/config/env/env.service';
import {
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
import { LangfuseCallbackHandler } from '@workspace/langfuse';
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
import { extractMessageUsage } from '../llm/usage-format';
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
import { BoardEventsBus, type BoardEvent } from '../memory/board-events.bus';
import { boardEventRelayPrompt, sessionRelayPrompt } from './seed-relay';
import { SessionRunnerService } from '../sessions/session-runner.service';
import {
  type BotStateDelta,
  BotGraphFactory,
} from '../bot-graph/bot-graph.factory';
import { ConductorEventsBus } from './conductor-events.bus';

/**
 * The dispatcher: a thin event loop around the shared channel for the SINGLE orchestrator, Atlas.
 * The human appends to the channel and moves on (never blocked); Atlas consumes the channel exactly
 * once via its durable cursor and emits its messages back as they're produced. Silent seed wake-ups
 * (an approval-card verdict, etc.) run as gate-bypassed turns. This is the Slack model; the
 * ChatSurface port + this conductor are the seam a Slack adapter fills.
 *
 * Atlas's turn runs on its gate-less LangGraph turn-graph (BotGraphFactory.getConductorGraph) — the
 * BRAIN: it owns the mid-step channel re-read, the deterministic memory fetch/reconcile, and the
 * checkpoint. The conductor is just the event loop: scheduling, the cursor's coordinate space, and
 * channel writes. It is UI-agnostic — it emits domain ConductorEvents on the events bus that
 * presentation surfaces (TUI, the Slack adapter) subscribe to and render.
 *
 * Specialists no longer run chat turns: they execute only as pipeline stage sessions
 * (PipelineRunnerService + SessionRunner.openStageSession), invisible to the channel. The peer
 * scheduler (per-bot fan-out, session relays, the execution throttle, the read-the-room gate) was
 * collapsed in the Atlas migration.
 */

interface ToolCall {
  id?: string;
  name: string;
}

/** A short HH:MM:SS stamp for the transcript — handy for eyeballing the async flow. */
const clock = (): string =>
  new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

// ── Autonomy loop caps — UNCAPPED per Dennis (2026-06-09) ───────────────────────────────────────────
/** Max LangGraph super-steps in a SINGLE Atlas turn (`llm ⇄ tools`). Effectively uncapped — finite
 * only because LangGraph's `recursionLimit` requires a real number. Still pauses GRACEFULLY if reached. */
const MAX_TURN_STEPS = 1_000_000;

// ── Crash safety (NOT an autonomy throttle — kept on purpose) ───────────────────────────────────────
/** Attempts before the conductor gives up on a turn that keeps ERRORING without progress. Removing it
 * wouldn't free autonomy, it would let a broken turn re-bill forever. */
const MAX_TURN_RETRIES = 3;

/** How long shutdown waits for the in-flight turn before giving up (ms). */
const SHUTDOWN_IDLE_TIMEOUT_MS = 10_000;

@Injectable()
export class ConductorService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ConductorService.name);

  /** Atlas works ONE turn at a time across the human thread + its seed wakes — a single in-flight
   * guard (the orchestrator is one "person", not a roster). */
  private running = false;
  /** Pending SILENT wake-ups injected from outside the conductor (e.g. a Slack approval-card verdict
   * waking Atlas). Same delivery semantics: a gate-bypassed seed turn, run when Atlas is free; the
   * seed is visible only to Atlas — what (if anything) to say in the channel is its own call. */
  private seedQueue: Array<{ channelId: string; prompt: string }> = [];
  /** Consecutive no-progress failures at a stuck cursor, keyed by channelId — the error retry-cap
   * loop breaker, scoped so one room's poison message can't skip another room's batch. */
  private failures = new Map<string, { cursor: number; count: number }>();
  private idleResolvers: (() => void)[] = [];
  private emitSeq = 0; // unique id per emitted message/row
  /** Per-boot tag baked into MINTED channel-message ids. Ids persist now, and `emitSeq` restarts at
   * 0 every boot — an untagged id would collide with a hydrated row from the previous run. */
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
    private readonly boardEvents: BoardEventsBus,
  ) {}

  /** Atlas — the single orchestrator (the one `teamLead`). */
  private atlas(): EmployeeDefinition {
    return this.employees.teamLead();
  }

  /** Constructor stays pure; subscriptions + the first schedule happen here (after channel/cursor
   * hydration, which runs in onModuleInit — module init completes before any bootstrap hook). */
  async onApplicationBootstrap(): Promise<void> {
    // The process's default room registers itself (full roster + the default human). Rooms whose
    // logs survived a restart but whose registry rows are missing re-register with channel defaults.
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

    // Reconcile MEMBERSHIP with the current roster BEFORE scheduling or cursor work. `ensure` above
    // returns an existing room untouched, so a room registered under a PRIOR roster keeps stale
    // membership — e.g. the Atlas migration collapsed 6 bots → `atlas`, but a channel created before
    // it still lists the dead {alex,riley,…} and NOT `atlas`. The scheduler gates every room on
    // `members.includes(atlas.id)`, so without this Atlas is skipped forever in those rooms (silent
    // channel, no thinking bubble). `addMembers` is additive + idempotent (old ids stay as historical
    // participants), so it's safe every boot and self-heals any future roster change.
    const roster = this.employees.list().map((b) => b.id);
    for (const info of this.registry.list())
      this.registry.addMembers(info.channelId, roster);

    // Reconcile durable cursors with each room's hydration window BEFORE any scheduling. A room
    // hydrates only a tail; a cursor below the window would have the gap silently skipped by
    // `since()`. A bot with NO stored cursor starts from the window floor (joins at the present
    // instead of replaying the archived history).
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

    // ATLAS CURSOR BOOTSTRAP (Atlas migration cutover). Seed Atlas's room cursor to the FURTHEST
    // point any old per-bot cursor reached, so the single orchestrator neither replays the hydrated
    // transcript (cost + re-emitting old Slack messages) nor skips pending work. `Math.max` guard =
    // never rewind; idempotent across boots (the specialists' cursors are frozen post-cutover, and
    // once Atlas advances past them its own cursor wins).
    const atlas = this.atlas();
    for (const info of this.registry.list()) {
      const committed = this.botsIn(info)
        .filter((b) => this.cursors.has(b.id, info.channelId))
        .map((b) => this.cursors.get(b.id, info.channelId));
      if (committed.length === 0) continue;
      const target = Math.max(...committed);
      const current = this.cursors.has(atlas.id, info.channelId)
        ? this.cursors.get(atlas.id, info.channelId)
        : this.channel.floorSeqOf(info.channelId);
      this.cursors.set(atlas.id, info.channelId, Math.max(current, target));
    }

    this.unsubscribers.push(this.channel.subscribe(() => this.schedule()));
    // Pending-keys mode: when provider keys land at runtime, release the gate and deliver backlog.
    const readySub = this.readiness.ready$.subscribe(() => this.schedule());
    this.unsubscribers.push(() => readySub.unsubscribe());
    // Session updates drive the running-sessions UI count AND relay an Atlas-owned background
    // session's turn-end back to Atlas. Pipeline stage advancement is owned by PipelineRunnerService
    // (its own onUpdate subscription); pipeline stage sessions are owned by SPECIALISTS, so the
    // owner-is-Atlas filter below keeps them out of this chat relay (no double-handling).
    this.unsubscribers.push(
      this.sessions.onUpdate((session) => {
        void this.sessions
          .list({ status: 'running' })
          .then((running) => this.bus.patchStatus({ running: running.length }))
          .catch((err) =>
            this.logger.warn(`running-sessions count refresh failed: ${err}`),
          );
        this.maybeRelaySession(session);
      }),
    );
    // Narrate the human-facing PIPELINE board events (PR opened/ready, self-review verdict) in chat —
    // the pipeline runs as detached specialist sessions, so without this Atlas would ship/stall
    // silently. ticket-approved/plan-attached are filtered out (PipelineRunnerService owns those).
    this.unsubscribers.push(
      this.boardEvents.onEvent((event) => this.maybeRelayBoardEvent(event)),
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

  /** Resolves once Atlas isn't running and nothing is left to deliver. For tests + shutdown. */
  whenIdle(): Promise<void> {
    if (this.isQuiescent()) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Append the current speaker's message to the channel and return immediately — NEVER waits on
   * Atlas. (The TUI's input path; the SurfaceBridge uses `submitFrom` with the surface's author.) */
  submitUser(text: string): void {
    this.submitFrom(
      this.bus.status.speaker,
      titleCase(this.bus.status.speaker),
      text,
    );
  }

  /**
   * SILENTLY wake Atlas with a gate-bypassed seed turn — exposed for out-of-band events (e.g. an
   * approval-card verdict). Nothing is appended to the channel log: only Atlas sees the seed, and
   * whether anything gets said in the room is its decision. `botId` is accepted for the existing
   * caller signature but the orchestrator is always Atlas. */
  injectSeed(_botId: string, channelId: string, prompt: string): void {
    this.seedQueue.push({ channelId, prompt });
    this.schedule();
  }

  /**
   * Relay an ATLAS-owned background session's turn-end (idle/failed) back to Atlas as a gate-bypassed
   * seed carrying the worker's report — the wake that lets Atlas act on its own investigate /
   * create_session workers (reply, close, or speak). A 'running' start or a 'closed' session never
   * relays. Sessions owned by a SPECIALIST (pipeline stages) are skipped: PipelineRunnerService drives
   * those, so relaying them here would both wake the wrong actor and double-handle the turn-end.
   */
  private maybeRelaySession(session: Session): void {
    if (session.status !== 'idle' && session.status !== 'failed') return;
    if (session.ownerBot !== this.atlas().id) return;
    const channelId = this.registry.get(session.notifyThread)
      ? session.notifyThread
      : this.channel.surfaceId;
    this.seedQueue.push({ channelId, prompt: sessionRelayPrompt(session) });
    this.schedule();
  }

  /**
   * Narrate a human-facing pipeline board event (PR opened/ready, self-review verdict) by waking Atlas
   * with a gate-bypassed seed. `boardEventRelayPrompt` returns null for the events the conductor must
   * NOT consume (`ticket-approved` is the plan-gate resume owned by PipelineRunnerService;
   * `plan-attached` isn't narrated), so this never double-handles a transition.
   */
  private maybeRelayBoardEvent(event: BoardEvent): void {
    const prompt = boardEventRelayPrompt(event);
    if (!prompt) return;
    const thread = 'notifyThread' in event ? event.notifyThread : undefined;
    const channelId =
      thread && this.registry.get(thread) ? thread : this.channel.surfaceId;
    this.seedQueue.push({ channelId, prompt });
    this.schedule();
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
    const id = opts.id ?? `u-${this.mintTag}-${this.emitSeq++}`;
    this.channel.append({
      id,
      channelId,
      author: authorName,
      authorId,
      text,
    });
    // Surface the human's own message through the SAME event stream, keyed by the channel id — so
    // the UI renders it from one uniform path and a reaction can fold onto it.
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

  /** The human currently speaking (the TUI's `/as` identity). */
  get speaker(): string {
    return this.bus.status.speaker;
  }

  private emit(event: ConductorEvent): void {
    this.bus.emit(event);
  }

  private refreshThinking(): void {
    const atlas = this.atlas();
    this.bus.patchStatus({
      thinking: this.running ? [atlas.name] : [],
      busy: this.running,
    });
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Synchronous: claims Atlas when it has work and starts the turn WITHOUT awaiting (so input never
   * blocks). Re-entrant-safe — it only kicks off `void` work. Re-called on channel growth and on
   * each turn's completion.
   */
  private schedule(): void {
    if (this.stopping) {
      this.maybeResolveIdle();
      return;
    }
    const atlas = this.atlas();
    // Injected silent wake-ups first (gate-bypassed, run when Atlas is free).
    for (let i = 0; i < this.seedQueue.length; ) {
      if (this.running) break;
      const seed = this.seedQueue[i];
      const team = this.registry.teamIdOf(seed.channelId);
      if (!this.readiness.isReady(team)) {
        this.readiness.ensureChecked(team);
        i++;
        continue;
      }
      this.seedQueue.splice(i, 1);
      const channelId = this.registry.get(seed.channelId)
        ? seed.channelId
        : this.channel.surfaceId;
      this.claim(() => this.runBotGraph(atlas, { seed: seed.prompt, channelId }));
    }
    // Room deliveries: Atlas's undelivered work per room it's a member of.
    if (!this.running)
      for (const info of this.registry.list()) {
        if (this.running) break;
        if (!info.members.includes(atlas.id)) continue;
        if (!this.readiness.isReady(info.teamId)) {
          this.readiness.ensureChecked(info.teamId);
          continue;
        }
        if (!this.hasWork(atlas, info.channelId)) continue;
        this.claim(() => this.runBotGraph(atlas, { channelId: info.channelId }));
      }
    this.maybeResolveIdle();
  }

  /** Mark Atlas busy (before any async work), run `task`, then release + re-schedule. */
  private claim(task: () => Promise<void>): void {
    this.running = true;
    this.refreshThinking();
    void task().finally(() => {
      this.running = false;
      this.refreshThinking();
      this.schedule();
    });
  }

  /** True if a room holds a non-own message Atlas hasn't consumed yet. */
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
   * Run one Atlas turn on its gate-less LangGraph turn-graph. The graph consumes the channel
   * (mid-step) and checkpoints; the conductor interprets its streamed node deltas — writing each
   * assistant message back to the CHANNEL and emitting domain ConductorEvents. After the turn it
   * reads the authoritative cursor back from the checkpoint and persists it.
   *
   * `seed` forces a turn on a synthetic message (silent wakes); `channelId` is the room the turn runs
   * in (defaults to the process's default room).
   */
  private async runBotGraph(
    bot: EmployeeDefinition,
    opts: { seed?: string; channelId?: string } = {},
  ): Promise<void> {
    // Scope the LangGraph thread by ROOM so one room's durable conversation history never replays
    // into another — the {botId}:{channelId}:root convention.
    const channelId = opts.channelId ?? this.channel.surfaceId;
    const info = this.registry.ensure({ channelId });
    // Resolve this workspace's LLM keys and run the WHOLE turn inside the credential context, so the
    // model/embedding builders (llm node, reconcile) all pick up the right tenant's key.
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

    // ── share_artifact coordination ──────────────────────────────────────────────────────────────
    // When an AIMessage contains both text AND share_artifact tool call(s), the message event is
    // DEFERRED until the tool results arrive (so the Slack post happens AFTER the file_id is known
    // and can be attached via chat.update). `resolvedFileIds` accumulates ids across all
    // share_artifact results in the turn; they're spliced into the next text-bearing message event.
    let deferredMsg:
      | {
          id: string;
          text: string;
          usage: MessageUsage | undefined;
          pendingCallIds: Set<string>;
        }
      | undefined;
    const resolvedFileIds: string[] = [];
    const artifactCallIds = new Set<string>();

    const flushDeferred = (fileIds: string[]) => {
      if (!deferredMsg) return;
      const { id, text, usage } = deferredMsg;
      deferredMsg = undefined;
      this.emit({
        id,
        kind: 'message',
        channelId,
        authorId: bot.id,
        authorName: bot.name,
        fromHuman: false,
        text,
        usage,
        fileIds: fileIds.length > 0 ? fileIds : undefined,
        ts: clock(),
      });
    };

    const commit = (msg: BaseMessage) => {
      const usage = extractMessageUsage(msg);
      // Footer ctx tracks EVERY billed step — including tool-only ones, which carry usage but no
      // text and so emit no `message` event.
      if (usage) {
        this.bus.patchStatus({
          ctx: { input: usage.input, output: usage.output },
        });
        this.emit({
          id: `usage-${bot.id}:${this.mintTag}:${this.emitSeq++}`,
          kind: 'usage',
          botId: bot.id,
          role: 'chat',
          usage,
        });
      }

      const text = flattenContent(msg.content).trim();
      const calls = (msg as { tool_calls?: ToolCall[] }).tool_calls ?? [];
      const shareArtifactCalls = calls.filter(
        (c) => c.name === 'share_artifact',
      );
      for (const c of shareArtifactCalls) if (c.id) artifactCallIds.add(c.id);

      if (text) {
        // The reply goes back onto the room's shared log so the surface + reconcile see it.
        const id = `${bot.id}:${this.mintTag}:${this.emitSeq++}`;
        this.channel.append({
          id,
          channelId,
          author: bot.name,
          authorId: bot.id,
          authorBotId: bot.id,
          text,
        });

        if (shareArtifactCalls.length > 0) {
          deferredMsg = {
            id,
            text,
            usage,
            pendingCallIds: new Set(
              shareArtifactCalls
                .map((c) => c.id)
                .filter((id): id is string => id != null),
            ),
          };
        } else {
          const ids = resolvedFileIds.splice(0);
          this.emit({
            id,
            kind: 'message',
            channelId,
            authorId: bot.id,
            authorName: bot.name,
            fromHuman: false,
            text,
            usage,
            fileIds: ids.length > 0 ? ids : undefined,
            ts: clock(),
          });
        }
      }

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

    // Input overwrites the persisted cursor with the durable cursor — the conductor owns the
    // cursor's coordinate space; the graph only borrows it for within-run threading. A seed rides
    // as a synthetic Human message in state.messages (the prelude/llm respond to it).
    const input: Record<string, unknown> = { cursor: cursorBefore };
    if (opts.seed) input.messages = [new HumanMessage(opts.seed)];

    let failed = false;
    try {
      // Langfuse: a FRESH handler per turn (it holds per-run span state). `sessionId = channelId`
      // groups every turn in a room into one Langfuse session (the conversation timeline).
      const stream = await this.graphs.getConductorGraph(bot).stream(input, {
        configurable: { thread_id: thread, identity, channelId },
        streamMode: 'updates',
        recursionLimit: MAX_TURN_STEPS,
        callbacks: [
          new LangfuseCallbackHandler({
            sessionId: channelId,
            userId: bot.id,
            tags: [bot.name, info.teamId],
            traceMetadata: {
              teamId: info.teamId,
              threadId: thread,
              seed: !!opts.seed,
            },
          }),
        ],
        runName: `turn:${bot.name}`,
      });
      for await (const update of stream as AsyncIterable<
        Record<string, BotStateDelta>
      >) {
        for (const delta of Object.values(update)) {
          // Observability: the fetch node's pre-LLM recall — what Atlas walked in knowing this turn.
          if (delta.recalled) {
            this.emit({
              id: `m-${this.emitSeq++}`,
              kind: 'recall',
              botId: bot.id,
              botName: bot.name,
              text: delta.recalled,
            });
          }
          // READ-THE-ROOM: a suppressed draft never appears in delta.messages, so `commit` can't
          // bill it — emit its usage here (same pipeline as tool-only steps), then the debug event.
          if (delta.draftUsage) {
            this.bus.patchStatus({
              ctx: {
                input: delta.draftUsage.input,
                output: delta.draftUsage.output,
              },
            });
            this.emit({
              id: `usage-${bot.id}:${this.mintTag}:${this.emitSeq++}`,
              kind: 'usage',
              botId: bot.id,
              role: 'chat',
              usage: delta.draftUsage,
            });
          }
          if (delta.draft) {
            this.emit({
              id: `d-${this.emitSeq++}`,
              kind: 'draft',
              botId: bot.id,
              botName: bot.name,
              text: delta.draft,
            });
          }
          for (const msg of delta.messages ?? []) {
            if (msg.getType() === 'ai') {
              commit(msg); // skip injected Human messages (already in channel/UI)
            } else if (msg instanceof ToolMessage) {
              // A share_artifact result — collect its file_id regardless of whether a message is
              // currently deferred (Case B: the artifact was uploaded in a tool-call-only step).
              const callId = msg.tool_call_id;
              if (callId && artifactCallIds.has(callId)) {
                artifactCallIds.delete(callId);
                const content =
                  typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content);
                const m = content.match(/file_id:\s*(F[A-Z0-9]+)/i);
                if (m?.[1]) resolvedFileIds.push(m[1]);
                if (deferredMsg?.pendingCallIds.has(callId)) {
                  deferredMsg.pendingCallIds.delete(callId);
                  if (deferredMsg.pendingCallIds.size === 0) {
                    flushDeferred(resolvedFileIds.splice(0));
                  }
                }
              }
            }
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
    } finally {
      // Safety-flush a deferred message (e.g. the graph ended/errored before the tool result
      // arrived). Posts without file_ids rather than silently dropping the message.
      if (deferredMsg) flushDeferred(resolvedFileIds.splice(0));
    }

    // The checkpoint is the cursor's source of truth; read it back, then persist it. MONOTONIC on
    // purpose: `Math.max` keeps a brand-new thread's default-0 annotation from rewinding the durable
    // cursor (also covers the `0 ?? x` falsy-zero trap the old `??` fallback had).
    let cursorAfter = cursorBefore;
    try {
      const final = await this.graphs
        .getConductorGraph(bot)
        .getState({ configurable: { thread_id: thread } });
      const committed = (final.values as { cursor?: number }).cursor;
      cursorAfter = Math.max(
        cursorBefore,
        typeof committed === 'number' ? committed : cursorBefore,
      );
    } catch {
      /* keep cursorBefore — a getState failure must not advance the cursor past unconsumed messages */
    }

    // Retry cap (the loop breaker for errors). A turn that threw WITHOUT advancing the cursor would
    // be re-scheduled forever — hasWork stays true. Count consecutive attempts at this cursor; after
    // MAX_TURN_RETRIES, drop the wedged batch and surface it. Seed turns are excluded (they're
    // spliced from the queue before running, so a failure isn't re-scheduled).
    if (failed && cursorAfter <= cursorBefore && !opts.seed) {
      const failKey = channelId;
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
      this.failures.delete(channelId); // real forward progress resets the streak
    }
    this.cursors.set(bot.id, channelId, cursorAfter);
    // Memory + tasks are reconciled INSIDE the graph (Atlas's brain), not here — the conductor is
    // just the event loop: schedule, stream, emit, advance the cursor.
  }

  /**
   * A reactive loop hit the per-turn step cap. End it gracefully: Atlas tells the channel — first
   * person — that it's pausing, instead of the turn dying with a raw error. For a normal channel turn
   * we also advance the cursor to the high-water mark so it doesn't immediately re-fire and re-hit
   * the cap; seed turns aren't re-scheduled, so theirs stays put.
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
    this.failures.delete(channelId); // a step cap isn't a failure — don't count it toward the streak
  }

  // ── Memory + identity ────────────────────────────────────────────────────────────────────────────

  /** A turn's identity comes from the room: its project (memory scope), its human members (the
   * participants — pair scopes in a DM), and its kind (isChannel guards 1:1 fact recall).
   *
   * A DM is WORKSPACE-level, not project-bound: it recalls every project Atlas shares with the
   * present humans, `project` falls back to the default, and the DM row's own `project` is ignored. */
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
    const atlas = this.atlas();
    return this.registry
      .list()
      .some(
        (info) =>
          info.members.includes(atlas.id) &&
          this.hasWork(atlas, info.channelId),
      );
  }

  private isQuiescent(): boolean {
    return (
      !this.running &&
      this.seedQueue.length === 0 &&
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
