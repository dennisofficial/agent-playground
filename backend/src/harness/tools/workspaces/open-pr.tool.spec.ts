import type { GithubApiService } from '../../projects/github-api.service';
import type { GithubTokenStore } from '../../projects/github-token-store';
import type { ProjectRecord } from '../../projects/project.types';
import type { WorkspaceService } from '../../workspaces/workspace.service';
import type { Workspace } from '../../workspaces/workspace.types';
import { OpenPrTool } from './open-pr.tool';

const WS: Workspace = {
  id: 'ws-001',
  name: 'feature',
  branch: 'agent/alex/ws-001-feature',
  baseRef: 'abc',
  path: '/repos/proj/.workspaces/ws-001-feature',
  checkout: '/repos/proj/.workspaces/ws-001-feature',
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
  description: null,
  gitUrl: 'https://github.com/dennis/proj',
  defaultBranch: 'main',
  tokenName: null,
  createdAt: '',
  updatedAt: '',
};

function build(opts: {
  workspace?: Workspace;
  record?: ProjectRecord;
  token?: { name: string; token: string };
  pushError?: string;
}) {
  const calls: string[] = [];
  const workspaces = {
    get: () => opts.workspace,
    // The tool resolves the project THROUGH the workspace service (origin-URL recovery included).
    projectRecordFor: async () => opts.record,
    pushSharedToOrigin: async () => {
      calls.push('push');
      if (opts.pushError) throw new Error(opts.pushError);
      return {
        sharedBranch: opts.workspace?.sharedBranch ?? '',
        gitUrl: opts.record?.gitUrl ?? '',
      };
    },
  } as unknown as WorkspaceService;
  const tokens = {
    resolve: async () => opts.token,
  } as unknown as GithubTokenStore;
  const prArgs: unknown[] = [];
  const github = {
    openPullRequest: async (_tok: string, args: unknown) => {
      calls.push('pr');
      prArgs.push(args);
      return {
        url: 'https://github.com/dennis/proj/pull/9',
        number: 9,
        existing: false,
      };
    },
  } as unknown as GithubApiService;
  return { tool: new OpenPrTool(workspaces, tokens, github), calls, prArgs };
}

describe('open_pr tool', () => {
  const TOKEN = { name: 'default', token: 'SECRET' };

  it('pushes the shared branch first, then opens the PR against the project base branch', async () => {
    const { tool, calls, prArgs } = build({
      workspace: WS,
      record: REC,
      token: TOKEN,
    });
    const out = await tool.execute({
      workspaceId: 'ws-001',
      title: 'Feature',
      body: 'desc',
    });
    expect(out).toBe(
      `Opened DRAFT PR for shared/feat: https://github.com/dennis/proj/pull/9 — mark_pr_ready when it's ready for Dennis.`,
    );
    expect(calls).toEqual(['push', 'pr']); // push BEFORE pr
    expect(prArgs[0]).toEqual({
      owner: 'dennis',
      repo: 'proj',
      head: 'shared/feat',
      base: 'main',
      title: 'Feature',
      body: 'desc',
      draft: true,
    });
    expect(out).not.toContain('SECRET');
  });

  it('reports an existing PR with the existing wording', async () => {
    const { tool } = build({ workspace: WS, record: REC, token: TOKEN });
    (
      tool as unknown as {
        github: { openPullRequest: () => Promise<unknown> };
      }
    ).github.openPullRequest = async () => ({
      url: 'https://github.com/dennis/proj/pull/3',
      number: 3,
      existing: true,
    });
    const out = await tool.execute({ workspaceId: 'ws-001', title: 'T' });
    expect(out).toBe(
      'A PR for shared/feat already exists: https://github.com/dennis/proj/pull/3',
    );
  });

  it('refuses: missing workspace, non-shared workspace, unregistered project, missing token', async () => {
    expect(
      await build({}).tool.execute({ workspaceId: 'ws-x', title: 'T' }),
    ).toContain('No workspace');
    expect(
      await build({
        workspace: { ...WS, sharedBranch: undefined },
      }).tool.execute({
        workspaceId: 'ws-001',
        title: 'T',
      }),
    ).toContain('not on a shared branch');
    expect(
      await build({ workspace: WS }).tool.execute({
        workspaceId: 'ws-001',
        title: 'T',
      }),
    ).toContain('No registered GitHub repo matches');
    expect(
      await build({ workspace: WS, record: REC }).tool.execute({
        workspaceId: 'ws-001',
        title: 'T',
      }),
    ).toContain('No default GitHub token');
    expect(
      await build({
        workspace: WS,
        record: { ...REC, tokenName: 'special' },
      }).tool.execute({
        workspaceId: 'ws-001',
        title: 'T',
      }),
    ).toContain('"special" isn\'t in the token store');
  });

  it('surfaces the identity-guard refusal from the push step as a friendly failure', async () => {
    const { tool, calls } = build({
      workspace: WS,
      record: REC,
      token: TOKEN,
      pushError:
        "This workspace's repo origin isn't the project's registered repo — recreate the workspace to work against it.",
    });
    const out = await tool.execute({ workspaceId: 'ws-001', title: 'T' });
    expect(out).toContain("Couldn't open the PR");
    expect(out).toContain('recreate the workspace');
    expect(calls).toEqual(['push']); // never reached the GitHub API
  });
});
