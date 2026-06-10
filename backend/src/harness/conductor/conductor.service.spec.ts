import type { EnvService } from '@core/config/env/env.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { CursorStore } from '../channel/cursor.store';
import type { ConductorEvent } from '../domain/conductor-events';
import type { EmployeeRegistry } from '../employees/employee.registry';
import type { Job, JobRegistry } from '../jobs/job-registry.port';
import type { WorkerService } from '../jobs/worker.service';
import type { BotGraphFactory } from './bot-graph.factory';
import { ConductorEventsBus } from './conductor-events.bus';
import { ConductorService } from './conductor.service';

/** Minimal synchronous channel double (same contract as ChannelService). */
class FakeChannel {
  readonly surfaceId = 'tui:test';
  private log: ChannelMsg[] = [];
  private subs = new Set<() => void>();
  private nextSeq = 0;
  append(msg: Omit<ChannelMsg, 'seq'>): ChannelMsg {
    const full = { ...msg, seq: this.nextSeq++ };
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

const ALEX = { id: 'alex', name: 'Alex', role: 'backend engineer', sortOrder: 10, roleContext: 'x', engine: 'claude' as const, scrumMaster: true };

interface FakeGraphBehavior {
  /** Called per stream; returns deltas to yield and the cursor getState should report. */
  run: (input: { cursor: number; forced: boolean }) => { deltas: object[]; cursorAfter: number; throw?: Error };
}

function buildConductor(behavior: FakeGraphBehavior) {
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

  const jobUpdateCbs: Array<(j: Job) => void> = [];
  const jobs = {
    list: async () => [],
    onUpdate: (cb: (j: Job) => void) => {
      jobUpdateCbs.push(cb);
      return () => {};
    },
  } as unknown as JobRegistry;

  const worker = { abortAll: () => {} } as unknown as WorkerService;
  const env = { get: () => undefined } as unknown as EnvService;

  const conductor = new ConductorService(
    channel as unknown as ChannelService,
    cursors as unknown as CursorStore,
    employees,
    graphs,
    jobs,
    worker,
    bus,
    env,
  );
  conductor.onApplicationBootstrap();
  return { conductor, channel, cursors, events, fireJobUpdate: (j: Job) => jobUpdateCbs.forEach((cb) => cb(j)) };
}

describe('ConductorService scheduling', () => {
  it('claims a bot on channel growth, streams deltas, persists the advanced cursor', async () => {
    const { conductor, channel, cursors, events } = buildConductor({
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
    const { conductor, channel, cursors, events } = buildConductor({
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
    expect((errors.at(-1) as { message: string }).message).toContain('gave up after 3 failed attempts');
  });

  it('relays a finished job through its owner gate-bypassed (forced seed)', async () => {
    const forcedInputs: boolean[] = [];
    const { conductor, channel, fireJobUpdate } = buildConductor({
      run: ({ forced }) => {
        forcedInputs.push(forced);
        return { deltas: [], cursorAfter: channel.length };
      },
    });
    fireJobUpdate({
      id: 'job-001',
      task: 'investigate',
      status: 'done',
      threadId: 'job:job-001',
      notifyThread: 'tui:test',
      ownerBot: 'alex',
      project: 'local',
      engine: 'claude',
      mode: 'plan',
      turns: 1,
      version: 0,
      lastReport: 'all done',
    });
    await conductor.whenIdle();
    expect(forcedInputs).toEqual([true]); // the relay ran as a forced (gate-bypassed) turn
  });

  it('emits gate observability and folds reactions onto the gated message', async () => {
    const { conductor, events } = buildConductor({
      run: () => ({
        deltas: [
          { decision: 'respond', reasoning: 'mine to answer', gateUsage: { input: 100, output: 10 }, reaction: '👀', reactionTargetId: 'u-0' },
        ],
        cursorAfter: 1,
      }),
    });
    conductor.submitFrom('dennis', 'Dennis', 'alex, can you look?');
    await conductor.whenIdle();
    const gate = events.find((e) => e.kind === 'gate') as Extract<ConductorEvent, { kind: 'gate' }>;
    expect(gate.action).toBe('respond');
    expect(gate.reasoning).toBe('mine to answer');
    const reaction = events.find((e) => e.kind === 'reaction') as Extract<ConductorEvent, { kind: 'reaction' }>;
    expect(reaction.emoji).toBe('👀');
    expect(reaction.targetId).toBe('u-0');
  });
});
