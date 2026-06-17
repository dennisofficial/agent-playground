import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { EnvService } from '@core/config/env/env.service';
import { Subject } from 'rxjs';
import type {
  ChannelInfo,
  ChannelRegistryService,
} from '../channel/channel-registry.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { CursorStore } from '../channel/cursor.store';
import type { ConductorEvent } from '../domain/conductor-events';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { CredentialContext } from '../llm-keys/credential-context';
import type { LlmReadinessService } from '../llm-keys/llm-readiness.service';
import type { TenantCredentialService } from '../llm-keys/tenant-credential.service';
import type {
  Session,
  SessionRegistry,
} from '../sessions/session-registry.port';
import type { SessionRunnerService } from '../sessions/session-runner.service';
import type { BotGraphFactory } from '../bot-graph/bot-graph.factory';
import type { BoardEvent, BoardEventsBus } from '../memory/board-events.bus';
import { ConductorEventsBus } from './conductor-events.bus';
import { ConductorService } from './conductor.service';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';

/** Minimal synchronous channel double (same contract as ChannelService). */
class FakeChannel {
  readonly surfaceId = 'tui:test';
  private log: ChannelMsg[] = [];
  private subs = new Set<() => void>();
  private nextSeq = 0;
  append(
    msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'> & {
      channelId?: string;
    },
  ): ChannelMsg {
    const full = {
      ...msg,
      channelId: msg.channelId ?? this.surfaceId,
      seq: this.nextSeq++,
      createdAt: Date.now(),
    };
    this.log.push(full);
    for (const cb of this.subs) cb();
    return full;
  }
  since(cursor: number): ChannelMsg[] {
    return this.log.filter((m) => m.seq >= cursor);
  }
  get length(): number {
    return this.nextSeq;
  }
  lengthOf(): number {
    return this.nextSeq;
  }
  floorSeqOf(): number {
    return 0;
  }
  channelIds(): string[] {
    return [];
  }
  get floorSeq(): number {
    return 0;
  }
  async backfillTo(_seq: number): Promise<void> {}
  snapshot(): ChannelMsg[] {
    return [...this.log];
  }
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeCursors {
  private map = new Map<string, number>();
  has(botId: string, surfaceId: string): boolean {
    return this.map.has(`${botId} ${surfaceId}`);
  }
  get(botId: string, surfaceId: string): number {
    return this.map.get(`${botId} ${surfaceId}`) ?? 0;
  }
  set(botId: string, surfaceId: string, v: number): void {
    this.map.set(`${botId} ${surfaceId}`, v);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

const ALEX = {
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
  roleContext: 'x',
  engine: EWorkerEngineName.CLAUDE,
  teamLead: true,
};

/** Minimal in-memory registry double (same contract as ChannelRegistryService). */
class FakeRegistry {
  private map = new Map<string, ChannelInfo>();
  ensure(info: Partial<ChannelInfo> & { channelId: string }): ChannelInfo {
    const existing = this.map.get(info.channelId);
    if (existing) return existing;
    const full: ChannelInfo = {
      channelId: info.channelId,
      teamId: info.teamId ?? 'local',
      kind: info.kind ?? 'channel',
      project: info.project ?? 'local',
      members: info.members ?? [],
      displayName: info.displayName ?? info.channelId,
    };
    this.map.set(full.channelId, full);
    return full;
  }
  teamIdOf(channelId: string): string {
    return this.map.get(channelId)?.teamId ?? 'local';
  }
  addMembers(channelId: string, ids: string[]): void {
    const info = this.map.get(channelId);
    if (!info) return;
    info.members = [...new Set([...info.members, ...ids])];
  }
  get(channelId: string): ChannelInfo | undefined {
    return this.map.get(channelId);
  }
  list(): ChannelInfo[] {
    return [...this.map.values()];
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

interface FakeGraphBehavior {
  /** Called per stream; returns deltas to yield and the cursor getState should report. */
  run: (input: { cursor: number }) => {
    deltas: object[];
    cursorAfter: number;
    throw?: Error;
  };
}

async function buildConductor(behavior: FakeGraphBehavior) {
  const channel = new FakeChannel();
  const cursors = new FakeCursors();
  const bus = new ConductorEventsBus();
  const events: ConductorEvent[] = [];
  bus.events$.subscribe((e) => events.push(e));

  let lastCursor = 0;
  const graphs = {
    getConductorGraph: () => ({
      stream: async (input: { cursor: number }) => {
        const { deltas, cursorAfter, throw: err } = behavior.run(input);
        lastCursor = cursorAfter;
        return (async function* () {
          for (const d of deltas) yield { node: d };
          if (err) throw err;
        })();
      },
      getState: async () => ({ values: { cursor: lastCursor } }),
    }),
  } as unknown as BotGraphFactory;

  // ALEX is the single orchestrator (teamLead) in these specs.
  const employees = {
    list: () => [ALEX],
    byId: (id: string) => (id === 'alex' ? ALEX : undefined),
    fallbackOwner: () => ALEX,
    teamLead: () => ALEX,
  } as unknown as EmployeeRegistry;

  const sessionUpdateCbs: Array<(s: Session) => void> = [];
  const sessions = {
    list: async () => [],
    onUpdate: (cb: (s: Session) => void) => {
      sessionUpdateCbs.push(cb);
      return () => {};
    },
  } as unknown as SessionRegistry;

  const boardEventCbs: Array<(e: BoardEvent) => void> = [];
  const boardEvents = {
    onEvent: (cb: (e: BoardEvent) => void) => {
      boardEventCbs.push(cb);
      return () => {};
    },
    emit: () => {},
  } as unknown as BoardEventsBus;

  const runner = { abortAll: () => {} } as unknown as SessionRunnerService;
  const env = { get: () => undefined } as unknown as EnvService;
  // Always-ready in conductor specs; pending-keys gating is covered by the readiness spec.
  const readiness = {
    isReady: () => true,
    ensureChecked: () => {},
    ready$: new Subject<string>(),
  } as unknown as LlmReadinessService;
  // Credential plumbing: resolve returns no keys, run executes the turn body inline.
  const creds = {
    resolve: async () => ({}),
    isReady: async () => true,
  } as unknown as TenantCredentialService;
  const credCtx = {
    run: (_c: unknown, fn: () => unknown) => fn(),
  } as unknown as CredentialContext;

  const conductor = new ConductorService(
    channel as unknown as ChannelService,
    new FakeRegistry() as unknown as ChannelRegistryService,
    cursors as unknown as CursorStore,
    employees,
    graphs,
    sessions,
    runner,
    bus,
    env,
    readiness,
    creds,
    credCtx,
    boardEvents,
  );
  await conductor.onApplicationBootstrap();
  return {
    conductor,
    channel,
    cursors,
    events,
    fireSessionUpdate: (s: Session) => sessionUpdateCbs.forEach((cb) => cb(s)),
    fireBoardEvent: (e: BoardEvent) => boardEventCbs.forEach((cb) => cb(e)),
  };
}

describe('ConductorService scheduling', () => {
  it('claims Atlas on channel growth, streams deltas, persists the advanced cursor', async () => {
    const { conductor, channel, cursors, events } = await buildConductor({
      run: () => ({
        deltas: [{}],
        cursorAfter: channel.length, // consumed everything
      }),
    });
    conductor.submitFrom('dennis', 'Dennis', 'hello team');
    await conductor.whenIdle();
    expect(cursors.get('alex', 'tui:test')).toBe(1);
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(1); // the human's own echo
  });

  it('gives up after MAX_TURN_RETRIES no-progress failures and skips the wedged batch', async () => {
    let attempts = 0;
    const { conductor, channel, cursors, events } = await buildConductor({
      run: ({ cursor }) => {
        attempts++;
        return { deltas: [], cursorAfter: cursor, throw: new Error('boom') }; // no progress
      },
    });
    conductor.submitFrom('dennis', 'Dennis', 'poison message');
    await conductor.whenIdle();
    expect(attempts).toBe(3); // MAX_TURN_RETRIES
    expect(cursors.get('alex', 'tui:test')).toBe(channel.length); // batch dropped to high-water mark
    const errors = events.filter((e) => e.kind === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(4); // 3 turn errors + the gave-up notice
    expect((errors.at(-1) as { message: string }).message).toContain(
      'gave up after 3 failed attempts',
    );
  });

  it('session updates only refresh the running-count UI — they never run a chat turn', async () => {
    const { conductor, channel, fireSessionUpdate } = await buildConductor({
      run: () => {
        throw new Error('no turn should run');
      },
    });
    const base = {
      id: 'sess-002',
      task: 't',
      worktreeId: 'wt-001',
      notifyThread: 'tui:test',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
      engine: EWorkerEngineName.CLAUDE,
      mode: 'plan' as const,
      turns: 0,
    };
    fireSessionUpdate({ ...base, status: 'idle', lastReport: 'done' });
    fireSessionUpdate({ ...base, status: 'running' });
    fireSessionUpdate({ ...base, status: 'closed' });
    await conductor.whenIdle();
    expect(channel.snapshot()).toHaveLength(0); // nothing ran, nothing posted
  });

  it('bills a suppressed read-the-room draft: full usage event (cache fields) + draft debug event', async () => {
    const draftUsage = {
      input: 1200,
      output: 340,
      cacheRead: 900,
      cacheWrite1h: 120,
    };
    const { conductor, events } = await buildConductor({
      run: () => ({
        deltas: [
          // The stale step: injected humans ride messages (none here), the suppressed reply rides
          // the draft fields — never delta.messages, so commit() can't post it.
          { draft: 'unposted duplicate answer', draftUsage, revisionPasses: 1 },
        ],
        cursorAfter: 1,
      }),
    });
    conductor.submitFrom('dennis', 'Dennis', 'status?');
    await conductor.whenIdle();
    // The suppressed step is billed through the SAME pipeline as tool-only steps: a `usage` event
    // with the FULL MessageUsage (incl. cache fields) that the SurfaceBridge accumulates into the
    // next real post's cost footer.
    const usage = events.find((e) => e.kind === 'usage') as Extract<
      ConductorEvent,
      { kind: 'usage' }
    >;
    expect(usage.botId).toBe('alex');
    expect(usage.role).toBe('chat');
    expect(usage.usage).toEqual(draftUsage);
    const draft = events.find((e) => e.kind === 'draft') as Extract<
      ConductorEvent,
      { kind: 'draft' }
    >;
    expect(draft.text).toBe('unposted duplicate answer');
    expect(draft.botName).toBe('Alex');
    // And nothing posted: no message event from the bot for this turn.
    expect(events.some((e) => e.kind === 'message' && !e.fromHuman)).toBe(
      false,
    );
  });
});

// ── share_artifact coordination ───────────────────────────────────────────────────────────────────

describe('ConductorService share_artifact coordination', () => {
  it('defers the message event until the tool result arrives, then emits with fileIds', async () => {
    // Case A: text + share_artifact in the same AIMessage.
    // Delta 1: AIMessage with text + share_artifact tool call.
    // Delta 2: ToolMessage with the file_id result.
    // Expected: ONE message event emitted AFTER delta 2, with fileIds.
    const { conductor, events } = await buildConductor({
      run: () => ({
        deltas: [
          {
            decision: 'respond',
            messages: [
              new AIMessage({
                content: 'Here is the analysis.',
                tool_calls: [
                  {
                    id: 'call_abc',
                    name: 'share_artifact',
                    args: { content: '# Data', filename: 'data.md' },
                  },
                ],
              }),
              new ToolMessage({
                content: 'Uploaded (file_id: F0ABCDEF).',
                tool_call_id: 'call_abc',
              }),
            ],
          },
        ],
        cursorAfter: 1,
      }),
    });
    conductor.submitFrom('dennis', 'Dennis', 'can you share your analysis?');
    await conductor.whenIdle();

    const botMessages = events.filter(
      (e) => e.kind === 'message' && !e.fromHuman,
    ) as Extract<ConductorEvent, { kind: 'message' }>[];

    expect(botMessages).toHaveLength(1);
    expect(botMessages[0].text).toBe('Here is the analysis.');
    expect(botMessages[0].fileIds).toEqual(['F0ABCDEF']);
  });

  it('emits with fileIds collected from a prior tool-call step (Case B: no text in tool-call message)', async () => {
    // Case B: AIMessage 1 has only tool_call (no text), ToolMessage brings file_id,
    // AIMessage 2 has text — the text message should carry the fileIds.
    const { conductor, events } = await buildConductor({
      run: () => ({
        deltas: [
          {
            decision: 'respond',
            messages: [
              // Step 1: tool call only, no text
              new AIMessage({
                content: '',
                tool_calls: [
                  {
                    id: 'call_xyz',
                    name: 'share_artifact',
                    args: { content: 'data', filename: 'out.md' },
                  },
                ],
              }),
              new ToolMessage({
                content: 'Uploaded (file_id: F1B2C3D4).',
                tool_call_id: 'call_xyz',
              }),
              // Step 2: final text (no tool calls)
              new AIMessage({ content: 'Here is the file.' }),
            ],
          },
        ],
        cursorAfter: 1,
      }),
    });
    conductor.submitFrom('dennis', 'Dennis', 'upload it');
    await conductor.whenIdle();

    const botMessages = events.filter(
      (e) => e.kind === 'message' && !e.fromHuman,
    ) as Extract<ConductorEvent, { kind: 'message' }>[];

    // Only the text-bearing message should be emitted
    expect(botMessages).toHaveLength(1);
    expect(botMessages[0].text).toBe('Here is the file.');
    expect(botMessages[0].fileIds).toEqual(['F1B2C3D4']);
  });

  it('safety-flushes a deferred message without fileIds if the turn ends before the tool result', async () => {
    // Simulates a graph that produces an AIMessage with text+share_artifact but no ToolMessage
    // (e.g. the graph errored or hit the step cap before running tools).
    const { conductor, events } = await buildConductor({
      run: () => ({
        deltas: [
          {
            decision: 'respond',
            messages: [
              new AIMessage({
                content: 'I attempted to share.',
                tool_calls: [
                  {
                    id: 'call_fail',
                    name: 'share_artifact',
                    args: { content: 'x', filename: 'x.md' },
                  },
                ],
              }),
              // No ToolMessage — the tool result never arrives
            ],
          },
        ],
        cursorAfter: 1,
      }),
    });
    conductor.submitFrom('dennis', 'Dennis', 'share something');
    await conductor.whenIdle();

    const botMessages = events.filter(
      (e) => e.kind === 'message' && !e.fromHuman,
    ) as Extract<ConductorEvent, { kind: 'message' }>[];

    // The message IS still emitted (safety flush), just without fileIds
    expect(botMessages).toHaveLength(1);
    expect(botMessages[0].text).toBe('I attempted to share.');
    expect(botMessages[0].fileIds).toBeUndefined();
  });
});
