import { afterEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { EnvService } from '@core/config/env/env.service';
import type { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import type { ChannelService } from '@harness/channel/channel.service';
import type { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import type { ConductorService } from '@harness/conductor/conductor.service';
import type { ConductorEvent } from '@harness/domain/conductor-events';
import type { EmployeeRegistry } from '@harness/employees/employee.registry';
import { CHAT_MODEL } from '@harness/llm/usage-format';
import type { SessionRegistry } from '@harness/sessions/session-registry.port';
import { DevConsoleService } from './dev-console.service';

function make() {
  const subject = new Subject<ConductorEvent>();
  const conductor = { submitFrom: vi.fn() } as unknown as ConductorService;
  const bus = { events$: subject.asObservable() } as unknown as ConductorEventsBus;
  const channel = { since: vi.fn(() => []) } as unknown as ChannelService;
  const registry = {
    ensure: vi.fn(),
    teamIdOf: vi.fn(() => 'T1'),
  } as unknown as ChannelRegistryService;
  const employees = {
    list: vi.fn(() => [{ id: 'atlas' }]),
  } as unknown as EmployeeRegistry;
  const sessions = {
    onUpdate: vi.fn(() => () => undefined),
  } as unknown as SessionRegistry;
  const env = { get: vi.fn(() => undefined) } as unknown as EnvService;
  const svc = new DevConsoleService(
    conductor,
    bus,
    channel,
    registry,
    employees,
    sessions,
    env,
  );
  svc.onApplicationBootstrap();
  const msg = (channelId: string, text = 'done'): ConductorEvent => ({
    id: `m-${text}`,
    kind: 'message',
    channelId,
    authorId: 'atlas',
    authorName: 'Atlas',
    fromHuman: false,
    text,
    ts: 't',
  });
  return {
    svc,
    conductor,
    registry,
    emit: (e: ConductorEvent) => subject.next(e),
    msg,
  };
}

afterEach(() => vi.useRealTimers());

describe('DevConsoleService', () => {
  it('newThread registers the room up front with team/project/members', () => {
    const { svc, registry } = make();
    const { channelId } = svc.newThread({ team: 'T9', project: 'proj-x' });
    expect(channelId).toMatch(/^console:/);
    expect(registry.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        teamId: 'T9',
        project: 'proj-x',
        members: expect.arrayContaining(['atlas', 'dennis']),
      }),
    );
  });

  it('say injects through conductor.submitFrom on the console channel', () => {
    const { svc, conductor } = make();
    const { channelId } = svc.newThread({});
    svc.say({ channelId, text: 'hi atlas' });
    expect(conductor.submitFrom).toHaveBeenCalledWith(
      'dennis',
      'Dennis',
      'hi atlas',
      { channelId, teamId: 'T1' },
    );
  });

  it('buffers the reply and flips settled only after a quiet window', () => {
    vi.useFakeTimers();
    const { svc, emit, msg } = make();
    const { channelId } = svc.newThread({});
    const { cursor } = svc.say({ channelId, text: 'go' });
    emit(msg(channelId, 'done'));
    let ev = svc.events(channelId, cursor);
    expect(ev.reply).toBe('done');
    expect(ev.settled).toBe(false); // just landed, not quiet yet
    vi.advanceTimersByTime(2000);
    ev = svc.events(channelId, cursor);
    expect(ev.settled).toBe(true);
    expect(ev.trace.some((t) => t.text.includes('done'))).toBe(true);
  });

  it("does not settle a thread from another channel's activity", () => {
    vi.useFakeTimers();
    const { svc, emit, msg } = make();
    const a = svc.newThread({}).channelId;
    const b = svc.newThread({}).channelId;
    const curA = svc.say({ channelId: a, text: 'a' }).cursor;
    emit(msg(b, 'b-reply')); // activity on B only
    vi.advanceTimersByTime(2000);
    const evA = svc.events(a, curA);
    expect(evA.settled).toBe(false); // A saw no events
    expect(evA.reply).toBeUndefined();
  });

  it('aggregates usage events into a cost line', () => {
    const { svc, emit } = make();
    const { channelId } = svc.newThread({});
    const { cursor } = svc.say({ channelId, text: 'x' });
    emit({
      id: 'u1',
      kind: 'usage',
      channelId,
      botId: 'atlas',
      role: 'chat',
      usage: { input: 1000, output: 80, cacheRead: 400 },
    });
    const ev = svc.events(channelId, cursor);
    expect(ev.cost).toContain(CHAT_MODEL);
    expect(ev.cost).toContain('in 1,000');
  });
});
