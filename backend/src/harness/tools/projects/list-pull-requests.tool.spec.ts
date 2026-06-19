import type { Identity } from '../../domain/identity';
import type {
  GithubApiService,
  PullRequestSummary,
} from '../../projects/github-api.service';
import type { GithubTokenStore } from '../../projects/github-token-store';
import type { ProjectRecord } from '../../projects/project.types';
import type { ProjectStore } from '../../projects/project-store';
import { ListPullRequestsTool } from './list-pull-requests.tool';

const REC: ProjectRecord = {
  teamId: 'local',
  projectId: 'proj',
  displayName: 'Proj',
  description: null,
  gitUrl: 'https://github.com/dennis/proj',
  defaultBranch: 'main',
  branchingPolicy: null,
  tokenName: null,
  createdAt: '',
  updatedAt: '',
};

const TOKEN = { name: 'default', token: 'SECRET' };

const PR: PullRequestSummary = {
  number: 42,
  title: 'Add payment flow',
  url: 'https://github.com/dennis/proj/pull/42',
  author: 'alex',
  headBranch: 'shared/payment-flow',
  baseBranch: 'main',
  draft: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const identity = (project = 'proj'): Identity => ({
  selfAgent: 'sam',
  team: 'local',
  project,
  participants: ['dennis'],
  speaker: 'dennis',
  surface: 'dev:root',
  isChannel: true,
});

const ctx = (project = 'proj') => ({ identity: identity(project) });

function build(opts: {
  record?: ProjectRecord;
  token?: { name: string; token: string };
  prs?: PullRequestSummary[];
  listError?: string;
}) {
  const projects = {
    get: () => opts.record,
  } as unknown as ProjectStore;
  const tokens = {
    // Must return a real Promise — the tool chains .catch() on this return value.
    resolve: () => Promise.resolve(opts.token),
  } as unknown as GithubTokenStore;
  const github = {
    listOpenPullRequests: () => {
      if (opts.listError) throw new Error(opts.listError);
      return opts.prs ?? [];
    },
  } as unknown as GithubApiService;
  return new ListPullRequestsTool(projects, tokens, github);
}

describe('list_pull_requests tool', () => {
  it('returns a formatted list of open PRs', async () => {
    const tool = build({ record: REC, token: TOKEN, prs: [PR] });
    const out = await tool.execute({}, ctx());
    expect(out).toContain('Open pull requests on dennis/proj');
    expect(out).toContain('#42');
    expect(out).toContain('Add payment flow');
    expect(out).toContain('alex');
    expect(out).toContain('shared/payment-flow → main');
    expect(out).toContain('https://github.com/dennis/proj/pull/42');
  });

  it('marks draft PRs with [draft]', async () => {
    const tool = build({
      record: REC,
      token: TOKEN,
      prs: [{ ...PR, draft: true }],
    });
    const out = await tool.execute({}, ctx());
    expect(out).toContain('[draft]');
  });

  it('returns a clear empty message when there are no open PRs', async () => {
    const tool = build({ record: REC, token: TOKEN, prs: [] });
    const out = await tool.execute({}, ctx());
    expect(out).toBe('No open pull requests on dennis/proj.');
  });

  it('refuses when the project is not registered', async () => {
    const tool = build({});
    const out = await tool.execute({}, ctx());
    expect(out).toContain('No registered GitHub repo for project "proj"');
  });

  it('refuses with a friendly message when no default token is stored', async () => {
    const tool = build({ record: REC });
    const out = await tool.execute({}, ctx());
    expect(out).toContain('No default GitHub token is stored');
  });

  it('refuses with a friendly message when a named token is missing', async () => {
    const tool = build({ record: { ...REC, tokenName: 'ci-bot' } });
    const out = await tool.execute({}, ctx());
    expect(out).toContain('"ci-bot" isn\'t in the token store');
  });

  it('wraps API errors gracefully and never leaks the token', async () => {
    const tool = build({
      record: REC,
      token: TOKEN,
      listError:
        'GitHub refused the pull request list (403): Must have push access',
    });
    const out = await tool.execute({}, ctx());
    expect(out).toContain("Couldn't list the pull requests");
    expect(out).toContain('403');
    expect(out).not.toContain('SECRET');
  });

  it('resolves an explicit project arg from the recallable set', async () => {
    const tool = build({ record: REC, token: TOKEN, prs: [PR] });
    // Pass project='proj' explicitly; identity.project is also 'proj' — both paths work.
    const out = await tool.execute({ project: 'proj' }, ctx());
    expect(out).toContain('#42');
  });

  it('falls back to identity.project when the explicit project arg is not in recallable set', async () => {
    const projectCalls: string[] = [];
    const projects = {
      get: (_team: string, projectId: string) => {
        projectCalls.push(projectId);
        return REC;
      },
    } as unknown as ProjectStore;
    const tokens = {
      resolve: () => Promise.resolve(TOKEN),
    } as unknown as GithubTokenStore;
    const github = {
      listOpenPullRequests: () => [],
    } as unknown as GithubApiService;
    const tool = new ListPullRequestsTool(projects, tokens, github);
    // 'other-proj' is NOT in recallProjects([id.project='proj']) → falls back to 'proj'
    await tool.execute({ project: 'other-proj' }, ctx('proj'));
    expect(projectCalls[0]).toBe('proj');
  });
});
