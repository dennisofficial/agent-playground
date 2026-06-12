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
import type { BotGraphFactory } from './bot-graph.factory';
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
  engine: 'claude' as const,
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
  run: (input: { cursor: number; forced: boolean }) => {
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
    getBotGraph: () => ({
      stream: async (input: { cursor: number; forced: boolean }) => {
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

  const employees = {
    list: () => [ALEX],
    byId: (id: string) => (id === 'alex' ? ALEX : undefined),
    fallbackOwner: () => ALEX,
  } as unknown as EmployeeRegistry;

  const sessionUpdateCbs: Array<(s: Session) => void> = [];
  const sessions = {
    list: async () => [],
    onUpdate: (cb: (s: Session) => void) => {
      sessionUpdateCbs.push(cb);
      return () => {};
    },
  } as unknown as SessionRegistry;

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
  );
  await conductor.onApplicationBootstrap();
  return {
    conductor,
    channel,
    cursors,
    events,
    fireSessionUpdate: (s: Session) => sessionUpdateCbs.forEach((cb) => cb(s)),
  };
}

describe('ConductorService scheduling', () => {
  it('claims a bot on channel growth, streams deltas, persists the advanced cursor', async () => {
    const { conductor, channel, cursors, events } = await buildConductor({
      run: ({ cursor }) => ({
        deltas: [{ decision: 'ignore' }],
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

  it("relays a session's turn-end through its owner gate-bypassed (forced seed)", async () => {
    const forcedInputs: boolean[] = [];
    const { conductor, channel, fireSessionUpdate } = await buildConductor({
      run: ({ forced }) => {
        forcedInputs.push(forced);
        return { deltas: [], cursorAfter: channel.length };
      },
    });
    fireSessionUpdate({
      id: 'sess-001',
      task: 'investigate',
      worktreeId: 'wt-001',
      status: 'idle',
      notifyThread: 'tui:test',
      ownerBot: 'alex',
      team: 'local',
      project: 'local',
      engine: EWorkerEngineName.CLAUDE,
      mode: 'plan',
      turns: 1,
      lastReport: 'here is what I found',
    });
    await conductor.whenIdle();
    expect(forcedInputs).toEqual([true]); // the relay ran as a forced (gate-bypassed) turn
  });

  it('never relays running or closed session updates', async () => {
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
    fireSessionUpdate({ ...base, status: 'running' });
    fireSessionUpdate({ ...base, status: 'closed' });
    await conductor.whenIdle();
    expect(channel.snapshot()).toHaveLength(0); // nothing ran, nothing posted
  });

  it('emits gate observability and folds reactions onto the gated message', async () => {
    const { conductor, events } = await buildConductor({
      run: () => ({
        deltas: [
          {
            decision: 'respond',
            reasoning: 'mine to answer',
            gateUsage: { input: 100, output: 10 },
            reaction: '👀',
            reactionTargetId: 'u-0',
          },
        ],
        cursorAfter: 1,
      }),
    });
    conductor.submitFrom('dennis', 'Dennis', 'alex, can you look?');
    await conductor.whenIdle();
    const gate = events.find((e) => e.kind === 'gate') as Extract<
      ConductorEvent,
      { kind: 'gate' }
    >;
    expect(gate.action).toBe('respond');
    expect(gate.reasoning).toBe('mine to answer');
    const reaction = events.find((e) => e.kind === 'reaction') as Extract<
      ConductorEvent,
      { kind: 'reaction' }
    >;
    expect(reaction.emoji).toBe('👀');
    expect(reaction.targetId).toBe('u-0');
  });
});
