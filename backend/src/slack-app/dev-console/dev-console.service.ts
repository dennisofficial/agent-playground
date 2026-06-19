import { EnvService } from '@core/config/env/env.service';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Subscription } from 'rxjs';
import { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import { ChannelService } from '@harness/channel/channel.service';
import { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import { ConductorService } from '@harness/conductor/conductor.service';
import type {
  AccumulatedUsage,
  ConductorEvent,
} from '@harness/domain/conductor-events';
import { DEFAULT_PROJECT, DEFAULT_TEAM } from '@harness/domain/identity';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import {
  CHAT_MODEL,
  calculateCost,
  formatUsageLine,
} from '@harness/llm/usage-format';
import {
  SESSION_REGISTRY,
  type Session,
  type SessionRegistry,
} from '@harness/sessions/session-registry.port';

/** Dedicated thread prefix — the Slack adapter ignores these (`parseSlackSurface` → undefined), so a
 * console turn never leaks into Slack and vice-versa. */
const CONSOLE_PREFIX = 'console:';
/** Per-channel ring cap (a console thread is short-lived; this is just a runaway guard). */
const MAX_EVENTS = 2000;
/** A turn is "settled" once its channel has been quiet this long after at least one event landed. */
const SETTLE_QUIET_MS = 1500;
const DEFAULT_AUTHOR = { id: 'dennis', name: 'Dennis' };

interface ChannelBuffer {
  /** Monotonic per-channel event cursor (distinct from the channel-log `seq`). */
  seq: number;
  events: { seq: number; event: ConductorEvent }[];
  lastEventAt: number;
}

export interface NewThreadInput {
  team?: string;
  project?: string;
  kind?: 'channel' | 'dm';
}
export interface ConsoleSessionView {
  id: string;
  status: string;
  mode: string;
  task: string;
  lastReport?: string;
}
export interface ConsoleTraceItem {
  seq: number;
  kind: string;
  text: string;
}
export interface ConsoleEventsView {
  cursor: number;
  settled: boolean;
  reply?: string;
  trace: ConsoleTraceItem[];
  sessions: ConsoleSessionView[];
  cost?: string;
}

/**
 * Dev-only seam to drive + observe Atlas from a terminal CLI, on a dedicated `console:*` thread.
 * It does NOT add a second `CHAT_SURFACE` (that seam is single-surface); instead it injects via the
 * normal inbound path (`ConductorService.submitFrom` — a real user turn, gate and all) and observes
 * out-of-band by tapping `ConductorEventsBus.events$` (channel-scoped after the Phase-0 event change)
 * plus the `SESSION_REGISTRY`. Mounted only when `DEV_CONSOLE_ENABLED`.
 */
@Injectable()
export class DevConsoleService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DevConsoleService.name);
  private readonly buffers = new Map<string, ChannelBuffer>();
  /** Sessions opened by a console turn, keyed by their `notifyThread` (the console channel). */
  private readonly sessionsByThread = new Map<
    string,
    Map<string, ConsoleSessionView>
  >();
  private busSub?: Subscription;
  private unsubSessions?: () => void;

  constructor(
    private readonly conductor: ConductorService,
    private readonly bus: ConductorEventsBus,
    private readonly channel: ChannelService,
    private readonly registry: ChannelRegistryService,
    private readonly employees: EmployeeRegistry,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    private readonly env: EnvService,
  ) {}

  onApplicationBootstrap(): void {
    this.busSub = this.bus.events$.subscribe((e) => this.onEvent(e));
    this.unsubSessions = this.sessions.onUpdate((s) => this.onSession(s));
  }
  onModuleDestroy(): void {
    this.busSub?.unsubscribe();
    this.unsubSessions?.();
  }

  // ── public API (wrapped by the controller) ──────────────────────────────────────────────────────
  /** Create a fresh, clean Atlas thread. Registers the room UP FRONT with full metadata (team,
   * project, members, displayName) so the project binds before the first message — lazy `submitFrom`
   * registration would default the project. */
  newThread(input: NewThreadInput = {}): { channelId: string } {
    const channelId = `${CONSOLE_PREFIX}${randomUUID().slice(0, 8)}`;
    const team =
      input.team ?? this.env.get('HARNESS_TEAM_ID') ?? DEFAULT_TEAM;
    this.registry.ensure({
      channelId,
      teamId: team,
      kind: input.kind ?? 'channel',
      project: input.project ?? DEFAULT_PROJECT,
      members: [...this.employees.list().map((b) => b.id), DEFAULT_AUTHOR.id],
      displayName: `console ${channelId.slice(CONSOLE_PREFIX.length)}`,
    });
    this.buffers.set(channelId, { seq: 0, events: [], lastEventAt: 0 });
    this.logger.log(
      `console thread ${channelId} (team '${team}', project '${input.project ?? DEFAULT_PROJECT}')`,
    );
    return { channelId };
  }

  /** Send a message as a user; returns the per-channel cursor to poll `events` from. */
  say(input: {
    channelId: string;
    text: string;
    authorId?: string;
    authorName?: string;
  }): { cursor: number } {
    const buf = this.buf(input.channelId);
    const cursor = buf.seq;
    this.conductor.submitFrom(
      input.authorId ?? DEFAULT_AUTHOR.id,
      input.authorName ?? DEFAULT_AUTHOR.name,
      input.text,
      { channelId: input.channelId, teamId: this.registry.teamIdOf(input.channelId) },
    );
    return { cursor };
  }

  /** Everything that happened on the thread since `since`: the human-readable trace, the latest bot
   * reply, the sessions the turn opened, the cost, and whether the turn has settled. */
  events(channelId: string, since: number): ConsoleEventsView {
    const buf = this.buf(channelId);
    const fresh = buf.events.filter((e) => e.seq > since);
    const trace = fresh.map((e) => ({
      seq: e.seq,
      kind: e.event.kind,
      text: this.summarize(e.event),
    }));
    const reply = [...fresh]
      .reverse()
      .find(
        (e) => e.event.kind === 'message' && e.event.fromHuman === false,
      )?.event;
    const cost = this.costSince(buf, since);
    const settled =
      buf.seq > since && Date.now() - buf.lastEventAt > SETTLE_QUIET_MS;
    return {
      cursor: buf.seq,
      settled,
      reply: reply && reply.kind === 'message' ? reply.text : undefined,
      trace,
      sessions: [...(this.sessionsByThread.get(channelId)?.values() ?? [])],
      cost,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────
  private isConsole(channelId?: string): channelId is string {
    return !!channelId && channelId.startsWith(CONSOLE_PREFIX);
  }
  private buf(channelId: string): ChannelBuffer {
    let b = this.buffers.get(channelId);
    if (!b) {
      b = { seq: 0, events: [], lastEventAt: 0 };
      this.buffers.set(channelId, b);
    }
    return b;
  }

  private onEvent(e: ConductorEvent): void {
    const channelId = 'channelId' in e ? e.channelId : undefined;
    if (!this.isConsole(channelId)) return;
    const buf = this.buf(channelId);
    buf.events.push({ seq: ++buf.seq, event: e });
    if (buf.events.length > MAX_EVENTS) buf.events.shift();
    buf.lastEventAt = Date.now();
  }

  private onSession(s: Session): void {
    if (!this.isConsole(s.notifyThread)) return;
    const byId =
      this.sessionsByThread.get(s.notifyThread) ??
      new Map<string, ConsoleSessionView>();
    byId.set(s.id, {
      id: s.id,
      status: s.status,
      mode: s.mode,
      task: s.task,
      lastReport: s.lastReport,
    });
    this.sessionsByThread.set(s.notifyThread, byId);
    // A session update is activity on the thread — keep the settle window honest.
    this.buf(s.notifyThread).lastEventAt = Date.now();
  }

  /** One-line human summary per event for the CLI trace. */
  private summarize(e: ConductorEvent): string {
    switch (e.kind) {
      case 'message':
        return `${e.fromHuman ? 'you' : e.authorName}: ${e.text}`;
      case 'tool':
        return `→ ${e.botName} called ${e.toolName}`;
      case 'gate':
        return `gate: ${e.action}`;
      case 'reaction':
        return `${e.remove ? '−' : '+'}${e.emoji}`;
      case 'recall':
        return `recall: ${e.text.slice(0, 200)}`;
      case 'draft':
        return `draft (suppressed): ${e.text.slice(0, 200)}`;
      case 'usage':
        return `usage: in ${e.usage.input} out ${e.usage.output}`;
      case 'error':
        return `error: ${e.message}`;
      default:
        return e.kind;
    }
  }

  private costSince(buf: ChannelBuffer, since: number): string | undefined {
    const acc: AccumulatedUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      costUsd: 0,
      callCount: 0,
    };
    for (const { seq, event } of buf.events) {
      if (seq <= since || event.kind !== 'usage') continue;
      acc.input += event.usage.input;
      acc.output += event.usage.output;
      acc.cacheRead += event.usage.cacheRead ?? 0;
      acc.cacheWrite5m += event.usage.cacheWrite5m ?? 0;
      acc.cacheWrite1h += event.usage.cacheWrite1h ?? 0;
      acc.costUsd += calculateCost(CHAT_MODEL, event.usage);
      acc.callCount += 1;
    }
    return acc.callCount ? formatUsageLine(acc, CHAT_MODEL) : undefined;
  }
}
