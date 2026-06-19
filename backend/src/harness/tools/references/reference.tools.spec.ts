import type { Identity } from '../../domain/identity';
import type { ProjectStore } from '../../projects/project-store';
import type { ProjectRecord } from '../../projects/project.types';
import type {
  EnsureReferenceResult,
  ReferenceLibraryService,
} from '../../workspaces/reference-library.service';
import type { HarnessToolContext } from '../tool.types';
import {
  ListReferenceProjectsTool,
  ReferenceProjectTool,
  ReferenceRepoTool,
} from './reference.tools';

const ctx: HarnessToolContext = {
  identity: {
    selfAgent: 'atlas',
    team: 'T1',
    project: 'main',
    participants: ['dennis'],
    speaker: 'dennis',
    surface: 'slack:T1:C1',
    isChannel: true,
  } as Identity,
};

const rec = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  teamId: 'T1',
  projectId: 'cubix-infra',
  displayName: 'Cubix Infra',
  description: 'SSE infra patterns',
  gitUrl: 'https://github.com/dennis/cubix-infra',
  defaultBranch: 'main',
  branchingPolicy: null,
  tokenName: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

const projects = (list: ProjectRecord[]) =>
  ({ list: vi.fn(() => Promise.resolve(list)) }) as unknown as ProjectStore;
/** A catalog whose `list` rejects — models a transient DB hiccup. */
const failingProjects = () =>
  ({
    list: vi.fn(() => Promise.reject(new Error('db down'))),
  }) as unknown as ProjectStore;

/** A reference library returning `result` from ensureReference + a fixed orientation. */
const refs = (
  result: EnsureReferenceResult = {
    ok: true,
    slug: 'cubix-infra',
    mountPath: '/refs/cubix-infra',
    gitUrl: 'https://github.com/dennis/cubix-infra',
  },
) =>
  ({
    ensureReference: vi.fn(() => Promise.resolve(result)),
    orientation: vi.fn(() => Promise.resolve('Top level: src, README')),
  }) as unknown as ReferenceLibraryService;

describe('reference_project', () => {
  it('materializes + orients a known catalog project via the library', async () => {
    const lib = refs();
    const tool = new ReferenceProjectTool(projects([rec()]), lib);
    const out = await tool.execute({ name: 'cubix-infra' }, ctx);
    expect(lib.ensureReference).toHaveBeenCalledWith('T1', {
      projectId: 'cubix-infra',
    });
    expect(out).toContain('/refs/cubix-infra');
    expect(out).toContain('Top level');
  });

  it('matches by display name too', async () => {
    const tool = new ReferenceProjectTool(projects([rec()]), refs());
    const out = await tool.execute({ name: 'Cubix Infra' }, ctx);
    expect(out).toContain('Referenced cubix-infra');
  });

  it('hands back an onboard Remedy when the project is unknown', async () => {
    const tool = new ReferenceProjectTool(projects([]), refs());
    const out = await tool.execute({ name: 'mystery' }, ctx);
    expect(out).toMatch(/Remedy:/);
    expect(out).toContain('onboard_project');
  });

  it('reports a clone failure distinctly from "not registered"', async () => {
    const tool = new ReferenceProjectTool(
      projects([rec()]),
      refs({ ok: false, reason: 'clone-failed', detail: 'boom' }),
    );
    const out = await tool.execute({ name: 'cubix-infra' }, ctx);
    expect(out).toMatch(/clone failed/i);
    expect(out).toContain('cubix-infra');
    expect(out).not.toMatch(/isn't a registered project/i);
  });

  it("asks to retry (not 'not registered') when the catalog can't be read", async () => {
    const tool = new ReferenceProjectTool(failingProjects(), refs());
    const out = await tool.execute({ name: 'cubix-infra' }, ctx);
    expect(out).toMatch(/catalog/i);
    expect(out).toMatch(/retry/i);
    expect(out).not.toMatch(/isn't a registered project/i);
  });
});

describe('reference_repo', () => {
  it('rejects a non-GitHub URL', async () => {
    const tool = new ReferenceRepoTool(refs());
    const out = await tool.execute({ url: 'http://example.com' }, ctx);
    expect(out).toMatch(/isn't an https/i);
  });

  it('materializes + orients a GitHub URL via the library', async () => {
    const lib = refs({
      ok: true,
      slug: 'dennis-cubix-infra',
      mountPath: '/refs/dennis-cubix-infra',
      gitUrl: 'https://github.com/dennis/cubix-infra',
    });
    const tool = new ReferenceRepoTool(lib);
    const out = await tool.execute(
      { url: 'https://github.com/dennis/cubix-infra' },
      ctx,
    );
    expect(lib.ensureReference).toHaveBeenCalledWith('T1', {
      gitUrl: 'https://github.com/dennis/cubix-infra',
    });
    expect(out).toContain('/refs/dennis-cubix-infra');
    expect(out).toContain('Top level');
  });

  it('surfaces a clone failure with a token/onboard Remedy', async () => {
    const tool = new ReferenceRepoTool(
      refs({ ok: false, reason: 'clone-failed', detail: 'no access' }),
    );
    const out = await tool.execute(
      { url: 'https://github.com/dennis/private' },
      ctx,
    );
    expect(out).toMatch(/Couldn't clone/i);
    expect(out).toContain('onboard_project');
  });
});

describe('list_reference_projects', () => {
  it('lists other projects, excluding the channel’s own', async () => {
    const tool = new ListReferenceProjectsTool(
      projects([rec(), rec({ projectId: 'main', displayName: 'Main' })]),
    );
    const out = await tool.execute({}, ctx);
    expect(out).toContain('cubix-infra');
    expect(out).not.toContain('• main');
  });

  it('explains when nothing is registered', async () => {
    const tool = new ListReferenceProjectsTool(projects([]));
    const out = await tool.execute({}, ctx);
    expect(out).toMatch(/No other projects/i);
  });

  it("asks to retry (not 'nothing registered') when the catalog can't be read", async () => {
    const tool = new ListReferenceProjectsTool(failingProjects());
    const out = await tool.execute({}, ctx);
    expect(out).toMatch(/catalog/i);
    expect(out).toMatch(/retry/i);
    expect(out).not.toMatch(/No other projects/i);
  });
});
