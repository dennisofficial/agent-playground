import type {
  ChannelInfo,
  ChannelRegistryService,
} from '../../channel/channel-registry.service';
import type { ChannelService } from '../../channel/channel.service';
import type { ConductorEventsBus } from '../../conductor/conductor-events.bus';
import type { ConductorEvent } from '../../domain/conductor-events';
import type { Identity } from '../../domain/identity';
import type { EmployeeRegistry } from '../../employees/employee.registry';
import type { ChannelMsg } from '../../channel/channel.types';
import { SendMessageTool } from './room.tools';

/**
 * The cross-room relay: a bot may post into another room it's a MEMBER of, or its 1:1 with a
 * HUMAN (find-or-create) — never a bot↔bot DM (two always-respond parties would loop forever).
 */

const identity: Identity = {
  selfAgent: 'alex',
  team: 'local',
  project: 'project-a',
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'tui:project-a',
  isChannel: true,
};
const ctx = { identity };

function build(rooms: ChannelInfo[]) {
  const map = new Map(rooms.map((r) => [r.channelId, r]));
  const registry = {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
    ensure: (info: ChannelInfo) => {
      const existing = map.get(info.channelId);
      if (existing) return existing;
      map.set(info.channelId, info);
      return info;
    },
  } as unknown as ChannelRegistryService;
  const appended: ChannelMsg[] = [];
  const channel = {
    append: (m: ChannelMsg) => {
      appended.push(m);
      return m;
    },
  } as unknown as ChannelService;
  const events: ConductorEvent[] = [];
  const bus = {
    emit: (e: ConductorEvent) => events.push(e),
  } as unknown as ConductorEventsBus;
  const employees = {
    byId: (id: string) =>
      ['alex', 'riley'].includes(id)
        ? { id, name: id[0].toUpperCase() + id.slice(1) }
        : undefined,
  } as unknown as EmployeeRegistry;
  const tool = new SendMessageTool(registry, channel, bus, employees);
  return { tool, appended, events, map };
}

const room = (
  channelId: string,
  kind: 'channel' | 'dm',
  members: string[],
): ChannelInfo => ({
  channelId,
  kind,
  project: 'local',
  members,
  displayName: channelId,
});

describe('SendMessageTool', () => {
  it('posts into another member room and emits the routed event', async () => {
    const { tool, appended, events } = build([
      room('tui:project-a', 'channel', ['alex', 'dennis']),
      room('tui:main', 'channel', ['alex', 'riley', 'dennis']),
    ]);
    const res = await tool.execute(
      { to: '#main', message: 'Deploy landed.' },
      ctx,
    );
    expect(res).toBe('Sent to #main.');
    expect(appended[0]).toMatchObject({
      channelId: 'tui:main',
      authorBotId: 'alex',
      text: 'Deploy landed.',
    });
    expect(events[0]).toMatchObject({
      kind: 'message',
      channelId: 'tui:main',
      fromHuman: false,
    });
  });

  it('refuses a room the bot is not a member of', async () => {
    const { tool, appended } = build([
      room('tui:project-a', 'channel', ['alex', 'dennis']),
      room('tui:secret', 'channel', ['riley', 'dennis']),
    ]);
    const res = await tool.execute({ to: '#secret', message: 'hi' }, ctx);
    expect(res).toContain('not a member');
    expect(appended).toHaveLength(0);
  });

  it('refuses to post into the conversation it is already in', async () => {
    const { tool, appended } = build([
      room('tui:project-a', 'channel', ['alex', 'dennis']),
    ]);
    const res = await tool.execute({ to: '#project-a', message: 'hi' }, ctx);
    expect(res).toContain('THIS conversation');
    expect(appended).toHaveLength(0);
  });

  it('finds-or-creates the 1:1 with a known human', async () => {
    const { tool, appended, map } = build([
      room('tui:project-a', 'channel', ['alex', 'dennis']),
      room('tui:main', 'channel', ['alex', 'dimitri']),
    ]);
    const res = await tool.execute(
      { to: '@dimitri', message: 'Task done, as promised.' },
      ctx,
    );
    expect(res).toBe('Sent to @alex:dimitri.');
    expect(map.get('tui:dm:alex:dimitri')).toMatchObject({
      kind: 'dm',
      members: ['alex', 'dimitri'],
    });
    expect(appended[0].channelId).toBe('tui:dm:alex:dimitri');
  });

  it('refuses to DM a teammate bot (loop guard) and an unknown person', async () => {
    const { tool } = build([
      room('tui:main', 'channel', ['alex', 'riley', 'dennis']),
    ]);
    expect(await tool.execute({ to: '@riley', message: 'hi' }, ctx)).toContain(
      'teammate bot',
    );
    expect(await tool.execute({ to: '@nobody', message: 'hi' }, ctx)).toContain(
      "Nobody called 'nobody'",
    );
  });
});
