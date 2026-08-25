import type { TurnEnvContributor, TurnEnvFragment } from '@shared/engine/turn-env';
import { describe, expect, it } from 'vitest';
import type { AgentAuthEnvProvider } from '../../agent-credentials/agent-auth-env.provider';
import type { GitAuthEnvProvider } from '../../github/git-auth-env.provider';
import { TurnEnvBuilder } from '../turn-env-builder.service';

const ctx = { orgId: 'o', jobId: 'j' };

/** Build the builder over stub contributors, bypassing the concrete constructor types. */
function makeBuilder(fragments: (TurnEnvFragment | null)[]): TurnEnvBuilder {
  const contributors: TurnEnvContributor[] = fragments.map((f) => ({
    contribute: async () => f,
  }));
  const [agent, git] = contributors;
  return new TurnEnvBuilder(agent as AgentAuthEnvProvider, git as GitAuthEnvProvider);
}

describe('TurnEnvBuilder.build', () => {
  it('merges disjoint env fragments and carries the credentialsFile through', async () => {
    const builder = makeBuilder([
      { source: 'agent-claude', env: { CLAUDE_CODE_OAUTH_TOKEN: 't' }, credentialsFile: '{"k":1}' },
      { source: 'git-auth', env: { GITHUB_TOKEN: 'g', GIT_TERMINAL_PROMPT: '0' } },
    ]);

    const result = await builder.build(ctx);

    expect(result.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      GITHUB_TOKEN: 'g',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(result.credentialsFile).toBe('{"k":1}');
  });

  it('skips null contributors (a non-github repo adds nothing)', async () => {
    const builder = makeBuilder([{ source: 'agent-claude', env: { A: '1' } }, null]);
    const result = await builder.build(ctx);
    expect(result.env).toEqual({ A: '1' });
    expect(result.credentialsFile).toBeUndefined();
  });

  it('throws — never silently overrides — when two sources claim the same key', async () => {
    const builder = makeBuilder([
      { source: 'agent-claude', env: { GITHUB_TOKEN: 'from-agent' } },
      { source: 'git-auth', env: { GITHUB_TOKEN: 'from-git' } },
    ]);
    await expect(builder.build(ctx)).rejects.toThrow(/collision on 'GITHUB_TOKEN'/);
  });

  it('throws when two sources both set a credentialsFile', async () => {
    const builder = makeBuilder([
      { source: 'agent-claude', env: {}, credentialsFile: 'a' },
      { source: 'git-auth', env: {}, credentialsFile: 'b' },
    ]);
    await expect(builder.build(ctx)).rejects.toThrow(/credentialsFile collision/);
  });
});
