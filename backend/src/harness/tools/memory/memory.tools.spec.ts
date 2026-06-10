import type { Identity } from '../../domain/identity';
import type { MemoryWriteService } from '../../memory/memory-write.service';
import { RememberTool } from './memory.tools';

/**
 * The write-side leak guard: a fact saved without an explicit tier defaults to the PAIR scope in a
 * DM (it must never surface in group chat) and to the project scope in a channel. The read-side
 * guard (recallScopes) only filters recall — this is the half that keeps the leak from being
 * stored wrong in the first place.
 */

const identity = (isChannel: boolean): Identity => ({
  selfAgent: 'alex',
  team: 'local',
  project: 'local',
  participants: ['dennis'],
  speaker: 'dennis',
  surface: isChannel ? 'tui:main' : 'dm:alex:dennis',
  isChannel,
});

function buildTool() {
  const calls: { tier: string; project?: string }[] = [];
  const writes = {
    rememberDeduped: (args: { tier: string; project?: string }) => {
      calls.push({ tier: args.tier, project: args.project });
      return Promise.resolve({ action: 'inserted' as const });
    },
  } as unknown as MemoryWriteService;
  return { tool: new RememberTool(writes), calls };
}

describe('RememberTool tier defaults', () => {
  it('defaults to the pair (private) tier in a DM', async () => {
    const { tool, calls } = buildTool();
    await tool.execute(
      { fact: 'Dennis prefers async standups' },
      {
        identity: identity(false),
      },
    );
    expect(calls).toEqual([{ tier: 'private' }]);
  });

  it('defaults to the project tier in a channel', async () => {
    const { tool, calls } = buildTool();
    await tool.execute(
      { fact: 'We deploy on Fridays' },
      {
        identity: identity(true),
      },
    );
    expect(calls).toEqual([{ tier: 'project' }]);
  });

  it('an explicit tier always wins', async () => {
    const { tool, calls } = buildTool();
    await tool.execute(
      { fact: 'Dennis is traveling next week', tier: 'team' },
      { identity: identity(false) },
    );
    expect(calls).toEqual([{ tier: 'team', project: undefined }]);
  });

  it('passes the named project through for DM project-tier writes', async () => {
    const { tool, calls } = buildTool();
    await tool.execute(
      {
        fact: 'project-a switches to MySQL',
        tier: 'project',
        project: 'project-a',
      },
      { identity: identity(false) },
    );
    expect(calls).toEqual([{ tier: 'project', project: 'project-a' }]);
  });
});
