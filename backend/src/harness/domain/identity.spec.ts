import {
  botScope,
  pairScope,
  parseScope,
  projectScope,
  recallScopes,
  scopeForTier,
  teamScope,
  type Identity,
} from './identity';

/**
 * The DM-is-workspace-level memory rules: a DM recalls every project the pair shares, and a
 * project-tier WRITE from a DM must name one of those projects — anything else stays pair-private
 * (the leak-safe fallback).
 */

const channelId: Identity = {
  selfAgent: 'alex',
  team: 'local',
  project: 'project-a',
  projects: ['project-a'],
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'tui:project-a',
  isChannel: true,
};

const dmId: Identity = {
  selfAgent: 'alex',
  team: 'local',
  project: 'local',
  projects: ['local', 'project-a', 'project-b'],
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'tui:dm:alex',
  isChannel: false,
};

describe('recallScopes', () => {
  it('a channel recalls its own project + team + bot, no pair', () => {
    expect(recallScopes(channelId)).toEqual([
      'project:project-a',
      'team:local',
      'bot:alex',
    ]);
  });

  it('a DM recalls every shared project + team + bot + pair', () => {
    expect(recallScopes(dmId)).toEqual([
      'project:local',
      'project:project-a',
      'project:project-b',
      'team:local',
      'bot:alex',
      'pair:alex:dennis',
    ]);
  });
});

describe('parseScope', () => {
  it('round-trips teamScope', () => {
    expect(parseScope(teamScope('local'))).toEqual({ tier: 'team' });
  });

  it('round-trips projectScope', () => {
    expect(parseScope(projectScope('my-project'))).toEqual({
      tier: 'project',
      projectId: 'my-project',
    });
  });

  it('round-trips botScope', () => {
    expect(parseScope(botScope('alex'))).toEqual({
      tier: 'bot',
      botId: 'alex',
    });
  });

  it('round-trips pairScope', () => {
    expect(parseScope(pairScope('alex', 'dennis'))).toEqual({
      tier: 'private',
      botId: 'alex',
      humanId: 'dennis',
    });
  });

  it('handles a botId that contains underscores — important for starts_with vs LIKE safety', () => {
    expect(parseScope(pairScope('a_b', 'dennis'))).toEqual({
      tier: 'private',
      botId: 'a_b',
      humanId: 'dennis',
    });
  });

  it('handles an unknown/malformed scope gracefully (falls back to team)', () => {
    expect(parseScope('unknown:xyz')).toEqual({ tier: 'team' });
    expect(parseScope('')).toEqual({ tier: 'team' });
  });

  it('handles a pair scope with no human segment (malformed)', () => {
    expect(parseScope('pair:alex')).toEqual({ tier: 'private', botId: 'alex' });
  });
});

describe('scopeForTier — project tier', () => {
  it('a channel writes to ITS project and ignores a named project', () => {
    expect(scopeForTier('project', channelId)).toBe('project:project-a');
    expect(scopeForTier('project', channelId, 'project-b')).toBe(
      'project:project-a',
    );
  });

  it('a DM write lands in a NAMED shared project', () => {
    expect(scopeForTier('project', dmId, 'project-b')).toBe(
      'project:project-b',
    );
  });

  it('a DM write with no named project falls back to pair', () => {
    expect(scopeForTier('project', dmId)).toBe('pair:alex:dennis');
  });

  it('a DM write naming an UNSHARED project falls back to pair', () => {
    expect(scopeForTier('project', dmId, 'someone-elses-project')).toBe(
      'pair:alex:dennis',
    );
  });
});
