import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelInfo,
  ChannelRegistryService,
} from '../channel/channel-registry.service';
import type { BoardStore } from '../memory/board-store';
import type { SemanticMemory } from '../memory/semantic-memory';
import type { TaskStore } from '../memory/task-store';
import type { ProjectStore } from '../projects/project-store';
import { ChannelProjectLinker } from './channel-project-linker';

function build(opts: {
  channel?: Partial<ChannelInfo> | null;
  /** Does `projects.get(team, channel.project)` resolve? (i.e. is the channel already linked?) */
  currentRegistered?: boolean;
}) {
  const channel =
    opts.channel === null
      ? undefined
      : ({
          channelId: 'slack:T1:C1',
          teamId: 'T1',
          kind: 'channel',
          project: 'ai-crew-local-testing',
          members: [],
          displayName: '#ai-crew-local-testing',
          ...opts.channel,
        } as ChannelInfo);

  const setProject = vi.fn();
  const channels = {
    get: vi.fn(() => channel),
    setProject,
  } as unknown as ChannelRegistryService;
  const projects = {
    get: vi.fn(async () =>
      opts.currentRegistered ? ({ projectId: channel?.project } as never) : undefined,
    ),
  } as unknown as ProjectStore;
  const board = { reproject: vi.fn(async () => 0) } as unknown as BoardStore;
  const tasks = { reproject: vi.fn(async () => 0) } as unknown as TaskStore;
  const facts = {
    reprojectFacts: vi.fn(async () => 0),
  } as unknown as SemanticMemory;

  const linker = new ChannelProjectLinker(channels, projects, board, tasks, facts);
  return { linker, setProject, board, tasks, facts };
}

const LINK = { team: 'T1', surfaceId: 'slack:T1:C1', projectId: 'cubix-infra' };

describe('ChannelProjectLinker.linkChannelProject', () => {
  it('links an unlinked channel as its main repo and reprojects its rows', async () => {
    const { linker, setProject, board, tasks, facts } = build({
      currentRegistered: false,
    });
    const r = await linker.linkChannelProject(LINK);
    expect(r).toEqual({ linkedAsMain: true });
    expect(setProject).toHaveBeenCalledWith('slack:T1:C1', 'cubix-infra');
    const args = ['T1', 'ai-crew-local-testing', 'cubix-infra'];
    expect(board.reproject).toHaveBeenCalledWith(...args);
    expect(tasks.reproject).toHaveBeenCalledWith(...args);
    expect(facts.reprojectFacts).toHaveBeenCalledWith(...args);
  });

  it('does NOT relink a channel that already has a registered main repo (reference instead)', async () => {
    const { linker, setProject, board } = build({
      channel: { project: 'existing-repo' },
      currentRegistered: true,
    });
    const r = await linker.linkChannelProject(LINK);
    expect(r).toEqual({ linkedAsMain: false });
    expect(setProject).not.toHaveBeenCalled();
    expect(board.reproject).not.toHaveBeenCalled();
  });

  it('never links a DM', async () => {
    const { linker, setProject } = build({
      channel: { kind: 'dm', project: 'local' },
    });
    const r = await linker.linkChannelProject({
      ...LINK,
      surfaceId: 'slack:T1:D1',
    });
    expect(r).toEqual({ linkedAsMain: false });
    expect(setProject).not.toHaveBeenCalled();
  });

  it('no-ops for an unknown room', async () => {
    const { linker, setProject } = build({ channel: null });
    const r = await linker.linkChannelProject(LINK);
    expect(r).toEqual({ linkedAsMain: false });
    expect(setProject).not.toHaveBeenCalled();
  });

  it('no-ops when the channel is already on the target project', async () => {
    const { linker, setProject } = build({ channel: { project: 'cubix-infra' } });
    const r = await linker.linkChannelProject(LINK);
    expect(r).toEqual({ linkedAsMain: false });
    expect(setProject).not.toHaveBeenCalled();
  });
});
