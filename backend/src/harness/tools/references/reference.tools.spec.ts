import type { Identity } from '../../domain/identity';
import type { ProjectStore } from '../../projects/project-store';
import type { ProjectRecord } from '../../projects/project.types';
import type { WorkspaceService } from '../../workspaces/workspace.service';
import { localGitProvider } from '../../workspaces/workspace-git.test-util';
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
  tokenName: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

const projects = (list: ProjectRecord[]) =>
  ({ list: vi.fn(() => Promise.resolve(list)) }) as unknown as ProjectStore;
const workspaces = () =>
  ({
    ensureReferenceClone: vi.fn(() =>
      Promise.resolve({ path: '/refs/cubix-infra', gitUrl: 'g' }),
    ),
    referenceOrientation: vi.fn(() => Promise.resolve('Top level: src, README')),
  }) as unknown as WorkspaceService;

describe('reference_project', () => {
  it('clones + orients a known catalog project', async () => {
    const ws = workspaces();
    const tool = new ReferenceProjectTool(projects([rec()]), localGitProvider(ws));
    const out = await tool.execute({ name: 'cubix-infra' }, ctx);
    expect(ws.ensureReferenceClone).toHaveBeenCalledWith('T1', {
      projectId: 'cubix-infra',
    });
    expect(out).toContain('/refs/cubix-infra');
    expect(out).toContain('Top level');
  });

  it('matches by display name too', async () => {
    const tool = new ReferenceProjectTool(
      projects([rec()]),
      localGitProvider(workspaces()),
    );
    const out = await tool.execute({ name: 'Cubix Infra' }, ctx);
    expect(out).toContain('Referenced cubix-infra');
  });

  it('hands back an onboard Remedy when the project is unknown', async () => {
    const tool = new ReferenceProjectTool(
      projects([]),
      localGitProvider(workspaces()),
    );
    const out = await tool.execute({ name: 'mystery' }, ctx);
    expect(out).toMatch(/Remedy:/);
    expect(out).toContain('onboard_project');
  });
});

describe('reference_repo', () => {
  it('rejects a non-GitHub URL', async () => {
    const tool = new ReferenceRepoTool(localGitProvider(workspaces()));
    const out = await tool.execute({ url: 'http://example.com' }, ctx);
    expect(out).toMatch(/isn't an https/i);
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
});
