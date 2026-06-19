import {
  ProjectConflictError,
  type ProjectStore,
} from '../projects/project-store';
import type {
  GithubApiService,
  RepoInfo,
} from '../projects/github-api.service';
import type { GithubTokenStore } from '../projects/github-token-store';
import {
  ProjectOnboardService,
  ProjectRegistrar,
} from './project-onboard.service';
import type { ProjectOnboardPresenter } from './project-onboard-presenter.port';
import type { ChannelProjectLinker } from './channel-project-linker';

/** A linker that never links — the default for tests exercising the needs-token / presenter path. */
const noLinker = (): ChannelProjectLinker =>
  ({
    linkChannelProject: vi.fn(async () => ({ linkedAsMain: false })),
  }) as unknown as ChannelProjectLinker;

const repo = (over: Partial<RepoInfo> = {}): RepoInfo => ({
  fullName: 'dennis/cubix-infra',
  owner: 'dennis',
  name: 'cubix-infra',
  htmlUrl: 'https://github.com/dennis/cubix-infra',
  defaultBranch: 'main',
  private: false,
  description: 'SSE infra',
  ...over,
});

function makeRegistrar(opts: {
  token?: string;
  getRepo?: RepoInfo | null;
  search?: RepoInfo[];
  createThrows?: unknown;
}) {
  const created: unknown[] = [];
  const projects = {
    create: vi.fn((input: unknown) => {
      if (opts.createThrows) return Promise.reject(opts.createThrows);
      created.push(input);
      return Promise.resolve(input);
    }),
  } as unknown as ProjectStore;
  const tokens = {
    resolve: vi.fn(() =>
      Promise.resolve(opts.token ? { name: 'd', token: opts.token } : undefined),
    ),
    listMeta: vi.fn(() => Promise.resolve([])),
    put: vi.fn(() => Promise.resolve()),
  } as unknown as GithubTokenStore;
  const github = {
    getRepo: vi.fn(() => Promise.resolve(opts.getRepo ?? null)),
    searchAccessibleRepos: vi.fn(() => Promise.resolve(opts.search ?? [])),
  } as unknown as GithubApiService;
  return {
    registrar: new ProjectRegistrar(projects, tokens, github),
    projects,
    tokens,
    github,
    created,
  };
}

describe('ProjectRegistrar.resolveAndRegister', () => {
  it('registers a URL the default token can read', async () => {
    const { registrar, created } = makeRegistrar({
      token: 'ghp_x',
      getRepo: repo(),
    });
    const r = await registrar.resolveAndRegister({
      team: 'T1',
      url: 'https://github.com/dennis/cubix-infra',
    });
    expect(r).toEqual({
      status: 'registered',
      projectId: 'cubix-infra',
      displayName: 'cubix-infra',
    });
    expect(created).toHaveLength(1);
  });

  it('needs a token when the default token cannot read the URL', async () => {
    const { registrar } = makeRegistrar({ token: 'ghp_x', getRepo: null });
    const r = await registrar.resolveAndRegister({
      team: 'T1',
      url: 'https://github.com/dennis/private',
    });
    expect(r.status).toBe('needs-token');
  });

  it('needs a token when none is stored at all', async () => {
    const { registrar } = makeRegistrar({});
    const r = await registrar.resolveAndRegister({ team: 'T1', name: 'x' });
    expect(r.status).toBe('needs-token');
  });

  it('registers a by-name match (exactly one)', async () => {
    const { registrar } = makeRegistrar({
      token: 'ghp_x',
      search: [repo()],
    });
    const r = await registrar.resolveAndRegister({
      team: 'T1',
      name: 'cubix-infra',
    });
    expect(r.status).toBe('registered');
  });

  it('reports not-found when no repo matches the name', async () => {
    const { registrar } = makeRegistrar({ token: 'ghp_x', search: [] });
    const r = await registrar.resolveAndRegister({ team: 'T1', name: 'nope' });
    expect(r).toEqual({ status: 'not-found', query: 'nope' });
  });

  it('reports ambiguous when several repos match', async () => {
    const { registrar } = makeRegistrar({
      token: 'ghp_x',
      search: [
        repo({ htmlUrl: 'https://github.com/a/x' }),
        repo({ htmlUrl: 'https://github.com/b/x' }),
      ],
    });
    const r = await registrar.resolveAndRegister({ team: 'T1', name: 'x' });
    expect(r.status).toBe('ambiguous');
    expect(r).toMatchObject({ matches: expect.arrayContaining(['https://github.com/a/x']) });
  });

  it('treats a slug collision as already-registered (idempotent)', async () => {
    const { registrar } = makeRegistrar({
      token: 'ghp_x',
      getRepo: repo(),
      createThrows: new ProjectConflictError('cubix-infra'),
    });
    const r = await registrar.resolveAndRegister({
      team: 'T1',
      url: 'https://github.com/dennis/cubix-infra',
    });
    expect(r).toEqual({ status: 'already-registered', projectId: 'cubix-infra' });
  });
});

describe('ProjectOnboardService.onboard (presenter wrapper)', () => {
  const base = makeRegistrar({ token: undefined }); // resolveAndRegister → needs-token

  it('presents a card on needs-token when a presenter is bound', async () => {
    const present = vi.fn(() => Promise.resolve());
    const svc = new ProjectOnboardService(base.registrar, noLinker(), {
      present,
    } as ProjectOnboardPresenter);
    const r = await svc.onboard({
      team: 'T1',
      surfaceId: 'slack:T1:C1',
      proposedBy: 'atlas',
      name: 'cubix-infra',
    });
    expect(present).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ status: 'needs-input', presented: true });
  });

  it('degrades to presented:false when no presenter is bound', async () => {
    const svc = new ProjectOnboardService(base.registrar, noLinker(), undefined);
    const r = await svc.onboard({
      team: 'T1',
      surfaceId: 'slack:T1:C1',
      proposedBy: 'atlas',
      name: 'cubix-infra',
    });
    expect(r).toMatchObject({ status: 'needs-input', presented: false });
  });

  it('links the channel as its main repo on register and reports linkedAsMain', async () => {
    const { registrar } = makeRegistrar({ token: 'ghp_x', getRepo: repo() });
    const linkChannelProject = vi.fn(async () => ({ linkedAsMain: true }));
    const svc = new ProjectOnboardService(
      registrar,
      { linkChannelProject } as unknown as ChannelProjectLinker,
      undefined,
    );
    const r = await svc.onboard({
      team: 'T1',
      surfaceId: 'slack:T1:C1',
      proposedBy: 'atlas',
      url: 'https://github.com/dennis/cubix-infra',
    });
    expect(linkChannelProject).toHaveBeenCalledWith({
      team: 'T1',
      surfaceId: 'slack:T1:C1',
      projectId: 'cubix-infra',
    });
    expect(r).toMatchObject({ status: 'registered', linkedAsMain: true });
  });
});
