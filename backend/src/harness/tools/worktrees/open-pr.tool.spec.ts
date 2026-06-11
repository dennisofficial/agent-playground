import type { GithubApiService } from '../../projects/github-api.service';
import type { GithubTokenStore } from '../../projects/github-token-store';
import type { ProjectRecord } from '../../projects/project.types';
import type { WorktreeService } from '../../worktrees/worktree.service';
import type { Worktree } from '../../worktrees/worktree.types';
import { OpenPrTool } from './open-pr.tool';

const WT: Worktree = {
  id: 'wt-001',
  name: 'feature',
  branch: 'agent/alex/wt-001-feature',
  baseRef: 'abc',
  path: '/repos/proj/.worktrees/wt-001-feature',
  checkout: '/repos/proj/.worktrees/wt-001-feature',
  ownerBot: 'alex',
  team: 'local',
  project: 'proj',
  repoRoot: '/repos/proj',
  sharedBranch: 'shared/feat',
};

const REC: ProjectRecord = {
  teamId: 'local',
  projectId: 'proj',
  displayName: 'Proj',
  gitUrl: 'https://github.com/dennis/proj',
  defaultBranch: 'main',
  tokenName: null,
  createdAt: '',
  updatedAt: '',
};

function build(opts: {
  worktree?: Worktree;
  record?: ProjectRecord;
  token?: { name: string; token: string };
  pushError?: string;
}) {
  const calls: string[] = [];
  const worktrees = {
    get: () => opts.worktree,
    // The tool resolves the project THROUGH the worktree service (origin-URL recovery included).
    projectRecordFor: async () => opts.record,
    pushSharedToOrigin: async () => {
      calls.push('push');
      if (opts.pushError) throw new Error(opts.pushError);
      return { sharedBranch: opts.worktree?.sharedBranch ?? '', gitUrl: opts.record?.gitUrl ?? '' };
    },
  } as unknown as WorktreeService;
  const tokens = { resolve: async () => opts.token } as unknown as GithubTokenStore;
  const prArgs: unknown[] = [];
  const github = {
    openPullRequest: async (_tok: string, args: unknown) => {
      calls.push('pr');
      prArgs.push(args);
      return { url: 'https://github.com/dennis/proj/pull/9', number: 9, existing: false };
    },
  } as unknown as GithubApiService;
  return { tool: new OpenPrTool(worktrees, tokens, github), calls, prArgs };
}

describe('open_pr tool', () => {
  const TOKEN = { name: 'default', token: 'SECRET' };

  it('pushes the shared branch first, then opens the PR against the project base branch', async () => {
    const { tool, calls, prArgs } = build({ worktree: WT, record: REC, token: TOKEN });
    const out = await tool.execute({ worktreeId: 'wt-001', title: 'Feature', body: 'desc' });
    expect(out).toBe('Opened PR for shared/feat: https://github.com/dennis/proj/pull/9');
    expect(calls).toEqual(['push', 'pr']); // push BEFORE pr
    expect(prArgs[0]).toEqual({
      owner: 'dennis',
      repo: 'proj',
      head: 'shared/feat',
      base: 'main',
      title: 'Feature',
      body: 'desc',
    });
    expect(out).not.toContain('SECRET');
  });

  it('reports an existing PR with the existing wording', async () => {
    const { tool } = build({ worktree: WT, record: REC, token: TOKEN });
    (
      tool as unknown as {
        github: { openPullRequest: () => Promise<unknown> };
      }
    ).github.openPullRequest = async () => ({
      url: 'https://github.com/dennis/proj/pull/3',
      number: 3,
      existing: true,
    });
    const out = await tool.execute({ worktreeId: 'wt-001', title: 'T' });
    expect(out).toBe('A PR for shared/feat already exists: https://github.com/dennis/proj/pull/3');
  });

  it('refuses: missing worktree, non-shared worktree, unregistered project, missing token', async () => {
    expect(await build({}).tool.execute({ worktreeId: 'wt-x', title: 'T' })).toContain(
      'No worktree',
    );
    expect(
      await build({ worktree: { ...WT, sharedBranch: undefined } }).tool.execute({
        worktreeId: 'wt-001',
        title: 'T',
      }),
    ).toContain('not on a shared branch');
    expect(
      await build({ worktree: WT }).tool.execute({ worktreeId: 'wt-001', title: 'T' }),
    ).toContain('No registered GitHub repo matches');
    expect(
      await build({ worktree: WT, record: REC }).tool.execute({ worktreeId: 'wt-001', title: 'T' }),
    ).toContain('No default GitHub token');
    expect(
      await build({ worktree: WT, record: { ...REC, tokenName: 'special' } }).tool.execute({
        worktreeId: 'wt-001',
        title: 'T',
      }),
    ).toContain('"special" isn\'t in the token store');
  });

  it('surfaces the identity-guard refusal from the push step as a friendly failure', async () => {
    const { tool, calls } = build({
      worktree: WT,
      record: REC,
      token: TOKEN,
      pushError: "This worktree's repo origin isn't the project's registered repo — recreate the worktree to work against it.",
    });
    const out = await tool.execute({ worktreeId: 'wt-001', title: 'T' });
    expect(out).toContain("Couldn't open the PR");
    expect(out).toContain('recreate the worktree');
    expect(calls).toEqual(['push']); // never reached the GitHub API
  });
});
